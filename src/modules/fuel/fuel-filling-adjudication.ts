/**
 * Did the fuel actually go INTO the tank?
 *
 * The mirror of `fuel-adjudication.ts`, and it exists for the same reason. Every
 * `fuel_fillings` row is Wialon's claim, not ours: its report template decides
 * that a level RISE is a refuelling, and we store what it says. Drains have been
 * adjudicated against our own telemetry since 2026-08-04; fillings never were,
 * and that asymmetry turned out to matter in two directions at once.
 *
 * ## What the ledger actually looks like
 *
 * Measured 2026-08-11 over 5,794 fillings since 2026-07-01. 1,865 have at least
 * three readings either side and so can be checked at all; the other 3,929 have
 * no telemetry to check against — the same coverage gap the drains have.
 *
 * Of the decidable ones, observed rise over claimed volume:
 *
 *   p05  -0.58      p25  0.84      p50  0.96      p75  1.00      p95  1.21
 *
 * So **the typical filling is very nearly exact** and the ledger is mostly
 * sound: 1,558 of 1,865 (84%) show at least half the claimed volume arriving.
 * This module is not a cleanup of a broken feed. It is here for the 307 that
 * are not, of which **210 show no rise at all** — many of them a level that
 * FELL sharply around the moment fuel was supposedly added.
 *
 * ## Why those 210 exist
 *
 * They are the up-swings of oscillating probes. The worst offenders are the
 * same machines the drain trust gate already distrusts — `MUFINDI - CTR 10`,
 * `FTT 06`, `CTR 23`, `DZ 20`, `CTR 03`, `KTCB 295U`, `DZ 05`, `DZ 14`,
 * `EX 04`. On a probe that swings, Wialon logs the up-swings as fillings and
 * the down-swings as thefts, and BOTH are artefacts of the same movement.
 * `MUFINDI - EX 22` on 2026-08-10 produced `-21.7, +29.1, +24.8, -27.7,
 * +28.2 L` inside four minutes.
 *
 * ## Why this is not cosmetic
 *
 * A phantom filling does damage beyond its own row:
 *
 *   1. It inflates every fuel-IN total — consumption rates, cost analytics,
 *      driver reports.
 *   2. It CORRUPTS DRAIN ADJUDICATION. `adjudicateDrain` cuts its recovery
 *      window at the first filling in the window, because a rise after a
 *      refuel proves nothing. A phantom filling therefore truncates the window
 *      and lands the drain on `filling-too-soon` — 438 rows, the third-largest
 *      category on the drains ledger. That is how a `-27.7 L` undulation on
 *      EX 22 came to be classified a refill and drawn green.
 *
 * ## Same vocabulary as the drains, deliberately
 *
 * `FuelEventVerdict` covers both tables. A fuel event is a REFILL, a DRAIN or a
 * REDISTRIBUTION whichever ledger it arrived on, which is the operator's own
 * model — and it means a "filling" that was really the probe swinging gets the
 * same word as a "theft" that was really the probe swinging.
 */

import { smoothLevels, type Adjudication, type LevelSample } from './fuel-adjudication.js'

/**
 * How much of the CLAIMED volume our own series must show arriving before the
 * filling is corroborated.
 *
 * Half, mirroring `OBSERVED_DROP_MIN_RATIO`, and the data has a clean gap to
 * sit it in — unlike the drains, where the equivalent threshold had to be
 * chosen out of a continuum. Decidable fillings run 1,558 at >= 0.5, then 46
 * between 0.2 and 0.5, 51 below 0.2, and 210 at or below zero. With p25 already
 * at 0.84, a half-claim floor sits far beneath the corroborated mass and well
 * above the junk.
 */
export const FILL_OBSERVED_MIN_RATIO = 0.5

/**
 * How long to let a refuelling finish before reading the level.
 *
 * A tank being filled reads somewhere between its start and end value for as
 * long as the pump is running, so a reading taken during it is neither. Twenty
 * minutes past the timestamp is comfortably clear of a bowser filling plant.
 */
export const FILL_SETTLE_MINUTES = 20

/** How long after the settle window to keep reading, to see the rise HOLD. */
export const FILL_HOLD_MINUTES = 40

/** How far before the claim to establish the pre-fill baseline. */
export const FILL_LOOKBEHIND_MINUTES = 20

/** Readings needed either side before the series is worth believing. */
const MIN_SAMPLES = 3

export interface FillingClaim {
  filledAt: Date
  filledMl: number
}

/** The median of a set of levels — robust where an extremum is not. */
function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b)
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid]! : Math.round((v[mid - 1]! + v[mid]!) / 2)
}

/**
 * Judge one filling against the vehicle's own level series.
 *
 * Pure: no clock, no database.
 *
 * Uses MEDIANS either side rather than the extrema the drain rules use, and the
 * difference is deliberate. A drain asks "how far down did it ever go", which is
 * a question about an extreme. A filling asks "what was the level before, and
 * what is it now" — two steady states — and on a probe that swings 25 L while
 * parked, a max-before/min-after pair would invent a fill or erase one on noise
 * alone. The series is median-filtered first as well, so an isolated spike
 * cannot reach either figure.
 */
export function adjudicateFilling(
  claim: FillingClaim,
  samples: readonly LevelSample[],
  now: Date,
): Adjudication {
  if (now.getTime() - claim.filledAt.getTime() < (FILL_SETTLE_MINUTES + FILL_HOLD_MINUTES) * 60_000) {
    return { verdict: 'PENDING', recoveredMl: null, reason: 'settling', confirmed: false }
  }

  const level  = smoothLevels(samples)
  const before = level.filter(s => s.capturedAt <= claim.filledAt)
  // Readings from the settle window onwards: the pump has stopped and the tank
  // has had time to read its new steady state.
  const settled = new Date(claim.filledAt.getTime() + FILL_SETTLE_MINUTES * 60_000)
  const after  = level.filter(s => s.capturedAt >= settled)

  if (before.length < MIN_SAMPLES || after.length < MIN_SAMPLES) {
    // The provider saw fuel go in and we cannot check it. We relay the claim
    // rather than contradicting it — the same posture the drains take, and for
    // the same reason: we remove what we can DISPROVE, not what we doubt.
    // 3,929 of 5,794 fillings are in this state.
    return { verdict: 'REFILL', recoveredMl: null, reason: 'insufficient-telemetry', confirmed: false }
  }

  const baseline = median(before.map(s => s.fuelLevelMl))
  const settledLevel = median(after.map(s => s.fuelLevelMl))
  const rise = settledLevel - baseline

  if (claim.filledMl > 0 && rise >= claim.filledMl * FILL_OBSERVED_MIN_RATIO) {
    return { verdict: 'REFILL', recoveredMl: rise, reason: 'level-rose', confirmed: true }
  }

  // Fuel was supposedly added and the tank is no fuller for it. On these
  // machines that is the probe swinging, not a delivery — so it takes the same
  // word as a drain that turned out to be the probe swinging.
  return { verdict: 'REDISTRIBUTION', recoveredMl: rise, reason: 'no-rise-observed', confirmed: true }
}
