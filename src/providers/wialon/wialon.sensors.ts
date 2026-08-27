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
 */
export function readIgnition(
  sensors: Record<string, WialonSensor> | undefined,
  params: Record<string, unknown> | undefined,
): boolean | null {
  if (!sensors || !params) return null

  for (const sensor of Object.values(sensors)) {
    if (sensor.t !== IGNITION_SENSOR_TYPE) continue
    const raw = params[sensor.p]
    // Some firmwares send the line as a string, hence the coercion rather than
    // a typeof-number guard.
    if (raw == null || raw === '') continue
    const n = Number(raw)
    if (!Number.isFinite(n)) continue

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
    if (n !== 0 && n !== 1) continue
    return n === 1
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
