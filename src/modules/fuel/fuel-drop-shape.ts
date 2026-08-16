/**
 * The SHAPE of a falling fuel level, and how much engine ran while it fell.
 *
 * Pure: no clock, no database. Two questions, both of which the theft
 * classifier needs and neither of which `fuel-adjudication` asks:
 *
 *   · **How much engine time is inside this window?** Which turns a drop in
 *     millilitres into a burn RATE, and so lets it be compared against what the
 *     machine is known to consume.
 *   · **Does the fall look like a siphon or like liquid settling?** A siphon
 *     removes fuel at a steady rate. A tank finding its level after the machine
 *     shuts down on a slope drops fast and then slows, the way anything
 *     approaching equilibrium does.
 *
 * Written as its own module rather than inside the classifier because the
 * measurement harness (`prisma/fuel-cause-measure.ts`) has to run exactly the
 * same arithmetic to choose the thresholds the classifier will use. Two copies
 * of a curve fit would mean tuning against one and shipping the other — the
 * same failure `judgeDrain` was created to prevent when the backfill kept its
 * own copy of the evidence query and silently diverged.
 */

/** A level reading. Structurally the `LevelSample` adjudication already uses. */
export interface ShapeSample {
  capturedAt:  Date
  fuelLevelMl: number
  /**
   * MEASURED engine state, or undefined where the provider sent none.
   *
   * `undefined` is not "off" and callers must never collapse the two. The
   * telemetry column this usually comes from cannot make the distinction —
   * `vehicle_telemetries.engine_on` is NOT NULL with a default of false and the
   * Wialon adapter fills it as `ignition ?? (speed > 0)` — so a caller reading
   * that column directly is handing this module "was it moving" dressed up as
   * "was the engine running". The raw payload's `ignition_known` is what
   * separates them.
   */
  engineOn?:   boolean
}

/** A reading with the motion evidence a fall measurement also needs. */
export interface FallSample extends ShapeSample {
  speedKmh?: number | null
}

/**
 * Longest gap that may count as continuous engine running, in seconds.
 *
 * Matched to `MAX_RUN_GAP_SECONDS` in `fuel-rate.service`, which cuts a
 * consumption run at the same span, so the two agree on what "the engine was on
 * for this long" means. Without a cap a unit that reports, goes silent for
 * three hours and reports again would contribute three engine-hours from two
 * readings, and the implied burn rate computed against it would be nonsense in
 * the direction that suppresses alerts.
 */
export const MAX_ENGINE_GAP_SECONDS = 900

/**
 * Seconds of engine-on time between two instants, integrated over the pings.
 *
 * This is the substitute for motohours at event resolution, and the reason the
 * plan does not use Wialon's `cneh` counter: that counter only advances when
 * the poller's reconcile sweep re-reads it, so it has day resolution, while a
 * drain is often under ten minutes long.
 *
 * Each interval is credited when the reading that OPENS it has the engine on.
 * The opening sample is the one that describes the interval that follows it —
 * crediting on the closing sample instead would attribute a period of running
 * to the minutes before the engine actually started.
 *
 * Samples with no engine reading at all contribute nothing. That biases the
 * total DOWN, which biases the implied burn rate UP, which is the direction
 * that makes a drop look less like ordinary consumption. The caller must treat
 * a window with little engine evidence as unknown rather than as parked — see
 * `engineEvidenceRatio`.
 */
export function engineOnSeconds(
  samples: readonly ShapeSample[],
  from: Date,
  to: Date,
): number {
  const win = samples
    .filter(s => s.capturedAt >= from && s.capturedAt <= to)
    .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())

  let total = 0
  for (let i = 0; i < win.length - 1; i++) {
    if (win[i]!.engineOn !== true) continue
    const dt = (win[i + 1]!.capturedAt.getTime() - win[i]!.capturedAt.getTime()) / 1000
    total += Math.min(dt, MAX_ENGINE_GAP_SECONDS)
  }
  return total
}

/**
 * What share of the window's readings carry an engine state at all.
 *
 * Ignition arrives on 78.9% of KASULU readings and 64.3% of SUKARI's (sensor
 * census, 2026-08-16), so "no engine-on samples" genuinely means "we do not
 * know" on a substantial minority of units — never "the machine was off". A
 * theft verdict that requires the engine to be off must know which of the two
 * it is looking at.
 */
export function engineEvidenceRatio(
  samples: readonly ShapeSample[],
  from: Date,
  to: Date,
): number {
  const win = samples.filter(s => s.capturedAt >= from && s.capturedAt <= to)
  if (win.length === 0) return 0
  return win.filter(s => s.engineOn != null).length / win.length
}

// ─── curve fitting ─────────────────────────────────────────────────────────

export interface Fit {
  /** Root-mean-square residual, in millilitres. */
  rmse: number
}

export interface LinearFit extends Fit {
  /** Millilitres per second. Negative while the level falls. */
  slope:     number
  intercept: number
}

export interface DecayFit extends Fit {
  /** Decay constant, per second. Larger = settles faster. */
  k:         number
  /** Millilitres the curve falls through, from start to asymptote. */
  amplitude: number
  /** The level the curve is heading for. */
  asymptote: number
  /**
   * `k` × the window duration — the curve's SHAPE, independent of how long we
   * watched. This is the number that actually separates settling from a
   * siphon, and the raw `k` is not:
   *
   *   kT ≪ 1  the exponential has barely begun to bend; over this window it
   *           IS a straight line, whatever the fitter returned
   *   kT ≳ 1  the fall visibly flattens before the window ends — the
   *           signature of liquid finding its level
   */
  kT:        number
}

/**
 * A fit's residual as a share of the fall it was fitted to.
 *
 * The comparable form of `rmse`. A 200 ml residual is excellent on a 100 L
 * fall and hopeless on a 2 L one, so no threshold can be written against the
 * raw figure. Both models leaving a large normalised residual is the signature
 * of a step — see `fitDecay`'s note.
 */
export const normalisedResidual = (fit: Fit | null, dropMl: number): number | null =>
  fit == null || dropMl <= 0 ? null : fit.rmse / dropMl

/** Points as (seconds from the first sample, millilitres). */
function toXY(samples: readonly ShapeSample[]): Array<[number, number]> {
  const ordered = [...samples].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())
  const t0 = ordered[0]?.capturedAt.getTime() ?? 0
  return ordered.map(s => [(s.capturedAt.getTime() - t0) / 1000, s.fuelLevelMl])
}

const rmseOf = (residuals: readonly number[]): number =>
  Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length)

/** Ordinary least squares against `basis(x)`, solved for 2 coefficients. */
function ols2(
  pts: ReadonlyArray<[number, number]>,
  basis: (x: number) => [number, number],
): { c0: number; c1: number; rmse: number } | null {
  let s00 = 0, s01 = 0, s11 = 0, sy0 = 0, sy1 = 0
  for (const [x, y] of pts) {
    const [b0, b1] = basis(x)
    s00 += b0 * b0; s01 += b0 * b1; s11 += b1 * b1
    sy0 += b0 * y;  sy1 += b1 * y
  }
  const det = s00 * s11 - s01 * s01
  // Singular: the two basis functions are indistinguishable over these points,
  // which happens when every x is identical or when k is small enough that
  // e^(-kx) is constant to floating point. No fit exists; say so.
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null

  const c0 = (sy0 * s11 - sy1 * s01) / det
  const c1 = (sy1 * s00 - sy0 * s01) / det
  const residuals = pts.map(([x, y]) => {
    const [b0, b1] = basis(x)
    return y - (c0 * b0 + c1 * b1)
  })
  return { c0, c1, rmse: rmseOf(residuals) }
}

/** Straight line through the points. */
export function fitLinear(samples: readonly ShapeSample[]): LinearFit | null {
  const pts = toXY(samples)
  if (pts.length < 3) return null
  const f = ols2(pts, x => [1, x])
  return f ? { intercept: f.c0, slope: f.c1, rmse: f.rmse } : null
}

/**
 * Exponential decay `y = C + A·e^(−k·t)` — a level settling toward equilibrium.
 *
 * `k` enters non-linearly, so it is found by a coarse-to-fine SCAN rather than
 * by a solver: for any fixed `k` the remaining two coefficients are an ordinary
 * least-squares problem, so the scan costs one 2×2 solve per candidate. That is
 * both cheaper and far more predictable than Levenberg-Marquardt on a few dozen
 * noisy points, and it cannot diverge.
 *
 * The scan runs over `kT` — decay constant times window length — rather than
 * over `k` itself, so the same grid is appropriate for a four-minute drop and a
 * three-hour one.
 *
 * ## This will almost always beat the straight line, and that is not a finding
 *
 * As `k → 0`, `e^(−kt) → 1 − kt`: the decay family CONTAINS the straight line
 * in its limit. So a decay fit's residual is essentially never worse than a
 * linear one, and "the curve fits better" is therefore not evidence of a curve.
 *
 * ## `kT` ALONE IS NOT THE DISCRIMINATOR EITHER — measured, 2026-08-16
 *
 * The obvious reading of this module ("high kT means settling") is wrong, and
 * wrong in the dangerous direction. A STEP — the level falling between two
 * consecutive readings and staying down, which is the operator's own
 * description of siphoning — is in neither model family, and what the fitter
 * returns for it depends on WHERE IN THE WINDOW the step happens to sit:
 *
 *   shape                     kT     decay rmse    half-slope
 *   step at 5% of window     8.000        5,785         0.000
 *   step at 25%              4.066        8,280         0.000
 *   step at 50%              0.050        9,992         0.000
 *   straight line            0.050            5         1.000
 *   decay, tau = 300 s       4.066          214         0.141
 *   decay, tau = 1200 s      0.965           11         0.614
 *
 * Two things follow, and both are load-bearing for the classifier:
 *
 *   · **`half-slope` reads 0.000 for every step**, identical to a settle,
 *     because the flat stretches either side of the step have no slope. A rule
 *     of "half-slope well below 1 means settling" would file every sharp
 *     siphon on the fleet as noise — the exact failure this work exists to
 *     prevent, arrived at from the opposite direction.
 *
 *   · **The RESIDUAL is what separates a step from both models.** A real decay
 *     fits to 11-214 ml and a real line to 5 ml, while a step cannot be fitted
 *     by either and leaves thousands. So a poor fit from BOTH is itself the
 *     signature of a step.
 *
 * The robust discriminator is therefore the model-free one — what share of the
 * drop happened in a single interval — with the residual as corroboration.
 * `kT` is useful only to confirm a settle once a step has been ruled out.
 */
export function fitDecay(samples: readonly ShapeSample[]): DecayFit | null {
  const pts = toXY(samples)
  if (pts.length < 4) return null
  const span = pts[pts.length - 1]![0] - pts[0]![0]
  if (span <= 0) return null

  let best: { k: number; c0: number; c1: number; rmse: number } | null = null
  // kT from 0.05 (indistinguishable from a line) to 8 (fully settled well
  // before the window ends). Geometric, because what matters is the ORDER of
  // magnitude of the bend, not its absolute value.
  const STEPS = 60
  for (let i = 0; i <= STEPS; i++) {
    const kT = 0.05 * Math.pow(8 / 0.05, i / STEPS)
    const k  = kT / span
    const f  = ols2(pts, x => [1, Math.exp(-k * x)])
    if (f && (best == null || f.rmse < best.rmse)) best = { k, ...f }
  }
  if (!best) return null

  return {
    k:         best.k,
    kT:        best.k * span,
    asymptote: best.c0,
    amplitude: best.c1,
    rmse:      best.rmse,
  }
}

/**
 * What share of the total fall happened in its single largest interval.
 *
 * The model-free discriminator, and — per the measurement in `fitDecay`'s note
 * — the only one of the three that is not fooled by a step. It assumes no
 * functional form at all, so unlike `kT` it cannot depend on where in the
 * window the event sits.
 *
 *   → 1   the level fell between two consecutive readings and stayed down:
 *         a sharp siphon, or a probe dropping out
 *   ≈ 1/n  the fall was spread evenly across n intervals: a steady drain, a
 *         settle, or ordinary consumption
 *
 * It does NOT distinguish a sharp siphon from a probe glitch — both are steps.
 * That is the recovery test's job (`fuel-adjudication`), which has already run
 * by the time a drop reaches here: a glitch comes back and is REDISTRIBUTION,
 * a siphon does not. This measures the shape and says nothing about the cause.
 *
 * Returns 0 for a series that did not fall.
 */
export function stepFraction(samples: readonly ShapeSample[]): number {
  const ordered = [...samples].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())
  if (ordered.length < 2) return 0
  const drop = ordered[0]!.fuelLevelMl - ordered[ordered.length - 1]!.fuelLevelMl
  if (drop <= 0) return 0

  let biggest = 0
  for (let i = 0; i < ordered.length - 1; i++) {
    biggest = Math.max(biggest, ordered[i]!.fuelLevelMl - ordered[i + 1]!.fuelLevelMl)
  }
  return biggest / drop
}

/**
 * How much the fall slows down: |second-half slope| ÷ |first-half slope|.
 *
 * The interpretable companion to `kT`, and deliberately model-free — it assumes
 * nothing about the functional form, so it cannot be wrong in the way a fitted
 * curve can be.
 *
 *   ≈ 1   the level fell at the same rate throughout — a siphon, a pump, a leak
 *   ≪ 1   it fell fast then eased off — settling, or a drop that had already
 *         finished before our window did
 *   > 1   it accelerated, which is neither, and usually means the window has
 *         caught the start of a second event
 *
 * Returns null when either half is too short to have a slope, or when the first
 * half is flat (nothing to compare against).
 */
export function halfSlopeRatio(samples: readonly ShapeSample[]): number | null {
  const pts = toXY(samples)
  if (pts.length < 6) return null
  const mid = Math.floor(pts.length / 2)
  const slopeOf = (p: ReadonlyArray<[number, number]>): number | null => {
    if (p.length < 2) return null
    const f = ols2(p, x => [1, x])
    return f ? f.c1 : null
  }
  // The halves SHARE the midpoint, so neither is measured across a gap the
  // other owns — with an odd number of points a strict split would drop the
  // interval spanning the middle entirely.
  const a = slopeOf(pts.slice(0, mid + 1))
  const b = slopeOf(pts.slice(mid))
  if (a == null || b == null || Math.abs(a) < 1e-9) return null
  return Math.abs(b) / Math.abs(a)
}

// ─── measuring one fall ────────────────────────────────────────────────────

/**
 * Everything the cause classifier needs about a single fall.
 *
 * Defined here rather than beside the classifier because THIS module is what
 * produces it. The classifier consumes it and must not be able to reach past it
 * to the raw series — that separation is what lets the measurement harness and
 * the live sweep be given identical evidence by construction.
 */
export interface DropEvidence {
  /** Baseline to trough, millilitres, from the smoothed series. */
  dropMl:         number
  /** Wall-clock seconds from the last reading at the top to the trough. */
  fallSeconds:    number
  /** Engine-on seconds inside that span. */
  engineSeconds:  number
  /** Share of the fall's readings carrying a MEASURED ignition. */
  engineEvidence: number
  /** Did anything in the fall report movement? */
  moved:          boolean
  /** Largest single-interval drop ÷ total drop. */
  stepFraction:   number
  /** Decay constant × window length, or null where it could not be fitted. */
  kT:             number | null
  /** Decay residual as a share of the drop. */
  decayResidual:  number | null
  /** Readings in the fall. */
  samples:        number
}

/**
 * How far below the baseline still counts as "on the plateau".
 *
 * The fall does not begin at the baseline READING. The baseline is the highest
 * level in a window that opens 30 minutes before the drain, so a machine
 * sitting full for half an hour and then losing fuel in four minutes would
 * otherwise be measured as a 34-minute fall — dividing its drop rate by eight
 * and turning a siphon into a trickle. Measured 2026-08-16, before this was
 * fixed, parked "falls" had a median duration of 33 minutes, most of it flat.
 *
 * The tolerance exists so a probe wobbling by a few millilitres on the plateau
 * does not re-open the window at its first dip.
 */
export const PLATEAU_TOLERANCE = 0.05

/**
 * Measure the fall inside one drain claim.
 *
 * Takes RAW samples and smooths them here, so no caller has to reproduce the
 * "filter the levels but keep the engine state" step — getting that wrong
 * silently substitutes a smoothed engine flag, which is meaningless.
 *
 * Returns null when the series cannot describe a fall: too few readings either
 * side, or no drop at all. That is not a failure to report, it is the honest
 * answer, and the caller must reach INDETERMINATE rather than guess.
 *
 * Mirrors `adjudicateDrain`'s geometry deliberately — same baseline (highest
 * reading before the claim opens), same trough (lowest anywhere after it
 * began, including the settle window, so a fall that lags the reported event
 * is still that event's fall).
 */
export interface FallMeasurement {
  evidence: DropEvidence
  /**
   * The smoothed fall segment itself, so a caller needing diagnostics the
   * classifier does not use — a half-slope ratio, a linear residual — computes
   * them from the SAME points rather than re-deriving the segment. The
   * measurement harness explores thresholds off this; the live sweep ignores
   * it. Re-deriving is exactly how the harness and the live path would come to
   * measure different falls and nobody would notice.
   */
  fall: FallSample[]
}

export function measureFall(
  samples: readonly FallSample[],
  claim: { beganAt: Date; detectedAt: Date },
  smooth: (s: readonly ShapeSample[]) => ShapeSample[],
): FallMeasurement | null {
  if (samples.length < 6) return null

  // Smoothed ONCE over the whole run, then the engine and motion evidence is
  // re-attached by timestamp: levels are filtered, engine state is not and
  // must not be.
  const byTime = new Map(samples.map(s => [s.capturedAt.getTime(), s]))
  const series: FallSample[] = smooth(samples).map(s => ({
    capturedAt:  s.capturedAt,
    fuelLevelMl: s.fuelLevelMl,
    engineOn:    byTime.get(s.capturedAt.getTime())?.engineOn,
    speedKmh:    byTime.get(s.capturedAt.getTime())?.speedKmh ?? null,
  }))

  const before = series.filter(s => s.capturedAt <= claim.beganAt)
  const after  = series.filter(s => s.capturedAt >= claim.detectedAt)
  if (before.length < 3 || after.length < 3) return null

  const baseline = before.reduce((hi, s) => s.fuelLevelMl > hi.fuelLevelMl ? s : hi, before[0]!)
  const post     = series.filter(s => s.capturedAt >= claim.beganAt)
  if (post.length < 3) return null
  const lowest   = post.reduce((lo, s) => s.fuelLevelMl < lo.fuelLevelMl ? s : lo, post[0]!)

  const dropMl = baseline.fuelLevelMl - lowest.fuelLevelMl
  if (dropMl <= 0) return null

  // Trim the plateau: the descent begins at the LAST reading still at the top.
  const top          = baseline.fuelLevelMl - dropMl * PLATEAU_TOLERANCE
  const beforeTrough = series.filter(s =>
    s.capturedAt >= baseline.capturedAt && s.capturedAt <= lowest.capturedAt)
  const atTop     = beforeTrough.filter(s => s.fuelLevelMl >= top)
  const fallStart = atTop.length > 0 ? atTop[atTop.length - 1]! : baseline

  const fallSeconds = (lowest.capturedAt.getTime() - fallStart.capturedAt.getTime()) / 1000
  if (fallSeconds <= 0) return null

  const fall = series.filter(s =>
    s.capturedAt >= fallStart.capturedAt && s.capturedAt <= lowest.capturedAt)
  const decay = fitDecay(fall)

  return {
    fall,
    evidence: {
      dropMl,
      fallSeconds,
      engineSeconds:  engineOnSeconds(fall, fallStart.capturedAt, lowest.capturedAt),
      engineEvidence: engineEvidenceRatio(fall, fallStart.capturedAt, lowest.capturedAt),
      moved:          fall.some(s => (s.speedKmh ?? 0) > 0),
      stepFraction:   stepFraction(fall),
      kT:             decay?.kT ?? null,
      decayResidual:  normalisedResidual(decay, dropMl),
      samples:        fall.length,
    },
  }
}
