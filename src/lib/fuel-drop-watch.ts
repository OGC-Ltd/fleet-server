/**
 * A fuel drop, seen as it happens rather than reported hours later.
 *
 * ## Why this exists beside the adjudicator
 *
 * `modules/fuel/fuel-adjudication` is the authority on whether fuel left a
 * tank, and it is deliberately slow: it waits `SETTLE_MINUTES` for the level to
 * come back, and it cannot start until Wialon's own fuel report has matured and
 * the quarter-hourly sync has written a `fuel_thefts` row. Measured over the
 * live ledger, mean time from event to verdict is **8.9 hours**.
 *
 * None of that delay is ours to remove by tuning. The settle window is the
 * smallest term in it; the provider's report is the largest.
 *
 * But we already hold the level ourselves. The poller writes a fix every ~30 s
 * per unit, so the drop is visible to THIS process the moment it happens — no
 * provider report, no sync cycle, no ledger row. That is what this module
 * watches.
 *
 * ## It is provisional, and says so
 *
 * This raises a WARNING that names what it saw and states it is unconfirmed.
 * It is not, and must not become, a theft accusation: three of the six gates
 * the adjudicator applies are simply not available in a poll loop.
 *
 *   · the probe's 30-day parked-swing profile — a database question
 *   · whether a filling explains the fall — a ledger question
 *   · whether the level comes back — a question about the future
 *
 * So the division is: this says "a tank just dropped and nobody is near it",
 * the adjudicator says "and here is what it was". The second still runs, still
 * decides, and still owns the word theft.
 *
 * ## What it refuses to raise on
 *
 * The one rule that makes a fast signal safe is the operator's own: fuel does
 * not reposition itself inside a tank that is sitting still. Redistribution
 * needs a disturbance — the machine tilting, moving, or stopping. So this
 * demands the ENTIRE window be stationary with the engine state MEASURED, and
 * abandons the moment anything moves. A fall on a machine that is working is
 * left to the adjudicator, which has the burn bands to judge it against.
 *
 * The engine may have run BRIEFLY (MAX_ENGINE_ON_MS) on a machine that never
 * moved. MUFINDI: CTR 12 on 2026-09-25: the engine was started for about two
 * minutes at 15:08 EAT, then the tank fell 6 L over twenty minutes with it off.
 * Idling burns a fraction of a litre in that time, so it cannot explain the
 * fall — but an engine-off-throughout rule was blind to it until 15:24.
 *
 * Where a unit has no ignition line, its engine-hours counter stands in: the
 * same gates, with the engine's running time read as how far the counter moved.
 * The counter ticks every few minutes, so it cannot time a start to the second —
 * but "it did not move in forty minutes" is exactly the evidence a parked fall
 * needs. Whether a given unit's counter tracks its ENGINE (and not its wheels,
 * or nothing) is a database question, so `fuel-watch.worker` asks it before
 * anything is published. Where a unit has both, they must not contradict: a
 * counter that ran for well over the allowance while the line read off means
 * the line is wrong, and the fall is refused.
 *
 * Without either, it stays silent, which is correct: "we do not know if the
 * engine was off" is not "the engine was off".
 *
 * ## The theft call, made within minutes
 *
 * This is where the parked-fall rule (`modules/fuel/parked-fall`) decides. A
 * fall that clears every gate is HELD, and raised only if the level is still
 * down `STILL_DOWN_CONFIRM_MS` after it settled; one that comes straight back is
 * the fuel settling and is dropped unseen. What is raised goes out as possible
 * theft at once — the operator's requirement is a verdict within ten minutes.
 * `lib/queues/parked-falls` then follows each one: it escalates a fall that is
 * poured back, and retracts one whose level returns when the machine works.
 *
 * ## Nothing here touches the database
 *
 * Same contract as `speeding-episodes`: per frame this is one Map lookup and a
 * short scan of a bounded ring. The publish is handed to a worker over the
 * event bus, never awaited in a frame's turn.
 */

import { env } from '../config/env.js'
import type { AccelAxes, VehicleTelemetryFrame } from '../providers/telemetry-provider.js'
import { stillDown, STILL_DOWN_CONFIRM_MS, type EngineEvidence } from '../modules/fuel/parked-fall.js'

export interface DropWatchContext {
  orgId:     string
  vehicleId: string
  plate:     string | null
  /** Carried through for the worker's empty-probe gate; the watch does not read it. */
  tankCapacityMl?: number | null
}

/** Published on the bus when a drop clears every gate below. */
export interface LiveFuelDrop {
  orgId:      string
  vehicleId:  string
  plate:      string | null
  /** The settled level before the fall. */
  baselineMl: number
  /** Where it settled after. */
  troughMl:   number
  droppedMl:  number
  /** First reading at the new low — when the fall finished, not when it began. */
  settledAt:  Date
  /** The last reading still at the old level — when the fall began. */
  fallStartedAt: Date
  /** How long the machine had stood still when the fall began — at least STILL_MIN_MS. */
  stillBeforeFallMs: number
  /** How long the machine had been standing still by the reading that found the fall. */
  stillForMs: number
  /** How long the engine ran inside that time — zero on most. */
  engineOnMs: number
  /** Which instrument said the engine was off. */
  engineEvidence: EngineEvidence
  /** How far the engine-hours counter moved across the window, where it reported. */
  meterAdvanceH:  number | null
  /**
   * How much the machine's angle changed across the fall, in g, where the
   * tracker has an accelerometer — below TILT_SHIFT_G by construction. Null on
   * units that send no axes.
   */
  attitudeShiftG: number | null
  /** The reading that found the level still down `STILL_DOWN_CONFIRM_MS` on. */
  confirmedAt:    Date
  tankCapacityMl: number | null
}

/**
 * How much history each vehicle keeps.
 *
 * 45 minutes, raised from 15: a siphon is not always fast. CTR 12's fell 6 L
 * over twenty minutes, so a 15-minute window never held the level before the
 * fall and the level after it at once.
 *
 * Long enough to hold a settled baseline, a fall and its confirmation at a
 * ~30 s cadence; short enough that 1,500 units cost a few hundred KB between
 * them. A fall slower than this is not something a fast path should be judging
 * anyway — that is the adjudicator's work.
 */
const WINDOW_MS = 45 * 60_000

/**
 * How long a machine must have stood still before its FALL BEGAN.
 *
 * Five minutes, the operator's choice for the parked-fall rule (2026-09-26); it
 * was fifteen. Counted to the start of the fall, not to the reading that found
 * it: counted that way, a fall could begin a minute after the machine stopped,
 * which is exactly when a probe settles or catches up with fuel burnt on the
 * drive. Replayed over 23–25 Sep, 106 of 171 flags began within five minutes of
 * the last movement; counted from the fall's start, possible-theft verdicts fell
 * from 21 to 10 a day and still caught CTR 12 and the 23 Sep yard falls.
 */
export const STILL_MIN_MS = 5 * 60_000

/**
 * How late the engine-hours counter reports running.
 *
 * The counter ticks every few minutes and each tick covers the running before
 * it, so the first tick after a machine stops belongs to the drive. `MUFINDI -
 * FT 13` on 23 Sep stopped at 12:40:53, its engine went off at 12:42:22, and the
 * counter logged 4.9 minutes at 12:44:40 — counted as running inside the parked
 * window, that refused the 19.4 L drain that followed. So an advance within this
 * long of the last movement is not counted against the window.
 */
const COUNTER_LAG_MS = 6 * 60_000

/**
 * A counter that moved this much more than the engine allowance, while the
 * ignition line read off, contradicts the line. `MUFINDI: DZ 13` on 22 Sep: the
 * line said off while the counter logged half an hour in thirty minutes.
 */
const COUNTER_CONFLICT_H = 0.1

/**
 * Least a drop must be before it is worth saying anything about.
 *
 * Five litres (was ten until 2026-09-25, lowered after CTR 12's 6 L siphon went
 * unseen). Safe on this path and only on this path: it fires only on a machine
 * that never moved and whose engine state is measured, and it needs a settled
 * plateau both before and after, so a single noisy step cannot make one.
 *
 * Deliberately BELOW the adjudicator's `SIPHON_MIN_DROP_ML` of
 * 15 L. The two answer different questions: 15 L is the floor for asserting a
 * theft on a probe whose noise has been characterised over 30 days, while this
 * only claims a tank dropped on a machine nobody was near. Measured across the
 * ledger, 176 drains sit in the 10-15 L band that the adjudicator's floor
 * excludes entirely.
 *
 * Not lower, because p99 of the level move between two consecutive readings is
 * 2.9 L; ten litres is three and a half times that and is not reachable by
 * ordinary probe noise on a stationary machine.
 */
export const LIVE_DROP_MIN_ML = 5_000

/**
 * Most the engine may have run inside the window, on a machine that never
 * moved: a START, not work. Three minutes — CTR 12's was two. Replayed over
 * 24–25 Sep, five minutes let through machines that work without moving
 * (compressors, excavators slewing in place) and roughly doubled the feed.
 */
export const MAX_ENGINE_ON_MS = 3 * 60_000

/** Readings that must agree on the new low before the fall is believed. */
const HOLD_READINGS = 3

/** Readings that must agree on the OLD level, so a slope is not read as a fall. */
const BASELINE_READINGS = 3

/**
 * How far apart readings in a plateau may sit and still count as agreeing.
 *
 * 1.5 L, a little under the 2.9 L p99 single-step move, so a plateau means a
 * plateau rather than a slow drift.
 */
const PLATEAU_TOLERANCE_ML = 1_500

/**
 * How long the same vehicle is left alone after a drop is raised.
 *
 * One fall produces one item. Without this, every subsequent frame still sees
 * the same baseline-to-trough difference in its window and would re-raise on
 * each one until the window rolled past it.
 */
const COOLDOWN_MS = 60 * 60_000

interface Reading {
  atMs:     number
  ml:       number
  /** Movement and engine state, as MEASURED — an inferred state is not used. */
  moving:   boolean
  engineOn: boolean
  /** The ignition line reported. */
  known:    boolean
  /** The engine-hours counter, where the unit has one. */
  meter:    number | null
  /** The tracker's accelerometer, in g, where the unit sends one — its angle. */
  accel:    AccelAxes | null
}

/**
 * How far the machine's angle may change across a fall before the fall is put
 * down to the tilt. 0.03 g is under 2°; on the Mufindi plant (26 Sep) the fuel
 * reading moved about 30 L per 0.06 g, so a shift this size can make a fall on
 * its own. GPS cannot see it: a truck loaded or jacked where it stands has not
 * moved, and its tank still reads a different level with the same fuel in it.
 */
const TILT_SHIFT_G = 0.03

/** The median of each axis over readings with all three, or null without two such readings. */
function attitude(rs: Reading[]): [number, number, number] | null {
  const v = rs.filter(r => r.accel?.x != null && r.accel?.y != null && r.accel?.z != null)
  if (v.length < 2) return null
  const med = (ns: number[]) => { const s = [...ns].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2 }
  return [med(v.map(r => r.accel!.x!)), med(v.map(r => r.accel!.y!)), med(v.map(r => r.accel!.z!))]
}

const rings = new Map<string, Reading[]>()
const lastRaisedMs = new Map<string, number>()
/** Falls that cleared every gate, waiting out STILL_DOWN_CONFIRM_MS before they are raised. */
const held = new Map<string, LiveFuelDrop>()

/** Median of a small set — robust where a mean is not. */
function median(ns: number[]): number {
  const v = [...ns].sort((a, b) => a - b)
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid]! : Math.round((v[mid - 1]! + v[mid]!) / 2)
}

const spread = (ns: number[]): number => Math.max(...ns) - Math.min(...ns)

/**
 * Offer one frame to the watcher.
 *
 * Returns the drop when this frame is the one that confirms it — the first
 * reading `STILL_DOWN_CONFIRM_MS` after the fall settled, with the level still
 * down — and null every other time, including while a fall is in progress or
 * being held. The caller publishes; this module never does.
 */
export function noteFuelFrame(
  frame: VehicleTelemetryFrame,
  ctx: DropWatchContext,
): LiveFuelDrop | null {
  if (!env.LIVE_FUEL_WATCH_ENABLED) return null

  const ml = frame.fuelLevelMl
  // No reading says nothing either way. It must not extend a plateau and must
  // not break one — the window simply does not learn anything from this frame.
  if (ml == null || !Number.isFinite(ml)) return null

  const atMs = frame.capturedAt.getTime()
  const ring = rings.get(ctx.vehicleId) ?? []
  const meter = frame.engineHoursMeter
  ring.push({
    atMs,
    ml,
    moving:   (frame.speedKmh ?? 0) > 0,
    engineOn: frame.engineOn,
    known:    frame.ignitionKnown,
    meter:    typeof meter === 'number' && Number.isFinite(meter) ? meter : null,
    accel:    frame.accelG ?? null,
  })
  // Bounded by time, not by count: a unit reporting every 2 s and one reporting
  // every 5 min both keep the same span of history.
  while (ring.length > 0 && atMs - ring[0]!.atMs > WINDOW_MS) ring.shift()
  rings.set(ctx.vehicleId, ring)

  // ── a fall already found waits out the confirmation ─────────────────────
  const waiting = held.get(ctx.vehicleId)
  if (waiting) {
    const since = waiting.settledAt.getTime()
    const afterReadings = ring.filter(r => r.atMs >= since)
    const after = afterReadings.filter(r => r.atMs > since).map(r => r.ml)
    // A counter tick while the fall is held may be the late report of the
    // engine running through the fall itself (COUNTER_LAG_MS), and on a unit
    // with no ignition line there is no way to say which: drop it.
    const meters = afterReadings.filter(r => r.meter != null).map(r => r.meter!)
    const tickedWhileHeld = waiting.engineEvidence === 'counter' && meters.length >= 2
      && Math.max(...meters) - meters[0]! > 0.005
    if (!stillDown(waiting.troughMl, waiting.droppedMl, after) || tickedWhileHeld) {
      // It came back (the fuel settling), or the engine may have run: never
      // raised, and the vehicle may be judged afresh.
      held.delete(ctx.vehicleId)
      lastRaisedMs.delete(ctx.vehicleId)
      return null
    }
    if (atMs - since < STILL_DOWN_CONFIRM_MS) return null
    held.delete(ctx.vehicleId)
    return { ...waiting, confirmedAt: frame.capturedAt }
  }

  const found = findParkedFall(ring, atMs, ctx)
  if (found) {
    held.set(ctx.vehicleId, found)
    lastRaisedMs.set(ctx.vehicleId, atMs)
  }
  return null
}

/** Every gate the poll loop can run, over the ring as it stands. */
function findParkedFall(ring: Reading[], atMs: number, ctx: DropWatchContext): LiveFuelDrop | null {
  if (ring.length < BASELINE_READINGS + HOLD_READINGS) return null

  // ── the disturbance rule ────────────────────────────────────────────────
  //
  // Fuel does not reposition itself in a tank that is sitting still, so a level
  // that falls on a motionless machine cannot be redistribution. The converse
  // is what makes this safe to act on fast: if ANYTHING in the window moved or
  // ran, a fall has an innocent explanation this module cannot rule out, and
  // the adjudicator — which has the burn bands — should have it instead.
  //
  // An engine state is required, not assumed: the ignition line, or the
  // engine-hours counter. On a unit with neither, "the engine was off" is not a
  // fact we have.
  //
  // A brief engine run is tolerated (MAX_ENGINE_ON_MS), timed from each
  // engine-on reading to the next reading. Never at the trough: the machine
  // must be off when we say it fell.
  //
  // The window is judged from the last disturbance on, not across all 45
  // minutes: a machine that parked half an hour ago has been still for half an
  // hour, and a siphon in that half hour must not wait for its drive to roll out
  // of the ring. But a disturbance inside the last STILL_MIN_MS still refuses.
  let start = 0
  for (const [i, r] of ring.entries()) if (r.moving || (!r.known && r.meter == null)) start = i + 1
  if (start > 0 && atMs - ring[start - 1]!.atMs < STILL_MIN_MS) return null
  const win = ring.slice(start)
  if (win.length < BASELINE_READINGS + HOLD_READINGS) return null
  // Still since the last disturbance — or, with none in the ring, at least since
  // the ring's first reading, which is all this module can vouch for.
  const stillSince = start > 0 ? ring[start - 1]!.atMs : ring[0]!.atMs

  // Which instrument speaks for the engine across the whole window: the line
  // where every reading carries it, else the counter where every reading has one.
  const evidence: EngineEvidence | null =
    win.every(r => r.known) ? 'sensor' : win.every(r => r.meter != null) ? 'counter' : null
  if (evidence == null) return null
  // The counter reports late (COUNTER_LAG_MS): after a real stop, what it moves
  // in the first minutes belongs to the drive, so it counts from where it stood
  // once that tick has landed.
  const lagUntil = start > 0 ? stillSince + COUNTER_LAG_MS : -Infinity
  const meters = win.filter(r => r.meter != null).map(r => r.meter!)
  const settledMeters = win.filter(r => r.meter != null && r.atMs <= lagUntil).map(r => r.meter!)
  const meterFloor = settledMeters.length > 0 ? Math.max(...settledMeters) : meters.length > 0 ? Math.min(...meters) : null
  const meterAdvanceH = meters.length >= 2 && meterFloor != null ? Math.max(0, Math.max(...meters) - meterFloor) : null
  const last = win.slice(-HOLD_READINGS)

  let engineOnMs = 0
  if (evidence === 'sensor') {
    for (const [i, r] of win.entries()) {
      if (r.engineOn) engineOnMs += (win[i + 1]?.atMs ?? r.atMs) - r.atMs
    }
    if (engineOnMs > MAX_ENGINE_ON_MS) return null
    if (last.some(r => r.engineOn)) return null
    if (meterAdvanceH != null && meterAdvanceH > MAX_ENGINE_ON_MS / 3_600_000 + COUNTER_CONFLICT_H) return null
  } else {
    engineOnMs = Math.round((meterAdvanceH ?? 0) * 3_600_000)
    if (engineOnMs > MAX_ENGINE_ON_MS) return null
    // Off at the trough: the counter did not move into or across the hold.
    if (last[last.length - 1]!.meter! - win[win.length - HOLD_READINGS - 1]!.meter! > 0.005) return null
  }

  const lows = last.map(r => r.ml)
  // The fall has to have FINISHED. A level still moving is not a trough.
  if (spread(lows) > PLATEAU_TOLERANCE_ML) return null
  const troughMl = median(lows)

  // The baseline is the highest settled plateau earlier in the window — not the
  // maximum reading, which a single spike would set.
  const earlier = win.slice(0, -HOLD_READINGS)
  let baselineMl = -1
  for (let i = 0; i + BASELINE_READINGS <= earlier.length; i++) {
    const mls = earlier.slice(i, i + BASELINE_READINGS).map(r => r.ml)
    if (spread(mls) > PLATEAU_TOLERANCE_ML) continue
    const level = median(mls)
    if (level > baselineMl) baselineMl = level
  }
  if (baselineMl < 0) return null

  const droppedMl = baselineMl - troughMl
  if (droppedMl < LIVE_DROP_MIN_ML) return null

  // When the fall began: the last reading still near the old level. The machine
  // must have stood STILL_MIN_MS by then, not merely by now.
  const nearBaseline = baselineMl - 0.2 * droppedMl
  let fallStartMs = earlier[0]!.atMs
  for (let i = earlier.length - 1; i >= 0; i--) {
    if (earlier[i]!.ml >= nearBaseline) { fallStartMs = earlier[i]!.atMs; break }
  }
  if (fallStartMs - stillSince < STILL_MIN_MS) return null

  // The machine's angle before the fall and at the trough, where the tracker
  // reports one. A fall that comes with the angle changing is the fuel moving
  // in a tilted tank, not leaving it — see TILT_SHIFT_G.
  const before = attitude(earlier.filter(r => r.atMs <= fallStartMs))
  const after = attitude(last)
  const attitudeShiftG = before && after
    ? Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2])
    : null
  if (attitudeShiftG != null && attitudeShiftG >= TILT_SHIFT_G) return null

  const since = lastRaisedMs.get(ctx.vehicleId)
  if (since != null && atMs - since < COOLDOWN_MS) return null

  const settledAt = new Date(last[0]!.atMs)
  return {
    orgId:          ctx.orgId,
    vehicleId:      ctx.vehicleId,
    plate:          ctx.plate,
    baselineMl,
    troughMl,
    droppedMl,
    settledAt,
    fallStartedAt:     new Date(fallStartMs),
    stillBeforeFallMs: fallStartMs - stillSince,
    stillForMs:     atMs - win[0]!.atMs,
    engineOnMs,
    engineEvidence: evidence,
    meterAdvanceH,
    attitudeShiftG,
    confirmedAt:    settledAt,
    tankCapacityMl: ctx.tankCapacityMl ?? null,
  }
}

/**
 * Forget a vehicle's history.
 *
 * Used by the tests, and by any caller that knows the series is about to become
 * discontinuous — a replayed backlog would otherwise compare a reading from
 * yesterday with one from today and call the difference a drop.
 */
export function resetFuelWatch(vehicleId?: string): void {
  if (vehicleId) { rings.delete(vehicleId); lastRaisedMs.delete(vehicleId); held.delete(vehicleId); return }
  rings.clear()
  lastRaisedMs.clear()
  held.clear()
}
