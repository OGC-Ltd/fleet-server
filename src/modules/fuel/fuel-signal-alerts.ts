/**
 * Fuel signal alerts: the seven-stage filter-and-residual detector from the
 * "Fuel Alert Algorithm" specification (2026-09-26), over one unit's series.
 *
 * Pure: no clock, no database. A caller feeds samples oldest first and gets back
 * REFUEL / THEFT_SUSPECTED / LEAK_SUSPECTED / LOW_FUEL events. The service in
 * `fuel-signal-alerts.service` builds the samples from stored telemetry; the
 * `POST /fuel/signal-alerts/evaluate` route feeds a caller's own samples
 * straight in, which is the path for any feed that does carry an IMU.
 *
 * The stages, as specified:
 *
 *   1. median-of-5 then a 1-D Kalman filter on the level
 *   2. gravity removed from the accelerometer by a low-pass estimate
 *   3. the sloshing gate: no classification while dynamic acceleration is high,
 *      and none until `minStable` consecutive calm samples
 *   4. residual = ΔF + C·ΔW over the window since the last reset
 *   5. per-type thresholds, scaled up by tank capacity where it is known
 *   6. debounce: a candidate must persist `nConfirmS` before it is emitted
 *   7. the state machine that ties them together
 *
 * ## Where this departs from the specification's pseudocode, and why
 *
 * **No accelerometer on this fleet.** The census of 2026-08-16
 * (`docs/fuel-theft-discrimination-plan.md` §8) found a g-sensor ARRIVING on
 * 3.2% of KASULU units and 16.4% of SUKARI, and those are Teltonika harsh-event
 * thresholds (`io_253`/`io_254`), not a continuous signal. So stage 2 runs only
 * on samples that carry `ax/ay/az`. Without them the gate falls back to speed:
 * a sample is calm when the unit was still (< STILL_KMH) at both ends of the
 * interval. That keeps the spec's intent — trust the probe only when the liquid
 * has settled — and it is the same "engine off and stationary" fallback the
 * discrimination plan settled on. `motion` in the stats says which ran.
 *
 * **Gravity is seeded from the first IMU sample**, not from zero. From zero,
 * every unit reads |g| ≈ 9.8 m/s² of "dynamic" acceleration on its first
 * samples and is gated as sloshing for several τ for no reason.
 *
 * **LOW_FUEL waits `nConfirmS`**, per stage 6 rule 6. The pseudocode emits it on
 * the first low reading and returns early, which both skips the debounce the
 * prose asks for and stops that sample being classified for anything else.
 *
 * **NORMAL is not reported.** The pseudocode emits it like any other event and
 * resets the window on it; the reset is kept (it is what keeps the window
 * short), the event is not, because "nothing happened" is not an alert.
 *
 * **Unmeasured work suppresses THEFT and LEAK.** The residual adds expected
 * burn back, so when the work behind it is unknown (no ignition reading on a
 * machine judged per engine-hour, no position on one judged per km) the
 * expected term is too small and every ordinary burn looks like loss. 78% of
 * falls had no ignition reading when measured on 2026-08-25. A window that
 * contains an unmeasured increment can still show a REFUEL (the bias runs
 * against it) but never a loss.
 *
 * **A window restarts at the reading that closed the last one**, not at the
 * next sample, so no level change falls between two windows; and contiguous
 * confirmations of one fill or one siphon are reported as one event (see
 * `mergeContiguous`).
 *
 * **A silence in the feed restarts the filters** (GAP_RESET_S), and the
 * cumulative rule only compares against a base that is about fifteen minutes
 * old. The specification assumes regular sampling and says nothing about gaps;
 * without both, one change across a silence was reported as two events.
 *
 * **The 15-minute cumulative leak rule** from stage 6 rule 5 is implemented
 * alongside the windowed one. Without it no leak slower than `tol` per
 * `nConfirmS` can ever be seen, because each NORMAL confirmation resets the
 * window before a slow loss accumulates.
 *
 * ## What it cannot see
 *
 * The windowed rules only catch fast events: under steady consumption the
 * window resets every `nConfirmS`, so THEFT needs `rTheft` litres gone inside
 * `tTheftMaxS` of a reset. On a unit reporting every few minutes while parked,
 * the median-of-5 alone spans longer than `tTheftMaxS`. `stats.medianGapS`
 * is returned so a caller can tell when a series is too sparse to judge.
 */

export type SignalEventType = 'REFUEL' | 'THEFT_SUSPECTED' | 'LEAK_SUSPECTED' | 'LOW_FUEL'

export type ProfileType =
  | 'truck' | 'car' | 'bus' | 'motorcycle'
  | 'excavator' | 'generator' | 'bulldozer' | 'forklift'

/** What `work` counts: kilometres for road vehicles, engine-hours for machinery. */
export type WorkUnit = 'km' | 'hours'

export interface SignalThresholds {
  /** Expected consumption, litres per `workUnit`. */
  consumption: number
  workUnit:    WorkUnit
  /** Dynamic acceleration above which the probe is not trusted, m/s². */
  kSlosh:      number
  rRefuel:     number
  rTheft:      number
  rLeak:       number
  tol:         number
  nConfirmS:   number
  minStable:   number
  fLow:        number
  tTheftMaxS:  number
  mLeak:       number
}

type TableRow = Omit<SignalThresholds, 'tTheftMaxS' | 'mLeak'>

/** Stage 5's table, as the specification gives it. */
export const PROFILES: Readonly<Record<ProfileType, TableRow>> = {
  truck:      { consumption: 0.30, workUnit: 'km',    kSlosh: 1.2, rRefuel: 15, rTheft: 10, rLeak: 3,   tol: 2.0, nConfirmS: 60,  minStable: 3, fLow: 15 },
  car:        { consumption: 0.07, workUnit: 'km',    kSlosh: 1.0, rRefuel: 8,  rTheft: 5,  rLeak: 1.5, tol: 1.0, nConfirmS: 45,  minStable: 3, fLow: 8 },
  bus:        { consumption: 0.35, workUnit: 'km',    kSlosh: 1.3, rRefuel: 30, rTheft: 15, rLeak: 5,   tol: 3.0, nConfirmS: 60,  minStable: 3, fLow: 30 },
  motorcycle: { consumption: 0.03, workUnit: 'km',    kSlosh: 1.8, rRefuel: 3,  rTheft: 2,  rLeak: 0.5, tol: 0.4, nConfirmS: 30,  minStable: 3, fLow: 2 },
  excavator:  { consumption: 8,    workUnit: 'hours', kSlosh: 1.5, rRefuel: 20, rTheft: 12, rLeak: 4,   tol: 2.5, nConfirmS: 90,  minStable: 3, fLow: 20 },
  generator:  { consumption: 3,    workUnit: 'hours', kSlosh: 0.8, rRefuel: 10, rTheft: 6,  rLeak: 2,   tol: 1.5, nConfirmS: 120, minStable: 3, fLow: 10 },
  bulldozer:  { consumption: 12,   workUnit: 'hours', kSlosh: 1.6, rRefuel: 25, rTheft: 15, rLeak: 5,   tol: 3.0, nConfirmS: 90,  minStable: 3, fLow: 25 },
  forklift:   { consumption: 2,    workUnit: 'hours', kSlosh: 1.1, rRefuel: 6,  rTheft: 4,  rLeak: 1.2, tol: 1.0, nConfirmS: 60,  minStable: 3, fLow: 6 },
}

export const PROFILE_TYPES = Object.keys(PROFILES) as ProfileType[]

export const T_THEFT_MAX_S = 300
export const M_LEAK = 3
/** Stage 6 rule 5's alternative leak test runs over this span. */
export const LEAK_CUMULATIVE_S = 15 * 60
/**
 * How much older than LEAK_CUMULATIVE_S the cumulative rule's base may be.
 * Beyond it the base was left behind by a silence in the feed, and the rule
 * would be judging hours as though they were fifteen minutes.
 */
export const LEAK_BASE_SLACK_S = 5 * 60
/**
 * A silence between fuel readings longer than this restarts the filters.
 *
 * The median and the Kalman filter assume regular sampling. Across a long
 * silence the readings before it say nothing about the level after it, and the
 * lag they impose splits one change into two events: replayed on 25 Sep, a unit
 * silent from 01:57 to 03:44 EAT came back 39 L lower and was reported as a
 * 20 L leak and, two minutes later, a 19 L theft, while the filtered level
 * converged. Ten minutes is twenty readings at the fleet's ~30 s cadence.
 */
export const GAP_RESET_S = 10 * 60
/**
 * Below this a unit counts as still, for the no-IMU gate and for the theft
 * rule's `speed == 0`. Not literally zero because GPS speed on a parked unit
 * jitters at 1-2 km/h.
 */
export const STILL_KMH = 2

export const KALMAN_Q = 0.05
export const KALMAN_R = 0.5
export const GRAVITY_TAU_S = 1.5

/**
 * The table row for a type, with stage 5's tank scaling and an optional
 * measured consumption in place of the table's.
 *
 * `consumption` should be the vehicle's own measured figure wherever there is
 * one. The table is a generic starting point and on this fleet is badly off:
 * it gives a generator 3 L/h against an operator band of 35-95 L/h.
 */
export function thresholdsFor(
  type: ProfileType,
  opts: { tankCapacityL?: number | null; consumption?: number | null } = {},
): SignalThresholds {
  const row = PROFILES[type]
  const cap = opts.tankCapacityL != null && opts.tankCapacityL > 0 ? opts.tankCapacityL : 0
  return {
    ...row,
    consumption: opts.consumption != null && opts.consumption > 0 ? opts.consumption : row.consumption,
    rRefuel: Math.max(row.rRefuel, 0.05 * cap),
    rTheft:  Math.max(row.rTheft,  0.03 * cap),
    rLeak:   Math.max(row.rLeak,   0.01 * cap),
    tol:     Math.max(row.tol,     0.005 * cap),
    tTheftMaxS: T_THEFT_MAX_S,
    mLeak:      M_LEAK,
  }
}

export interface SignalSample {
  /** Epoch seconds. */
  t: number
  /** Tank level in litres. A sample without one is skipped. */
  fuelL: number | null
  /** Raw accelerometer, m/s². All three or none. */
  ax?: number | null
  ay?: number | null
  az?: number | null
  /** Cumulative work in the profile's unit: odometer km or engine-hours. */
  work?: number | null
  /**
   * False when the increment of `work` ending at this sample was not measured
   * (e.g. engine state unknown on an hours machine). Unknown work makes the
   * expected burn too small, so a window containing any is not judged for loss.
   */
  workMeasured?: boolean
  speedKmh?: number | null
  /** True off, false running, null/undefined unknown. Unknown is never "off". */
  ignitionOff?: boolean | null
}

export type SignalRule = 'window' | 'cumulative' | 'level'

export interface SignalEvent {
  type: SignalEventType
  /** Epoch seconds of the sample that confirmed it. */
  at: number
  /** Epoch seconds the candidate first appeared. */
  since: number
  /** Epoch seconds the compared-against reading was taken; null for LOW_FUEL. */
  windowStart: number | null
  /** Filtered level at confirmation, litres. */
  fuelL: number
  deltaFuelL: number | null
  expectedL: number | null
  residualL: number | null
  workDelta: number | null
  rule: SignalRule
}

export type MotionSource = 'imu' | 'speed' | 'none'

export interface SignalStats {
  samples: number
  withFuel: number
  sloshing: number
  stable: number
  /** Windows that closed as ordinary consumption. */
  normalWindows: number
  /** Loss candidates discarded because the window's work was unmeasured. */
  suppressedUnmeasured: number
  /** Times the filters were restarted after a silence — see GAP_RESET_S. */
  gapResets: number
  motion: Record<MotionSource, number>
  medianGapS: number | null
}

type Candidate = SignalEventType | 'NORMAL' | 'NONE'

interface Anchor { t: number; F: number; W: number; unmeasured: number }

/** The detector's state, one per unit. Push samples in time order. */
export class FuelSignalDetector {
  private readonly buf: number[] = []
  private F: number | null = null
  private P = KALMAN_R
  private g: [number, number, number] | null = null
  private lastT: number | null = null
  private lastImuT: number | null = null
  private lastSpeed: number | null = null
  private lastW: number | null = null
  /** Monotone count of unmeasured work increments — see Anchor.unmeasured. */
  private unmeasured = 0
  private stableCount = 0
  private window: Anchor | null = null
  private trail: Anchor[] = []
  private candidate: Candidate = 'NONE'
  private candidateSince = 0
  private leakCount = 0
  private lowSince: number | null = null
  private lowLatched = false
  private gaps: number[] = []

  readonly stats: SignalStats = {
    samples: 0, withFuel: 0, sloshing: 0, stable: 0, normalWindows: 0, suppressedUnmeasured: 0, gapResets: 0,
    motion: { imu: 0, speed: 0, none: 0 }, medianGapS: null,
  }

  constructor(private readonly th: SignalThresholds) {}

  push(s: SignalSample): SignalEvent[] {
    this.stats.samples++
    // Work and motion are tracked on every sample, fuel or not: a gap in the
    // level does not stop the machine working or moving.
    const W = s.work != null && Number.isFinite(s.work) ? s.work : this.lastW
    if (s.work == null || s.workMeasured === false) this.unmeasured++
    if (W != null) this.lastW = W

    if (s.fuelL == null || !Number.isFinite(s.fuelL)) {
      this.noteSpeed(s)
      return []
    }
    this.stats.withFuel++

    const dt = this.lastT != null ? Math.max(0, s.t - this.lastT) : 1
    if (this.lastT != null) this.gaps.push(dt)
    this.lastT = s.t
    if (dt > GAP_RESET_S) {
      this.buf.length = 0
      this.F = null
      this.stats.gapResets++
    }

    // ── Stage 1: median-of-5, then Kalman ──────────────────────────────────
    this.buf.push(s.fuelL)
    if (this.buf.length > 5) this.buf.shift()
    const z = median(this.buf)
    if (this.F == null) {
      this.F = z
      this.P = KALMAN_R
    } else {
      const Ppred = this.P + KALMAN_Q
      const K = Ppred / (Ppred + KALMAN_R)
      this.F = this.F + K * (z - this.F)
      this.P = (1 - K) * Ppred
    }
    const F = this.F

    // ── Stages 2-3: dynamic acceleration and the sloshing gate ─────────────
    const aMag = this.dynamicAcceleration(s)
    this.noteSpeed(s)
    if (aMag > this.th.kSlosh) {
      this.stats.sloshing++
      this.stableCount = 0
      this.candidate = 'NONE'
      this.lowSince = null
      return []
    }
    this.stableCount++
    if (this.stableCount < this.th.minStable) return []
    this.stats.stable++

    const out: SignalEvent[] = []
    const Wn = W ?? 0

    // ── Low fuel, debounced and latched (stage 6 rule 6) ───────────────────
    if (F <= this.th.fLow) {
      this.lowSince ??= s.t
      if (!this.lowLatched && s.t - this.lowSince >= this.th.nConfirmS) {
        this.lowLatched = true
        out.push({
          type: 'LOW_FUEL', at: s.t, since: this.lowSince, windowStart: null, fuelL: F,
          deltaFuelL: null, expectedL: null, residualL: null, workDelta: null, rule: 'level',
        })
      }
    } else {
      this.lowSince = null
      if (F > this.th.fLow + this.th.tol) this.lowLatched = false
    }

    // ── Stage 4: residual over the window ──────────────────────────────────
    const point: Anchor = { t: s.t, F, W: Wn, unmeasured: this.unmeasured }
    this.window ??= point
    const w = this.window
    const dF = F - w.F
    const dW = Wn - w.W
    const expected = this.th.consumption * dW
    const residual = dF + expected
    const lossJudgeable = this.unmeasured === w.unmeasured

    const still = s.ignitionOff === true || (s.speedKmh != null && s.speedKmh < STILL_KMH)
    let c: Candidate
    if (residual > this.th.rRefuel) c = 'REFUEL'
    else if (residual < -this.th.rTheft && still && s.t - w.t <= this.th.tTheftMaxS) c = 'THEFT_SUSPECTED'
    else if (residual < -this.th.rLeak) c = 'LEAK_SUSPECTED'
    else if (Math.abs(residual) <= this.th.tol) c = 'NORMAL'
    else c = 'NONE'

    if ((c === 'THEFT_SUSPECTED' || c === 'LEAK_SUSPECTED') && !lossJudgeable) {
      this.stats.suppressedUnmeasured++
      c = 'NONE'
    }

    this.leakCount = c === 'LEAK_SUSPECTED' ? this.leakCount + 1 : 0

    // ── Stage 6: debounce ──────────────────────────────────────────────────
    if (c !== this.candidate || c === 'NONE') {
      this.candidate = c
      this.candidateSince = s.t
    }
    if (c !== 'NONE' && s.t - this.candidateSince >= this.th.nConfirmS) {
      if (c === 'NORMAL') {
        this.stats.normalWindows++
        this.restartWindow(point)
      } else if (c !== 'LEAK_SUSPECTED' || this.leakCount >= this.th.mLeak) {
        out.push({
          type: c, at: s.t, since: this.candidateSince, windowStart: w.t, fuelL: F,
          deltaFuelL: dF, expectedL: expected, residualL: residual, workDelta: dW, rule: 'window',
        })
        this.restartAfterEvent(point)
        return out
      }
    }

    // ── Stage 6 rule 5's cumulative leak: 15 minutes, engine running ──────
    const leak = this.cumulativeLeak(point, s)
    if (leak) {
      out.push(leak)
      this.restartAfterEvent(point)
    } else {
      this.trail.push(point)
    }
    return out
  }

  finish(): SignalStats {
    this.stats.medianGapS = this.gaps.length > 0 ? median(this.gaps) : null
    return this.stats
  }

  private dynamicAcceleration(s: SignalSample): number {
    const { ax, ay, az } = s
    if (isNum(ax) && isNum(ay) && isNum(az)) {
      this.stats.motion.imu++
      if (this.g == null) {
        this.g = [ax, ay, az]
      } else {
        const dt = this.lastImuT != null ? Math.max(1e-3, s.t - this.lastImuT) : 1
        const alpha = GRAVITY_TAU_S / (GRAVITY_TAU_S + dt)
        this.g = [
          alpha * this.g[0] + (1 - alpha) * ax,
          alpha * this.g[1] + (1 - alpha) * ay,
          alpha * this.g[2] + (1 - alpha) * az,
        ]
      }
      this.lastImuT = s.t
      return Math.hypot(ax - this.g[0], ay - this.g[1], az - this.g[2])
    }
    if (isNum(s.speedKmh)) {
      this.stats.motion.speed++
      // Calm only if still at both ends of the interval: a unit that has just
      // stopped has fuel still moving in the tank.
      const prev = this.lastSpeed ?? s.speedKmh
      return s.speedKmh < STILL_KMH && prev < STILL_KMH ? 0 : Number.POSITIVE_INFINITY
    }
    this.stats.motion.none++
    return 0
  }

  private noteSpeed(s: SignalSample): void {
    if (isNum(s.speedKmh)) this.lastSpeed = s.speedKmh
  }

  private cumulativeLeak(now: Anchor, s: SignalSample): SignalEvent | null {
    // Keep one point at or before the cut-off as the base, drop the rest.
    const cutoff = now.t - LEAK_CUMULATIVE_S
    while (this.trail.length > 1 && this.trail[1]!.t <= cutoff) this.trail.shift()
    const base = this.trail[0]
    if (base == null || base.t > cutoff || base.t < cutoff - LEAK_BASE_SLACK_S) return null
    if (s.ignitionOff !== false) return null         // "while engine is running"
    if (now.unmeasured !== base.unmeasured) return null

    const dF = now.F - base.F
    const dW = now.W - base.W
    const expected = this.th.consumption * dW
    const residual = dF + expected
    if (residual >= -this.th.rLeak) return null
    return {
      type: 'LEAK_SUSPECTED', at: now.t, since: base.t, windowStart: base.t, fuelL: now.F,
      deltaFuelL: dF, expectedL: expected, residualL: residual, workDelta: dW, rule: 'cumulative',
    }
  }

  /**
   * Close the window and open the next AT this reading. The pseudocode drops
   * the window and opens one on the next stable sample, which discards the
   * level change between the two; anchoring here loses nothing, and makes
   * consecutive windows share an edge — which is how mergeContiguous knows
   * two confirmations are one event.
   */
  private restartWindow(at: Anchor): void {
    this.window = at
    this.candidate = 'NONE'
    this.leakCount = 0
  }

  /** After an alert the level has moved for a reason; nothing before it compares. */
  private restartAfterEvent(at: Anchor): void {
    this.restartWindow(at)
    this.trail = [at]
  }
}

/** Run a whole series through a fresh detector. */
export function detectFuelSignals(
  samples: readonly SignalSample[],
  th: SignalThresholds,
): { events: SignalEvent[]; stats: SignalStats } {
  const d = new FuelSignalDetector(th)
  const events: SignalEvent[] = []
  for (const s of samples) events.push(...d.push(s))
  return { events: mergeContiguous(events), stats: d.finish() }
}

/**
 * One fill, one event; one siphon, one event.
 *
 * A bowser fill takes minutes, and the detector confirms a REFUEL `nConfirmS`
 * after the residual crosses `rRefuel` — part-way through — then restarts its
 * window at that level, so the rest of the fill confirms again. A siphon does
 * the same, and its tail is usually smaller than `rTheft`, so it confirms as a
 * LEAK: the filtered level is still catching up with the drop when the theft
 * is confirmed. An event whose window opened exactly where the previous one
 * was confirmed is that event continuing — for loss, whichever type either
 * part was, the stronger claim (THEFT) standing for the whole.
 */
export function mergeContiguous(events: readonly SignalEvent[]): SignalEvent[] {
  const out: SignalEvent[] = []
  for (const e of events) {
    const prev = out.at(-1)
    if (prev && continuesEvent(prev, e)) {
      out[out.length - 1] = {
        ...e,
        type: prev.type === 'THEFT_SUSPECTED' ? prev.type : e.type,
        since: prev.since,
        windowStart: prev.windowStart,
        deltaFuelL: sum(prev.deltaFuelL, e.deltaFuelL),
        expectedL:  sum(prev.expectedL, e.expectedL),
        residualL:  sum(prev.residualL, e.residualL),
        workDelta:  sum(prev.workDelta, e.workDelta),
      }
    } else {
      out.push(e)
    }
  }
  return out
}

/**
 * Whether `e` is `prev` continuing — the rule mergeContiguous applies, exported
 * for a live consumer that receives confirmations one at a time and has to
 * decide the same thing without the whole list.
 */
export function continuesEvent(prev: SignalEvent, e: SignalEvent): boolean {
  const isLoss = (t: SignalEventType) => t === 'THEFT_SUSPECTED' || t === 'LEAK_SUSPECTED'
  const sameKind = prev.type === e.type || (isLoss(prev.type) && isLoss(e.type))
  return sameKind && e.rule === 'window' && prev.rule === 'window'
    && e.type !== 'LOW_FUEL' && e.windowStart === prev.at
}

function sum(a: number | null, b: number | null): number | null {
  return a == null || b == null ? null : a + b
}

function isNum(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v)
}

function median(xs: readonly number[]): number {
  const a = [...xs].sort((x, y) => x - y)
  const m = a.length >> 1
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2
}
