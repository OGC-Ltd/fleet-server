/**
 * A fuel probe that has stopped reporting is invisible to every rule we have.
 *
 * ## Why a verdict cannot fix this
 *
 * `fuel-adjudication` can only judge a drain, and a drain only exists because
 * a probe reported one. The dead probes do not report anything: measured over
 * 30 days to 2026-08-11, **32 units never read above zero at all**, 29 of them
 * with neither a drain nor a filling to their name. They sit on the dashboard
 * as monitored vehicles with clean records. The cleanest record on the fleet is
 * a probe that has been dead for a month.
 *
 * The `SENSOR_FAULT` verdict shipped in `e89cdcf` addresses the loud failure —
 * a probe that dies mid-drain and bills a driver for it. This addresses the
 * quiet one, which is much larger, and it is the reason that verdict fires on
 * almost nothing historically.
 *
 * ## The two faults, and why they are told apart
 *
 * DIED and SILENT need different messages because they need different work: one
 * is a probe that failed on a known date and can be dated to a shift, the other
 * has never worked and may never have been commissioned.
 *
 * ## Why engine evidence is NOT required here
 *
 * The adjudicator's dead-probe rule requires `engineOn`, correctly: it is
 * deciding between a broken probe and a tank drained to empty, and an engine
 * cannot run on an empty tank. This is not that question. Checked against the
 * five units the operator independently sent for a workshop visit —
 * `MUFINDI: FT 11`, `MUFINDI: EX 07`, `KDL 182X`, `KTCC 811D`, `KTCC 856B` —
 * **two report no `engineOn` at all** (856B: 0 of 780 readings; EX 07: 0 of
 * 11,965), so an engine-gated rule would have missed 40% of the operator's own
 * list.
 *
 * Movement stands in for it. A machine that drives for days cannot be running
 * on an empty tank either, and `speedKmh` is populated where `engineOn` is not.
 * Movement is evidence, not a requirement: a probe that reads 358 L and then
 * nothing for four days is broken whether or not the machine moved since.
 *
 * ## Constants, and what they were measured against
 *
 * With these thresholds the rule flags 15 DIED and 32 SILENT out of 365 units
 * with enough telemetry — and the 15 include all five the operator named,
 * which is the whole reason to believe the numbers. The other ten had not been
 * noticed. `MUFINDI - FT 13` has been dark since 2026-07-31 and has driven
 * 2,992 pings' worth of movement since.
 */

/** How far back the sweep looks. Long enough to see a probe that was alive. */
export const LOOKBACK_DAYS = 30

/**
 * How long a probe must read nothing before it is called dead.
 *
 * A day, because a genuinely empty tank refills within one and a probe that is
 * merely between readings does not. All five named units had been dark for two
 * to five days when the operator raised them, so this is not a tight bound —
 * it is set to catch the fault a day after it starts rather than a week.
 */
export const DEAD_HOURS = 24

/**
 * The level a probe must once have read for "it reads zero now" to mean
 * anything. 20 L: below that a tank genuinely can be near-empty, and the
 * failures observed all fell from far higher — 28, 38, 111, 258, 358 L.
 */
export const ALIVE_ML = 20_000

/** Enough telemetry in the lookback to be sure the unit is reporting at all. */
export const MIN_PINGS = 200
/** ...and enough inside the dead window to be sure the silence is the probe's. */
export const MIN_RECENT_PINGS = 20

export type ProbeState =
  /** Reporting a level. */
  | 'OK'
  /** Read a real level, then fell to zero and stayed there. */
  | 'DIED'
  /** Has never read above zero. */
  | 'SILENT'
  /** No `fuelLevelMl` on any reading — nothing is fitted, so nothing is broken. */
  | 'NOT_FITTED'
  /** Too little telemetry to say. */
  | 'UNKNOWN'

/** One vehicle's probe as the lookback window sees it. */
export interface ProbeWindow {
  /** Readings in the lookback, of any kind. */
  pings:        number
  /** Readings carrying a `fuelLevelMl` at all. */
  levelPings:   number
  /** Highest level read anywhere in the lookback. */
  peakMl:       number | null
  /** Last time it read above zero, and what it read. */
  lastAliveAt:  Date | null
  /** Readings inside the dead window. */
  recentPings:  number
  /** Highest level read inside the dead window. */
  recentPeakMl: number | null
  /** Readings inside the dead window showing movement. */
  recentMoving: number
}

export interface ProbeVerdict {
  state:  ProbeState
  /** Short slug naming the rule that decided, for auditing. */
  reason: string
}

/**
 * Classify one probe. Pure: no clock, no database.
 *
 * Order matters. NOT_FITTED is tested before anything else so an unprobed
 * vehicle never reaches a fault state — 25 units report telemetry with no fuel
 * channel at all, and calling those broken would bury the 47 that are.
 */
export function classifyProbe(w: ProbeWindow): ProbeVerdict {
  if (w.pings < MIN_PINGS)  return { state: 'UNKNOWN',    reason: 'too-little-telemetry' }
  if (w.levelPings === 0)   return { state: 'NOT_FITTED', reason: 'no-fuel-channel' }

  // Never read anything, across a month of readings, on a unit that IS fitted
  // with a channel. Fuel goes into three of these and the probe says nothing.
  if ((w.peakMl ?? 0) === 0) return { state: 'SILENT', reason: 'never-reported' }

  // Read a real level once, reads nothing now. The transition is the evidence:
  // a tank that is genuinely empty was filled by somebody, and a filling shows
  // up as a level. Silence after a real reading is the instrument.
  if (w.recentPings >= MIN_RECENT_PINGS &&
      (w.recentPeakMl ?? 0) === 0 &&
      (w.peakMl ?? 0) >= ALIVE_ML &&
      w.lastAliveAt != null) {
    return { state: 'DIED', reason: 'stopped-reporting' }
  }

  return { state: 'OK', reason: 'reporting' }
}

/** True for the states that want somebody to go and look at the vehicle. */
export const isFaulty = (v: ProbeVerdict): boolean =>
  v.state === 'DIED' || v.state === 'SILENT'
