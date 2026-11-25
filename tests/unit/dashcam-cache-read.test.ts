/**
 * What the Alarms page and the reports read once the vss-worker captures
 * (dashcam.service getAlarms over dashcam-store): the Redis day cache first,
 * then the database, then live VSS only for days neither holds.
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
  db: new Map<string, unknown[]>(),
  files: new Map<string, { orgId: string; url: string }>(),
  asked: { cache: [] as string[][], db: [] as string[][] },
}))
vi.mock('../../src/modules/dashcam/dashcam-store.js', () => ({
  readDays: vi.fn(async (_org: string, days: string[]) => {
    held.asked.cache.push(days)
    return new Map(days.filter((d) => held.cache.has(d)).map((d) => [d, held.cache.get(d)]))
  }),
  dbDays: vi.fn(async (_org: string, days: string[]) => {
    held.asked.db.push(days)
    return new Map(days.filter((d) => held.db.has(d)).map((d) => [d, held.db.get(d)]))
  }),
  rememberFile: vi.fn(),
  storedFile: vi.fn(async (k: string) => held.files.get(k) ?? null),
}))

const vss = vi.hoisted(() => ({ searches: 0, refuse: false }))
vi.mock('../../src/providers/vss/index.js', async (orig) => {
  const real = await orig<typeof import('../../src/providers/vss/index.js')>()
  return {
    ...real,
    vssAvailable: () => true,
    listDevices: async () => [{ deviceId: '70462493', name: 'SUKARI - KCJ 099T', plate: '', accessMode: 1, channels: real.parseChannels('ROAD', 1) }],
    vssCall: async (path: string, body: Record<string, unknown>) => {
      if (path.endsWith('findRecords.action')) {
        vss.searches++
        if (vss.refuse) throw new real.VssError('Requests too frequent', real.VSS_TOO_FREQUENT)
        return { dataList: [{ deviceID: '70462493', alarmGuid: 'LIVE1', alarmType: 214, fileType: 4, channel: 1, downUrl: 'https://vss/f?token=T', fileStartTime: String(body['beginTime']).slice(0, 10) + ' 09:00:00', alarmGps: '34.38,-0.82' }] }
      }
      return []
    },
  }
})

import { prismaMock } from '../helpers/prisma.mock.js'
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  svc.resetDashcamState(0)
  held.cache.clear(); held.db.clear(); held.files.clear()
  held.asked.cache = []; held.asked.db = []
  vss.searches = 0; vss.refuse = false
  prismaMock.vehicle.findMany.mockResolvedValue([{ id: 'veh_1', registrationPlate: 'KCJ 099T', name: 'Tipper 7' }] as never)
})
afterEach(() => { vi.useRealTimers() })

describe('getAlarms from the worker’s capture', () => {
  it('serves cached days without searching VSS, newest first, trimmed to the window', async () => {
    held.cache.set('2026-11-25', day([inc('A', '2026-11-25 08:00:00'), inc('OLD', '2026-11-25 05:00:00')]))
    held.cache.set('2026-11-26', day([inc('B', '2026-11-26 09:00:00')]))
    const a = await svc.getAlarms(ORG, null, at('2026-11-25 06:00:00'))
    expect(vss.searches).toBe(0)
    expect(a.incidents.map((i) => i.id)).toEqual(['B', 'A'])
    expect(a.cameras).toBe(4)
    expect(held.asked.cache[0]).toEqual(['2026-11-25', '2026-11-26'])
  })

  it('keeps only the vehicles in the caller’s scope', async () => {
    held.cache.set('2026-11-26', day([inc('MINE', '2026-11-26 09:00:00'), inc('THEIRS', '2026-11-26 09:30:00', 'veh_9')]))
    const a = await svc.getAlarms(ORG, new Set(['veh_1']), at('2026-11-26 00:00:00'))
    expect(a.incidents.map((i) => i.id)).toEqual(['MINE'])
  })

  it('reads a captured day the cache no longer holds from the database, without VSS', async () => {
    held.cache.set('2026-11-26', day([inc('B', '2026-11-26 09:00:00')]))
    held.db.set('2026-11-25', [inc('DB1', '2026-11-25 10:00:00')])
    const a = await svc.getAlarms(ORG, null, at('2026-11-25 00:00:00'))
    expect(vss.searches).toBe(0)
    expect(a.incidents.map((i) => i.id)).toEqual(['B', 'DB1'])
    expect(held.asked.db[0]).toEqual(['2026-11-25'])     // today is never read from the database
  })

  it('asks VSS for today when the worker’s copy is stale', async () => {
    held.cache.set('2026-11-26', day([inc('B', '2026-11-26 09:00:00')], NOW - 30 * 60_000))
    const a = await svc.getAlarms(ORG, null, at('2026-11-26 00:00:00'))
    expect(vss.searches).toBe(1)
    expect(a.incidents.map((i) => i.id)).toEqual(['LIVE1'])
  })

  it('when VSS refuses, shows what is held and says it may be incomplete', async () => {
    vss.refuse = true
    held.cache.set('2026-11-25', day([inc('A', '2026-11-25 08:00:00')]))
    const a = await svc.getAlarms(ORG, null, at('2026-11-25 00:00:00'))
    expect(a.incidents.map((i) => i.id)).toEqual(['A'])
    expect(a.stale).toBe(true)
    expect(a.partial).toBe(true)
  })

  it('with nothing held and VSS refusing, fails as before', async () => {
    vss.refuse = true
    await expect(svc.getAlarms(ORG, null, at('2026-11-26 00:00:00'))).rejects.toMatchObject({ status: 10129 })
  })

  it('counts untyped alarms and passes a cached day’s partial flag on', async () => {
    held.cache.set('2026-11-26', day([inc('U', '2026-11-26 09:00:00', 'veh_1', 0), inc('T', '2026-11-26 10:00:00')], NOW - 60_000, { partial: true }))
    const a = await svc.getAlarms(ORG, null, at('2026-11-26 00:00:00'))
    expect(a.untyped).toBe(1)
    expect(a.partial).toBe(true)
  })

  it('reads up to 30 days back, past VSS’s two weeks', async () => {
    held.db.set('2026-11-01', [inc('NOV1', '2026-11-01 10:00:00')])
    held.cache.set('2026-11-26', day([]))
    const a = await svc.getAlarms(ORG, null, at('2026-11-01 00:00:00'), at('2026-11-02 00:00:00'))
    expect(a.incidents.map((i) => i.id)).toEqual(['NOV1'])
    expect(vss.searches).toBe(0)     // 1 Nov is past VSS's two weeks: not searched
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
