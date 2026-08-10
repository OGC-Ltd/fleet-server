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
 * How much of the CLAIMED volume our own series must have seen fall before a
 * recovery test on it means anything.
 *
 * A recovery ratio is only as good as the drop it is measured against. Nine of
 * 37 REDISTRIBUTION verdicts over the 30 days to 2026-08-08 had recovered less
 * than a fifth of what was claimed — 181.4 L cleared in total, including
 * KTCC 850B at 19 ml against 25.8 L and KCX 802S at 4.2 L against 41.3 L.
 *
 * There is no clean gap in the data to sit this on. Recovered-over-claimed
 * across those 37 runs 0.001 · 0.068 · 0.097 … 0.179 · 0.254 · 0.274 · 0.401 ·
 * 0.43 · 0.482 · 0.531 · 0.769 · 0.829, then 21 of them at 0.8 and above (some
 * well over 1, because our window can see more come back than was claimed
 * gone). So the population that clearly means something is the ≥0.8 cluster,
 * and the rest is a continuum. Half the claim is the round number inside it,
 * chosen to sit ABOVE the grey band rather than in it.
 *
 * Erring high is the safe direction: this only ever moves a drain to
 * UNVERIFIED, which stays IN the loss figures. Nothing is written off by it,
 * and a real theft cannot be hidden by it — the opposite of the failure it
 * fixes, where an unobserved claim was written off on noise.
 */
export const OBSERVED_DROP_MIN_RATIO = 0.5

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
  /** Engine state at the reading, where the provider sent one. */
  engineOn?:   boolean
}

/**
 * A dead fuel probe reports a full tank draining to nothing.
 *
 * Measured 2026-08-11 over 298 probes with two days of telemetry: **37 (12.4%)
 * sit at exactly zero — min and max both 0 — and 27 of those have never
 * produced a single theft or filling row** despite the fleet recording 154
 * fillings against them. Fuel goes in; the probe says nothing.
 *
 * The damage is done on the way down. Five probes fell to zero inside one day,
 * from as high as 256 L, and one of them reached the ledger: KDL 182X, 55 L
 * "stolen", 55 L -> 0 L, 2026-08-07. That drain was only spared because the
 * level happened to come back and the recovery test caught it. A probe that
 * dies and STAYS dead produces a confirmed LOSS against whoever was driving,
 * and — because only REDISTRIBUTION is skipped — a notification naming them.
 *
 * ## Telling a dead probe from a tank drained to empty
 *
 * They look identical in the level series, and the second is the most serious
 * theft there is, so this cannot be decided on the level alone.
 *
 * What separates them is that **an engine cannot run on an empty tank.** If the
 * readings after the drain are all zero while the engine is still turning, the
 * machine is running on fuel the probe says is not there, and it is the probe
 * that is wrong. A genuinely emptied tank stops the engine.
 *
 * Requires `engineOn`, which the provider populates on 58-74% of readings
 * depending on fleet. With no engine evidence this rule stays silent and the
 * ordinary recovery test decides, which is the conservative direction: it
 * risks calling a sensor fault a loss, not a loss a sensor fault.
 *
 * ## This is a guard, not a cleanup — it currently fires on nothing
 *
 * Checked against the whole ledger, 2,553 drains: 1,049 have enough readings
 * after detection, 55 touch zero at some point, **exactly one is all-zero
 * afterwards, and that one has no engine-on reading at all**. So the rule
 * reclassifies nothing historically, and it is insurance rather than a fix.
 *
 * That is because dead probes mostly go SILENT rather than noisy — 27 of the 37
 * zero-pinned probes have never produced a theft or a filling row, so they
 * never reach this function. The blind spot is the larger problem and this does
 * not address it; it wants an `fsl_dead` alert, not a verdict.
 *
 * What this does buy is the severe case: a probe that dies mid-operation while
 * the machine keeps working, which would otherwise be a confirmed LOSS and a
 * notification naming a driver. Five probes fell to zero inside one day.
 */
const DROPOUT_MIN_BASELINE_ML = 5_000
/** Engine-on readings needed at zero before the probe is blamed rather than the driver. */
const DROPOUT_MIN_RUNNING = 3

export interface DrainClaim {
  beganAt:    Date
  detectedAt: Date
  stolenMl:   number
}

export type Verdict = 'PENDING' | 'LOSS' | 'REDISTRIBUTION' | 'UNVERIFIED' | 'SENSOR_FAULT'

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
 * Rolling median over the level series, THREE samples wide.
 *
 * ## Why any filter
 *
 * Every quantity below is an extremum — `max` of the readings before, `min`
 * during, `max` after — so a SINGLE bad reading sets it. That is not a
 * hypothetical: over 362k consecutive-ping deltas on live fuel telemetry
 * (2 days, both orgs) the 99th percentile jump is ~5 L between one ping and the
 * next, on a probe whose median step is 0 ml.
 *
 * The expensive direction is the after-window. One spuriously high reading
 * there raises `peakAfter`, the recovery ratio clears RECOVERY_THRESHOLD, and a
 * real theft is written off as REDISTRIBUTION — the only verdict that leaves
 * the loss figures. A one-sample glitch should not be able to do that.
 *
 * ## Why three samples, and not "the last N minutes"
 *
 * A median of three removes exactly an ISOLATED bad reading and preserves any
 * move sustained for two consecutive readings, which is the narrowest filter
 * that does the job — and narrow is what this data needs. Drains are short:
 *
 *   detected_at − began_at   p25      p50
 *   KASULU                   1.5 min  11.0 min
 *   SUKARI                   0.8 min   2.3 min
 *
 * against a ping interval of ~28-30 s. A five-minute window — the obvious
 * reading of "median filter the last N minutes" — is wider than the median
 * SUKARI drain and would smooth away the very event it is meant to measure.
 * Three samples spans about a minute and a half at the usual rate, and shrinks
 * with the sampling gap rather than swallowing a fixed span of time.
 *
 * A drop that lasts one reading and is gone by the next is, by definition, not
 * a sustained loss, so losing it is the correct behaviour and not a cost.
 *
 * ## What it actually moves
 *
 * Backtested over all 833 adjudicated drains (481k level readings), same code
 * with the filter on and off: **15 verdicts change, 1.8%**, for a net 51 L more
 * written off across the whole ledger. Five of those keep their verdict and
 * only correct the REASON from `drop-not-observed` to `no-drop-observed` —
 * cases where the drop was entirely one bad reading.
 *
 * So this is a correctness fix, not a money fix, and it should not be sold as
 * one. It removes a way for a single glitch to decide a verdict; it does not
 * meaningfully change what the ledger reports today.
 *
 * (Raising the trough by removing a spurious low necessarily raises the
 * recovery RATIO, since numerator and denominator both fall by the same amount.
 * That is why four drains move LOSS -> REDISTRIBUTION: if the trough was fake
 * the real drop was smaller, so the same returned volume is a larger share of
 * it. Correct, but it is the write-off direction, so worth knowing.)
 */
const MEDIAN_WINDOW = 3

const medianOf3 = (a: number, b: number, c: number): number =>
  Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))

/**
 * Median-filter a level series, preserving each sample's timestamp.
 *
 * Sorted defensively: the callers below select by timestamp and take extrema,
 * so ordering never used to matter, and a filter that silently depends on it is
 * the kind of coupling that breaks quietly a year later.
 *
 * Endpoints take the median of the nearest three rather than being passed
 * through. Padding the edges by repeating them — the usual trick — would leave
 * a spike at either end untouched, and both ends are load-bearing here: the
 * first samples set the baseline and the last set the recovery.
 */
export function smoothLevels(samples: readonly LevelSample[]): LevelSample[] {
  const ordered = [...samples].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())
  const n = ordered.length
  if (n < MEDIAN_WINDOW) return ordered

  const v = ordered.map(s => s.fuelLevelMl)
  return ordered.map((s, i) => {
    const j = i === 0 ? 1 : i === n - 1 ? n - 2 : i
    return { capturedAt: s.capturedAt, fuelLevelMl: medianOf3(v[j - 1], v[j], v[j + 1]) }
  })
}

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

  // ── is the probe working at all? ─────────────────────────────────────────
  //
  // Asked for directly: if a probe is not functional, ignore it. A dead FLS
  // must not produce a verdict of any kind — judging its output was how a
  // broken sensor ended up counted as loss and announced against a driver.
  //
  // Two ways to be sure the instrument, not the tank, is the problem:
  //
  //   ZERO THROUGHOUT. The window opens 30 minutes BEFORE the drain began, so
  //   a series that is zero all the way through says the tank read empty
  //   before the "theft" started. There was nothing there to take. This needs
  //   no engine evidence — it is not a claim about the machine, it is the
  //   observation that the claimed fuel was never on the gauge.
  //
  //   FLAT THROUGHOUT. One value for three and a half hours while the engine
  //   is running: a working machine burns fuel, so a gauge that never moves is
  //   not reading it. Engine evidence IS required here, because a genuinely
  //   parked vehicle holding a steady level is the normal case, not a fault.
  //
  // 37 of 298 probes (12.4%) sit at exactly zero, measured 2026-08-11.
  if (samples.length >= MIN_SAMPLES) {
    const vals = samples.map(s => s.fuelLevelMl)
    const running = samples.filter(s => s.engineOn === true).length
    const flat = Math.min(...vals) === Math.max(...vals)
    if (vals.every(v => v === 0) || (flat && running >= DROPOUT_MIN_RUNNING)) {
      return { verdict: 'SENSOR_FAULT', recoveredMl: null, reason: 'fsl-dead' }
    }
  }

  // Filtered ONCE, over the whole run, before it is split. Smoothing each
  // segment on its own would leave the reading at each boundary without the
  // neighbours that decide it — and the boundaries are where the baseline and
  // the trough are read.
  const level = smoothLevels(samples)

  const before = level.filter(s => s.capturedAt <= claim.beganAt)
  // Only readings BEFORE any filling can speak to a recovery — after one, a
  // rise is explained by the fuel that was just put in. Cutting the window at
  // the filling rather than discarding the whole case matters: a refuel two
  // hours later says nothing about a level that came back five minutes after
  // the drain, and on the live ledger 29-35% of drains have a filling
  // somewhere in the window. Throwing those away would forfeit most of what
  // is decidable.
  const after = level.filter(s =>
    s.capturedAt >= claim.detectedAt && (fillingAt == null || s.capturedAt < fillingAt))

  if (before.length < MIN_SAMPLES || after.length < MIN_SAMPLES) {
    // Distinguish "no readings" from "a filling landed too soon to see past" —
    // they are different problems and only one is ours to fix.
    return fillingAt != null && after.length < MIN_SAMPLES
      ? { verdict: 'UNVERIFIED', recoveredMl: null, reason: 'filling-too-soon' }
      : { verdict: 'UNVERIFIED', recoveredMl: null, reason: 'insufficient-telemetry' }
  }

  // Is this a dead probe rather than a drain? Tested BEFORE the drop rules,
  // because a probe falling to zero produces a textbook large sustained drop
  // and would otherwise be confirmed as the biggest loss the vehicle ever had.
  //
  // Deliberately reads the RAW series, not the filtered one: this asks whether
  // the readings are literally zero, and smoothing near the step could leave a
  // small non-zero value at the boundary and hide the fault.
  const rawAfter = samples.filter(s => s.capturedAt >= claim.detectedAt)
  const baselineBefore = Math.max(...before.map(s => s.fuelLevelMl))
  if (rawAfter.length >= MIN_SAMPLES &&
      baselineBefore >= DROPOUT_MIN_BASELINE_ML &&
      rawAfter.every(s => s.fuelLevelMl === 0) &&
      rawAfter.filter(s => s.engineOn === true).length >= DROPOUT_MIN_RUNNING) {
    return { verdict: 'SENSOR_FAULT', recoveredMl: null, reason: 'fsl-dropout' }
  }

  // The drop as OUR telemetry saw it — the highest level before it started
  // down to the lowest during it. Deliberately measured rather than taken from
  // the claim's own initial/final levels, so the recovery is judged against
  // the same series that would show it returning.
  const baseline = Math.max(...before.map(s => s.fuelLevelMl))
  const during   = level.filter(s => s.capturedAt >= claim.beganAt && s.capturedAt <= claim.detectedAt)
  const trough   = Math.min(...(during.length ? during : after).map(s => s.fuelLevelMl))
  const drop     = baseline - trough
  if (drop <= 0) {
    // Our series never saw the level fall. That is not evidence of a recovery,
    // it is evidence the two sources disagree about what happened.
    return { verdict: 'UNVERIFIED', recoveredMl: null, reason: 'no-drop-observed' }
  }
  // ...and the same is true when it saw a fall far too SMALL to be the one
  // claimed. The recovery ratio below is measured against `drop`, so without
  // this a few millilitres of probe noise that wobbled and settled would clear
  // a claim of tens of litres: KTCC 850B on 2026-08-07 was ruled REDISTRIBUTION
  // on 19 ml recovered against a 25,830 ml claim — a ratio of 0.0007 — which is
  // not evidence the fuel came back, but evidence we never saw it leave.
  //
  // `drop <= 0` was the only version of this check, so anything above zero was
  // treated as the claimed event no matter its size.
  if (claim.stolenMl > 0 && drop < claim.stolenMl * OBSERVED_DROP_MIN_RATIO) {
    return { verdict: 'UNVERIFIED', recoveredMl: null, reason: 'drop-not-observed' }
  }

  const peakAfter   = Math.max(...after.map(s => s.fuelLevelMl))
  const recoveredMl = Math.max(0, Math.min(peakAfter - trough, drop))

  return (peakAfter - trough) / drop >= RECOVERY_THRESHOLD
    ? { verdict: 'REDISTRIBUTION', recoveredMl, reason: 'level-recovered' }
    : { verdict: 'LOSS', recoveredMl, reason: 'level-stayed-down' }
}
