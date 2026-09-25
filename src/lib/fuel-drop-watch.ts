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
 * demands the ENTIRE window be stationary with the ignition MEASURED, and
 * abandons the moment anything moves. A fall on a machine that is working is
 * left to the adjudicator, which has the burn bands to judge it against.
 *
 * The engine may have run BRIEFLY (MAX_ENGINE_ON_MS) on a machine that never
 * moved. MUFINDI: CTR 12 on 2026-09-25: the engine was started for about two
 * minutes at 15:08 EAT, then the tank fell 6 L over twenty minutes with it off.
 * Idling burns a fraction of a litre in that time, so it cannot explain the
 * fall — but an engine-off-throughout rule was blind to it until 15:24.
 *
 * That also means it is silent on the 54 of 147 units whose ignition we cannot
 * read (see `readIgnition`), which is correct: "we do not know if the engine was
 * off" is not "the engine was off".
 *
 * ## Nothing here touches the database
 *
 * Same contract as `speeding-episodes`: per frame this is one Map lookup and a
 * short scan of a bounded ring. The publish is handed to a worker over the
 * event bus, never awaited in a frame's turn.
 */

import { env } from '../config/env.js'
import type { VehicleTelemetryFrame } from '../providers/telemetry-provider.js'

export interface DropWatchContext {
  orgId:     string
  vehicleId: string
  plate:     string | null
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
  /** How long the machine had been standing still before the fall started. */
  stillForMs: number
  /** How long the engine ran inside that time — zero on most. */
  engineOnMs: number
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

/** How long a machine must have stood still before a fall on it is believed. */
const STILL_MIN_MS = 15 * 60_000

/**
 * Least a drop must be before it is worth saying anything about.
 *
 * Five litres (was ten until 2026-09-25, lowered after CTR 12's 6 L siphon went
 * unseen). Safe on this path and only on this path: it fires only on a machine
 * that never moved and whose ignition is measured, and it needs a settled
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
  known:    boolean
}

const rings = new Map<string, Reading[]>()
const lastRaisedMs = new Map<string, number>()

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
 * Returns the drop when this frame is the one that confirms it, and null every
 * other time — including while a fall is still in progress. The caller
 * publishes; this module never does.
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
  ring.push({
    atMs,
    ml,
    moving:   (frame.speedKmh ?? 0) > 0,
    engineOn: frame.engineOn,
    known:    frame.ignitionKnown,
  })
  // Bounded by time, not by count: a unit reporting every 2 s and one reporting
  // every 5 min both keep the same span of history.
  while (ring.length > 0 && atMs - ring[0]!.atMs > WINDOW_MS) ring.shift()
  rings.set(ctx.vehicleId, ring)

  if (ring.length < BASELINE_READINGS + HOLD_READINGS) return null

  // ── the disturbance rule ────────────────────────────────────────────────
  //
  // Fuel does not reposition itself in a tank that is sitting still, so a level
  // that falls on a motionless machine cannot be redistribution. The converse
  // is what makes this safe to act on fast: if ANYTHING in the window moved or
  // ran, a fall has an innocent explanation this module cannot rule out, and
  // the adjudicator — which has the burn bands — should have it instead.
  //
  // `known` is required, not assumed. On a unit whose ignition we cannot read,
  // "the engine was off" is not a fact we have.
  //
  // A brief engine run is tolerated (MAX_ENGINE_ON_MS), timed from each
  // engine-on reading to the next reading. Never at the trough: the machine
  // must be off when we say it fell.
  //
  // The window is judged from the last disturbance on, not across all 45
  // minutes: a machine that parked half an hour ago has been still for half an
  // hour, and a siphon in that half hour must not wait for its drive to roll out
  // of the ring. But a disturbance inside the last STILL_MIN_MS still refuses,
  // exactly as the old 15-minute all-still window did — the level straight after
  // stopping is still settling.
  let start = 0
  for (const [i, r] of ring.entries()) if (!r.known || r.moving) start = i + 1
  if (start > 0 && atMs - ring[start - 1]!.atMs < STILL_MIN_MS) return null
  const win = ring.slice(start)
  if (win.length < BASELINE_READINGS + HOLD_READINGS) return null

  let engineOnMs = 0
  for (const [i, r] of win.entries()) {
    if (r.engineOn) engineOnMs += (win[i + 1]?.atMs ?? r.atMs) - r.atMs
  }
  if (engineOnMs > MAX_ENGINE_ON_MS) return null

  const last = win.slice(-HOLD_READINGS)
  if (last.some(r => r.engineOn)) return null
  const lows = last.map(r => r.ml)
  // The fall has to have FINISHED. A level still moving is not a trough.
  if (spread(lows) > PLATEAU_TOLERANCE_ML) return null
  const troughMl = median(lows)

  // The baseline is the highest settled plateau earlier in the window — not the
  // maximum reading, which a single spike would set.
  const earlier = win.slice(0, -HOLD_READINGS)
  let baselineMl = -1
  let baselineAtMs = 0
  for (let i = 0; i + BASELINE_READINGS <= earlier.length; i++) {
    const run = earlier.slice(i, i + BASELINE_READINGS)
    const mls = run.map(r => r.ml)
    if (spread(mls) > PLATEAU_TOLERANCE_ML) continue
    const level = median(mls)
    if (level > baselineMl) { baselineMl = level; baselineAtMs = run[0]!.atMs }
  }
  if (baselineMl < 0) return null

  const droppedMl = baselineMl - troughMl
  if (droppedMl < LIVE_DROP_MIN_ML) return null

  const since = lastRaisedMs.get(ctx.vehicleId)
  if (since != null && atMs - since < COOLDOWN_MS) return null
  lastRaisedMs.set(ctx.vehicleId, atMs)

  return {
    orgId:      ctx.orgId,
    vehicleId:  ctx.vehicleId,
    plate:      ctx.plate,
    baselineMl,
    troughMl,
    droppedMl,
    settledAt:  new Date(last[0]!.atMs),
    stillForMs: atMs - win[0]!.atMs,
    engineOnMs,
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
  if (vehicleId) { rings.delete(vehicleId); lastRaisedMs.delete(vehicleId); return }
  rings.clear()
  lastRaisedMs.clear()
}
