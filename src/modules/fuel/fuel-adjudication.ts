/**
 * Did the fuel actually leave the tank?
 *
 * ## The problem
 *
 * Every `fuel_thefts` row is Wialon's verdict, not ours: its report template
 * decides that a level drop is a theft, and we store what it says. The
 * operator's account of why that is wrong is specific — a vehicle parked on a
 * slope with a part-full tank lets fuel move away from the probe, the level
 * reads low, and it comes back when the vehicle levels out.
 *
 * Measured over the 250 most recent drains per org (2026-08-04), excluding any
 * drain with a filling in the window:
 *
 *   KASULU   3,920 L came back · 5,809 L stayed down  → 40% of decidable volume
 *   SUKARI     775 L came back ·   781 L stayed down  → 50% of decidable volume
 *
 * That is KES 703,177 and KES 138,934 of those samples alone, reported as loss,
 * for fuel that never left. Individual cases are not marginal: `KTCB 295U`
 * 66.4 L with 100% back, `MUFINDI: DZ 13` 31.7 L with 134% back.
 *
 * ## Why the level series and nothing else
 *
 * Two other signals were tested against the live data and dropped:
 *
 *   - **Tank fill fraction** does not separate the populations at all: 0.62 vs
 *     0.63 on KASULU, and on SUKARI it runs the OPPOSITE way to the prediction.
 *   - **Slope** is weak. Altitude is populated on 100% of fixes so it could be
 *     tested rather than assumed: SUKARI's recovered drains swing 85 m against
 *     50 m for real ones, but KASULU's are 22 m against 20 m — nothing.
 *
 * So the test is simply whether the fuel came back, which needs no theory about
 * why it moved. That matters: it catches the flat-ground KASULU cases too,
 * where the slope explanation demonstrably does not apply.
 *
 * ## What it deliberately does NOT do
 *
 * It never deletes and never lowers a volume. A drain is either confirmed,
 * reclassified as redistribution, or marked unverified — and only
 * REDISTRIBUTION is excluded from the loss figures. We remove what we can
 * DISPROVE, not what we merely doubt: a drain we cannot check still counts,
 * because the provider saw something and we cannot show otherwise.
 */

/** How much of the observed drop must return before it is not a loss. */
export const RECOVERY_THRESHOLD = 0.6

/**
 * How long after detection a drain must be left before judging it.
 *
 * Recovery is already visible at detection time in the median case. Measured
 * share of recoveries caught by waiting:
 *
 *   10 min → 85% / 90%      30 min → 94% / 93%
 *   20 min → 92% / 93%     120 min → 100% / 98%      (KASULU / SUKARI)
 *
 * 20 minutes takes over nine tenths of the false flags for 20 minutes of
 * notification delay, which the operator accepted as the trade.
 */
export const SETTLE_MINUTES = 20

/** A level reading from our own telemetry. */
export interface LevelSample {
  capturedAt:  Date
  fuelLevelMl: number
}

export interface DrainClaim {
  beganAt:    Date
  detectedAt: Date
  stolenMl:   number
}

export type Verdict = 'PENDING' | 'LOSS' | 'REDISTRIBUTION' | 'UNVERIFIED'

export interface Adjudication {
  verdict:     Verdict
  /** Millilitres of the observed drop that returned, when measurable. */
  recoveredMl: number | null
  /** Short slug naming the rule that decided, for auditing. */
  reason:      string
}

/**
 * Minimum readings either side before the series is worth believing. Two
 * points can describe a drop; they cannot describe whether it recovered.
 */
const MIN_SAMPLES = 3

/**
 * Judge one drain against the vehicle's own level series.
 *
 * `samples` should span roughly [beganAt − 30 min, detectedAt + settle], sorted
 * ascending. `hasFilling` is true when a filling was recorded in that window —
 * in which case a rise is explained and proves nothing either way.
 *
 * Pure: no clock, no database. `now` is passed so the settle check is testable.
 */
export function adjudicateDrain(
  claim: DrainClaim,
  samples: readonly LevelSample[],
  /** When a filling was recorded in the window, if one was. */
  fillingAt: Date | null,
  now: Date,
): Adjudication {
  // Not yet ripe. Judging early is how you confirm a loss that was about to
  // come back — the failure mode this whole module exists to prevent.
  if (now.getTime() - claim.detectedAt.getTime() < SETTLE_MINUTES * 60_000) {
    return { verdict: 'PENDING', recoveredMl: null, reason: 'settling' }
  }

  const before = samples.filter(s => s.capturedAt <= claim.beganAt)
  // Only readings BEFORE any filling can speak to a recovery — after one, a
  // rise is explained by the fuel that was just put in. Cutting the window at
  // the filling rather than discarding the whole case matters: a refuel two
  // hours later says nothing about a level that came back five minutes after
  // the drain, and on the live ledger 29-35% of drains have a filling
  // somewhere in the window. Throwing those away would forfeit most of what
  // is decidable.
  const after = samples.filter(s =>
    s.capturedAt >= claim.detectedAt && (fillingAt == null || s.capturedAt < fillingAt))

  if (before.length < MIN_SAMPLES || after.length < MIN_SAMPLES) {
    // Distinguish "no readings" from "a filling landed too soon to see past" —
    // they are different problems and only one is ours to fix.
    return fillingAt != null && after.length < MIN_SAMPLES
      ? { verdict: 'UNVERIFIED', recoveredMl: null, reason: 'filling-too-soon' }
      : { verdict: 'UNVERIFIED', recoveredMl: null, reason: 'insufficient-telemetry' }
  }

  // The drop as OUR telemetry saw it — the highest level before it started
  // down to the lowest during it. Deliberately measured rather than taken from
  // the claim's own initial/final levels, so the recovery is judged against
  // the same series that would show it returning.
  const baseline = Math.max(...before.map(s => s.fuelLevelMl))
  const during   = samples.filter(s => s.capturedAt >= claim.beganAt && s.capturedAt <= claim.detectedAt)
  const trough   = Math.min(...(during.length ? during : after).map(s => s.fuelLevelMl))
  const drop     = baseline - trough
  if (drop <= 0) {
    // Our series never saw the level fall. That is not evidence of a recovery,
    // it is evidence the two sources disagree about what happened.
    return { verdict: 'UNVERIFIED', recoveredMl: null, reason: 'no-drop-observed' }
  }

  const peakAfter   = Math.max(...after.map(s => s.fuelLevelMl))
  const recoveredMl = Math.max(0, Math.min(peakAfter - trough, drop))

  return (peakAfter - trough) / drop >= RECOVERY_THRESHOLD
    ? { verdict: 'REDISTRIBUTION', recoveredMl, reason: 'level-recovered' }
    : { verdict: 'LOSS', recoveredMl, reason: 'level-stayed-down' }
}
