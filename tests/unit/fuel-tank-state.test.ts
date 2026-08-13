import { describe, it, expect } from 'vitest'
import {
  deriveTankState, closingLevel, CLOSE_WINDOW_MINUTES, TURBULENCE_MIN_SAMPLES,
  type LevelReading,
} from '../../src/modules/fuel/fuel-tank-state.js'

const T0 = Date.parse('2026-08-13T04:00:00Z')
/** One reading every 2 minutes. */
const at = (i: number) => new Date(T0 + i * 2 * 60_000)

const run = (n: number, ml: number, engineOn: boolean, from = 0): LevelReading[] =>
  Array.from({ length: n }, (_, i) => ({ capturedAt: at(from + i), fuelLevelMl: ml, engineOn }))

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

  it('measures turbulence only while working', () => {
    // 30-minute windows = 15 readings at this spacing. The parked run swings
    // 100 L and must not count, or a probe settling after a shift would read as
    // violent terrain.
    const parked: LevelReading[] = Array.from({ length: 20 }, (_, i) => ({
      capturedAt: at(i), fuelLevelMl: i % 2 ? 300_000 : 200_000, engineOn: false,
    }))
    const working: LevelReading[] = Array.from({ length: 40 }, (_, i) => ({
      capturedAt: at(20 + i), fuelLevelMl: i % 2 ? 250_000 : 230_000, engineOn: true,
    }))
    expect(deriveTankState([...parked, ...working], 300_000).turbulenceMl).toBe(20_000)
  })

  it('will not compute turbulence from a handful of readings', () => {
    const thin: LevelReading[] = Array.from({ length: TURBULENCE_MIN_SAMPLES - 1 }, (_, i) => ({
      capturedAt: at(i), fuelLevelMl: i % 2 ? 250_000 : 230_000, engineOn: true,
    }))
    expect(deriveTankState(thin, 300_000).turbulenceMl).toBeNull()
  })

  it('says nothing about turbulence without engine state', () => {
    // Turbulence is defined as what happens WHILE WORKING; a provider that does
    // not say whether the engine was on cannot answer that. Two of the
    // operator's five condemned units report it on zero readings.
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
