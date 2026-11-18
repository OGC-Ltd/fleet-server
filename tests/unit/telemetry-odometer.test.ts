import { describe, it, expect } from 'vitest'
import { readOdometerM } from '../../src/providers/wialon/wialon.sensors.js'
import { odometerColumns } from '../../src/modules/ingest/ingest.service.js'
import { pickDayKm, rangeSource } from '../../src/modules/reports/range-reports.service.js'

// Operator, 18 Nov 2026 (Weighbridges › Metrics): store the tracker's own
// odometer per fix, and read a day's distance off it where a unit sends one.
describe('readOdometerM', () => {
  it("reads Teltonika io_16 in metres, then a firmware's own `odometer`", () => {
    expect(readOdometerM({ io_16: 412_345_678 })).toBe(412_345_678)
    expect(readOdometerM({ odometer: '1500.4' })).toBe(1500)
  })
  it('returns null for a counter that is off, out of range, or absent', () => {
    expect(readOdometerM({ io_16: 0 })).toBeNull()
    expect(readOdometerM({ io_16: -5 })).toBeNull()
    expect(readOdometerM({ io_16: 2e10 })).toBeNull()
    expect(readOdometerM({ pwr_ext: 24 })).toBeNull()
    expect(readOdometerM(undefined)).toBeNull()
  })
})

describe('odometerColumns', () => {
  it('writes whole metres, and null for nothing usable', () => {
    expect(odometerColumns({ odometerM: 1234.6 } as never)).toEqual({ odometerM: 1235 })
    expect(odometerColumns({} as never)).toEqual({ odometerM: null })
    expect(odometerColumns({ odometerM: Number.NaN } as never)).toEqual({ odometerM: null })
  })
})

describe('pickDayKm', () => {
  it("takes the odometer where at least half the day's fixes carry one", () => {
    expect(pickDayKm({ gpsKm: 66.1, odoKm: 71.8, odoReadings: 900, fixes: 1374 })).toEqual({ km: 71.8, source: 'odometer' })
  })
  it('takes the GPS sum on a day with too few readings, or none (every day before the column)', () => {
    expect(pickDayKm({ gpsKm: 66.1, odoKm: 71.8, odoReadings: 300, fixes: 1374 })).toEqual({ km: 66.1, source: 'gps' })
    expect(pickDayKm({ gpsKm: 66.1, odoKm: 0, odoReadings: 0, fixes: 1374 })).toEqual({ km: 66.1, source: 'gps' })
  })
  it('reads a counter that stood still while the GPS covered ground as stuck', () => {
    expect(pickDayKm({ gpsKm: 40, odoKm: 0, odoReadings: 500, fixes: 500 })).toEqual({ km: 40, source: 'gps' })
  })
  it('keeps the odometer on a parked day', () => {
    expect(pickDayKm({ gpsKm: 0.3, odoKm: 0, odoReadings: 200, fixes: 200 })).toEqual({ km: 0, source: 'odometer' })
  })
})

describe('rangeSource', () => {
  it('names one source, or mixed', () => {
    expect(rangeSource(new Set())).toBeNull()
    expect(rangeSource(new Set(['gps'] as const))).toBe('gps')
    expect(rangeSource(new Set(['gps', 'odometer'] as const))).toBe('mixed')
  })
})

describe('unit-distance', async () => {
  const { odoKmOf, needsFill, MISS_TTL_MS } = await import('../../src/modules/reports/unit-distance.service.js')
  it("counts the odometer's rises between readings, in any order", () => {
    expect(odoKmOf([{ t: 120, m: 1_002_000 }, { t: 0, m: 1_000_000 }, { t: 60, m: 1_001_000 }])).toBe(2)
  })
  it('skips a reset and a jump faster than a lorry drives', () => {
    expect(odoKmOf([{ t: 0, m: 5_000 }, { t: 60, m: 6_000 }, { t: 120, m: 100 }, { t: 180, m: 1_100 }])).toBe(2)
    expect(odoKmOf([{ t: 0, m: 0 + 1 }, { t: 60, m: 50_001 }, { t: 120, m: 51_001 }])).toBe(1)
  })
  it('pulls a Wialon unit-day with no stored reading, once', () => {
    const now = 10 * MISS_TTL_MS
    expect(needsFill(undefined, 30170978, undefined, now)).toBe(true)
    expect(needsFill({ gpsKm: 60, odoKm: 0, odoReadings: 0, fixes: 1374 }, 30170978, undefined, now)).toBe(true)
    expect(needsFill({ gpsKm: 60, odoKm: 70, odoReadings: 1371, fixes: 1374 }, 30170978, undefined, now)).toBe(false)
    // Most rows without a reading though some carry one (the deploy day's early hours): pulled
    expect(needsFill({ gpsKm: 60, odoKm: 70, odoReadings: 900, fixes: 1374 }, 30170978, undefined, now)).toBe(true)
    expect(needsFill({ gpsKm: 0, odoKm: 0, odoReadings: 2, fixes: 14 }, 30171059, undefined, now)).toBe(true)
    // ...but not again within the memo, answered or not
    expect(needsFill({ gpsKm: 0, odoKm: 0, odoReadings: 2, fixes: 14 }, 30171059, now - 60_000, now)).toBe(false)
    expect(needsFill(undefined, null, undefined, now)).toBe(false)
    expect(needsFill(undefined, 1, now - 1000, now)).toBe(false)
    expect(needsFill(undefined, 1, now - MISS_TTL_MS, now)).toBe(true)
  })
})

describe('odometer-at', async () => {
  const { readingAt, fleetDayOf, NEAR_MS } = await import('../../src/modules/reports/odometer-at.service.js')
  it('interpolates between the readings either side of the moment', () => {
    expect(readingAt(1_500, { t: 1_000, m: 10_000 }, { t: 2_000, m: 12_000 })).toBe(11_000)
    expect(readingAt(1_000, { t: 1_000, m: 10_000 }, { t: 1_000, m: 10_000 })).toBe(10_000)
  })
  it('takes a one-sided reading only when it is near', () => {
    expect(readingAt(NEAR_MS, { t: 0, m: 5_000 }, null)).toBe(5_000)
    expect(readingAt(NEAR_MS + 1, { t: 0, m: 5_000 }, null)).toBeNull()
    expect(readingAt(0, null, { t: NEAR_MS, m: 7_000 })).toBe(7_000)
    expect(readingAt(0, null, null)).toBeNull()
  })
  it('files a moment under its Nairobi fleet day', () => {
    expect(fleetDayOf(Date.parse('2026-11-14T23:47:00Z'))).toBe('2026-11-15')
    expect(fleetDayOf(Date.parse('2026-11-15T20:59:00Z'))).toBe('2026-11-15')
  })
})
