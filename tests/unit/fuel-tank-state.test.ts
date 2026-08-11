import { describe, it, expect } from 'vitest'
import {
  deriveTankState, STOP_MINUTES, TURBULENCE_MIN_SAMPLES,
} from '../../src/modules/fuel/fuel-tank-state.js'

const T0 = Date.parse('2026-08-11T06:00:00Z')
/** One reading every 2 minutes. */
const at = (i: number) => new Date(T0 + i * 2 * 60_000)

type S = { capturedAt: Date; fuelLevelMl: number; engineOn?: boolean }
const run = (n: number, ml: number, engineOn: boolean, from: number): S[] =>
  Array.from({ length: n }, (_, i) => ({ capturedAt: at(from + i), fuelLevelMl: ml, engineOn }))

describe('deriveTankState', () => {
  it('reads the pair across a stop', () => {
    // Parked at 300 L for 40 min (a real stop), works and burns down to 240 L.
    const s = [
      ...run(20, 300_000, false, 0),    // stopped — 40 min
      ...run(30, 240_000, true, 20),    // working
    ]
    const out = deriveTankState(s)
    expect(out.initialMl).toBe(300_000)
    expect(out.currentMl).toBe(240_000)
    expect(out.consumedMl).toBe(60_000)
    expect(out.workingSince).toEqual(at(19))
  })

  it('does not split one working period on a brief pause', () => {
    // Two minutes of engine-off in the middle of a shift is a pause, not a
    // stop, or a machine restarting after a blockage would report three shifts.
    const s = [
      ...run(20, 300_000, false, 0),
      ...run(10, 280_000, true, 20),
      ...run(1,  278_000, false, 30),   // 2 min off — under STOP_MINUTES
      ...run(20, 240_000, true, 31),
    ]
    expect(deriveTankState(s).initialMl).toBe(300_000)
    expect(deriveTankState(s).consumedMl).toBe(60_000)
  })

  it('takes the settled level at a stop, never one reading', () => {
    // A tank in motion has a range, not a level. The stop is the only moment
    // the number means a quantity — and it is a median of the settled window,
    // so one bad reading cannot set the baseline for a whole shift.
    const stopped: S[] = [
      ...run(9, 300_000, false, 0),
      { capturedAt: at(9), fuelLevelMl: 9_000, engineOn: false },   // spike
      ...run(10, 300_000, false, 10),
    ]
    const out = deriveTankState([...stopped, ...run(20, 250_000, true, 20)])
    expect(out.initialMl).toBe(300_000)
  })

  it('says nothing at all without engine state', () => {
    // Both halves are defined by it. Two of the operator's five condemned units
    // report engineOn on zero readings, and a consumption figure derived from a
    // guess is worse than none because it looks measured.
    const s = Array.from({ length: 40 }, (_, i) => ({ capturedAt: at(i), fuelLevelMl: 300_000 }))
    expect(deriveTankState(s)).toMatchObject({
      initialMl: null, currentMl: null, consumedMl: null, turbulenceMl: null,
    })
  })

  it('gives no consumption figure for a machine never seen stopped', () => {
    const out = deriveTankState(run(40, 300_000, true, 0))
    expect(out.initialMl).toBeNull()
    expect(out.consumedMl).toBeNull()
    expect(out.currentMl).toBe(300_000)   // the live level is still honest
  })

  it('measures turbulence only while working', () => {
    // A 30-minute window is 15 readings at this spacing. The working windows
    // swing 20 L; the stopped ones swing 100 L and must not count, or a probe
    // settling after a shift would read as violent terrain.
    const wild: S[] = Array.from({ length: 20 }, (_, i) => ({
      capturedAt: at(i), fuelLevelMl: i % 2 ? 300_000 : 200_000, engineOn: false,
    }))
    const working: S[] = Array.from({ length: 40 }, (_, i) => ({
      capturedAt: at(20 + i), fuelLevelMl: i % 2 ? 250_000 : 230_000, engineOn: true,
    }))
    const out = deriveTankState([...wild, ...working])
    expect(out.turbulenceMl).toBe(20_000)
  })

  it('will not compute turbulence from a handful of readings', () => {
    const s = [
      ...run(20, 300_000, false, 0),
      ...Array.from({ length: TURBULENCE_MIN_SAMPLES - 1 }, (_, i) => ({
        capturedAt: at(20 + i), fuelLevelMl: i % 2 ? 250_000 : 230_000, engineOn: true,
      })),
    ]
    expect(deriveTankState(s).turbulenceMl).toBeNull()
  })

  it('needs a full STOP_MINUTES of engine-off to call it a stop', () => {
    const brief = Math.floor(STOP_MINUTES / 2 / 2)   // half the window, in samples
    const s = [
      ...run(20, 300_000, true, 0),
      ...run(brief, 290_000, false, 20),
      ...run(20, 250_000, true, 20 + brief),
    ]
    expect(deriveTankState(s).initialMl).toBeNull()
  })
})
