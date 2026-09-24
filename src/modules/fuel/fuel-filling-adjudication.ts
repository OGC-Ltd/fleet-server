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

import {
  smoothLevels, lerp, probeSwings,
  type Adjudication, type LevelSample, type ProbeProfile,
} from './fuel-adjudication.js'

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

/** How far before the claim to READ, so the pre-fill state is available. */
export const FILL_LOOKBEHIND_MINUTES = 20

/**
 * How far above the tank's own pre-fill level a lookbehind reading may sit and
 * still count toward the baseline.
 *
 * The baseline used to be the median of the whole 20-minute lookbehind, which
 * silently assumed nothing happened in them. When a DRAIN had just occurred
 * that window straddled the fall, more than half its readings were pre-drop,
 * and the median came out at the OLD level — so a refill which merely restored
 * what had been taken measured as zero or negative rise and was ruled
 * REDISTRIBUTION.
 *
 * Measured on the live ledger, 2026-09-23 (docs/fuel-theft-alerting-gaps.md):
 *
 *   MUFINDI: MTR 09  12:22  claimed 19.9 L  observed −0.8 L   tank 39.4 → 59.3
 *   MUFINDI - FT 13  13:01  claimed 20.0 L  observed −1.0 L   tank 71.6 → 90.6
 *   MUFINDI: MTR 04  17:20  claimed 16.8 L  observed −2.3 L   tank 40.7 → 57.8
 *   MUFINDI: CTR 14  13:59  claimed 25.6 L  observed +9.1 L   tank 238.1 → 263.6
 *
 * Every one of those deliveries is visible in the raw series and every one was
 * written off. On MTR 09 the consequence ran further: `adjudicateDrain` excludes
 * a filling already ruled REDISTRIBUTION from truncating a drain's recovery
 * window, so the phantom verdict let the refill's rise count as spontaneous
 * recovery and the 20.6 L drain was erased too.
 *
 * ## The rule, and the two alternatives that were measured and rejected
 *
 * A reading ABOVE the level the tank actually stood at when the pump started
 * describes fuel that has since gone. It cannot be the baseline a delivery is
 * measured from, so it is excluded — and the median is taken over what is left,
 * because the module's reasoning for medians stands: a filling asks "what was
 * the level before, and what is it now", two steady states, and an extremum
 * would invent a fill or erase one on noise alone.
 *
 * Measured over 1,195 decidable fillings, 12 days to 2026-09-24
 * (`prisma/measure-fill-baseline.ts`):
 *
 *   baseline rule              → REFILL   → REDISTRIBUTION
 *   median of the last 5 min        23          24
 *   capped at the pre-fill level    66           0
 *
 * A plain five-minute median was tried first and is rejected: on a LARGE
 * delivery the tank is already rising before the provider's `filledAt`, so a
 * short window sits partway up the ramp and understates the arrival. It lost 24
 * genuine refills, several of them 200–600 L.
 *
 * A plain minimum over the window is rejected for the opposite reason: on a
 * probe that oscillates it takes the trough of the swing and turns the
 * up-swings this module exists to catch into corroborated deliveries.
 *
 * ## Why this only applies to a probe we trust
 *
 * Capping at the pre-fill level flips 66 rows to REFILL, and **54 of those sit
 * on probes the trust gate distrusts** — where there is no meaningful "level
 * before the fill" to cap at, because the level is swinging. On those units the
 * old wide-window behaviour is kept unchanged: not because it is right, but
 * because nothing measurable is right there, and re-admitting phantom
 * deliveries would undo what this module was built for. 307 of 5,794 fillings
 * are REDISTRIBUTION precisely because they are such up-swings.
 *
 * That leaves 12 flips, all on trusted probes, and no genuine refill lost.
 */
export const FILL_BASELINE_TOLERANCE_ML = 2_000

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
 *
 * ## Why this takes no `drainAt`, when `adjudicateDrain` takes a `fillingAt`
 *
 * The asymmetry looks like an oversight and is not. It was measured on
 * 2026-08-26 over 30 days — `prisma/measure-fill-drain-overlap.ts`, which can be
 * re-run — and the answer was decisive in both directions.
 *
 * **The medians already catch the phantom case.** 1,935 of 5,923 fillings
 * (32.7%) have a drain inside this window. **77.4% of them are already
 * REDISTRIBUTION, against 7.8% of the fillings with no drain nearby** — a
 * tenfold enrichment, reached without knowing the drain existed. On a probe
 * that swings symmetrically the before and after medians are the same, so the
 * rise is ~0 and the row fails on its own evidence. The `MUFINDI - EX 22`
 * oscillation that motivated asking is handled by the statistic, not by
 * cross-referencing.
 *
 * **And the rows a drain-aware rule WOULD change are real fuel.** 208
 * overlapping fillings are `level-rose`: 33,278 L claimed against 36,617 L our
 * own telemetry watched arrive — we saw MORE go in than was claimed. They are
 * dominated by `MUFINDI - DG 13` and `DG 12`, generators with ~1,700 L tanks
 * refuelled 700-1,400 L every day or two, whose engines run 87-96% of the time.
 * A generator refuelled while running legitimately shows a fill and a drain in
 * the same eighty minutes. Suppressing those would delete the largest and
 * best-corroborated deliveries on the fleet.
 *
 * So the two directions are not mirror images, and treating them as such would
 * be the bug: a filling inside a drain's window genuinely explains a rise, so
 * it must cut the recovery test — but a drain inside a filling's window does
 * not unexplain an arrival this module watched happen.
 */
export function adjudicateFilling(
  claim: FillingClaim,
  samples: readonly LevelSample[],
  now: Date,
  /**
   * The vehicle's probe as its own recent history describes it.
   *
   * Optional, and omitting it means "assume the probe is trustworthy" — which
   * keeps every existing caller and test behaving as before. It is consulted
   * for one thing only: whether the pre-fill level is a meaningful quantity to
   * cap the baseline at. See FILL_BASELINE_TOLERANCE_ML.
   */
  profile?: ProbeProfile | null,
): Adjudication {
  if (now.getTime() - claim.filledAt.getTime() < (FILL_SETTLE_MINUTES + FILL_HOLD_MINUTES) * 60_000) {
    return { verdict: 'PENDING', recoveredMl: null, reason: 'settling', confirmed: false, confidence: null }
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
    // No evidence to grade this claim against, so — same reasoning as the
    // equivalent drain branch — the confidence is a population prior, not a
    // measurement of this row. Fillings are a friendlier population than
    // drains here: of the DECIDABLE ones, 1,558 of 1,865 (84%) show at least
    // half the claimed volume arriving, and the module docstring's own
    // percentiles put the median observed rise at 0.96 of the claim. That is
    // still a claim about decidable fillings, not this unchecked bucket
    // specifically, so treat 0.75 as a starting point pending its own
    // backtest, not a fitted figure.
    return { verdict: 'REFILL', recoveredMl: null, reason: 'insufficient-telemetry', confirmed: false, confidence: 0.75 }
  }

  // The tank as it stood when the pump started, not as it stood twenty minutes
  // earlier — see FILL_BASELINE_TOLERANCE_ML. Readings above that level are
  // fuel that has since gone and cannot be a baseline for what arrived.
  //
  // Only on a probe we trust. Where the level swings there is no "level before
  // the fill" to cap at, and the old window stands — see the constant.
  const baselineWindow = probeSwings(profile)
    ? before
    : (() => {
        // The level at the pump, from our own series rather than the provider's
        // figure: this module measures the claim, it does not adopt it.
        const atPump = median(before.slice(-MIN_SAMPLES).map(s => s.fuelLevelMl))
        const kept = before.filter(s => s.fuelLevelMl <= atPump + FILL_BASELINE_TOLERANCE_ML)
        // A sparse reporter with too little left falls back to the whole
        // window, which is the old behaviour and the honest answer when there
        // is nothing finer to measure.
        return kept.length >= MIN_SAMPLES ? kept : before
      })()

  const baseline = median(baselineWindow.map(s => s.fuelLevelMl))
  const settledLevel = median(after.map(s => s.fuelLevelMl))
  const rise = settledLevel - baseline

  // Both confirmed branches graded the same way as the drain module's
  // level-stayed-down / level-recovered pair: distance from the threshold that
  // decided them, not distance from zero. riseRatio can run negative (the
  // tank fell) or past 1 (more arrived than claimed), so it is not clamped
  // before the lerp — lerp itself clamps the OUTPUT, which is what bounds the
  // score to [0,1].
  const riseRatio = claim.filledMl > 0 ? rise / claim.filledMl : 0

  if (claim.filledMl > 0 && rise >= claim.filledMl * FILL_OBSERVED_MIN_RATIO) {
    return {
      verdict: 'REFILL', recoveredMl: rise, reason: 'level-rose', confirmed: true,
      confidence: lerp(riseRatio, FILL_OBSERVED_MIN_RATIO, 1, 0.55, 0.95),
    }
  }

  // Fuel was supposedly added and the tank is no fuller for it. On these
  // machines that is the probe swinging, not a delivery — so it takes the same
  // word as a drain that turned out to be the probe swinging.
  return {
    verdict: 'REDISTRIBUTION', recoveredMl: rise, reason: 'no-rise-observed', confirmed: true,
    confidence: lerp(riseRatio, FILL_OBSERVED_MIN_RATIO, -1, 0.55, 0.95),
  }
}