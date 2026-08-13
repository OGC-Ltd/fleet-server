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

import { engineBurnMl, type RateBasis, type ResolvedRate } from './fuel-rate.js'

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

/**
 * Moving readings a 30-minute window needs before its swing counts.
 *
 * "More than 1", per the operator — so two. A single reading has no range at
 * all, and two is the least that can describe one.
 */
export const TURBULENCE_MIN_SAMPLES = 2

/**
 * Continuous engine-off that ends a run. SUSTAINED, not merely spanned.
 *
 * A run is *"between start and temporary stop or heavy stop whichever comes
 * first"*, so any stop cuts it; the two kinds differ in what they mean
 * operationally, not in whether they end a journey.
 *
 * ## Why five minutes and not one
 *
 * One minute was the operator's first figure and it broke on chattering engine
 * flags. `MUFINDI: EX 10` on 2026-08-12 reported **266 temporary stops and 212
 * runs in a single day**: its engine flag changed state **1,445 times** across
 * 3,957 readings. Those are not journeys, they are a sensor toggling, and they
 * shredded the day into fragments — its turbulence read 1.1 L where comparable
 * machines read tens of litres.
 *
 * Worth recording what the cause was NOT, because the obvious guard is wrong
 * here: the flag never contradicted motion. Readings with the engine off and
 * speed >= 1 km/h numbered **zero**, so "a stop must also be stationary" would
 * have fixed nothing. The unit genuinely alternates on/off while standing
 * still.
 *
 * Five minutes of CONSECUTIVE engine-off readings is what separates the two. A
 * unit pinging every few seconds satisfies a one-minute span on a brief
 * chatter; sustaining five minutes without a single engine-on reading in
 * between requires the machine to have actually stopped.
 *
 * The "consecutive" part is structural, not incidental: any engine-on reading
 * closes the open stop and resets the span, so a chatter can never accumulate.
 */
export const TEMPORARY_STOP_MINUTES = 5

/**
 * Engine-off at or beyond which a stop is HEAVY rather than temporary.
 *
 * The operator's split: under an hour is a pause in the work — a gate, a
 * weighbridge, a driver's break; an hour or more is the machine standing down.
 * Both end a run; the distinction is recorded because it describes the day
 * differently, and a day of six temporary stops is not a day of six heavy ones.
 */
export const HEAVY_STOP_MINUTES = 60

/**
 * Kilometres the fleet is expected to cover per litre burned.
 *
 * Two, per the operator: *"for every 2KM we expect 1L usage"*.
 *
 * A FLEET-WIDE EXPECTATION, and deliberately labelled as one. It cannot be
 * right for every unit here: `fuel-consumption-rates.md` records that 215 of
 * 310 probed units are plant or tractors, that KASULU PLANT averages 1.5 km/h
 * and 7.361 L/km, and that the spread within a single vehicle type reaches
 * 4.1x. A dozer clearing a face burns fuel while covering almost no ground, so
 * its expected burn will read near zero against a real consumption.
 *
 * That divergence is the useful part rather than a defect: expected burn sits
 * beside `consumedMl`, which is what the tank actually did, and the gap between
 * them is the question worth asking. It is not used to judge anything.
 */
export const KM_PER_LITRE = 2

/**
 * Longest gap between two readings that still counts as engine time, in
 * seconds.
 *
 * Engine seconds are integrated between consecutive fixes and attributed to the
 * EARLIER one's state, so a unit that reports engine-on and then goes silent
 * for three hours would otherwise bank three hours of running it may never have
 * done. Capped at fifteen minutes, the gap is charged at fifteen.
 *
 * Fifteen minutes because that is the cut `fuel-consumption-rates.md` §6 uses
 * to break a run, and the two MUST agree: `engineBurnMl` is a rate derived
 * under that convention multiplied by hours counted here. Integrating time one
 * way and calibrating it another puts a silent bias straight into the product.
 *
 * The error runs SHORT on a sparse reporter, which is the safe direction — an
 * under-counted hour understates the expectation rather than inventing burn to
 * explain a drop with.
 */
export const MAX_ENGINE_GAP_SECONDS = 900

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
 * 1 km/h, per the operator. This was 0.1, which admitted a stationary machine's
 * fix wandering as travel — at 1 km/h a reading is unambiguously movement.
 */
export const MOTION_MIN_KMH = 1

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
  /** Stops under HEAVY_STOP_MINUTES — a pause in the work. */
  temporaryStops: number
  /** Stops of HEAVY_STOP_MINUTES or more — the machine standing down. */
  heavyStops: number
  /** Ground covered today, in metres. Null when the unit sent no positions. */
  distanceM: number | null
  /**
   * What the engine is EXPECTED to have burned over that distance, at
   * `KM_PER_LITRE`. An expectation, not a measurement — compare it against
   * `consumedMl`, which is what the tank actually did.
   *
   * The DISTANCE-based expectation of the pair; `engineBurnMl` is the other
   * and is the better one for most of this fleet. See its note.
   */
  expectedBurnMl: number | null
  /**
   * Seconds the engine ran today. A MEASUREMENT, integrated from the telemetry
   * — see `MAX_ENGINE_GAP_SECONDS` for how a silent stretch is treated.
   *
   * This is the quantity the fleet's work is actually made of: 215 of 310
   * probed units are plant or tractors, which burn fuel while stationary, and
   * position freezes at speed 0 on this telemetry — so a working excavator
   * reports ≈0 km against a real shift's burn. Engine hours are what it has to
   * show for the day.
   */
  engineSeconds: number | null
  /**
   * What the engine is expected to have burned over those hours, at the
   * vehicle's measured litres-per-hour. The ENGINE-based half of the pair.
   *
   * The primary expectation for every type — `modules/fuel/fuel-rate` carries
   * the reasoning and `docs/fuel-consumption-rates.md` the measurement. Null
   * when no rate has been derived for the machine or its type, never zero: a
   * zero would read as "burned nothing" where the truth is "we have never
   * measured this one".
   */
  engineBurnMl: number | null
  /** The rate `engineBurnMl` was computed at, echoed so the figure is auditable. */
  engineRateLPerHour: number | null
  /**
   * Whether that rate is the vehicle's OWN or its org+type median. A borrowed
   * rate is a weaker claim and the column should be able to say so.
   */
  engineRateBasis: RateBasis | null
}

export const UNKNOWN_TANK_STATE: TankState = {
  initialMl: null, currentMl: null, consumedMl: null,
  turbulenceMl: null, stopsAveraged: 0, runSloshMl: [],
  temporaryStops: 0, heavyStops: 0, distanceM: null, expectedBurnMl: null,
  engineSeconds: null, engineBurnMl: null,
  engineRateLPerHour: null, engineRateBasis: null,
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
export interface TankStateInputs {
  /**
   * Run slosh from BEFORE this day, oldest first, so the moving average can
   * span midnight. Omitted, the average covers only this day's runs — which is
   * a one- or two-run figure on most vehicles, not the eight it claims.
   */
  priorRunSloshMl?: readonly number[]
  /** Ground covered today in metres, summed from the position fixes. */
  distanceM?: number | null
  /**
   * Seconds the engine ran today, integrated from EVERY fix rather than the
   * fuel-carrying ones — see the service, which measures it in the same pass as
   * the distance and for the same reason.
   */
  engineSeconds?: number | null
  /** This vehicle's resolved consumption rate, or null if it has none. */
  rate?: ResolvedRate | null
}

export function deriveTankState(
  dayReadings: readonly LevelReading[],
  previousDayCloseMl: number | null,
  {
    priorRunSloshMl = [], distanceM = null, engineSeconds = null, rate = null,
  }: TankStateInputs = {},
): TankState {
  const currentMl = closingLevel(dayReadings)
  const { runSloshMl, temporaryStops, heavyStops } = dayRuns(dayReadings)
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
    temporaryStops,
    heavyStops,
    distanceM,
    // Rounded to a whole millilitre; the expectation is a fleet rule of thumb
    // and false precision on it would invite it to be read as a measurement.
    expectedBurnMl: distanceM == null
      ? null
      : Math.round((distanceM / 1000 / KM_PER_LITRE) * 1000),
    engineSeconds,
    engineBurnMl:       engineBurnMl(engineSeconds, rate),
    engineRateLPerHour: rate?.lPerHour ?? null,
    engineRateBasis:    rate?.basis    ?? null,
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
 * A RUN is the motion between two stops. A STOP is `TEMPORARY_STOP_MINUTES` (5)
 * or more of CONSECUTIVE engine-off readings; one lasting `HEAVY_STOP_MINUTES` (60) or
 * more is a HEAVY stop rather than a temporary one, and either ends the run —
 * whichever comes first. Within a run, readings group into 30-minute windows;
 * a window counts only if it holds at least `TURBULENCE_MIN_SAMPLES` (2)
 * readings taken at `speedKmh >= MOTION_MIN_KMH` (1 km/h).
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
function dayRuns(readings: readonly LevelReading[]): {
  runSloshMl: number[]; temporaryStops: number; heavyStops: number
} {
  const runs: LevelReading[][] = []
  let current: LevelReading[] = []
  // The span of the engine-off stretch currently open, if any. Measured
  // between the first and last OFF READING, so a sparse-reporting unit's stop
  // reads slightly short — the alternative, counting the gap to the next
  // engine-on ping, reads long on exactly the same units. Short is the safer
  // error: it merges a marginal stop into the run rather than inventing one.
  let offFrom: Date | null = null
  let offTo:   Date | null = null
  let temporaryStops = 0, heavyStops = 0

  const closeStop = () => {
    if (offFrom == null || offTo == null) return
    const minutes = (offTo.getTime() - offFrom.getTime()) / 60_000
    if (minutes >= HEAVY_STOP_MINUTES) heavyStops++
    else if (minutes >= TEMPORARY_STOP_MINUTES) temporaryStops++
    offFrom = null
    offTo   = null
  }

  for (const r of readings) {
    if (r.engineOn === false) {
      offFrom ??= r.capturedAt
      offTo = r.capturedAt
      // A stop of any kind ends the run — temporary or heavy, whichever comes
      // first. The classification happens when the engine returns and the
      // stop's full length is known.
      if (offTo.getTime() - offFrom.getTime() >= TEMPORARY_STOP_MINUTES * 60_000
          && current.length > 0) {
        runs.push(current)
        current = []
      }
      continue
    }
    // Engine on, or unknown: the machine is not stopped, so the run continues.
    closeStop()
    current.push(r)
  }
  // A stop still open when the day ends is still a stop that happened.
  closeStop()
  // A day that ends mid-run still contributes it — the machine is out there.
  if (current.length > 0) runs.push(current)

  const runSloshMl: number[] = []
  for (const run of runs) {
    const t = runSlosh(run)
    // Rounded here, because these are persisted and re-averaged later: keeping
    // full precision in the array and rounding only at the end would make a
    // stored row disagree with the same day recomputed.
    if (t != null) runSloshMl.push(Math.round(t))
  }

  return { runSloshMl, temporaryStops, heavyStops }
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
