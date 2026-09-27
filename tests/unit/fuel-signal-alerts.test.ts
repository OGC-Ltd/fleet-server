import { describe, it, expect } from 'vitest'
import {
  detectFuelSignals, thresholdsFor, mergeContiguous,
  type SignalSample, type SignalEvent,
} from '../../src/modules/fuel/fuel-signal-alerts.js'
import { toSignalSamples, profileTypeFor, scanTelemetry, SignalStream, NO_BAND_INPUTS } from '../../src/modules/fuel/fuel-signal-scan.js'

/** A deterministic ±amp jitter, so the series is noisy but the test is not. */
const jitter = (i: number, amp: number) => amp * Math.sin(i * 2.399)

/** `n` samples every `step` s from `t0`, built by `f(i, t)`. */
function series(n: number, step: number, f: (i: number, t: number) => Partial<SignalSample>, t0 = 1_000_000): SignalSample[] {
  return Array.from({ length: n }, (_, i) => {
    const t = t0 + i * step
    return { t, fuelL: null, speedKmh: 0, ignitionOff: true, work: 0, ...f(i, t) }
  })
}

const types = (events: SignalEvent[]) => events.map(e => e.type)

describe('detectFuelSignals — the specification\'s stages', () => {
  const truck = thresholdsFor('truck')

  it('raises nothing on a parked tank with probe noise', () => {
    const s = series(360, 10, i => ({ fuelL: 300 + jitter(i, 1) }))
    const { events, stats } = detectFuelSignals(s, truck)
    expect(events).toEqual([])
    expect(stats.normalWindows).toBeGreaterThan(0)
    expect(stats.motion.speed).toBe(360)
  })

  it('reports a five-minute bowser fill as ONE refuel of about its size', () => {
    const s = series(180, 10, i => {
      // 200 L over 30 samples (5 min), starting at sample 60.
      const added = Math.min(Math.max(i - 60, 0), 30) * (200 / 30)
      return { fuelL: 100 + added + jitter(i, 0.8) }
    })
    const { events } = detectFuelSignals(s, truck)
    expect(types(events)).toEqual(['REFUEL'])
    expect(events[0]!.deltaFuelL).toBeGreaterThan(150)
    expect(events[0]!.residualL).toBeGreaterThan(150)
  })

  it('flags a fast drop from a parked, switched-off tank as theft', () => {
    const s = series(120, 10, i => {
      // 40 L gone over 2 minutes from sample 40.
      const taken = Math.min(Math.max(i - 40, 0), 12) * (40 / 12)
      return { fuelL: 400 - taken + jitter(i, 0.5) }
    })
    const { events } = detectFuelSignals(s, truck)
    // One event: the filter-lag tail after confirmation is the same siphon.
    expect(types(events)).toEqual(['THEFT_SUSPECTED'])
    expect(events[0]!.residualL!).toBeLessThan(-35)
  })

  it('accounts a drive\'s burn against distance, so arriving lighter is not loss', () => {
    // Parked 5 min, drive 60 km in 60 min burning exactly C per km, parked again.
    const s = series(60 + 360 + 60, 10, i => {
      const driving = i >= 30 && i < 390
      const km = Math.min(Math.max(i - 30, 0), 360) * (60 / 360)
      return {
        fuelL: 300 - km * truck.consumption + jitter(i, driving ? 6 : 0.5),
        speedKmh: driving ? 60 : 0,
        ignitionOff: !driving,
        work: km,
      }
    })
    const { events, stats } = detectFuelSignals(s, truck)
    expect(events).toEqual([])
    expect(stats.sloshing).toBeGreaterThan(300)
  })

  it('ignores level swings while the accelerometer shows sloshing', () => {
    const s = series(200, 1, i => {
      const sloshing = i >= 50 && i < 150
      return {
        fuelL: 300 + (sloshing ? 40 * Math.sin(i) : 0),
        ax: sloshing ? 3 * Math.sin(i * 1.7) : 0.1,
        ay: sloshing ? 3 * Math.cos(i * 1.3) : 0,
        az: 9.81,
        speedKmh: null,
      }
    })
    const { events, stats } = detectFuelSignals(s, thresholdsFor('car'))
    expect(events).toEqual([])
    expect(stats.motion.imu).toBe(200)
    expect(stats.sloshing).toBeGreaterThan(50)
  })

  it('seeds gravity from the first IMU reading instead of gating the start as sloshing', () => {
    const s = series(10, 1, () => ({ fuelL: 50, ax: 0.2, ay: -0.1, az: 9.8, speedKmh: null }))
    const { stats } = detectFuelSignals(s, thresholdsFor('car'))
    expect(stats.sloshing).toBe(0)
  })

  it('does not call loss where the engine time behind the expected burn is unknown', () => {
    const ex = thresholdsFor('excavator', { consumption: 20 })
    // Stationary, ignition unreported, level falling at 60 L/h: could be a
    // running machine or a leak; the detector must not say which.
    const s = series(120, 10, i => ({
      fuelL: 500 - i * 10 * (60 / 3600) * 10, ignitionOff: null, work: 0, workMeasured: i === 0,
    }))
    const { events, stats } = detectFuelSignals(s, ex)
    expect(events.filter(e => e.type !== 'REFUEL')).toEqual([])
    expect(stats.suppressedUnmeasured).toBeGreaterThan(0)
  })

  it('raises LOW_FUEL only after it persists, and once until the tank recovers', () => {
    const car = thresholdsFor('car')
    const s = series(80, 10, i => ({ fuelL: i < 60 ? 6 : 40 }))
    const low = detectFuelSignals(s, car).events.filter(e => e.type === 'LOW_FUEL')
    expect(low).toHaveLength(1)
    // Stable from sample 2; 45 s of persistence at 10 s steps.
    expect(low[0]!.at - 1_000_000).toBeGreaterThanOrEqual(20 + car.nConfirmS)
  })

  it('catches a slow leak on a running machine through the 15-minute rule', () => {
    const gen = thresholdsFor('generator', { consumption: 45 })
    // Running 40 min at 45 L/h plus a 30 L/h leak — slower per window than tol.
    const s = series(240, 10, i => {
      const h = (i * 10) / 3600
      return { fuelL: 800 - h * (45 + 30) + jitter(i, 0.3), ignitionOff: false, work: h }
    })
    const { events } = detectFuelSignals(s, gen)
    const leak = events.find(e => e.type === 'LEAK_SUSPECTED')
    expect(leak?.rule).toBe('cumulative')
    expect(leak!.residualL!).toBeLessThan(-gen.rLeak)
  })

  it('reports a change across a silence in the feed once, not split by filter lag', () => {
    // Replayed 25 Sep: a unit silent 01:57-03:44 EAT came back 39 L lower and
    // was reported as a cumulative LEAK and, two minutes later, a THEFT.
    const before = series(40, 30, () => ({ fuelL: 300, ignitionOff: false }))
    const after = series(40, 30, () => ({ fuelL: 261, ignitionOff: false }), before.at(-1)!.t + 2 * 3600)
    const { events, stats } = detectFuelSignals([...before, ...after], truck)
    expect(types(events)).toEqual(['LEAK_SUSPECTED'])
    expect(events[0]!.rule).toBe('window')
    expect(events[0]!.residualL!).toBeCloseTo(-39, 0)
    expect(stats.gapResets).toBe(1)
  })

  it('leaves ordinary running burn alone on the same machine', () => {
    const gen = thresholdsFor('generator', { consumption: 45 })
    const s = series(240, 10, i => {
      const h = (i * 10) / 3600
      return { fuelL: 800 - h * 45 + jitter(i, 0.3), ignitionOff: false, work: h }
    })
    expect(detectFuelSignals(s, gen).events).toEqual([])
  })
})

describe('thresholdsFor', () => {
  it('scales the litre thresholds up by tank, never down', () => {
    const big = thresholdsFor('truck', { tankCapacityL: 1_000 })
    expect(big).toMatchObject({ rRefuel: 50, rTheft: 30, rLeak: 10, tol: 5 })
    expect(thresholdsFor('truck', { tankCapacityL: 50 })).toMatchObject({ rRefuel: 15, rTheft: 10, rLeak: 3, tol: 2 })
  })

  it('prefers a measured consumption over the table', () => {
    expect(thresholdsFor('generator', { consumption: 45 }).consumption).toBe(45)
    expect(thresholdsFor('generator').consumption).toBe(3)
  })
})

describe('mergeContiguous', () => {
  const ev = (at: number, windowStart: number, residualL: number): SignalEvent => ({
    type: 'REFUEL', at, since: at - 60, windowStart, fuelL: 0, deltaFuelL: residualL,
    expectedL: 0, residualL, workDelta: 0, rule: 'window',
  })

  it('folds a loss tail into the theft it continues', () => {
    const theft = { ...ev(100, 0, -30), type: 'THEFT_SUSPECTED' as const }
    const tail = { ...ev(160, 100, -8), type: 'LEAK_SUSPECTED' as const }
    expect(mergeContiguous([theft, tail])).toEqual([
      expect.objectContaining({ type: 'THEFT_SUSPECTED', at: 160, windowStart: 0, residualL: -38 }),
    ])
  })

  it('keeps a refuel and a loss apart even when contiguous', () => {
    const tail = { ...ev(160, 100, -8), type: 'LEAK_SUSPECTED' as const }
    expect(mergeContiguous([ev(100, 0, 30), tail])).toHaveLength(2)
  })

  it('joins an event that opened where the previous one closed', () => {
    const [m, ...rest] = mergeContiguous([ev(100, 0, 20), ev(200, 100, 30), ev(900, 500, 25)])
    expect(m).toMatchObject({ at: 200, since: 40, windowStart: 0, residualL: 50 })
    expect(rest).toHaveLength(1)
  })
})

describe('toSignalSamples', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 8, 1, 6, 0, s))
  const row = (s: number, o: Partial<Parameters<typeof toSignalSamples>[0][number]> = {}) => ({
    capturedAt: at(s), lat: -1, lng: 36, speedKmh: 0, engineOn: true, ignitionKnown: true, fuelLevelMl: 100_000, ...o,
  })

  it('integrates engine-hours only over intervals opened by a measured engine', () => {
    const out = toSignalSamples([
      row(0), row(600), row(1200, { ignitionKnown: null }), row(1800),
    ], 'hours')
    expect(out.map(s => s.work)).toEqual([0, 1 / 6, 1 / 3, 1 / 3])
    expect(out.map(s => s.workMeasured)).toEqual([true, true, true, false])
    expect(out[0]).toMatchObject({ fuelL: 100, ignitionOff: false })
    expect(out[2]!.ignitionOff).toBeNull()
  })

  it('does not credit engine time across a silence longer than the gap cap', () => {
    const out = toSignalSamples([row(0), row(3600)], 'hours')
    expect(out[1]).toMatchObject({ work: 0, workMeasured: false })
  })

  it('counts distance from positions and refuses a GPS jump', () => {
    const out = toSignalSamples([
      row(0, { lat: 0, lng: 36 }),
      row(60, { lat: 0.009, lng: 36 }),   // ~1 km in a minute: 60 km/h
      row(120, { lat: 1, lng: 36 }),      // ~110 km in a minute
    ], 'km')
    expect(out[1]!.work).toBeCloseTo(1, 1)
    expect(out[2]).toMatchObject({ workMeasured: false })
    expect(out[2]!.work).toBe(out[1]!.work)
  })
})

describe('SignalStream', () => {
  it('confirms, one fix at a time, exactly what the batch scan reports', () => {
    const t0 = Date.UTC(2026, 8, 1, 6)
    // Parked truck: a 200 L fill, a quiet hour, then a 40 L fall in two minutes.
    const rows = Array.from({ length: 600 }, (_, i) => {
      const added = Math.min(Math.max(i - 60, 0), 30) * (200 / 30)
      const taken = Math.min(Math.max(i - 400, 0), 12) * (40 / 12)
      return {
        capturedAt: new Date(t0 + i * 10_000), lat: -1, lng: 36, speedKmh: 0,
        engineOn: false, ignitionKnown: true,
        fuelLevelMl: Math.round((100 + added - taken + 0.8 * Math.sin(i * 2.399)) * 1000),
      }
    })
    const batch = scanTelemetry(rows, NO_BAND_INPUTS, new Date(t0), { profile: 'truck' })
    const stream = new SignalStream(NO_BAND_INPUTS, { profile: 'truck' })
    const live = rows.flatMap(r => stream.push(r))

    expect(batch.events.map(e => e.type)).toEqual(['REFUEL', 'THEFT_SUSPECTED'])
    expect(mergeContiguous(live)).toEqual(batch.events)
    expect(stream.profile).toEqual(batch.profile)
  })
})

describe('profileTypeFor', () => {
  const b = (vehicleType: string | null, plate = 'KAA 001A', orgCode = 'X') =>
    ({ orgCode, plate, vehicleType, tankCapacityLitres: null })

  it('maps this fleet\'s types onto the specification\'s rows', () => {
    expect(profileTypeFor(b('GENERATOR')).type).toBe('generator')
    expect(profileTypeFor(b('SALOON')).type).toBe('car')
    expect(profileTypeFor(b('BUS')).type).toBe('bus')
    expect(profileTypeFor(b('TRUCK')).type).toBe('truck')
    expect(profileTypeFor(b(null)).type).toBe('truck')
  })

  it('gives unclassed hours machinery the nearest machinery row', () => {
    const p = profileTypeFor(b('TRACTOR'))
    expect(p.type).toBe('excavator')
    expect(p.reason).toMatch(/engine-hour/)
  })
})
