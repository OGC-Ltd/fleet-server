/**
 * What the tank held at the close of yesterday, what it holds at the close of
 * the day being viewed, and how much the probe moved about while working.
 *
 * ## The pair is a DAY boundary, not an event
 *
 * `initialMl` is the last level of the PREVIOUS fleet day. `currentMl` is the
 * last level of the day being viewed — for today, that is simply the latest
 * reading. Their difference is what the day has cost, and because one day's
 * `current` is the next day's `initial`, the column reconciles down a week
 * without gaps.
 *
 * This replaced a stop-based reading — initial at the last engine-off, current
 * now — which measured a shift rather than a day and so could not be lined up
 * with a date filter or added across dates. The operator asked for the day
 * boundary and it is the more useful quantity: a day is what the fuel ledger,
 * the drains and the reports are all bucketed by.
 *
 * Fleet days are Kenyan, not UTC — see `lib/provider-time`. A reading at 01:00
 * EAT belongs to that day.
 *
 * ## Why the closing level is a median, not the last reading
 *
 * It IS the final fuel level; taking it robustly is the only way to be sure it
 * is. Every extremum in this module has had to be defended against a single bad
 * sample — the 99th-percentile ping-to-ping jump on this fleet is about 5 L on
 * a probe whose median step is zero — and a closing level read off one reading
 * would put that error into the day's consumption AND into the next day's
 * opening balance, where it would be subtracted back out again the following
 * day. A median over the last `CLOSE_WINDOW_MINUTES` costs nothing and cannot
 * do that.
 *
 * ## Consumption is not the whole story, deliberately
 *
 * `consumedMl` is `initial − current`. On a day with a refuel that figure is
 * NOT what the machine burned — fuel went in as well as out. The fillings
 * ledger holds what went in and is adjudicated separately; combining them here
 * would bury a measurement inside a derived number. The column reports the
 * tank, and the events beside it say why it moved.
 */

/**
 * How much of the end of a day is averaged into its closing level.
 *
 * Fifteen minutes is about 30 readings at this fleet's ping rate — enough for a
 * median to be stable, short enough that it is still the CLOSE of the day and
 * not the evening.
 */
export const CLOSE_WINDOW_MINUTES = 15

/**
 * How many recent STOPS the turbulence moving average spans.
 *
 * The unit of the average is a stop, not a clock interval: a machine that made
 * three runs today and eleven yesterday should not have yesterday dominate
 * simply by being busier. Eight is roughly a working day of runs on this fleet.
 */
export const TURBULENCE_STOPS = 8

/** Readings a 30-minute window needs before its swing is worth measuring. */
export const TURBULENCE_MIN_SAMPLES = 10

/**
 * Continuous engine-off that ends a motion segment.
 *
 * The same definition of a stop the operator gave for the working/stopped
 * split: working is engine-on, so stopped is engine-off. Fifteen minutes, so a
 * machine restarting after a short pause is one run and not three.
 */
export const STOP_MINUTES = 15

export interface LevelReading {
  capturedAt:  Date
  fuelLevelMl: number
  engineOn?:   boolean
  /** Instantaneous speed. Turbulence is measured in MOTION — see below. */
  speedKmh?:   number | null
}

/**
 * Speed at or above which the unit counts as moving.
 *
 * 0.1 km/h, matching the operator's own motion threshold. Anything lower is GPS
 * jitter on a stationary machine, not travel.
 */
export const MOTION_MIN_KMH = 0.1

export interface TankState {
  /** Closing level of the PREVIOUS fleet day. */
  initialMl: number | null
  /** Closing level of the day being viewed; the latest reading, for today. */
  currentMl: number | null
  /**
   * initial − current. What the tank fell by over the day.
   *
   * Not "what the machine burned" on any day carrying a refuel — see the module
   * note. Null unless both ends are real: a consumption figure with a guessed
   * end looks like a measurement.
   */
  consumedMl: number | null
  /**
   * Mean level range per 30-minute window WHILE THE UNIT IS MOVING, over the
   * most recent TURBULENCE_WINDOWS.
   *
   * ## This is for TREND LOGGING and must never reach theft detection
   *
   * A moving tank sloshes. The level jumps up and down and the provider logs
   * some of those swings as drains and some as fillings, but they are artefacts
   * of the fuel moving in the tank, not fuel entering or leaving it. The point
   * of measuring them is to have a per-unit baseline that can be TRENDED — a
   * probe whose slosh is drifting upward over weeks is telling you something
   * about the machine or its mounting — not to judge any individual event.
   *
   * Nothing in `fuel-adjudication` reads this, and nothing should. The drain
   * rules already have their own instrument for probe trustworthiness
   * (`getProbeProfile`, measured while PARKED, which is a different question
   * asked of different readings). Feeding a motion-slosh average into a theft
   * verdict would let a machine excuse its own drains by working rough ground.
   */
  turbulenceMl: number | null
  /**
   * How many STOPS the moving average actually spans.
   *
   * Carried so a figure built on one run is not read as confidently as one
   * built on eight — a trend line needs to say how much it is standing on.
   * Reaches TURBULENCE_STOPS once the vehicle has made that many runs, however
   * many days that took.
   */
  stopsAveraged: number
  /**
   * THIS day's per-run slosh values, in order — the raw T(r) of the formula.
   *
   * Returned so the caller can persist them. The moving average spans days, and
   * averaging the last eight runs requires knowing what they were: a day's mean
   * cannot be un-meaned back into its runs.
   */
  runSloshMl: number[]
}

export const UNKNOWN_TANK_STATE: TankState = {
  initialMl: null, currentMl: null, consumedMl: null,
  turbulenceMl: null, stopsAveraged: 0, runSloshMl: [],
}

/**
 * The settled level at the end of a run of readings.
 *
 * Median of everything in the final CLOSE_WINDOW_MINUTES, falling back to the
 * last reading when the day ends with a single ping — a vehicle that reported
 * once at 23:58 still has a closing level, it is just less well measured.
 */
export function closingLevel(readings: readonly LevelReading[]): number | null {
  if (readings.length === 0) return null
  const last = readings[readings.length - 1]!
  const cutoff = last.capturedAt.getTime() - CLOSE_WINDOW_MINUTES * 60_000
  const tail = readings.filter(r => r.capturedAt.getTime() >= cutoff)
  const v = (tail.length > 0 ? tail : [last]).map(r => r.fuelLevelMl).sort((a, b) => a - b)
  return v[Math.floor(v.length / 2)]!
}

/**
 * Derive the day's tank state.
 *
 * `dayReadings` are the viewed day's readings, ascending.
 * `previousDayCloseMl` is the previous fleet day's closing level, or null when
 * the vehicle reported nothing that day — in which case there is no opening
 * balance and no consumption figure, rather than an invented zero.
 *
 * Pure: no clock, no database.
 */
export function deriveTankState(
  dayReadings: readonly LevelReading[],
  previousDayCloseMl: number | null,
  /**
   * Run slosh from BEFORE this day, oldest first, so the moving average can
   * span midnight. Omitted, the average covers only this day's runs — which is
   * a one- or two-run figure on most vehicles, not the eight it claims.
   */
  priorRunSloshMl: readonly number[] = [],
): TankState {
  const currentMl  = closingLevel(dayReadings)
  const runSloshMl = dayRunSlosh(dayReadings)
  const { mean, stops } = movingAverage([...priorRunSloshMl, ...runSloshMl])
  return {
    initialMl:  previousDayCloseMl,
    currentMl,
    consumedMl: previousDayCloseMl != null && currentMl != null
      ? previousDayCloseMl - currentMl
      : null,
    turbulenceMl:  mean,
    stopsAveraged: stops,
    runSloshMl,
  }
}

/**
 * TURB: the mean of the last TURBULENCE_STOPS run values.
 *
 * The window is counted in RUNS and takes them wherever they fell. A vehicle
 * that makes two runs a day reaches back four days for its eight; one that
 * makes ten reaches back less than one. That is the point — the average
 * describes the machine's recent journeys, not its recent calendar.
 */
export function movingAverage(runs: readonly number[]): { mean: number | null; stops: number } {
  const recent = runs.slice(-TURBULENCE_STOPS)
  if (recent.length === 0) return { mean: null, stops: 0 }
  return {
    mean:  Math.round(recent.reduce((a, b) => a + b, 0) / recent.length),
    stops: recent.length,
  }
}

/**
 * T(r) for each run in this day — the per-run slosh values the moving average
 * is later taken over. See `movingAverage` for the averaging step, which spans
 * days rather than resetting at midnight.
 *
 * ## The formula, in full
 *
 * A RUN is the motion between two stops. A STOP is `STOP_MINUTES` of
 * continuous engine-off. Within a run, readings are grouped into 30-minute
 * windows; a window counts only if it holds at least `TURBULENCE_MIN_SAMPLES`
 * readings taken at `speedKmh >= MOTION_MIN_KMH`.
 *
 *   window range      R(w)  = max(level in w) − min(level in w)
 *
 *   run turbulence    T(r)  = mean over the qualifying windows w in run r
 *                             of R(w)
 *
 *   moving average    TURB  = mean over the last N runs of T(r),
 *                             N = TURBULENCE_STOPS, taken across days —
 *                             see `movingAverage`
 *
 * ## Why per WINDOW inside a run, and not the run's whole range
 *
 * A run's outright max−min is contaminated by consumption: a two-hour haul
 * burns fuel, so its range measures the burn plus the slosh and mostly the
 * burn. Inside a 30-minute window the burn is small enough to ignore and the
 * range is dominated by fuel moving about in the tank, which is the quantity
 * wanted. Averaging the windows then gives that run's typical slosh.
 *
 * ## Why per STOP, and not per clock interval
 *
 * Asked for directly. It also weights correctly: the average is over RUNS, so a
 * machine that made three runs today and eleven yesterday does not have
 * yesterday dominate simply by being busier. Every run counts once, whatever
 * its length — the unit of the average is the journey, not the hour.
 *
 * ## And why the window crosses midnight
 *
 * Measured 2026-08-13: vehicles average 1.3-2.0 runs a day. An eight-run
 * average that restarted each night therefore spanned one or two runs — a daily
 * figure wearing a moving average's name. The run values are persisted per day
 * (`runSloshMl`) precisely so the window can reach back through them; a day's
 * mean cannot be un-meaned into its runs.
 *
 * ## This is a trend line and feeds nothing
 *
 * See the note on `TankState.turbulenceMl`. Slosh is not fuel entering or
 * leaving a tank, and a motion-slosh average must never reach a theft verdict —
 * the drain rules have their own probe instrument, measured while PARKED.
 *
 * Null without speed or engine state: runs cannot be cut without knowing when
 * the machine stopped, and slosh cannot be measured without knowing it moved.
 */
function dayRunSlosh(readings: readonly LevelReading[]): number[] {
  // Cut the day into runs at each stop. A run accumulates every reading until
  // STOP_MINUTES of continuous engine-off closes it; the off readings
  // themselves are not part of the run, they are the stop.
  const runs: LevelReading[][] = []
  let current: LevelReading[] = []
  let offSince: Date | null = null

  for (const r of readings) {
    if (r.engineOn === false) {
      offSince ??= r.capturedAt
      if (r.capturedAt.getTime() - offSince.getTime() >= STOP_MINUTES * 60_000 && current.length > 0) {
        runs.push(current)
        current = []
      }
      continue
    }
    // Engine on, or unknown: the machine is not stopped, so the run continues.
    offSince = null
    current.push(r)
  }
  // A day that ends mid-run still contributes it — the machine is out there.
  if (current.length > 0) runs.push(current)

  const perRun: number[] = []
  for (const run of runs) {
    const t = runSlosh(run)
    // Rounded here, because these are persisted and re-averaged later: keeping
    // full precision in the array and rounding only at the end would make a
    // stored row disagree with the same day recomputed.
    if (t != null) perRun.push(Math.round(t))
  }
  return perRun
}

/** T(r): mean of the 30-minute window ranges inside one run, moving only. */
function runSlosh(run: readonly LevelReading[]): number | null {
  const buckets = new Map<number, number[]>()
  for (const r of run) {
    if (r.speedKmh == null || r.speedKmh < MOTION_MIN_KMH) continue
    const key = Math.floor(r.capturedAt.getTime() / (30 * 60_000))
    const b = buckets.get(key)
    if (b) b.push(r.fuelLevelMl)
    else buckets.set(key, [r.fuelLevelMl])
  }

  const ranges = [...buckets.values()]
    .filter(v => v.length >= TURBULENCE_MIN_SAMPLES)
    .map(v => Math.max(...v) - Math.min(...v))

  if (ranges.length === 0) return null
  return ranges.reduce((a, b) => a + b, 0) / ranges.length
}
