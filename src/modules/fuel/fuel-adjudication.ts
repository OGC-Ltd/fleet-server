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
 * Erring high is the safe direction: failing this check leaves the row a DRAIN
 * and only withholds confirmation, so the volume still counts. Nothing is
 * written off by it and no real drain can be hidden by it — the opposite of the
 * failure it fixes, where an unobserved claim was written off on noise.
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

/**
 * What happened to the fuel — a description of the event, not an accusation.
 *
 * The vocabulary changed on 2026-08-11 at the operator's instruction: a level
 * that moves is a REFILL, a DRAIN or a REDISTRIBUTION, and nothing here says
 * "loss", "theft" or "stolen". The old set carried LOSS and UNVERIFIED, and
 * both were the wrong shape:
 *
 *   LOSS asserted where the fuel went. We cannot see that. All we observe is
 *   that the level fell and did not come back, which is what DRAIN says and as
 *   far as the telemetry can honestly go. Whether a drain was theft, a
 *   transfer, or a machine working hard is not a question this data answers,
 *   and the word decided it for the reader.
 *
 *   UNVERIFIED was not a description of the fuel at all — it was a description
 *   of OUR evidence, promoted to a verdict. It made 1,938 of 2,571 rows
 *   unreadable: an operator could not tell whether the fuel had gone. That
 *   distinction is real and it is kept, but it belongs on `confirmed` and in
 *   `reason`, beside the verdict rather than instead of it.
 *
 * So the verdict answers "what happened" and `confirmed` answers "how sure are
 * we", which are separate questions that were previously mashed into one field.
 */
export type Verdict =
  /** Too recent to judge — the level may still come back. */
  | 'PENDING'
  /**
   * Fuel went IN. RESERVED, and never produced by this module: every row on
   * `fuel_thefts` is a reported DROP, so a refill is not something a drain can
   * turn out to be. Real refills are `fuel_fillings` rows and the dashboard
   * renders those green.
   *
   * It briefly WAS assigned here, to drains whose recovery window a filling
   * had closed, and the result was a negative volume drawn in green. See the
   * filling-too-soon note in adjudicateDrain.
   */
  | 'REFILL'
  /** The level went down and did not come back. */
  | 'DRAIN'
  /** The level came back with no filling: undulation, it never left the tank. */
  | 'REDISTRIBUTION'
  /** The probe failed, not the tank. Not a fuel event at all. */
  | 'SENSOR_FAULT'

export interface Adjudication {
  verdict:     Verdict
  /** Millilitres of the observed drop that returned, when measurable. */
  recoveredMl: number | null
  /** Short slug naming the rule that decided, for auditing. */
  reason:      string
  /**
   * Did OUR OWN telemetry corroborate the verdict, or is this the provider's
   * claim passed through because we could not check it?
   *
   * Derived from `reason`, never stored: `verdictReason` is already a column
   * and a second one that must agree with it is a second one that can disagree
   * with it. This is what carries the confidence that UNVERIFIED used to, and
   * it is what decides whether a drain is announced as critical or as a report
   * we could not confirm.
   */
  confirmed:   boolean
}

/** The reasons that mean we watched the level ourselves and saw the outcome. */
const CONFIRMED_REASONS: ReadonlySet<string> = new Set(['level-stayed-down', 'level-recovered'])

/** Did our own telemetry corroborate this, or are we relaying the claim? */
export const isConfirmed = (reason: string): boolean => CONFIRMED_REASONS.has(reason)

/**
 * The reasons that mean "we could not look", as opposed to "we looked and the
 * claim did not survive it".
 *
 * Both outcomes below are produced by an ABSENCE of readings rather than by
 * anything the readings say, which makes them the two a re-judgement can reach
 * for a reason having nothing to do with the drain: the telemetry that existed
 * when the row was first judged may simply not be there any more.
 * (`filling-too-soon` belongs here for the same reason — it is
 * `insufficient-telemetry` in the case where a filling happens to sit in the
 * window, so an empty window with a refuel in it lands on that reason instead.)
 *
 * A backfill must never overwrite a verdict that WAS decided on evidence with
 * one that says we have none. That trades a judgement for the absence of a
 * judgement, on nothing but data ageing out. See
 * `prisma/readjudicate-fuel.ts`, which is the only caller.
 */
const NO_EVIDENCE_REASONS: ReadonlySet<string> = new Set(['insufficient-telemetry', 'filling-too-soon'])

/** True when this adjudication reports an absence of readings, not a finding. */
export const isUncheckable = (a: Adjudication): boolean =>
  !a.confirmed && NO_EVIDENCE_REASONS.has(a.reason)

// ─── the probe trust gate ──────────────────────────────────────────────────
//
// Everything above reasons about ONE event: did the level fall, did it come
// back. This asks a different question — is this particular instrument worth
// believing at all — and it is deliberately kept separate because it is a fact
// about the machine rather than about the drain.
//
// ## What was asked for, and why it is not what shipped
//
// The operator's case on `MUFINDI: DZ 07` (-61.7, -51.6, +51.6, +23.9, -23.7 L
// in 55 min) came with a diagnosis: a part-full tank on undulating ground, and
// *"without the original tank state you cannot make a decision on if this is a
// theft or not."* The event is real. The diagnosis, tested, is not.
//
// `vehicles.tankCapacityLitres` is populated for 466 units and does not agree
// with the probes: the median unit's sustained maximum is 0.64 of its declared
// capacity, 120 of 299 never read above half of it, and 16 read ABOVE it —
// `MUFINDI: DZ 16` sustains 7,204 L on a declared 540 L tank. Observed maximum
// is no better as a substitute: max over sustained-max runs to 12x at p99.
// So the denominator of a fill fraction is unreliable in both directions.
//
// Worse, on the 119 units where the two sources DO corroborate each other
// (within 20%), the hypothesis itself fails. Parked half-hours, by fill:
//
//   fill      windows   swing p50  p90  p95   share >=10 L
//     0- 10%       77         0    1    1        3.90%
//    40- 50%      524         1   17   23       18.70%
//    70- 80%      703         3   19   36       21.76%
//    90-100%      922         1   15   20       16.49%
//
// A fuller tank swings MORE, not less — which is physically unsurprising, since
// there is more fuel free to move and a probe near the bottom of its range has
// little above it to move away. A gate that suppressed verdicts on part-full
// tanks would have suppressed the wrong ones. (This is a second, separate
// failure of fill fraction: §"Why the level series and nothing else" above
// records it failing as a CLASSIFIER. It now also fails as a TRUST GATE.)
//
// ## What the data does support
//
// The same question asked of the MACHINE instead of the tank. Big parked
// swings are not spread across the fleet — they are concentrated:
//
//   97 of 139 units never swing >=25 L while parked
//   80% of all >=25 L swings come from 13 vehicles (9% of the fleet)
//
// and unlike fill fraction, it predicts the verdict. Over the 82 units with a
// parked-swing profile and a drain, at 25 L / 5%:
//
//   swingy probes: 132 REDISTRIBUTION / 238 LOSS  ->  36% came back
//   steady probes:  36 REDISTRIBUTION / 226 LOSS  ->  14% came back
//
// against fill fraction's 0.62 vs 0.63.
//
// Read that 2.6x with its date on it: it was measured BEFORE the 2026-08-11
// backfill, which moved 187 rows out of LOSS and so changed both populations.
// Re-measured against the ledger as it now stands the same split gives 41% vs
// 28%, a separation of 1.47x. That is the number this gate actually ships on,
// and it is the smaller one — quoting the pre-backfill figure for a rule
// deployed after it would be measuring against verdicts we have since
// withdrawn. The direction and the concentration survive; the magnitude was
// partly the old ledger's over-confidence, which is what the backfill removed.
//
// `MUFINDI: DZ 07`, the case that started this, swings >=25 L in 9 of its 12
// parked half-hours with a worst of 116 L — see MIN_SWING_WINDOWS for why the
// obvious form of this rule missed it.

/**
 * How large a parked swing counts as the probe moving on its own.
 *
 * 25 L, which is the median claim on the whole ledger (p50 27.0 L, p25 16.2,
 * p75 45.1). That is the point of the number: a probe over this line moves, on
 * a machine standing still, by more than a typical drain claims was stolen.
 *
 * Chosen against the alternatives rather than assumed. Separation of
 * REDISTRIBUTION from LOSS across the grid (pre-backfill ledger, see the note
 * above on why that matters): 15 L/5% 1.95x, 15 L/10% 2.51x, 25 L/5% 2.60x,
 * 25 L/10% 2.27x, 40 L/5% 2.14x. 25 L at 5% is the best cell, and the
 * neighbours degrade gently, so it is not perched on a spike.
 */
export const SWING_ML = 25_000

/**
 * What share of a probe's parked windows must swing before it is distrusted.
 *
 * Both conditions earn their place. Dropping the share and keeping only the
 * count below gives 0.95x separation — i.e. nothing.
 */
export const SWING_SHARE = 0.05

/**
 * How many windows must actually have swung.
 *
 * This counts the EVIDENCE, not the opportunity, and the difference decided the
 * operator's own case. The obvious guard is a minimum number of PARKED windows,
 * on the reasoning that a machine with three of them clears 5% on a single one.
 * That guard excluded `MUFINDI: DZ 07`: 12 parked half-hours, 9 of them
 * swinging, a 75% share and the worst single swing on the fleet at 116 L. It is
 * not a thin case, it is the strongest one — it simply spends its time working
 * rather than standing still, which is what a dozer does.
 *
 * Measured against the ledger as it stands after the 2026-08-11 backfill,
 * separation of REDISTRIBUTION from LOSS on the machines each rule selects:
 *
 *   >=20 parked windows, >=5% share    1.27x   (excludes DZ 07)
 *   >=10 parked windows, >=5% share    1.39x
 *   >=3 SWINGING windows, >=5% share   1.47x   (includes DZ 07)
 *   >=5 swinging windows, >=5% share   1.39x
 *   >=3 swinging windows, no share     0.95x
 *
 * Three swinging windows also drops `MUFINDI - DZ 20` (1 swing in 20 parked)
 * and `MUFINDI: EX 14` (2 in 20), which is the thin evidence the parked-window
 * guard was reaching for and did not catch.
 */
export const MIN_SWING_WINDOWS = 3

/** A vehicle's probe as its own recent history describes it. */
export interface ProbeProfile {
  /** Half-hours the machine stood still with enough readings to measure. */
  parkedWindows: number
  /** How many of those swung at least SWING_ML from trough to peak. */
  swingWindows:  number
}

/** Does this probe move about on a machine that is standing still? */
export const probeSwings = (p: ProbeProfile | null | undefined): boolean =>
  p != null && p.parkedWindows > 0 &&
  p.swingWindows >= MIN_SWING_WINDOWS &&
  p.swingWindows / p.parkedWindows >= SWING_SHARE

/**
 * Withdraw the CONFIRMATION from a drain measured on a probe that cannot hold
 * still. The verdict itself does not change.
 *
 * This is where the new vocabulary earns itself. Under the old set the gate
 * moved a row LOSS -> UNVERIFIED, which was one field doing two jobs: it
 * downgraded our confidence AND it stopped describing what happened to the
 * fuel. With `verdict` and `confirmed` separated the gate touches only the
 * second — the level still fell and stayed down, so it is still a DRAIN, and
 * what we withdraw is the claim that our own telemetry settles it.
 *
 * Applied to a confirmed DRAIN and nothing else:
 *
 *   NOT to REDISTRIBUTION, though the instrument is equally suspect there. A
 *   REDISTRIBUTION says the fuel came back, and withdrawing it would push the
 *   volume back toward being reported as gone — the exact opposite of what the
 *   operator wants on DZ 07, whose recovered drains are the ones they agree
 *   with. The gate exists to stop us asserting more than we can support, not to
 *   unpick the cases where we already declined to.
 *
 *   NOT to an unconfirmed drain: there is nothing left to withdraw.
 *
 * No volume moves in either direction — a DRAIN counts the same whether or not
 * it is confirmed. What changes is that the drain stops being announced as
 * critical against whoever was driving.
 *
 * Kept out of `adjudicateDrain` so the level-series reasoning stays one thing:
 * this is evidence about the instrument, arrives from a different query, and is
 * fetched lazily by the service for the minority of rows that reach a confirmed
 * drain.
 */
export function applyProbeTrustGate(a: Adjudication, profile: ProbeProfile | null): Adjudication {
  if (a.verdict !== 'DRAIN' || !a.confirmed || !probeSwings(profile)) return a
  return { verdict: 'DRAIN', recoveredMl: a.recoveredMl, reason: 'probe-swings', confirmed: false }
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
    return { verdict: 'PENDING', recoveredMl: null, reason: 'settling', confirmed: false }
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
      return { verdict: 'SENSOR_FAULT', recoveredMl: null, reason: 'fsl-dead', confirmed: true }
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
    // Both are a DRAIN we could not check. The reason distinguishes them for
    // auditing, but neither is a finding about where the fuel went.
    //
    // `filling-too-soon` briefly returned REFILL, on the reasoning that fuel
    // demonstrably went IN so the reported drop was explained. That was wrong
    // twice over and it shipped:
    //
    //   It is an ABSENCE of evidence, not a finding. We cannot tell "the drop
    //   was spurious and they refuelled" from "fuel was taken and then they
    //   refuelled" — the two are identical in this data. Calling it a refill
    //   asserts the first. This module removes what it can DISPROVE, never
    //   what it merely doubts, and that rule broke the principle.
    //
    //   The filling that closes the window is not necessarily real. On a probe
    //   that oscillates, Wialon logs the up-swings as fillings and the
    //   down-swings as thefts. `MUFINDI - EX 22` on 2026-08-10 ran
    //   -21.7 L, +29.1, +24.8, -27.7 L, +28.2 inside four minutes: the -21.7 L
    //   was correctly ruled REDISTRIBUTION, while the -27.7 L had its recovery
    //   window cut by "fillings" that were the same noise, and came out a
    //   REFILL. A negative volume then rendered green on the dashboard.
    //
    // So no drain row is ever a REFILL. A refill is a level INCREASE and lives
    // in `fuel_fillings`; this table only ever holds reported drops.
    return { verdict: 'DRAIN', recoveredMl: null, confirmed: false,
             reason: fillingAt != null && after.length < MIN_SAMPLES
               ? 'filling-too-soon'
               : 'insufficient-telemetry' }
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
    return { verdict: 'SENSOR_FAULT', recoveredMl: null, reason: 'fsl-dropout', confirmed: true }
  }

  // The drop as OUR telemetry saw it — the highest level before it started
  // down to the lowest during it. Deliberately measured rather than taken from
  // the claim's own initial/final levels, so the recovery is judged against
  // the same series that would show it returning.
  const baseline = Math.max(...before.map(s => s.fuelLevelMl))
  // The trough is the lowest level reached ANYWHERE after the drain started —
  // during the provider's own window OR in the settle window after it.
  //
  // It used to be taken from the provider's window alone, and that silently
  // under-called real drains whose fall lags the event. `MUFINDI - EX 09` on
  // 2026-08-10: Wialon claimed 220 -> 199 L between 14:37 and 14:50, and our
  // own readings show
  //
  //     14:37  220.5L     14:52  212.7L     15:09  199.1L
  //     14:49  219.4L     14:58  203.7L     15:30  198.8L
  //
  // — a 21 L fall that matches the claim almost exactly and holds for half an
  // hour, on a machine parked with the engine off. But the level had barely
  // moved by 14:50, so the trough came out ~219, the measured drop ~1 L, and
  // OBSERVED_DROP_MIN_RATIO threw it out as `drop-not-observed`: "we never saw
  // it fall". We had seen it fall; we were looking two minutes too early.
  //
  // Searching the whole post-drain span cannot manufacture a drop that is not
  // there: a level that never falls still yields a trough at the baseline.
  //
  // It does move the RECOVERY test, though, and that has to move with it. The
  // recovery is "did the level come back UP AFTER its low point", so the peak
  // must be measured from the trough onwards. Taking the maximum of the whole
  // after-window, as this did while the trough was pinned inside the
  // provider's window, would now write off the very drains this is meant to
  // catch: a level that sits at 200 L and falls to 150 L late would yield
  // peak 200, trough 150, recovery ratio 1.0 — a perfect "it came back" read
  // off a fall that never recovered at all.
  const during   = level.filter(s => s.capturedAt >= claim.beganAt && s.capturedAt <= claim.detectedAt)
  const post     = [...during, ...after]
  const lowest   = post.reduce((lo, s) => s.fuelLevelMl < lo.fuelLevelMl ? s : lo, post[0]!)
  const trough   = lowest.fuelLevelMl
  const drop     = baseline - trough
  if (drop <= 0) {
    // Our series never saw the level fall. That is not evidence of a recovery,
    // it is evidence the two sources disagree about what happened — so the
    // provider's claim stands as a DRAIN, unconfirmed. A filling in the window
    // does NOT make it a refill: see the filling-too-soon note above.
    return { verdict: 'DRAIN', recoveredMl: null, reason: 'no-drop-observed', confirmed: false }
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
    return { verdict: 'DRAIN', recoveredMl: null, reason: 'drop-not-observed', confirmed: false }
  }

  // Only readings at or after the low point can speak to a recovery from it.
  const recovery    = after.filter(s => s.capturedAt >= lowest.capturedAt)
  const peakAfter   = recovery.length ? Math.max(...recovery.map(s => s.fuelLevelMl)) : trough
  const recoveredMl = Math.max(0, Math.min(peakAfter - trough, drop))

  // The only two outcomes we watched happen ourselves, and so the only two
  // that come back confirmed.
  return (peakAfter - trough) / drop >= RECOVERY_THRESHOLD
    ? { verdict: 'REDISTRIBUTION', recoveredMl, reason: 'level-recovered',  confirmed: true }
    : { verdict: 'DRAIN',          recoveredMl, reason: 'level-stayed-down', confirmed: true }
}
