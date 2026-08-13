import { describe, it, expect } from 'vitest'
import {
  deriveTankState, closingLevel, CLOSE_WINDOW_MINUTES, TURBULENCE_MIN_SAMPLES,
  MOTION_MIN_KMH, TURBULENCE_STOPS, HEAVY_STOP_MINUTES, type LevelReading,
} from '../../src/modules/fuel/fuel-tank-state.js'
import type { ResolvedRate } from '../../src/modules/fuel/fuel-rate.js'

const T0 = Date.parse('2026-08-13T04:00:00Z')
/** One reading every 2 minutes. */
const at = (i: number) => new Date(T0 + i * 2 * 60_000)

const run = (n: number, ml: number, engineOn: boolean, from = 0): LevelReading[] =>
  Array.from({ length: n }, (_, i) => ({ capturedAt: at(from + i), fuelLevelMl: ml, engineOn, speedKmh: 0 }))

describe('closingLevel', () => {
  it('takes the median of the final window, not the last reading', () => {
    // The closing level IS the final level; measuring it robustly is how you
    // know it is. A one-sample error here would land in the day's consumption
    // AND in tomorrow's opening balance.
    const day: LevelReading[] = [
      ...run(20, 300_000, true),
      ...run(9, 240_000, false, 20),
      { capturedAt: at(29), fuelLevelMl: 9_000, engineOn: false },   // spike at the close
    ]
    expect(closingLevel(day)).toBe(240_000)
  })

  it('falls back to the only reading a quiet day has', () => {
    const one = [{ capturedAt: at(0), fuelLevelMl: 187_000, engineOn: false }]
    expect(closingLevel(one)).toBe(187_000)
  })

  it('is null when the vehicle said nothing all day', () => {
    expect(closingLevel([])).toBeNull()
  })

  it('does not reach back beyond the close window', () => {
    // Morning at 300 L, evening at 240 L, and the close is the evening.
    const wide = CLOSE_WINDOW_MINUTES     // minutes, = window/2 samples at 2 min
    const day = [...run(40, 300_000, true), ...run(wide, 240_000, false, 40)]
    expect(closingLevel(day)).toBe(240_000)
  })
})

describe('deriveTankState', () => {
  it('opens on yesterday and closes on today', () => {
    // The pair is a DAY boundary: one day's current is the next day's initial,
    // so the column reconciles down a week.
    const day = [...run(20, 260_000, true), ...run(10, 210_000, false, 20)]
    const out = deriveTankState(day, 300_000)
    expect(out.initialMl).toBe(300_000)
    expect(out.currentMl).toBe(210_000)
    expect(out.consumedMl).toBe(90_000)
  })

  it('gives no consumption without an opening balance', () => {
    // A vehicle that reported nothing yesterday has no opening balance, and an
    // invented zero would report the whole tank as consumed today.
    const out = deriveTankState(run(20, 260_000, true), null)
    expect(out.initialMl).toBeNull()
    expect(out.consumedMl).toBeNull()
    expect(out.currentMl).toBe(260_000)   // the level is still honest
  })

  it('still shows the opening balance for a unit that went silent today', () => {
    // Worth noticing, not worth hiding: a blank Current beside a real Initial
    // is exactly the signal that a unit stopped reporting.
    const out = deriveTankState([], 415_000)
    expect(out.initialMl).toBe(415_000)
    expect(out.currentMl).toBeNull()
    expect(out.consumedMl).toBeNull()
  })

  it('reports a refuelled day as a NEGATIVE consumption rather than hiding it', () => {
    // initial − current is what the TANK did. On a day carrying a refuel that
    // is not what the machine burned, and the fillings ledger holds the other
    // half. Folding them together here would bury a measurement in a
    // derivation.
    const out = deriveTankState(run(20, 380_000, false), 120_000)
    expect(out.consumedMl).toBe(-260_000)
  })

  it('measures turbulence in MOTION, not merely engine-on', () => {
    // Slosh is caused by travel over ground, not by the engine turning. A
    // machine idling stationary for an hour produces a flat level; the swings
    // worth trending come from the one crossing a rutted haul road.
    //
    // The stationary run here swings 100 L with the engine ON and must not
    // count, or an idling probe would read as violent terrain.
    const idling: LevelReading[] = Array.from({ length: 20 }, (_, i) => ({
      capturedAt: at(i), fuelLevelMl: i % 2 ? 300_000 : 200_000, engineOn: true, speedKmh: 0,
    }))
    const moving: LevelReading[] = Array.from({ length: 40 }, (_, i) => ({
      capturedAt: at(20 + i), fuelLevelMl: i % 2 ? 250_000 : 230_000, engineOn: true, speedKmh: 12,
    }))
    const out = deriveTankState([...idling, ...moving], 300_000)
    expect(out.turbulenceMl).toBe(20_000)
    expect(out.stopsAveraged).toBeGreaterThan(0)
  })

  it('averages per RUN, so a long run does not outvote a short one', () => {
    // The unit of the average is the journey, not the hour. Run A swings 20 L
    // across four windows; run B swings 60 L across one. Weighted by window
    // the answer would be 28 L; weighted by RUN it is 40 L, which is what
    // "computed per every stop" means.
    const move = (n: number, from: number, lo: number, hi: number): LevelReading[] =>
      Array.from({ length: n }, (_, i) => ({
        capturedAt: at(from + i), fuelLevelMl: i % 2 ? hi : lo, engineOn: true, speedKmh: 14,
      }))
    const stopped = (n: number, from: number): LevelReading[] =>
      Array.from({ length: n }, (_, i) => ({
        capturedAt: at(from + i), fuelLevelMl: 250_000, engineOn: false, speedKmh: 0,
      }))

    const day = [
      ...move(60, 0, 240_000, 260_000),      // run A — 2 hours, swings 20 L
      ...stopped(10, 60),                    // a stop: 20 min of engine-off
      ...move(15, 70, 220_000, 280_000),     // run B — 30 min, swings 60 L
    ]
    const out = deriveTankState(day, 300_000)
    expect(out.stopsAveraged).toBe(2)
    expect(out.turbulenceMl).toBe(40_000)
  })

  it('does not let a chattering engine flag manufacture stops', () => {
    // MUFINDI: EX 10 reported 266 temporary stops in one day on a flag that
    // changed state 1,445 times. A stop needs five minutes of CONSECUTIVE
    // engine-off: any engine-on reading resets the span, so alternating
    // on/off — even for an hour — is one run and no stops at all.
    const chatter: LevelReading[] = Array.from({ length: 60 }, (_, i) => ({
      capturedAt: at(i), fuelLevelMl: i % 2 ? 260_000 : 240_000,
      engineOn: i % 2 === 0, speedKmh: 8,
    }))
    const out = deriveTankState(chatter, 300_000)
    expect(out.temporaryStops).toBe(0)
    expect(out.heavyStops).toBe(0)
  })

  it('cuts a run at ANY stop, temporary or heavy', () => {
    // A stop is five minutes of CONSECUTIVE engine-off. Readings here are
    // 2 minutes apart, so four of them span six minutes and qualify.
    const move = (n: number, from: number): LevelReading[] =>
      Array.from({ length: n }, (_, i) => ({
        capturedAt: at(from + i), fuelLevelMl: i % 2 ? 260_000 : 240_000, engineOn: true, speedKmh: 14,
      }))
    const pause: LevelReading[] = Array.from({ length: 4 }, (_, i) => ({
      capturedAt: at(20 + i), fuelLevelMl: 250_000, engineOn: false, speedKmh: 0,
    }))
    const out = deriveTankState([...move(20, 0), ...pause, ...move(20, 24)], 300_000)
    expect(out.stopsAveraged).toBe(2)          // two runs, not one
    expect(out.temporaryStops).toBe(1)
    expect(out.heavyStops).toBe(0)
  })

  it('tells a heavy stop from a temporary one', () => {
    // Under an hour is a pause in the work; an hour or more is the machine
    // standing down. Both end a run — only the classification differs.
    const move = (n: number, from: number): LevelReading[] =>
      Array.from({ length: n }, (_, i) => ({
        capturedAt: at(from + i), fuelLevelMl: i % 2 ? 260_000 : 240_000, engineOn: true, speedKmh: 14,
      }))
    const off = (n: number, from: number): LevelReading[] =>
      Array.from({ length: n }, (_, i) => ({
        capturedAt: at(from + i), fuelLevelMl: 250_000, engineOn: false, speedKmh: 0,
      }))
    // Readings are 2 min apart, so an hour of engine-off is 31 of them.
    const heavy = HEAVY_STOP_MINUTES / 2 + 1
    const out = deriveTankState(
      [...move(10, 0), ...off(5, 10), ...move(10, 15), ...off(heavy, 25), ...move(10, 25 + heavy)],
      300_000,
    )
    expect(out.temporaryStops).toBe(1)
    expect(out.heavyStops).toBe(1)
  })

  it('carries the moving average across midnight', () => {
    // Most vehicles make 1-2 runs a day, so an eight-run average that restarted
    // each night spanned one or two runs — a daily figure wearing a moving
    // average's name. Prior runs come in from previous days' stored values.
    const move = (n: number, from: number, lo: number, hi: number): LevelReading[] =>
      Array.from({ length: n }, (_, i) => ({
        capturedAt: at(from + i), fuelLevelMl: i % 2 ? hi : lo, engineOn: true, speedKmh: 14,
      }))
    const today = move(15, 0, 245_000, 255_000)          // one run, swings 10 L
    const prior = [30_000, 30_000, 30_000]               // three earlier runs at 30 L

    const alone   = deriveTankState(today, 300_000)
    const carried = deriveTankState(today, 300_000, { priorRunSloshMl: prior })

    expect(alone.stopsAveraged).toBe(1)
    expect(alone.turbulenceMl).toBe(10_000)
    // (30 + 30 + 30 + 10) / 4
    expect(carried.stopsAveraged).toBe(4)
    expect(carried.turbulenceMl).toBe(25_000)
    // The day's own runs are still reported separately, for persisting.
    expect(carried.runSloshMl).toEqual([10_000])
  })

  it('never averages more than TURBULENCE_STOPS runs', () => {
    const prior = Array.from({ length: 40 }, () => 8_000)
    const out = deriveTankState([], 300_000, { priorRunSloshMl: prior })
    expect(out.stopsAveraged).toBe(TURBULENCE_STOPS)
  })

  it('ignores GPS jitter below the motion threshold', () => {
    // MOTION_MIN_KMH is 1 km/h: below that a reading is a stationary machine's
    // fix wandering rather than travel.
    const jitter: LevelReading[] = Array.from({ length: 40 }, (_, i) => ({
      capturedAt: at(i), fuelLevelMl: i % 2 ? 250_000 : 230_000, engineOn: true,
      speedKmh: MOTION_MIN_KMH / 2,
    }))
    expect(deriveTankState(jitter, 300_000).turbulenceMl).toBeNull()
  })

  it('needs more than one moving reading in a window', () => {
    // A single reading has no range at all, so one is never enough.
    const thin: LevelReading[] = Array.from({ length: TURBULENCE_MIN_SAMPLES - 1 }, (_, i) => ({
      capturedAt: at(i), fuelLevelMl: i % 2 ? 250_000 : 230_000, engineOn: true, speedKmh: 12,
    }))
    expect(deriveTankState(thin, 300_000).turbulenceMl).toBeNull()
  })

  it('says nothing about turbulence without speed', () => {
    // Turbulence is defined as what happens IN MOTION; a provider that does not
    // say whether the unit was moving cannot answer that.
    const noEngine: LevelReading[] = [
      ...Array.from({ length: 30 }, (_, i) => ({
        capturedAt: at(i), fuelLevelMl: i % 2 ? 250_000 : 230_000,
      })),
      // A settled close, so this case asserts the engine rule and not median
      // tie-breaking on an alternating tail.
      ...Array.from({ length: 10 }, (_, i) => ({
        capturedAt: at(30 + i), fuelLevelMl: 240_000,
      })),
    ]
    const out = deriveTankState(noEngine, 300_000)
    expect(out.turbulenceMl).toBeNull()
    // ...but the pair does not depend on it and is still reported.
    expect(out.consumedMl).toBe(60_000)
  })
})

describe('mileage and expected burn', () => {
  it('converts distance to an expected burn at KM_PER_LITRE', () => {
    // "For every 2 km we expect 1 L." 40 km -> 20 L.
    const out = deriveTankState([], 300_000, { distanceM: 40_000 })
    expect(out.distanceM).toBe(40_000)
    expect(out.expectedBurnMl).toBe(20_000)
  })

  it('says nothing when the unit sent no positions', () => {
    // A zero would read as "went nowhere", which is a different claim from
    // "we do not know where it went".
    const out = deriveTankState([], 300_000)
    expect(out.distanceM).toBeNull()
    expect(out.expectedBurnMl).toBeNull()
  })

  it('leaves the expectation and the measurement side by side', () => {
    // Expected burn is a fleet rule of thumb; consumed is what the tank did.
    // The gap between them is the point, so neither is derived from the other.
    const day = [
      ...Array.from({ length: 20 }, (_, i) => ({
        capturedAt: at(i), fuelLevelMl: 250_000, engineOn: true, speedKmh: 20,
      })),
    ]
    const out = deriveTankState(day, 300_000, { distanceM: 10_000 })
    expect(out.expectedBurnMl).toBe(5_000)     // 10 km at 2 km/L
    expect(out.consumedMl).toBe(50_000)        // what the tank actually lost
  })
})

describe('engine hours and engine burn', () => {
  const rate = (lPerHour: number): ResolvedRate => ({ lPerHour, basis: 'vehicle', runs: 5 })

  it('burns the measured rate over the hours the engine ran', () => {
    // Two hours at 11.28 L/h — KASULU PLANT's measured aggregate.
    const out = deriveTankState([], 300_000, { engineSeconds: 7_200, rate: rate(11.28) })
    expect(out.engineSeconds).toBe(7_200)
    expect(out.engineBurnMl).toBe(22_560)
    expect(out.engineRateLPerHour).toBe(11.28)
    expect(out.engineRateBasis).toBe('vehicle')
  })

  it('says nothing when the machine and its type have no measured rate', () => {
    // Null, never zero. A zero reads as "burned nothing", where the truth is
    // "nobody has ever measured this one".
    const out = deriveTankState([], 300_000, { engineSeconds: 7_200, rate: null })
    expect(out.engineSeconds).toBe(7_200)
    expect(out.engineBurnMl).toBeNull()
    expect(out.engineRateLPerHour).toBeNull()
    expect(out.engineRateBasis).toBeNull()
  })

  it('reports a working excavator that covered no ground', () => {
    // The case the whole engine-hours basis exists for. Position freezes at
    // speed 0, so a machine that dug all day reports ~0 km: the distance
    // expectation reads near zero against a real shift's burn, and only the
    // engine-hours one describes what happened.
    const out = deriveTankState([], 300_000, {
      distanceM: 200, engineSeconds: 8 * 3_600, rate: rate(11.28),
    })
    expect(out.expectedBurnMl).toBe(100)        // 0.2 km at 2 km/L — near nothing
    expect(out.engineBurnMl).toBe(90_240)       // 8 h at 11.28 L/h — the real shift
  })

  it('keeps both expectations, and neither is derived from the other', () => {
    // A road vehicle, where the two bases are supposed to agree. They are still
    // reported separately: the gap between them is the diagnostic.
    const out = deriveTankState([], 300_000, {
      distanceM: 100_000, engineSeconds: 4 * 3_600, rate: rate(6.98),
    })
    expect(out.expectedBurnMl).toBe(50_000)     // 100 km at 2 km/L
    expect(out.engineBurnMl).toBe(27_920)       // 4 h at 6.98 L/h
  })

  it('says nothing about burn when the engine time is unknown', () => {
    const out = deriveTankState([], 300_000, { engineSeconds: null, rate: rate(9) })
    expect(out.engineSeconds).toBeNull()
    expect(out.engineBurnMl).toBeNull()
  })
})
