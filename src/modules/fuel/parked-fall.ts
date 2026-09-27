/**
 * The two-stage rule for fuel that leaves a PARKED machine. Pure.
 *
 * ## Why it exists
 *
 * The adjudicator judges the provider's drain reports, and on 2026-09-25 that
 * route missed the one theft an operator reported — `MUFINDI: CTR 12`, 6 L
 * siphoned over twenty minutes with the engine off, then topped back up. Wialon
 * never reported a drain, so there was nothing to judge. Replayed over
 * 19–25 Sep, the older pipeline sent 50 notifications a day and all but 7 were
 * burn-rate findings; this rule sent none of those and caught CTR 12.
 *
 * ## The call within minutes, then the follow-up
 *
 * THE CALL is the live watch (`lib/fuel-drop-watch`): a fall of 5 L or more on
 * a machine that had stood still five minutes when the fall began, engine off by
 * the ignition line or — where the unit has none — the engine-hours counter,
 * still down `STILL_DOWN_CONFIRM_MS` after it settled. It goes out as possible
 * theft there and then. Speed is the operator's requirement (2026-09-26: "a
 * verdict achieved in 10 minutes"), and it has a measured price: nothing seen
 * within minutes separates the falls that later come back from the ones that do
 * not (same sizes, same speeds, same stillness), so about a third of these calls
 * are retracted by the follow-up below.
 *
 * THE FOLLOW-UP is `judgeNextStart`, run by `lib/queues/parked-falls` until it
 * answers. It never waits on the fillings ledger, and it never takes "the level
 * came back" as proof the fall was not real — a thief who tops the tank up, or
 * drives to a pump, makes the level come back too (the operator, 2026-09-27).
 * What decides is where the machine was while the level rose, because fuel only
 * goes into a tank that is standing still:
 *
 *   TOPPED_UP   rose back to about the old level while the machine STOOD — at the
 *               spot it was drained, or at a stop after it moved — with the engine
 *               off, or idling as the accelerometer shows. Fuel went in. Decided
 *               the moment the rise finishes, whatever the ledger says (Wialon
 *               files a pour as a "filling": `MUFINDI - FT 13`, 23 Sep, 13:01)
 *   REFUELLED   the same, but rising well past the old level: a refuel, so the
 *               loss before it stays unexplained
 *   CONFIRMED   still gone after it next started and ran — fuel left the tank
 *   CLEARED     came back while the machine drove, when no fuel can go in (no
 *               stand of REFUEL_STAND_MS inside the rise), and read back up where
 *               it next stood — at the same angle as where it fell, by the
 *               accelerometer, or at two different places. Also the settle
 *               within three minutes, the operator's rule
 *   UNRESOLVED  cannot be told apart with what this unit reports — a rise while
 *               it stood with the engine running on a unit with no accelerometer,
 *               a slow creep, no second place to check against, or no start
 *               within a day. The call stands; nothing is retracted
 *
 * A reading at ONE place decides nothing on its own: a slope makes a tank read
 * high or low with the same fuel in it (the Mufindi plant, 26 Sep: ~30 L per
 * 0.06 g). A level that is up at one stop and back down at the next was that
 * stop's slope, and the fuel is still gone.
 *
 * So a theft followed by a refuel is reported as one — "drained and topped up",
 * or "refuelled after the loss" — never retracted as the gauge. The price is
 * that a real gauge artefact which came back while the machine stood, on a unit
 * with no accelerometer, stays an open call rather than being withdrawn.
 *
 * Replayed over 19–25 Sep with the earlier follow-up (313 stage-1 flags): 46%
 * still gone after the start, 22% came back once working, 16% refuelled first,
 * 11% came back parked, 5% no start within a day. In 123 of the 144 "still gone"
 * the probe reported a new value within five minutes of the start, so "gone" is
 * a reading, not a stale one.
 */

import type { AccelAxes } from '../../providers/telemetry-provider.js'

export type ParkedFallVerdict =
  | 'PENDING' | 'CONFIRMED' | 'TOPPED_UP' | 'REFUELLED' | 'CLEARED' | 'UNRESOLVED'
  /** Stage 1 raised it but a gate the poll loop cannot run refused it — see `stageOneRefusal`. */
  | 'WITHHELD'

export type EngineEvidence = 'sensor' | 'counter'

/**
 * Stage 1's confirmation: the level must still be down this long after it
 * settled. Five minutes is the operator's choice (2026-09-26); replayed, 24 of
 * 442 parked falls came back inside it.
 */
export const STILL_DOWN_CONFIRM_MS = 5 * 60_000
/** Back within 30% of the drop — the same definition every replay used. */
export const RETURN_FRACTION = 0.7
/** Less than this much back at the start is "still gone". */
export const PARTLY_FRACTION = 0.3
/** How long stage 2 waits for the machine to start before calling it unresolved. */
export const NEXT_START_HORIZON_MS = 24 * 3_600_000
/** Faster than this is moving; slower is GPS drift on a parked machine. */
export const MOVE_KMH = 5
/**
 * How long after the start the follow-up keeps watching before it says the fuel
 * is still gone. The gauge usually recovers only once the machine has worked a
 * while — measured, 63 of the 70 falls that came back after a start did so later
 * than its first readings. The CALL does not wait for this; it went out at
 * confirmation.
 */
export const WORK_WINDOW_MS = 2 * 3_600_000
/** A rise this quick is a pour or a pump; slower, on a standing machine, is a creep. */
export const POUR_MAX_MS = 15 * 60_000
/**
 * The shortest stand a refuel or a pour fits in. A rise with no stand this long
 * inside it — and no silence this long, which could hide one — happened while
 * the machine moved or worked, when no fuel can go in.
 */
export const REFUEL_STAND_MS = 2 * 60_000
/** Readings closer than this are the same spot; GPS on a parked machine wanders less. */
export const SAME_SPOT_M = 50
/**
 * On a unit that reports no position, a silence longer than this may hide a
 * trip, so it ends a stand.
 */
export const STAND_GAP_MS = 20 * 60_000
/**
 * Two stands whose accelerometer readings sit closer than this are at the same
 * angle — about 1°. Measured on the Mufindi plant (26 Sep), the reading moves up
 * to ~30 L per 0.06 g, so a difference below this cannot explain a return.
 */
export const SAME_ATTITUDE_G = 0.02
/**
 * How far the machine's angle may change across a fall before the fall is put
 * down to the tilt. 0.03 g is under 2°; on the Mufindi plant (26 Sep) the fuel
 * reading moved about 30 L per 0.06 g, so a shift this size can make a fall on
 * its own. GPS cannot see it: a truck loaded or jacked where it stands has not
 * moved, and its tank still reads a different level with the same fuel in it.
 * The live watch withholds such a fall (lib/fuel-drop-watch); the standing-fall
 * call vetoes one (standing-theft).
 */
export const TILT_SHIFT_G = 0.03
/**
 * Spread of the accelerometer above which a standing machine is working in
 * place, not idling. Idling and parked units read 0.01–0.02 g; digging and
 * dozing 0.1–0.4 g (DZ 09, EX 04, 26 Sep).
 */
export const WORKING_VIB_G = 0.04
/**
 * A return the follow-up checks by the machine's NEXT stand must see that stand
 * begin within this — otherwise too much has been burned in between to tell
 * "still there" from "never was".
 */
export const NEXT_STAND_WITHIN_MS = 30 * 60_000
/** A return on the move with no stand soon after must hold this long, on the median. */
export const PERSIST_MS = 15 * 60_000
/** Running this long after the start with the fuel still gone, a later refuel does not undo it. */
export const CONFIRM_RUN_MS = 15 * 60_000
/**
 * How far our stored level can trail the tank. The adapter reads fuel on its
 * two-minute sweep and carries it onto the fixes between, so a rise lands in
 * our rows up to a sweep and a reading late: `MUFINDI - FT 13` was poured back
 * 13:00–13:03 while parked, and our rows show the rise finishing as it drove off
 * at 13:04. Every "could fuel have gone in" looks back this much further.
 */
export const FUEL_LAG_MS = 3 * 60_000
/**
 * A dip that is back within this of settling was the fuel settling in the tank,
 * never a pour — the operator's rule (2026-09-26). The watch's own confirmation
 * (`STILL_DOWN_CONFIRM_MS`, five minutes) already drops these before they are
 * raised; this keeps the follow-up from ever calling one a pour.
 */
export const SETTLE_MAX_MS = 3 * 60_000
/**
 * How far past the old level a rise must go to be a refuel rather than the lost
 * fuel coming back: this much, or half the drop, whichever is more. A pour of
 * what was taken returns to the old level; a refuel fills the tank past it.
 */
export const OVERSHOOT_MIN_ML = 5_000
export const OVERSHOOT_FRACTION = 0.5
/** After this, stage 2 decides on what it has rather than wait any longer. */
export const GIVE_UP_MS = NEXT_START_HORIZON_MS + WORK_WINDOW_MS + NEXT_STAND_WITHIN_MS

export interface FallReading {
  /** Capture time, epoch ms. */
  t:             number
  fuelMl:        number | null
  speedKmh:      number | null
  engineOn:      boolean
  ignitionKnown: boolean
  /** The unit's cumulative engine-hours counter, in hours. */
  meterH:        number | null
  /** Where it stood, to tell one stop from the next. Without it a stand ends only on movement or a long silence. */
  lat?:          number | null
  lng?:          number | null
  /** The tracker's accelerometer at this reading, in g — the machine's angle and whether it was working. */
  accel?:        AccelAxes | null
}

export interface PendingFall {
  settledAtMs:    number
  troughMl:       number
  droppedMl:      number
  engineEvidence: EngineEvidence
}

export interface NextStartJudgement {
  /** PENDING while there is not yet enough to say. */
  verdict:     ParkedFallVerdict
  reason:      string | null
  nextStartAt: number | null
  nextStartBy: 'engine' | 'moved' | null
  /** Level change across the start, where one was measured. */
  jumpMl:      number | null
  /** When the level came back, where it did. */
  backAt:      number | null
}

const median = (ns: readonly number[]): number => {
  const v = [...ns].sort((a, b) => a - b)
  const m = v.length >> 1
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2
}

/** Stage 1: is the level still down, going by the newest readings? */
export function stillDown(troughMl: number, droppedMl: number, latestMl: readonly number[]): boolean {
  if (latestMl.length === 0) return true
  return median(latestMl.slice(-3)) < troughMl + RETURN_FRACTION * droppedMl
}

/**
 * A trough at or near empty is the probe dropping out, not a thief — nobody
 * drains a tank to the last litre, and a probe that loses contact reads zero.
 * `MUFINDI: EX 07` went 281 L → 0 L parked on 24 Sep.
 */
export function probeReadsEmpty(troughMl: number, tankCapacityL: number | null): boolean {
  return troughMl <= Math.max(5_000, 0.03 * (tankCapacityL ?? 0) * 1000)
}

/**
 * Does this unit's engine-hours counter track its ENGINE?
 *
 * Only then can "the counter did not move" stand in for "the engine was off".
 * Measured 2026-09-26 over 48 h: on 189 of 267 units with no ignition line the
 * counter advances while the machine stands still — engine time, not movement —
 * and on units with both it agrees with the line within 20% three times in four.
 * The rest either never advance (47) or advance only with the wheels (21); both
 * would make every parked fall look engine-off.
 *
 * Steps larger than the elapsed time allows are ignored — 377 units show the
 * counter stepping backwards and forwards, which would otherwise read as running.
 */
export function counterTracksEngine(rows: readonly Pick<FallReading, 't' | 'speedKmh' | 'meterH'>[]): {
  trusted: boolean; advancedH: number; standingH: number
} {
  let advancedH = 0, standingH = 0
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!, b = rows[i]!
    if (a.meterH == null || b.meterH == null || b.meterH <= a.meterH) continue
    const d = b.meterH - a.meterH
    if (d > (b.t - a.t) / 3_600_000 + 0.2) continue
    advancedH += d
    if ((a.speedKmh ?? 0) <= 2 && (b.speedKmh ?? 0) <= 2) standingH += d
  }
  return { trusted: advancedH >= 0.25 && standingH >= 0.25 && standingH >= 0.1 * advancedH, advancedH, standingH }
}

/**
 * Was the probe frozen while the machine ran, just before this fall?
 *
 * `MUFINDI : MTR 18`, 26 Sep: its Bluetooth probe stopped updating from 04:56 to
 * 11:10 — level, probe temperature and probe battery all unchanged across 678
 * messages — while the tractor worked some 2.5 engine-hours. At 11:11, parked
 * with the engine off, the level caught up in one step, 46 L to 21 L, which
 * looks exactly like a siphon. A working engine burns fuel, so a level that
 * holds to the millilitre through FROZEN_RUN_MIN_H of running is a probe that
 * is not reading, and the fall after it is the catch-up.
 *
 * `rows` ascending, ending at the fall's start.
 */
export const FROZEN_RUN_MIN_H = 1
export function probeFrozeWhileRunning(
  rows: readonly Pick<FallReading, 't' | 'fuelMl' | 'speedKmh' | 'engineOn' | 'ignitionKnown' | 'meterH'>[],
): { frozen: boolean; heldMl: number | null; ranH: number } {
  let best = { frozen: false, heldMl: null as number | null, ranH: 0 }
  let i = 0
  while (i < rows.length) {
    if (rows[i]!.fuelMl == null) { i++; continue }
    let j = i
    while (j + 1 < rows.length && (rows[j + 1]!.fuelMl == null || rows[j + 1]!.fuelMl === rows[i]!.fuelMl)) j++
    // Engine time inside the run: the line where it reports, and movement.
    let ranMs = 0
    for (let k = i; k < j; k++) {
      const r = rows[k]!, n = rows[k + 1]!
      if ((r.ignitionKnown && r.engineOn) || (r.speedKmh ?? 0) > MOVE_KMH) ranMs += n.t - r.t
    }
    // And the counter, capped at the run's own length so a stepping counter cannot inflate it.
    const meters = rows.slice(i, j + 1).filter(r => r.meterH != null).map(r => r.meterH!)
    const meterH = meters.length >= 2 ? Math.max(0, meters[meters.length - 1]! - meters[0]!) : 0
    const ranH = Math.max(ranMs / 3_600_000, Math.min(meterH, (rows[j]!.t - rows[i]!.t) / 3_600_000))
    if (ranH > best.ranH) best = { frozen: ranH >= FROZEN_RUN_MIN_H, heldMl: rows[i]!.fuelMl, ranH }
    i = j + 1
  }
  return best
}

/** A stretch where the machine stood at one spot, engine on or off. */
export interface Stand {
  from:  number
  to:    number
  /** The next reading after the stand — the latest it was known to be there. */
  until: number
  rows:  FallReading[]
}

const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }): number => {
  const k = Math.PI / 180
  const h = Math.sin((b.lat - a.lat) * k / 2) ** 2
    + Math.cos(a.lat * k) * Math.cos(b.lat * k) * Math.sin((b.lng - a.lng) * k / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h))
}

/**
 * The machine's stands: runs of readings that did not move, at one spot. A
 * reading faster than MOVE_KMH ends one; so does a position more than
 * SAME_SPOT_M from where it began, or — on a unit that reports no position — a
 * silence longer than STAND_GAP_MS, which could hide a trip.
 */
export function standsOf(readings: readonly FallReading[]): Stand[] {
  const out: Stand[] = []
  let cur: Stand | null = null
  let at: { lat: number; lng: number } | null = null
  const close = (next: number) => { if (cur) { cur.until = next; out.push(cur) } }
  for (const r of readings) {
    if ((r.speedKmh ?? 0) > MOVE_KMH) { close(r.t); cur = null; at = null; continue }
    const pos = r.lat != null && r.lng != null ? { lat: r.lat, lng: r.lng } : null
    const moved = cur != null && at != null && pos != null && metres(at, pos) > SAME_SPOT_M
    const silent = cur != null && r.t - cur.to > STAND_GAP_MS && (at == null || pos == null)
    if (cur == null || moved || silent) {
      close(r.t)
      cur = { from: r.t, to: r.t, until: r.t, rows: [r] }
      at = pos
      continue
    }
    cur.to = r.t
    cur.rows.push(r)
    at ??= pos
  }
  if (cur) { cur.until = cur.to; out.push(cur) }
  return out
}

type Vec = [number, number, number]
type FullAccel = FallReading & { accel: { x: number; y: number; z: number } }
const full = (r: FallReading): r is FullAccel => r.accel?.x != null && r.accel?.y != null && r.accel?.z != null

/** The machine's angle over some readings: the median of each axis, or null without two full readings. */
export function attitudeOf(rows: readonly FallReading[]): Vec | null {
  const v = rows.filter(full)
  if (v.length < 2) return null
  return [median(v.map(r => r.accel.x)), median(v.map(r => r.accel.y)), median(v.map(r => r.accel.z))]
}

const apart = (a: Vec, b: Vec): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/** Spread of the accelerometer about its median — vibration, which is work. Null without three full readings. */
export function vibrationOf(rows: readonly FallReading[]): number | null {
  const v = rows.filter(full)
  if (v.length < 3) return null
  const m = attitudeOf(v)!
  return Math.sqrt(v.reduce((s, r) => s + (r.accel.x - m[0]) ** 2 + (r.accel.y - m[1]) ** 2 + (r.accel.z - m[2]) ** 2, 0) / v.length)
}

/**
 * The follow-up. `readings` ascending, from a little before the fall settled to
 * now; `fillingsAt` the times of recorded fillings around it; `nowMs` the clock,
 * so the same call answers PENDING until the evidence it needs exists.
 *
 * Every return of the level is judged by where the machine was while it rose —
 * see the module note. Nothing here waits on the fillings ledger: a filling
 * already on it is used, and none is ever needed to retract.
 */
export function judgeNextStart(
  fall: PendingFall,
  readings: readonly FallReading[],
  fillingsAt: readonly number[],
  nowMs: number,
): NextStartJudgement {
  const S = fall.settledAtMs
  const T = fall.troughMl
  const D = fall.droppedMl
  const target = T + RETURN_FRACTION * D
  const lowMark = T + PARTLY_FRACTION * D
  // A pour of what was taken returns to the old level; a refuel fills past it.
  const refuelAbove = T + D + Math.max(OVERSHOOT_MIN_ML, OVERSHOOT_FRACTION * D)
  const out = (verdict: ParkedFallVerdict, reason: string | null, extra: Partial<NextStartJudgement> = {}): NextStartJudgement => ({
    verdict, reason, nextStartAt: null, nextStartBy: null, jumpMl: null, backAt: null, ...extra,
  })
  const givingUp = nowMs >= S + GIVE_UP_MS
  const fuel = readings.filter(r => r.fuelMl != null)
  const filledBetween = (a: number, b: number) => fillingsAt.some(f => f >= a && f <= b)
  /**
   * The highest settled level over [a, b] — a median of three, so one spike
   * cannot make a refuel — read only while the machine stood: fuel goes in
   * standing, and slosh on the road can carry a median well past the old level.
   */
  const peakBetween = (a: number, b: number): number => {
    const w = fuel.filter(r => r.t >= a && r.t <= b && (r.speedKmh ?? 0) <= MOVE_KMH)
    let best = -Infinity
    for (let i = 2; i < w.length; i++) best = Math.max(best, median([w[i - 2]!, w[i - 1]!, w[i]!].map(r => r.fuelMl!)))
    return best
  }

  // ── when did it next start or move? ──
  const meterAtS = [...readings].reverse().find(r => r.t <= S && r.meterH != null)?.meterH
    ?? readings.find(r => r.meterH != null)?.meterH ?? null
  let active: number | null = null
  let startT: number | null = null
  let by: 'engine' | 'moved' | null = null
  for (const r of readings) {
    if (r.t <= S || r.t > S + NEXT_START_HORIZON_MS) continue
    if ((r.speedKmh ?? 0) > MOVE_KMH) { active = r.t; startT = r.t; by = 'moved'; break }
    const running = fall.engineEvidence === 'sensor'
      ? r.ignitionKnown && r.engineOn
      : meterAtS != null && r.meterH != null && r.meterH - meterAtS > 0.005
    if (running) {
      active = r.t
      // The counter only ticks every few minutes: back-date the start by what it advanced.
      startT = fall.engineEvidence === 'sensor' ? r.t : Math.max(S, r.t - (r.meterH! - meterAtS!) * 3_600_000)
      by = 'engine'
      break
    }
  }
  const startInfo = { nextStartAt: active, nextStartBy: by }

  // ── where it stood ──
  const stands = standsOf(readings)
  const standAt = (t: number): Stand | null => stands.find(s => s.from <= t && (t < s.until || t === s.to)) ?? null
  const parking = standAt(S)
  const settledRows = (s: Stand) => s.rows.filter(r => r.fuelMl != null && r.t >= s.from + SETTLE_MAX_MS)
  /** Did the engine run over [a, b]? The line where it reports; else the counter, which ticks late. */
  const ranBetween = (a: number, b: number): boolean => {
    if (fall.engineEvidence === 'sensor') return readings.some(r => r.t >= a && r.t <= b && r.ignitionKnown && r.engineOn)
    const m = readings.filter(r => r.t >= a - 10 * 60_000 && r.t <= b + 10 * 60_000 && r.meterH != null).map(r => r.meterH!)
    return m.length >= 2 && Math.max(...m) - Math.min(...m) > 0.005
  }
  /** Engine or wheel time over [a, b]: the line where it reports, else the counter; movement either way. */
  const runMsBetween = (a: number, b: number): number => {
    let ms = 0
    for (let i = 1; i < readings.length; i++) {
      const p = readings[i - 1]!, r = readings[i]!
      if (p.t < a || p.t >= b) continue
      const lineOn = fall.engineEvidence === 'sensor' && p.ignitionKnown && p.engineOn
      if (lineOn || (p.speedKmh ?? 0) > MOVE_KMH) ms += Math.min(r.t, b) - p.t
    }
    if (fall.engineEvidence === 'counter') {
      const m = readings.filter(r => r.t >= a && r.t <= b && r.meterH != null).map(r => r.meterH!)
      if (m.length >= 2) ms = Math.max(ms, Math.min((Math.max(...m) - Math.min(...m)) * 3_600_000, b - a))
    }
    return ms
  }
  /** Could fuel have gone in over [a, b]? Only on a stand of REFUEL_STAND_MS, or in a silence that long. */
  const refuelPossible = (a: number, b: number): boolean => {
    if (stands.some(s => Math.min(s.until, b) - Math.max(s.from, a) >= REFUEL_STAND_MS)) return true
    for (let i = 1; i < readings.length; i++) {
      const p = readings[i - 1]!, r = readings[i]!
      if (r.t > a && p.t < b && r.t - p.t >= REFUEL_STAND_MS) return true
    }
    return false
  }

  /** The first rise back to `target` after `from`: where it was last near the trough, and where it got back. */
  const findReturn = (from: number): { riseStart: number; riseEnd: number } | null => {
    const w = fuel.filter(r => r.t > from)
    for (let i = 2; i < w.length; i++) {
      const trio = [w[i - 2]!, w[i - 1]!, w[i]!]
      if (median(trio.map(r => r.fuelMl!)) < target) continue
      const riseEnd = trio.find(r => r.fuelMl! >= target)!.t
      let riseStart = S
      for (const r of fuel) { if (r.t >= riseEnd) break; if (r.t >= S && r.fuelMl! <= lowMark) riseStart = r.t }
      return { riseStart, riseEnd }
    }
    return null
  }

  // ── every return of the level, judged by where the machine was while it rose ──
  //
  // A level read at one spot can mislead either way — a slope makes a tank read
  // high or low with the same fuel in it — so no single stand decides. A return
  // counts once it is seen at the same angle as where the fuel fell (the
  // accelerometer), or at two different places. Then it is fuel going in if the
  // machine stood anywhere a refuel fits while the level rose, and the fall was
  // the reading if it rose on the move.
  const pAttitude = attitudeOf(parking?.rows ?? [])
  const standLevel = (s: Stand): { t: number; level: number } | null => {
    const rows = settledRows(s).slice(0, 3)
    return rows.length === 3 ? { t: rows[2]!.t, level: median(rows.map(r => r.fuelMl!)) } : null
  }
  const sameAngleAsParked = (s: Stand): boolean => {
    const at = attitudeOf(s.rows)
    return pAttitude != null && at != null && apart(pAttitude, at) < SAME_ATTITUDE_G
  }
  let from = S
  for (let guard = 0; guard < 100; guard++) {
    const ret = findReturn(from)
    if (!ret) break
    const { riseStart, riseEnd } = ret
    const extra = { ...startInfo, backAt: riseEnd }

    if (riseEnd - S <= SETTLE_MAX_MS) {
      return out('CLEARED', 'came back within three minutes — the fuel settling', extra)
    }
    // Let the rise finish before sizing it: a pump runs a minute or two.
    if (nowMs < riseEnd + SETTLE_MAX_MS && !givingUp) {
      return out('PENDING', 'the level is coming back; waiting for the rise to finish', startInfo)
    }
    const peak = peakBetween(riseStart, riseEnd + POUR_MAX_MS)
    // Ran a while with the fuel still gone: the loss stood, whatever came after.
    const ranFirst = active != null && runMsBetween(active, riseStart) >= CONFIRM_RUN_MS
    const fuelIn = (how: string): NextStartJudgement => {
      if (ranFirst) return out('CONFIRMED', `stayed down while the machine ran, until fuel went in ${how}`, extra)
      return peak >= refuelAbove
        ? out('REFUELLED', `rose past the old level ${how}; the loss before the refuel is unexplained`, extra)
        : out('TOPPED_UP', `came back to the old level ${how}`, extra)
    }
    const a = standAt(riseStart), b = standAt(riseEnd)

    // A filling on the ledger at a moment the machine stood, or a rise well past
    // the old level — more than any slope or suspension moves a reading — is
    // fuel going in, whatever the engine or the angle was doing.
    const fillWhileStood = fillingsAt.find(f => f >= riseStart - FUEL_LAG_MS - 10 * 60_000 && f <= riseEnd + 10 * 60_000 && standAt(f) != null)
    if (fillWhileStood != null) return fuelIn('while the machine stood, recorded by the provider as a filling')
    if (peak >= refuelAbove && refuelPossible(riseStart - FUEL_LAG_MS, riseEnd)) return fuelIn('while the machine stood')

    // (1) It rose at one spot while the machine stood there, the spot long
    // settled: the angle did not change, so the tank did.
    if (a != null && a === b && (a === parking || riseStart >= a.from + SETTLE_MAX_MS)) {
      const before = attitudeOf(a.rows.filter(r => r.t <= riseStart))
      const after = attitudeOf(a.rows.filter(r => r.t >= riseEnd))
      const tilted = before != null && after != null && apart(before, after) >= SAME_ATTITUDE_G
      if (!tilted) {
        if (!ranBetween(riseStart, riseEnd)) {
          if (riseEnd - riseStart > POUR_MAX_MS) {
            return out('UNRESOLVED', 'crept back slowly while the machine stood — too slow for a pour or a pump, so likely the probe or the temperature', extra)
          }
          return fuelIn('while the machine stood with the engine off')
        }
        const vib = vibrationOf(a.rows.filter(r => r.t >= riseStart - REFUEL_STAND_MS && r.t <= riseEnd + REFUEL_STAND_MS))
        if (vib == null) {
          return out('UNRESOLVED', 'came back while the machine stood with its engine running, and this unit has no accelerometer to tell idling at a pump from working in place or a suspension rising', extra)
        }
        if (vib < WORKING_VIB_G) return fuelIn('while the machine stood with the engine idling')
      }
      // Its angle changed where it stood (a suspension rising, a boom coming up),
      // or it was working in place: the reading moved with the machine, and the
      // fuel cannot be read from it. Nothing retracted.
      return out('UNRESOLVED', tilted
        ? 'came back as the angle of the machine changed where it stood — a suspension rising or a boom coming up — so the fuel cannot be read at that angle'
        : 'came back while the machine worked in place, when the reading swings with the work', extra)
    }

    // (2) The rise spanned movement. Confirm the level is really back.
    const refuel = refuelPossible(riseStart - FUEL_LAG_MS, riseEnd)
    const later = stands.filter(s => s !== parking && s.until > riseEnd && standLevel(s) != null && standLevel(s)!.t > riseEnd)
    const first = later[0]
    if (first == null || first.from - riseEnd > NEXT_STAND_WITHIN_MS) {
      if (!givingUp && (first == null ? nowMs < riseEnd + NEXT_STAND_WITHIN_MS + 2 * SETTLE_MAX_MS : false)) {
        return out('PENDING', 'came back on the move; waiting for the machine to stand and settle', startInfo)
      }
      return out('UNRESOLVED', 'came back as the machine moved, and it did not stand anywhere soon after to confirm it', extra)
    }
    const l1 = standLevel(first)!
    if (l1.level < target) {
      // Not back once it stood: slosh on the road, or a slope. Look further on.
      from = l1.t
      continue
    }
    let confirmed = sameAngleAsParked(first)
    let checkedTo = l1.t
    if (!confirmed) {
      // One spot can read high on its slope. A second place settles it.
      const second = later.find(s => s.from >= first.until && standLevel(s) != null)
      if (second == null || second.from - first.until > NEXT_STAND_WITHIN_MS) {
        if (!givingUp && second == null && nowMs < first.until + NEXT_STAND_WITHIN_MS + 2 * SETTLE_MAX_MS) {
          return out('PENDING', 'came back at one stop; waiting to see it at a second place', startInfo)
        }
        return out('UNRESOLVED', 'came back at one stop, and the machine did not stand anywhere else soon after to confirm it', extra)
      }
      const l2 = standLevel(second)!
      checkedTo = l2.t
      if (l2.level <= lowMark) {
        // High at one spot only: that spot's angle. The fuel is still gone.
        from = l2.t
        continue
      }
      if (l2.level < target) return out('UNRESOLVED', 'came back at one stop, then partly fell again at the next', extra)
      confirmed = true
    }
    if (refuel || filledBetween(S - 10 * 60_000, checkedTo)) {
      return fuelIn('after the machine had stood where a refuel fits, and stayed up at the next places it stood')
    }
    return out('CLEARED', 'came back while the machine was moving, when no fuel can go in, and read back up where it next stood — so the fall was the reading', extra)
  }

  // ── a filling on the ledger while it stood, which the readings did not show ──
  const until = startT ?? Math.min(nowMs, S + NEXT_START_HORIZON_MS)
  const filling = fillingsAt.filter(f => f >= S - 10 * 60_000 && f <= until + 10 * 60_000).at(-1)
  if (filling != null) {
    if (nowMs < filling + POUR_MAX_MS && !givingUp) return out('PENDING', 'a filling was recorded; waiting for the level', startInfo)
    const peak = peakBetween(filling - 5 * 60_000, filling + POUR_MAX_MS)
    if (peak >= refuelAbove) return out('REFUELLED', 'was refuelled before the machine next started; the loss before the refuel is unexplained', startInfo)
    if (peak >= target) return out('TOPPED_UP', 'came back to the old level while the machine stood, recorded by the provider as a filling', { ...startInfo, backAt: filling })
    return out('REFUELLED', 'had a filling recorded before the machine next started', startInfo)
  }

  if (active == null) {
    return nowMs >= S + NEXT_START_HORIZON_MS
      ? out('UNRESOLVED', 'is still down, and the machine did not start within a day')
      : out('PENDING', 'waiting for the machine to start')
  }
  if (nowMs < active + WORK_WINDOW_MS && !givingUp) {
    return out('PENDING', 'watching the first two hours after it started', startInfo)
  }
  return out('CONFIRMED', 'had not come back as fuel two hours after the machine started', startInfo)
}
