/**
 * Fuel that left a vehicle while it STOOD, found inside a drain the classifier
 * judged as something else. Pure.
 *
 * ## Why
 *
 * KDE 585S at the Kabras factory pump, 27 Sep 2026: refuelled to 105.7 L, and
 * at 06:50:22 it read 79.3 L — 26.4 L gone in under three minutes, standing,
 * engine off. Wialon's drain ran on to 07:04 and took in 3.2 km of driving, so
 * the classifier judged all of it per kilometre, and it went out as a FUEL DOWN
 * warning; the part that happened standing was never looked at on its own. It
 * was the fourth time in a month on that truck, each within minutes of a refuel
 * (31 Aug, 10 Sep, 18 Sep), and the first three were never announced at all.
 *
 * ## The two rules (operator, 2026-09-27)
 *
 *   fell-while-standing   a FUEL RATE or FUEL DOWN finding that fell 10 L or
 *                         more inside one stand with nothing there to burn it.
 *                         7 in the 30 days to 27 Sep, of 598 such findings.
 *   fell-after-refuel     any drain that stayed down, whatever the classifier
 *                         made of it — except SLOSH, a fall it already judged
 *                         faster than any pump draws — that fell 10 L or more
 *                         (and 1.5% of the tank) standing within 30 minutes of
 *                         a refuel. KDE 585S five times in the 30 days to 27
 *                         Sep: 17, 18, 20 (twice) and 27 Sep.
 *
 * Either makes the drain a SIPHON — possible theft, critical, posted as it is
 * judged, and kept out of the daily summary — under its own reason. Everything
 * else keeps its cause, and a FUEL RATE or FUEL DOWN stays in the summary.
 *
 * ## Nothing there to burn it
 *
 *   engine off     the ignition line measured, and off through the fall.
 *   idling still   the engine running, and the accelerometer showing a machine
 *                  that only idled — its spread under WORKING_VIB_G — and kept
 *                  its angle, within TILT_SHIFT_G. An idling engine burns a few
 *                  litres an hour and cannot explain 10 L in minutes, and a tank
 *                  that did not tilt did not move its fuel to one end
 *                  (operator: "a drain might happen when the vehicle's engine is
 *                  on").
 *
 * Anything else — no ignition line and no accelerometer, or a machine working
 * in place — cannot be told from a machine burning its fuel, and no call is
 * made. The accelerometer can also VETO an engine-off call: a machine whose
 * angle changed where it stood (a jack, a load, a suspension settling) reads a
 * different level with the same fuel in it, which is why the live watch
 * withholds such a fall too.
 *
 * "Stood" is the parked-fall rule's own stand (`standsOf`): not faster than
 * MOVE_KMH, and within SAME_SPOT_M of where it stopped — speed and position
 * both, since GPS speed alone reads a creeping truck as parked.
 */

import {
  standsOf, attitudeOf, vibrationOf, stillDown, probeReadsEmpty,
  MOVE_KMH, TILT_SHIFT_G, WORKING_VIB_G, type FallReading,
} from './parked-fall.js'

/** The smallest standing fall either rule calls — the size both were measured at. */
export const STANDING_FALL_MIN_ML = 10_000
/**
 * ...and on a big tank, this share of it. A probe reads a 1,200 L tank on the
 * same scale as a 300 L one, so 12 L after a refuel is ~1% of its range —
 * the settling of the pour. Replayed over the 30 days to 27 Sep, the calls a
 * flat 10 L let through on the >1,000 L Mufindi tractors (CTR 10, 19, 23:
 * 12–17 L after a refuel, again and again) were that. KDE 585S's 600 L tank
 * keeps a 10 L floor.
 */
export const STANDING_FALL_MIN_FRACTION = 0.015
/** A refuel counts when the level topped out at most this long before the fall began. */
export const REFUEL_WITHIN_MS = 30 * 60_000
/**
 * A standing rise this size is a refuel — provided the tank still holds this
 * much more after the fall than it did before the refuel. A probe that jumps up
 * and straight back down (KDE 868R reads 0 → 158 L → 0 several times a day) put
 * nothing in, and its "fall" is the jump undoing itself.
 */
export const REFUEL_MIN_RISE_ML = 10_000
/** How far outside the drain's own stretch a standing fall may lie and still be that drain's. */
export const SPAN_MARGIN_MS = 5 * 60_000
/** Share of the readings through the fall that must carry a MEASURED ignition state... */
export const IGNITION_KNOWN_SHARE = 0.8
/** ...and share of those that must read off. */
export const ENGINE_OFF_SHARE = 0.9
/** Level moves smaller than this are the probe's own noise, when placing the fall's two ends. */
const NOISE_ML = 1_500
/** The accelerometer's spread is read over the fall and this much either side of it. */
const VIB_MARGIN_MS = 2 * 60_000

export type StandingTheftRule = 'fell-after-refuel' | 'fell-while-standing'
export const STANDING_THEFT_REASONS: readonly StandingTheftRule[] = ['fell-after-refuel', 'fell-while-standing']

export interface StandingTheft {
  rule:       StandingTheftRule
  engine:     'off' | 'idling-still'
  /** The last reading still at the level before the fall, and the first already at the level after it. */
  fromT:      number
  toT:        number
  beforeMl:   number
  afterMl:    number
  fallMl:     number
  /** The refuel it followed: the level it rose from and to, and when it topped out. */
  refuel:     { fromMl: number; toMl: number; atT: number } | null
  /** How far the machine's angle moved across the fall, where the unit has an accelerometer. */
  tiltShiftG: number | null
  /** The accelerometer's spread around the fall — idling or working. */
  vibrationG: number | null
  confidence: number
}

export interface StandingTheftInput {
  /** The drain's own stretch on the ledger: when it began, and when its fall ended. */
  spanFrom:       number
  spanTo:         number
  /** Is the drain a FUEL RATE or FUEL DOWN finding? Only those are called without a refuel. */
  fuelRateOrDown: boolean
  tankCapacityL:  number | null
}

const median = (ns: readonly number[]): number => {
  const v = [...ns].sort((a, b) => a - b)
  const m = v.length >> 1
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2
}

/** Each level as the median of it and its two neighbours, so one stray reading moves nothing. */
const smooth = (mls: readonly number[]): number[] => mls.map((_, k) => median(mls.slice(Math.max(0, k - 1), k + 2)))

interface StandFall { fromT: number; toT: number; beforeMl: number; afterMl: number; fallMl: number }

/** The biggest fall inside one stand that stayed down to the stand's end. */
function biggestFall(rows: readonly FallReading[]): StandFall | null {
  const f = rows.filter(r => r.fuelMl != null)
  if (f.length < 3) return null
  const m = smooth(f.map(r => r.fuelMl!))
  let best: { i: number; j: number; size: number } | null = null
  let top = 0
  for (let j = 1; j < m.length; j++) {
    if (m[j - 1]! >= m[top]!) top = j - 1
    const size = m[top]! - m[j]!
    if (size > 0 && (!best || size > best.size)) best = { i: top, j, size }
  }
  if (!best) return null
  // Not back within 30% of the fall by the end of the stand — the parked rule's own test.
  if (!stillDown(m[best.j]!, best.size, f.slice(-3).map(r => r.fuelMl!))) return null
  // Its two ends: the last reading still at the top, the first already at the bottom.
  let i = best.i
  while (i + 1 < best.j && m[i + 1]! >= m[best.i]! - NOISE_ML) i++
  let j = best.j
  for (let k = i + 1; k <= best.j; k++) if (m[k]! <= m[best.j]! + NOISE_ML) { j = k; break }
  return { fromT: f[i]!.t, toT: f[j]!.t, beforeMl: m[best.i]!, afterMl: m[best.j]!, fallMl: best.size }
}

/** Was the engine MEASURED off through these readings? */
function engineOff(rows: readonly FallReading[]): boolean {
  const known = rows.filter(r => r.ignitionKnown)
  return known.length >= 2
    && known.length >= IGNITION_KNOWN_SHARE * rows.length
    && known.filter(r => !r.engineOn).length >= ENGINE_OFF_SHARE * known.length
}

/**
 * The refuel a fall at `beforeT` followed, if any: the biggest rise of the
 * level over the half hour before it, read only while the vehicle stood —
 * fuel goes in standing — and only if it left real fuel behind.
 */
function refuelBefore(readings: readonly FallReading[], beforeT: number, afterMl: number): StandingTheft['refuel'] {
  const w = readings.filter(r => r.fuelMl != null && r.t >= beforeT - REFUEL_WITHIN_MS && r.t <= beforeT
    && (r.speedKmh ?? 0) <= MOVE_KMH)
  if (w.length < 3) return null
  const m = smooth(w.map(r => r.fuelMl!))
  let best: { low: number; j: number; rise: number } | null = null
  let low = 0
  for (let j = 1; j < m.length; j++) {
    if (m[j - 1]! <= m[low]!) low = j - 1
    const rise = m[j]! - m[low]!
    if (rise > 0 && (!best || rise > best.rise)) best = { low, j, rise }
  }
  if (!best || best.rise < REFUEL_MIN_RISE_ML) return null
  if (afterMl - m[best.low]! < REFUEL_MIN_RISE_ML) return null
  let at = best.j
  for (let k = best.low + 1; k <= best.j; k++) if (m[k]! >= m[best.j]! - NOISE_ML) { at = k; break }
  return { fromMl: m[best.low]!, toMl: m[best.j]!, atT: w[at]!.t }
}

/**
 * The standing-fall call for one drain, or null. `readings` ascending: the
 * drain's evidence window, which reaches half an hour before it began.
 */
export function standingTheft(readings: readonly FallReading[], input: StandingTheftInput): StandingTheft | null {
  let best: StandingTheft | null = null
  const near = (from: number, to: number) => to >= input.spanFrom - SPAN_MARGIN_MS && from <= input.spanTo + SPAN_MARGIN_MS
  const floorMl = Math.max(STANDING_FALL_MIN_ML, STANDING_FALL_MIN_FRACTION * (input.tankCapacityL ?? 0) * 1000)

  for (const stand of standsOf(readings)) {
    if (!near(stand.from, stand.to)) continue
    const fall = biggestFall(stand.rows)
    // It must be THIS drain's fall — the window reads three hours past it.
    if (fall == null || fall.fallMl < floorMl || !near(fall.fromT, fall.toT)) continue
    // A trough at empty is the probe losing contact.
    if (probeReadsEmpty(fall.afterMl, input.tankCapacityL)) continue

    const before = attitudeOf(stand.rows.filter(r => r.t <= fall.fromT))
    const after = attitudeOf(stand.rows.filter(r => r.t >= fall.toT))
    const tilt = before && after ? Math.hypot(before[0] - after[0], before[1] - after[1], before[2] - after[2]) : null
    // The angle changed where it stood: the reading moved with the machine.
    if (tilt != null && tilt >= TILT_SHIFT_G) continue
    const vib = vibrationOf(stand.rows.filter(r => r.t >= fall.fromT - VIB_MARGIN_MS && r.t <= fall.toT + VIB_MARGIN_MS))
    const engine = engineOff(stand.rows.filter(r => r.t >= fall.fromT && r.t <= fall.toT)) ? 'off'
      // Running, but only idling and holding its angle — both measured.
      : vib != null && vib < WORKING_VIB_G && tilt != null ? 'idling-still'
      : null
    if (engine == null) continue

    const refuel = refuelBefore(readings, fall.fromT, fall.afterMl)
    const rule: StandingTheftRule | null = refuel ? 'fell-after-refuel' : input.fuelRateOrDown ? 'fell-while-standing' : null
    if (rule == null) continue

    const call: StandingTheft = {
      rule, engine, ...fall, refuel, tiltShiftG: tilt, vibrationG: vib,
      confidence: Math.min(0.9, 0.6 + (engine === 'off' ? 0.15 : 0.05) + (refuel ? 0.1 : 0) + (tilt != null ? 0.05 : 0)),
    }
    if (best == null || call.fallMl > best.fallMl) best = call
  }
  return best
}

const HHMM = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Nairobi' })
const L = (ml: number): string => {
  const l = Math.round(ml / 100) / 10
  return `${Number.isInteger(l) ? l : l.toFixed(1)} L`
}

/**
 * The headline, stating the levels and the times so it can be checked against
 * the gauge, the place and the pump records. `where` is " at <place>" or "".
 */
export function standingTheftText(plate: string, s: StandingTheft, where: string): string {
  const how = s.engine === 'off'
    ? 'with its engine off'
    : 'with its engine idling, its accelerometer showing it still and level'
  const when = `between ${HHMM.format(s.fromT)} and ${HHMM.format(s.toT)}`
  return s.refuel
    ? `POSSIBLE THEFT: ${plate} was refuelled to ${L(s.refuel.toMl)}, then its tank fell to ${L(s.afterMl)} ${when} while it stood ${how}${where}`
    : `POSSIBLE THEFT: ${plate}'s tank fell from ${L(s.beforeMl)} to ${L(s.afterMl)} ${when} while it stood ${how}${where}`
}
