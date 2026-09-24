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
 * demands the ENTIRE window be stationary with the engine MEASURED off, and
 * abandons the moment anything moves. A fall on a machine that is working is
 * left to the adjudicator, which has the burn bands to judge it against.
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
}

/**
 * How much history each vehicle keeps.
 *
 * Long enough to hold a settled baseline, a fall and its confirmation at a
 * ~30 s cadence; short enough that 1,500 units cost a few hundred KB between
 * them. A fall slower than this is not something a fast path should be judging
 * anyway — that is the adjudicator's work.
 */
const WINDOW_MS = 15 * 60_000

/**
 * Least a drop must be before it is worth saying anything about.
 *
 * Ten litres, and deliberately BELOW the adjudicator's `SIPHON_MIN_DROP_ML` of
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
export const LIVE_DROP_MIN_ML = 10_000

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
  for (const r of ring) {
    if (!r.known || r.engineOn || r.moving) return null
  }

  const last = ring.slice(-HOLD_READINGS)
  const lows = last.map(r => r.ml)
  // The fall has to have FINISHED. A level still moving is not a trough.
  if (spread(lows) > PLATEAU_TOLERANCE_ML) return null
  const troughMl = median(lows)

  // The baseline is the highest settled plateau earlier in the window — not the
  // maximum reading, which a single spike would set.
  const earlier = ring.slice(0, -HOLD_READINGS)
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
    stillForMs: atMs - ring[0]!.atMs,
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
