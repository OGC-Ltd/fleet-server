/**
 * The 7-day day-distance cache (operator, 18 Nov 2026: "cache the odometer data
 * for easier query instead of querying the db each time ... expires after 7
 * days"). Tests run without REDIS_URL, so this is the in-process fallback; the
 * Redis path sets the same entries with EX = DAY_KM_TTL_S.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const queries: string[][] = []
const pool = {
  $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const ids = values.find((v) => Array.isArray(v)) as string[]
    queries.push(ids)
    return ids.filter((id) => id !== 'idle').map((id) => ({ vehicle_id: id, gps_km: 60, odo_km: 71.8, odo_n: 1300, fixes: 1374 }))
  }),
}
vi.mock('../../src/lib/report-db.js', () => ({ reportDb: () => pool }))
vi.mock('../../src/lib/prisma.js', () => ({ prisma: {} }))
vi.mock('../../src/modules/dashcam/dashcam.service.js', () => ({ getAlarms: vi.fn() }))

const { readDayKm, keepDayKm, DAY_KM_TTL_S, SETTLE_MS, _clearDayKmCache } = await import('../../src/modules/reports/day-km.cache.js')
const { cachedDayKmEvidence } = await import('../../src/modules/reports/range-reports.service.js')

const DAY = '2026-11-17'
const DAY_END = Date.parse('2026-11-17T21:00:00Z')
const e = { gpsKm: 66.1, odoKm: 71.8, odoReadings: 1371, fixes: 1374 }

beforeEach(() => { queries.length = 0; _clearDayKmCache() })

describe('day-km cache', () => {
  it('keeps a unit-day for 7 days, then lets it go', async () => {
    const now = DAY_END + SETTLE_MS
    await keepDayKm([['v1', e]], DAY, now)
    expect((await readDayKm(['v1', 'v2'], DAY, now)).get('v1')).toEqual(e)
    expect((await readDayKm(['v1'], DAY, now + DAY_KM_TTL_S * 1000 - 1)).has('v1')).toBe(true)
    expect((await readDayKm(['v1'], DAY, now + DAY_KM_TTL_S * 1000)).has('v1')).toBe(false)
  })

  it('reads a settled day from the database once, then from the cache', async () => {
    const now = DAY_END + SETTLE_MS + 1
    const first = await cachedDayKmEvidence(['v1', 'v2'], DAY, now)
    const second = await cachedDayKmEvidence(['v1', 'v2'], DAY, now)
    expect(queries).toEqual([['v1', 'v2']])
    expect(second).toEqual(first)
    expect(second.get('v1')).toMatchObject({ odoKm: 71.8, odoReadings: 1300 })
  })

  it('asks the database only for the units the cache lacks', async () => {
    const now = DAY_END + SETTLE_MS + 1
    await keepDayKm([['v1', e]], DAY, now)
    const out = await cachedDayKmEvidence(['v1', 'v2'], DAY, now)
    expect(queries).toEqual([['v2']])
    expect(out.get('v1')).toEqual(e)
  })

  it('remembers a unit with no fixes that day without listing it', async () => {
    const now = DAY_END + SETTLE_MS + 1
    expect((await cachedDayKmEvidence(['idle'], DAY, now)).has('idle')).toBe(false)
    expect((await cachedDayKmEvidence(['idle'], DAY, now)).has('idle')).toBe(false)
    expect(queries).toEqual([['idle']])
  })

  it('never caches a day still open or just ended', async () => {
    const now = DAY_END + SETTLE_MS - 1
    await cachedDayKmEvidence(['v1'], DAY, now)
    await cachedDayKmEvidence(['v1'], DAY, now)
    expect(queries).toEqual([['v1'], ['v1']])
  })
})
