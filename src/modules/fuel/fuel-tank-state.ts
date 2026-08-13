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
 * How many recent working windows the turbulence average spans.
 *
 * A moving average, so a machine that spent last week on a slope and this week
 * on a yard reads as it is now rather than as it was.
 */
export const TURBULENCE_WINDOWS = 8

/** Readings a window needs before its swing is worth measuring. */
export const TURBULENCE_MIN_SAMPLES = 10

export interface LevelReading {
  capturedAt:  Date
  fuelLevelMl: number
  engineOn?:   boolean
}

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
   * Mean level range per 30-minute window WHILE WORKING (engine on, moving or
   * stationary), over the most recent TURBULENCE_WINDOWS of the day.
   *
   * The working counterpart of the parked-swing figure the drain trust gate
   * uses (`getProbeProfile`): that one asks whether a probe can be believed at
   * rest, this one describes what the machine is putting the fuel through —
   * terrain, load and slope.
   */
  turbulenceMl: number | null
}

export const UNKNOWN_TANK_STATE: TankState = {
  initialMl: null, currentMl: null, consumedMl: null, turbulenceMl: null,
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
): TankState {
  const currentMl = closingLevel(dayReadings)
  return {
    initialMl:  previousDayCloseMl,
    currentMl,
    consumedMl: previousDayCloseMl != null && currentMl != null
      ? previousDayCloseMl - currentMl
      : null,
    turbulenceMl: workingTurbulence(dayReadings),
  }
}

/**
 * Mean level range per 30-minute window while the engine was on.
 *
 * Deliberately the SAME shape as the parked-swing measure in
 * `fuel-adjudication.service`'s `getProbeProfile` — 30-minute windows, range
 * within the window — so the two are directly comparable. High working with low
 * parked describes ground and load; high PARKED means the probe itself cannot
 * be trusted, and that already has a verdict gate.
 *
 * Null without engine state. Turbulence is defined as what happens WHILE
 * WORKING, and a provider that does not say whether the engine was on cannot
 * answer that — two of the operator's five condemned units report it on zero
 * readings.
 */
function workingTurbulence(readings: readonly LevelReading[]): number | null {
  const buckets = new Map<number, number[]>()
  for (const r of readings) {
    if (r.engineOn !== true) continue
    const key = Math.floor(r.capturedAt.getTime() / (30 * 60_000))
    const b = buckets.get(key)
    if (b) b.push(r.fuelLevelMl)
    else buckets.set(key, [r.fuelLevelMl])
  }

  const ranges = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, v]) => v.length >= TURBULENCE_MIN_SAMPLES)
    .map(([, v]) => Math.max(...v) - Math.min(...v))
    .slice(-TURBULENCE_WINDOWS)

  if (ranges.length === 0) return null
  return Math.round(ranges.reduce((a, b) => a + b, 0) / ranges.length)
}
