/**
 * What the Alarms page and the reports read (dashcam.service getAlarms over
 * dashcam-store): the Redis day cache, then the database, whose answer is
 * written back into the cache. VSS is never asked: only the vss-worker does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/config/env.js', async (orig) => {
  const real = await orig<typeof import('../../src/config/env.js')>()
  return { ...real, env: { ...real.env, VSS_TIMEZONE: 'Africa/Nairobi', VSS_CACHE_DAYS: 30 } }
})
vi.mock('../../src/lib/redis.js', () => ({ isRedisConfigured: () => true, getCacheRedis: () => null }))

const held = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  db: new Map<string, { incidents: unknown[]; partial: boolean; capturedAt: number }>(),
  cameras: null as string[] | null,
  files: new Map<string, { orgId: string; url: string }>(),
  written: [] as Array<{ day: string; value: Record<string, unknown>; opts: unknown }>,
}))
vi.mock('../../src/modules/dashcam/dashcam-store.js', () => ({
  readDays: vi.fn(async (_org: string, days: string[]) => new Map(days.filter((d) => held.cache.has(d)).map((d) => [d, held.cache.get(d)]))),
  dbDays: vi.fn(async (_org: string, days: string[]) => new Map(days.filter((d) => held.db.has(d)).map((d) => [d, held.db.get(d)]))),
  storeDay: vi.fn(async (_org: string, day: string, value: Record<string, unknown>, opts: unknown) => { held.written.push({ day, value, opts }); return true }),
  readCameras: vi.fn(async () => held.cameras),
  rememberFile: vi.fn(),
  storedFile: vi.fn(async (k: string) => held.files.get(k) ?? null),
}))

const vss = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../src/providers/vss/index.js', async (orig) => {
  const real = await orig<typeof import('../../src/providers/vss/index.js')>()
  return {
    ...real,
    vssAvailable: () => true,
    listDevices: async () => { vss.calls++; return [] },
    vssCall: async () => { vss.calls++; return [] },
  }
})

const svc = await import('../../src/modules/dashcam/dashcam.service.js')

const ORG = 'org_1'
const NOW = Date.parse('2026-11-26T12:00:00+03:00')
const at = (local: string) => new Date(`${local}+03:00`).toISOString().replace(/\.\d{3}Z$/, 'Z')
const inc = (id: string, local: string, vehicleId = 'veh_1', code = 214) => ({
  id, code, label: 'No seatbelt', group: 'Driver', severity: 'warning', category: 'driver',
  occurredAt: at(local), vehicleId, plate: 'KCJ 099T', deviceId: '70462493', lat: null, lng: null, speed: null, videos: [], photos: [],
})
const day = (incidents: unknown[], cachedAt = NOW - 60_000, extra: Record<string, unknown> = {}) =>
  ({ cameras: 4, incidents, partial: false, through: cachedAt, cachedAt, ...extra })
const dbDay = (incidents: unknown[], capturedAt = NOW - 60_000, partial = false) => ({ incidents, partial, capturedAt })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  svc.resetDashcamState(0)
  held.cache.clear(); held.db.clear(); held.files.clear(); held.written = []; held.cameras = null
  vss.calls = 0
})
afterEach(() => {
  expect(vss.calls).toBe(0)      // whatever the case, VSS is never asked
  vi.useRealTimers()
})

describe('getAlarms reads the cache, then the database — never VSS', () => {
  it('serves cached days, newest first, trimmed to the window', async () => {
    held.cache.set('2026-11-25', day([inc('A', '2026-11-25 08:00:00'), inc('OLD', '2026-11-25 05:00:00')]))
    held.cache.set('2026-11-26', day([inc('B', '2026-11-26 09:00:00')]))
    const a = await svc.getAlarms(ORG, null, at('2026-11-25 06:00:00'))
    expect(a.incidents.map((i) => i.id)).toEqual(['B', 'A'])
    expect(a.cameras).toBe(4)
    expect(a.partial).toBeUndefined()
    expect(held.written).toEqual([])
  })

  it('keeps only the vehicles in the caller’s scope, cameras counted from the worker’s list', async () => {
    held.cameras = ['veh_1', 'veh_9', 'veh_7']
    held.cache.set('2026-11-26', day([inc('MINE', '2026-11-26 09:00:00'), inc('THEIRS', '2026-11-26 09:30:00', 'veh_9')]))
    const a = await svc.getAlarms(ORG, new Set(['veh_1']), at('2026-11-26 00:00:00'))
    expect(a.incidents.map((i) => i.id)).toEqual(['MINE'])
    expect(a.cameras).toBe(1)
  })

  it('a cache miss reads the database, and its answer is written back where nothing is held', async () => {
    held.cache.set('2026-11-26', day([inc('B', '2026-11-26 09:00:00')]))
    held.db.set('2026-11-25', dbDay([inc('DB1', '2026-11-25 10:00:00')], Date.parse('2026-11-25T22:30:00Z')))
    const a = await svc.getAlarms(ORG, null, at('2026-11-25 00:00:00'))
    expect(a.incidents.map((i) => i.id)).toEqual(['B', 'DB1'])
    expect(held.written).toHaveLength(1)
    expect(held.written[0]).toMatchObject({
      day: '2026-11-25',
      value: { source: 'db', cachedAt: Date.parse('2026-11-25T22:30:00Z'), incidents: [{ id: 'DB1' }] },
      opts: { onlyIfAbsent: true },
    })
  })

  it('today from the database when the cache misses it, also written back', async () => {
    held.db.set('2026-11-26', dbDay([inc('T1', '2026-11-26 09:00:00')], NOW - 120_000))
    const a = await svc.getAlarms(ORG, null, at('2026-11-26 00:00:00'))
    expect(a.incidents.map((i) => i.id)).toEqual(['T1'])
    expect(a.stale).toBeUndefined()
    expect(held.written.map((w) => w.day)).toEqual(['2026-11-26'])
  })

  it('today’s copy older than 15 minutes is served, marked stale', async () => {
    held.cache.set('2026-11-26', day([inc('B', '2026-11-26 09:00:00')], NOW - 30 * 60_000))
    const a = await svc.getAlarms(ORG, null, at('2026-11-26 00:00:00'))
    expect(a.incidents.map((i) => i.id)).toEqual(['B'])
    expect(a.stale).toBe(true)
  })

  it('a day nobody holds is left out and the answer says it is incomplete', async () => {
    held.cache.set('2026-11-26', day([inc('B', '2026-11-26 09:00:00')]))
    const a = await svc.getAlarms(ORG, null, at('2026-11-24 00:00:00'))
    expect(a.incidents.map((i) => i.id)).toEqual(['B'])
    expect(a.partial).toBe(true)
  })

  it('nothing held at all: an empty, incomplete answer rather than an error', async () => {
    const a = await svc.getAlarms(ORG, null, at('2026-11-26 00:00:00'))
    expect(a.incidents).toEqual([])
    expect(a.partial).toBe(true)
    expect(a.stale).toBe(true)
  })

  it('counts untyped alarms and passes a held day’s partial flag on', async () => {
    held.cache.set('2026-11-26', day([inc('U', '2026-11-26 09:00:00', 'veh_1', 0), inc('T', '2026-11-26 10:00:00')], NOW - 60_000, { partial: true }))
    const a = await svc.getAlarms(ORG, null, at('2026-11-26 00:00:00'))
    expect(a.untyped).toBe(1)
    expect(a.partial).toBe(true)
  })

  it('reads up to 30 days back from the database', async () => {
    held.db.set('2026-11-01', dbDay([inc('NOV1', '2026-11-01 10:00:00')]))
    const a = await svc.getAlarms(ORG, null, at('2026-11-01 00:00:00'), at('2026-11-02 00:00:00'))
    expect(a.incidents.map((i) => i.id)).toEqual(['NOV1'])
  })
})

describe('file links', () => {
  it('opens a link the vss-worker listed, only for its organisation', async () => {
    const k = 'a'.repeat(40)
    held.files.set(k, { orgId: ORG, url: 'https://vss/f?token=W' })
    expect(await svc.fileFor(ORG, k)).toBe('https://vss/f?token=W')
    expect(await svc.fileFor('org_other', k)).toBeNull()
  })
})

describe('camera counts for pages and reports', () => {
  it('come from the worker’s list, scoped, never VSS; 0 before the worker has written it', async () => {
    expect(await svc.pairedCameraCount(ORG, null)).toBe(0)
    held.cameras = ['veh_1', 'veh_2', 'veh_3']
    expect(await svc.pairedCameraCount(ORG, null)).toBe(3)
    expect(await svc.pairedCameraCount(ORG, new Set(['veh_2', 'veh_8']))).toBe(1)
  })
})
