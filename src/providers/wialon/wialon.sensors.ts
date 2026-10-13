/**
 * Wialon sensor decoding — fuel level.
 *
 * Units carry configured sensors (`sens`) whose raw parameter values arrive in
 * the last message (`lmsg.p`). A fuel probe reports a RAW ADC reading — around
 * 0–4096 — not litres, so it must be run through the sensor's own calibration
 * table before it means anything. Publishing the raw number as a fuel level
 * would be badly wrong, not merely imprecise: a raw 1992 is 44 L on one unit
 * and something else entirely on the next.
 *
 * Tank capacity is not a field either — the operator encodes it in the sensor
 * NAME, e.g. "2.Main Tank Fuel Level Qty (95L)". That is the only source of
 * capacity available, and without it a percentage cannot be computed at all.
 */

import type { AccelAxes } from '../telemetry-provider.js'

/** One calibration point: for readings from `x` upward, litres = a·raw + b. */
export interface CalibrationPoint { x: number; a: number; b: number }

export interface WialonSensor {
  n:    string                  // name — carries the tank size in brackets
  t:    string                  // type — "fuel level" for a probe
  p:    string                  // parameter it reads, e.g. "io_270"
  m?:   string                  // metric, e.g. "l"
  tbl?: CalibrationPoint[]      // calibration table; may be empty
  /**
   * Wialon's per-sensor config, as a JSON STRING (not an object). Its `ci` map
   * is what the account's engineers wrote to explain out-of-band values — see
   * describeProbeValue.
   */
  c?:   string
}

const FUEL_SENSOR_TYPE = 'fuel level'
/**
 * Wialon's type for an ignition line. Verified against this account: 222 of
 * 224 units carry one, every one of them reading `io_239` — the standard
 * Teltonika ignition input.
 */
const IGNITION_SENSOR_TYPE = 'engine operation'

/**
 * Teltonika's ignition input, AVL id 239 — read directly by `readIgnition`
 * ahead of whatever parameter a sensor is bound to. See that function for the
 * measurement behind the precedence.
 */
const IGNITION_PARAM = 'io_239'

/**
 * A parameter's value as a digital line, or null when it is not one.
 *
 * The binary test is the whole guard: this account binds ignition sensors to
 * parameters that are not booleans at all, and a value outside {0, 1} is
 * evidence the parameter is measuring something else. Strings are coerced
 * because some firmwares send the line as text.
 */
function asDigital(raw: unknown): boolean | null {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || (n !== 0 && n !== 1)) return null
  return n === 1
}

/* ─────────────────────────── camera / MDVR ──────────────────────────────── */

/**
 * Wialon's own sensor types for a camera channel. Present in the documentation;
 * NOT present on this account — the one camera unit declares its video sensor
 * as `custom`, which is why the detection below cannot rely on type alone.
 */
const CAMERA_SENSOR_TYPES = new Set(['camera', 'image', 'video'])

/**
 * Parameters an MDVR reports about ITSELF rather than about the vehicle.
 *
 * Measured on the one camera unit in this account, 2026-08-29:
 * `recording_status 7`, `hd15_status 1`, `hd15_size 59488`, `video_loss 0`,
 * `video_blind 0`. A unit reporting these has a recorder fitted whatever its
 * sensors are called, so they are the reliable capability signal — the Video_URL
 * sensor is a configuration someone added by hand and another integrator may
 * name differently or omit.
 */
const MDVR_PARAMS = ['recording_status', 'video_loss', 'video_blind', 'hd15_status']

/** Sensor name or parameter that plausibly carries a media URL. */
const VIDEO_URL_HINT = /video.?(url|uri|link)|stream.?(url|uri)/i

export interface CameraState {
  /** A recorder is fitted, on the evidence of the unit's own diagnostics. */
  hasCamera: boolean
  /** Parameter the account's Video_URL sensor is bound to, when one exists. */
  urlParam: string | null
  /** The URL itself, when the parameter has actually arrived and looks usable. */
  streamUrl: string | null
  /** Recorder health, for a UI that has to explain a black screen. */
  recording: boolean | null
  signalLost: boolean | null
}

/**
 * What this unit's on-board recorder is doing, and how to reach it.
 *
 * ## Written against a real unit, but NOT against a real URL
 *
 * `VS Menengai CAMERA - KCS 078M` (Wialon id 28628615) is the only camera in
 * this account. Everything about the recorder below is read from parameters it
 * genuinely sends. The URL is the exception: it declares a custom sensor named
 * `Video_URL` bound to `video_uri`, and that parameter appeared in **0 of 1,707
 * messages over seven days**. So the extraction path is built, and it has never
 * had a value to extract.
 *
 * That uncertainty is why the parameter NAME is read from the sensor definition
 * rather than hardcoded to `video_uri`. `Video_URL` is a hand-made custom
 * sensor on one account; the next integrator may bind a differently-named
 * parameter, and following the sensor's own `p` costs nothing and survives that.
 *
 * ## And why an unrecognised value is dropped, not passed on
 *
 * Nobody knows whether `video_uri` will hold an absolute URL, a path, a token,
 * or a list of channels — it has never arrived. So the value is only reported
 * as `streamUrl` when it parses as an http(s) URL. Anything else leaves
 * `streamUrl` null while `hasCamera` stays true, which renders as "camera
 * fitted, no stream available" rather than as a broken `<video src>`. A guess
 * that reaches the client as a stream URL is a black rectangle nobody can
 * diagnose; a null is a sentence.
 */
export function readCamera(
  sensors: Record<string, WialonSensor> | undefined,
  params: Record<string, unknown> | undefined,
): CameraState {
  const none: CameraState = {
    hasCamera: false, urlParam: null, streamUrl: null,
    recording: null, signalLost: null,
  }

  const hasMdvrParams = params != null && MDVR_PARAMS.some(k => k in params)
  const typedSensor = sensors != null && Object.values(sensors)
    .some(s => CAMERA_SENSOR_TYPES.has(String(s?.t ?? '').toLowerCase()))

  // The sensor whose job is to carry the URL, by name or by the parameter it
  // reads. Either is enough — the account names it `Video_URL` and binds it to
  // `video_uri`, and matching on both means neither convention is required.
  const urlSensor = sensors == null ? undefined : Object.values(sensors).find(
    s => VIDEO_URL_HINT.test(String(s?.n ?? '')) || VIDEO_URL_HINT.test(String(s?.p ?? '')),
  )

  if (!hasMdvrParams && !typedSensor && !urlSensor) return none

  const urlParam = urlSensor?.p ?? null
  const raw = urlParam && params ? params[urlParam] : undefined
  const str = raw == null ? '' : String(raw).trim()

  let streamUrl: string | null = null
  if (str) {
    try {
      const u = new URL(str)
      // http(s) only. A `file:` or `rtsp:` value is real information but not
      // something a browser <video> can open, and handing one to the client
      // would produce exactly the undiagnosable black rectangle above.
      if (u.protocol === 'http:' || u.protocol === 'https:') streamUrl = u.toString()
    } catch { /* not a URL — leave null, see the note above */ }
  }

  // `recording_status` is a bitfield on this hardware and read as
  // "any channel recording". Truthy-vs-zero is all that can be claimed without
  // a second unit to compare bit meanings against.
  const rec = params?.['recording_status']
  const loss = params?.['video_loss']

  return {
    hasCamera: true,
    urlParam,
    streamUrl,
    recording:  rec == null ? null : Number(rec) > 0,
    signalLost: loss == null ? null : Number(loss) > 0,
  }
}
/** "…Qty (450L)" / "…Level (254 L)" → 450 / 254. */
const CAPACITY_IN_NAME = /\((\d+(?:\.\d+)?)\s*L\)/i

/** Tank capacity in litres, read from the sensor name. */
export function tankCapacityFromSensorName(name: string): number | null {
  const m = CAPACITY_IN_NAME.exec(name)
  if (!m) return null
  const litres = Number(m[1])
  return Number.isFinite(litres) && litres > 0 ? litres : null
}

/**
 * Convert a raw probe reading to litres using the sensor's calibration table.
 *
 * Wialon's table is piecewise-linear: points are sorted by `x`, and the
 * segment that applies is the last one whose `x` is at or below the reading.
 * Returns null when there is no table — a reading we cannot calibrate is not
 * a fuel level, and inventing one would be worse than showing nothing.
 *
 * ## Why a reading ABOVE the table is rejected outright
 *
 * The table is the domain over which the probe was actually calibrated. Above
 * its highest point there is no measurement to convert — and on these probes a
 * high reading is not a full tank, it is a fault code.
 *
 * The BLE probes on this account carry a second sensor on the SAME parameter
 * ("22.BLE Probe Status", io_270) whose value labels state it outright:
 *
 *      2 … 4094  "Healthy"                — the real operating range
 *      4095      "Full / Short Circuit / Water / Metallic / Dirt — Contact Support"
 *      6500      "Lost Contact with Tubes Error — Needs Replacement"
 *      7000      "Fuel Contamination Error — Needs Tank Flashing"
 *
 * So the two SUKARI winches sitting at io_270 = 7000 are reporting contaminated
 * probes, not fuel. Extrapolating the last segment turned that into 403.9 L in
 * a 160 L tank (252%) and 1722.5 L in a 270 L tank (638%); CLAMPING to the top
 * of the table is worse still, because it yields exactly 160.0 L and 270.0 L —
 * a full tank, indistinguishable from a healthy reading. A fault must not be
 * able to render as a plausible level. Null is the only honest answer, and the
 * caller already treats null as "no reading" rather than as empty.
 *
 * Measured live across all 1,504 units on the account, 34 read above their
 * table: 5 at the 6500/7000 fault codes, the rest pegged at or just past 4095,
 * which the vendor's own labelling flags as "Contact Support" rather than as a
 * trustworthy full tank. None of them is a level we can stand behind.
 *
 * Note this rejects only readings ABOVE the table. Below its floor the first
 * segment still applies, and the Math.max(0) below catches the slight negative
 * a near-empty tank can compute.
 */
export function calibrateFuel(raw: number, tbl: CalibrationPoint[] | undefined): number | null {
  if (!Number.isFinite(raw) || !tbl || tbl.length === 0) return null

  const sorted = [...tbl].sort((p, q) => p.x - q.x)
  // Off the end of the calibrated scale is not a measurement — see above.
  if (raw > sorted.at(-1)!.x) return null

  let seg = sorted[0]!
  for (const point of sorted) {
    if (point.x <= raw) seg = point
    else break
  }

  const litres = seg.a * raw + seg.b
  if (!Number.isFinite(litres)) return null
  // A probe reading below its calibrated floor can compute slightly negative.
  return Math.max(0, litres)
}

export interface FuelReading {
  /** Litres in the tank, calibrated. */
  litres:   number
  /** Tank capacity from the sensor name, when stated. */
  capacityL: number | null
}

export interface FuelProbeFault {
  /** The value the probe reported — the thing to quote when raising a ticket. */
  raw: number
  /** Top of the calibrated range, which `raw` exceeded. */
  calibratedMax: number
  /**
   * The account's OWN explanation of this value, when one is configured.
   * e.g. "Fuel Contamination Error - Needs Tank Flashing".
   */
  reason: string | null
}

/**
 * The account's label for a value on a given parameter, if any sensor on that
 * parameter defines one.
 *
 * These BLE probes carry a second, `custom`-typed sensor on the SAME parameter
 * as the fuel probe, purely to name its out-of-band values — for io_270:
 *
 *      2 … 4094  "Healthy"        4095  "Full / Short Circuit / Water / Dirt …"
 *      6500      "Lost Contact with Tubes Error - Needs Replacement"
 *      7000      "Fuel Contamination Error - Needs Tank Flashing"
 *
 * That is the fleet engineer's own diagnosis of the fault, which beats anything
 * we could infer, so it is preferred over a generic message wherever present.
 *
 * Wialon stores these in the sensor's `c` config as a JSON *string* whose `ci`
 * maps a threshold to `{ t: label }`, applied to every value at or above it
 * until the next threshold. Parsed defensively: `c` is operator-authored and a
 * malformed one must cost us the label, not the fault detection.
 */
function describeProbeValue(
  sensors: Record<string, WialonSensor>,
  param: string,
  value: number,
): string | null {
  let best: { at: number; text: string } | null = null

  for (const sensor of Object.values(sensors)) {
    if (sensor.p !== param || !sensor.c) continue

    let ci: Record<string, { t?: string }> | undefined
    try {
      ci = (JSON.parse(sensor.c) as { ci?: Record<string, { t?: string }> }).ci
    } catch { continue }
    if (!ci) continue

    for (const [key, entry] of Object.entries(ci)) {
      const at = Number(key)
      if (!Number.isFinite(at) || at > value) continue
      if (!entry?.t) continue
      if (!best || at > best.at) best = { at, text: entry.t }
    }
  }
  return best?.text ?? null
}

/**
 * Top of a 12-bit probe line. Every labelled account on this token treats a
 * value here or above as "Contact Support" at best, and the documented hard
 * faults (6500 "Lost Contact with Tubes", 7000 "Contamination") sit beyond it.
 * Used only where the account configured no label of its own.
 */
const PROBE_LINE_CEILING = 4095
/** The account's way of saying the hardware is fine — see the rule below. */
const HEALTHY_LABEL = /^\s*healthy\s*$/i

/**
 * Is the unit's fuel probe reporting a HARDWARE FAULT?
 *
 * Companion to `calibrateFuel` returning null: that refuses to invent a level,
 * this says why, so a broken probe is distinguishable from a vehicle with no
 * sensor fitted. Only faults qualify, and that distinction is the whole point
 * of the function — measured against the live account, "reading above the
 * calibration table" alone would flag 40 units, of which roughly half are
 * healthy probes whose table simply stops short of the top of their range
 * (raw 3986 against a table ending at 3720, and the like). Those need a longer
 * calibration table, not a workshop, and calling them faults would bury the
 * dozen that genuinely are broken.
 *
 * So a fault needs three things:
 *   1. NO usable reading from any of the unit's fuel sensors. A unit whose
 *      main tank reads fine is not faulty because a second probe is off — that
 *      contradiction was live on six units before this guard.
 *   2. A reading above the calibrated range.
 *   3. Evidence it is genuinely abnormal: the account's own label says so, or
 *      — where no label is configured — the value is at/above the line ceiling.
 */
export function readFuelProbeFault(
  sensors: Record<string, WialonSensor> | undefined,
  params: Record<string, unknown> | undefined,
): FuelProbeFault | null {
  if (!sensors || !params) return null
  // (1) A working reading anywhere on the unit outranks any fault below it.
  if (readFuel(sensors, params)) return null

  for (const sensor of Object.values(sensors)) {
    if (sensor.t !== FUEL_SENSOR_TYPE) continue
    if (!sensor.tbl || sensor.tbl.length === 0) continue

    const raw = params[sensor.p]
    if (typeof raw !== 'number') continue

    // (2) Inside the calibrated range there is nothing to report.
    const calibratedMax = Math.max(...sensor.tbl.map(p => p.x))
    if (raw <= calibratedMax) continue

    // (3) Abnormal, on the account's word or on the line's physical limit.
    const reason = describeProbeValue(sensors, sensor.p, raw)
    const abnormal = reason != null
      ? !HEALTHY_LABEL.test(reason)
      : raw >= PROBE_LINE_CEILING
    if (!abnormal) continue

    return { raw, calibratedMax, reason }
  }
  return null
}

/** Whether the unit has a fuel probe configured at all. */
export function hasFuelSensor(sensors: Record<string, WialonSensor> | undefined): boolean {
  return sensors != null && Object.values(sensors).some(s => s?.t === FUEL_SENSOR_TYPE)
}

/**
 * Whether a message carries a raw value for any of the unit's fuel probes.
 *
 * A message that does not says nothing about the tank or the probe — neither
 * that the level changed nor that a fault cleared — so a caller holding the
 * last reading keeps it.
 */
export function carriesFuelReading(
  sensors: Record<string, WialonSensor> | undefined,
  params: Record<string, unknown> | null | undefined,
): boolean {
  if (!sensors || !params) return false
  return Object.values(sensors).some(s => s?.t === FUEL_SENSOR_TYPE && typeof params[s.p] === 'number')
}

/**
 * Best fuel reading for a unit: its main-tank probe, calibrated.
 *
 * Where a unit has several fuel sensors (main + reserve) the one with the
 * largest stated capacity is treated as the main tank — reserve tanks are the
 * smaller of the pair, and summing them would misreport the level against the
 * capacity we display.
 */
export function readFuel(
  sensors: Record<string, WialonSensor> | undefined,
  params: Record<string, unknown> | undefined,
): FuelReading | null {
  if (!sensors || !params) return null

  let best: FuelReading | null = null
  for (const sensor of Object.values(sensors)) {
    if (sensor.t !== FUEL_SENSOR_TYPE) continue

    const raw = params[sensor.p]
    if (typeof raw !== 'number') continue

    const litres = calibrateFuel(raw, sensor.tbl)
    if (litres == null) continue

    const capacityL = tankCapacityFromSensorName(sensor.n)
    if (!best || (capacityL ?? 0) > (best.capacityL ?? 0)) best = { litres, capacityL }
  }
  return best
}

/**
 * Ignition state for a unit, or null when it cannot be known.
 *
 * This is the ONLY way to tell a vehicle that is idling from one that is
 * parked. Without it `engineOn` has to be derived from speed, which makes the
 * two states literally the same signal — the reason the dashboard could not
 * report idling at all.
 *
 * Null is returned rather than `false` when the unit has no ignition sensor,
 * or has one but its parameter is absent from this message: "we do not know"
 * and "the engine is off" are different claims, and only the first is honest
 * here. Callers fall back to the speed heuristic in that case.
 *
 * ## `io_239` is read FIRST, ahead of whatever a sensor is bound to
 *
 * AVL id 239 is Teltonika's ignition input. The account's sensors are not
 * reliably bound to it — "1.IGN" points at five different parameters and only
 * two are digital — so the sensor is the weaker source, not the stronger one.
 *
 * Measured against all 211 KASULU units, 2026-09-24
 * (`prisma/measure-ignition-fallback.ts`, re-runnable):
 *
 *   ignition readable before          104
 *   blind before                      107
 *     recovered by reading io_239      70   (62 reporting within 7 days)
 *     still blind, no io_239 at all    37
 *   io_239 values across the fleet    0 and 1, nothing else
 *
 * That matters well beyond idling. `engineEvidence >= MIN_ENGINE_EVIDENCE` is a
 * precondition of the parked branch in `fuel-theft-classifier`, and the parked
 * branch is the only route to a SIPHON verdict — so each of those 70 units was
 * structurally incapable of raising a fuel-theft alert, whatever happened to
 * its tank. MUFINDI - FT 13 is one of them; see
 * docs/fuel-theft-alerting-gaps.md.
 *
 * ## Why FIRST rather than as a fallback after the sensor
 *
 * Of the 104 units where both can be read, 99 agree. The five that disagree all
 * disagree the same way — the sensor says OFF while io_239 says ON:
 *
 *   MUFINDI - EX 07, LMV 15, CM 05, FTT 05   sensor on io_1
 *   MUFINDI: MTR 14                          sensor on io_9
 *
 * A false "engine off" is the dangerous direction here, not a harmless one: it
 * is exactly what makes `parked` true, and `parked` is what licenses a theft
 * verdict against whoever was driving. MTR 14 is the clearest case — io_9 is
 * not boolean at all, but it does take the value 0, and 0 passes the binary
 * test below, so a parameter this function has already judged untrustworthy
 * still reports "off" whenever it happens to read zero.
 *
 * Reading io_239 first resolves all five toward the genuine line and leaves the
 * 99 that agree untouched.
 *
 * Note the residual: a unit bound to io_9 that sends NO io_239 can still report
 * a false "off" from io_9 = 0. None of the 37 still-blind units is in that
 * position today, but the guard below remains per-value rather than
 * per-parameter, and that is worth revisiting separately.
 */
export function readIgnition(
  sensors: Record<string, WialonSensor> | undefined,
  params: Record<string, unknown> | undefined,
): boolean | null {
  if (!params) return null

  // The genuine ignition line, wherever a sensor happens to point.
  const direct = asDigital(params[IGNITION_PARAM])
  if (direct !== null) return direct

  if (!sensors) return null

  for (const sensor of Object.values(sensors)) {
    if (sensor.t !== IGNITION_SENSOR_TYPE) continue
    // ONLY a genuine digital line can answer this. `n !== 0` used to be the
    // test, and it silently accepted parameters that are not booleans at all.
    //
    // Every unit in this account names its sensor "1.IGN", but they are bound
    // to FIVE different parameters and only some are digital. Measured live:
    //
    //   io_239   0/1 only          — Teltonika ignition. Genuine.
    //   io_1     0/1 only          — digital input 1. Genuine.
    //   io_9     0,43,86,87,130,…  — NOT boolean. Never 1, almost never 0.
    //   pwr_ext  27.99            — external supply VOLTAGE, live whenever the
    //                               tracker is wired to the battery.
    //   flg:1                     — a message-flag bit, absent from `p`.
    //
    // Under `n !== 0`, io_9 and pwr_ext units reported the engine running
    // essentially always: 33 of 39 io_9 units read "on" against 41% of the
    // genuine io_239 ones. That inflated the idling count with vehicles that
    // were simply switched off, and no calibration exists to decode them —
    // the sensors carry no bounds and no conversion table.
    //
    // So the reading is trusted only when the value is actually binary.
    // Anything else is UNKNOWN, not "off": callers fall back to the speed
    // heuristic and lib/movement-state collapses to 'resting' rather than
    // claiming an idle it cannot support. Fixing this properly is a Wialon
    // configuration job — those sensors need binding to a real ignition input.
    //
    // ## And none of it can be evaluated after the fact
    //
    // `params` is `u.lmsg.p`, read live and never stored. `toFrame` persists
    // `pos` (the POSITION), odometer, engine hours and `ignition_known`, and
    // nothing else — so `pwr_ext`, `io_9` and `io_239` exist for the duration of
    // this function call and are then gone. Measured 2026-08-26: of the newest
    // 200,000 raw payloads, all `source: wialon`, ZERO contain any of the three,
    // and zero carry a voltage of any kind. (`batteryVoltageV` appears in the
    // payload SHAPE, but it belongs to another provider's frames and is absent
    // on every Wialon row.)
    //
    // That matters because the two obvious ways to recover ignition on the units
    // this rejects both need history that does not exist:
    //
    //   · supply VOLTAGE — on a 24 V system, alternator charging (~28 V) against
    //     rest (~24-25 V) should be bimodal per unit, and the trough would be the
    //     threshold. There is no stored voltage to look for a trough in.
    //   · `io_9` — values 0, 43, 86, 87, 130, 172, 174, never 1. Whether any bit
    //     or threshold tracks engine state is answerable only against a sample,
    //     and there is no sample.
    //
    // So neither can be measured today, let alone shipped. The enabling step is
    // small — persist the handful of params this function already reads — but it
    // starts a clock rather than answering a question: a per-unit bimodality test
    // needs days of accumulation before it means anything.
    //
    // The engine-hours meter is NOT the way round this. Measured the same day
    // over units that do have a genuine line, a per-fix meter delta agrees with
    // the sensor 24.7% of the time (the counter updates every ~5 minutes while
    // fixes arrive every ~26 s), and per 10-minute window it proves "the engine
    // never ran" correctly only 74.5% of the time — good enough for a rate,
    // nowhere near good enough to license a theft verdict. See
    // prisma/measure-meter-ignition.ts.
    const value = asDigital(params[sensor.p])
    if (value === null) continue
    return value
  }
  return null
}

/** Largest stated tank capacity across a unit's fuel sensors. */
export function tankCapacityOf(sensors: Record<string, WialonSensor> | undefined): number | null {
  if (!sensors) return null
  let max: number | null = null
  for (const sensor of Object.values(sensors)) {
    if (sensor.t !== FUEL_SENSOR_TYPE) continue
    const cap = tankCapacityFromSensorName(sensor.n)
    if (cap != null && (max == null || cap > max)) max = cap
  }
  return max
}

/* ─────────────────────────── accelerometer ──────────────────────────────── */

/** Teltonika's accelerometer axes, AVL ids 17/18/19, in X/Y/Z order. */
const ACCEL_PARAMS = ['io_17', 'io_18', 'io_19'] as const

/** A message's supply voltages, in volts; null where the message has none. */
export interface SupplyVolts {
  ext: number | null
  int: number | null
}

/** Volts above this are not a supply reading; past 100 the firmware sent millivolts. */
const VOLT_LIMIT = 60

/**
 * The tracker's external supply and internal battery voltages from one
 * message's params (`pwr_ext`, `pwr_int`), or null when it carries neither.
 * Most firmwares send volts (`27.99`); a value over 100 is read as millivolts.
 * A negative or impossible value is dropped, not clamped.
 */
export function readVoltages(params: Record<string, unknown> | null | undefined): SupplyVolts | null {
  if (!params) return null
  const volts = (raw: unknown): number | null => {
    let v = asNumber(raw)
    if (v == null) return null
    if (v > 100) v /= 1000
    return v >= 0 && v <= VOLT_LIMIT ? Math.round(v * 100) / 100 : null
  }
  const ext = volts(params['pwr_ext'])
  const int = volts(params['pwr_int'])
  return ext == null && int == null ? null : { ext, int }
}

/**
 * The most a tracker accelerometer can report, in g. Teltonika's range tops out
 * at ±16 g; a value past it is not a reading.
 */
const ACCEL_LIMIT_G = 16

/** A parameter as a finite number, or null. Some firmwares send numbers as text. */
function asNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * The accelerometer axes of one message, in g, or null when it carries none.
 *
 * Pass the params of the message whose POSITION the frame records. An axis
 * reading describes one instant, so it must never be held over onto a later
 * fix the way fuel and ignition are.
 *
 * ## Two encodings, told apart per message
 *
 * Wialon hands the axes on in one of two forms, and each unit keeps to one.
 * Measured over the 237 units that sent all three on 2026-09-27:
 *
 *   · in g, as decimals: `0.017, -0.004, -1.695`. All but eight units.
 *   · the tracker's own milli-g as whole numbers, negatives in 16-bit two's
 *     complement: `44, 65517, 65503` is +0.044, -0.019, -0.033 g. Eight
 *     MENENGAI units, e.g. CPO - MENENGAI - KCH 045A.
 *
 * So a message whose axes are ALL whole numbers is read as milli-g, and any
 * decimal means g. The one misread would be a g-unit reporting three exact
 * whole numbers at once, which a sensor quantised to 0.001 g does not do in
 * practice; all zeros is zero either way.
 *
 * ## Not `accel_x/y/z`
 *
 * Those are a different stream: bursts of ~1,000 raw samples sharing one
 * timestamp, in milli-g with gravity included, sent around harsh events
 * (MUFINDI: GR 01 and MUFINDI : MTR 18, 2026-09-27). They trace an event rather
 * than describe the fix, so they are deliberately not read here.
 */
export function readAccelerometer(params: Record<string, unknown> | null | undefined): AccelAxes | null {
  if (!params) return null
  const raw = ACCEL_PARAMS.map(k => asNumber(params[k]))
  const present = raw.filter((v): v is number => v != null)
  if (present.length === 0) return null

  const milliG = present.every(v => Number.isInteger(v))
  const toG = (v: number | null): number | null => {
    if (v == null) return null
    const g = milliG ? (v > 32767 ? v - 65536 : v) / 1000 : v
    return Math.abs(g) <= ACCEL_LIMIT_G ? g : null
  }
  const [x, y, z] = raw.map(toG) as [number | null, number | null, number | null]
  if (x == null && y == null && z == null) return null
  return { x, y, z }
}
