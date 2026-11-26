/**
 * The vss-worker's Redis day cache and file links (modules/dashcam/dashcam-store),
 * and which days its 5-minute sync captures (lib/queues/vss-sync).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/config/env.js', async (orig) => {
  const real = await orig<typeof import('../../src/config/env.js')>()
  return { ...real, env: { ...real.env, VSS_CACHE_DAYS: 30 } }
})
const redis = vi.hoisted(() => {
  const kv = new Map<string, { v: Buffer | string; ex: number }>()
  return {
    kv,
    client: {
      set: async (k: string, v: Buffer | string, _ex: 'EX', s: number, nx?: 'NX') => { if (nx && kv.has(k)) return null; kv.set(k, { v, ex: s }); return 'OK' },
      get: async (k: string) => { const e = kv.get(k); return e ? String(e.v) : null },
      mgetBuffer: async (...ks: string[]) => ks.map((k) => { const e = kv.get(k); return e ? Buffer.from(e.v as Buffer) : null }),
    },
  }
})
vi.mock('../../src/lib/redis.js', () => ({ getCacheRedis: () => redis.client, isRedisConfigured: () => true }))

import { prismaMock } from '../helpers/prisma.mock.js'
const store = await import('../../src/modules/dashcam/dashcam-store.js')
const { syncDays } = await import('../../src/lib/queues/vss-sync.js')
const { daysBetween } = await import('../../src/modules/dashcam/fleet-day.js')

const ORG = 'org_1'
const sample = {
  cameras: 3, partial: false, through: 1, cachedAt: 1,
  incidents: [{ id: 'A1', code: 214, label: 'No seatbelt', group: 'Driver', severity: 'warning' as const, category: 'driver' as const,
    occurredAt: '2026-11-26T06:00:00Z', vehicleId: 'veh_1', plate: 'KCJ 099T', deviceId: '7', lat: -0.8, lng: 34.3, speed: 40,
    videos: [{ key: 'f0', label: 'Road camera', url: '/api/v1/vss/file?org=org_1&k=x', download: '/api/v1/vss/file?org=org_1&k=x&download=1' }], photos: [] }],
}

beforeEach(() => { redis.kv.clear(); store.resetStoreMemo() })

describe('day cache', () => {
  it('round-trips a day, gzipped, kept 30 days', async () => {
    expect(await store.storeDay(ORG, '2026-11-26', sample)).toBe(true)
    const e = redis.kv.get(`vss:alarms:v1:${ORG}:2026-11-26`)!
    expect(e.ex).toBe(30 * 86_400)
    expect(Buffer.isBuffer(e.v) && e.v[0] === 0x1f && e.v[1] === 0x8b).toBe(true)
    const got = await store.readDays(ORG, ['2026-11-25', '2026-11-26'])
    expect([...got.keys()]).toEqual(['2026-11-26'])
    expect(got.get('2026-11-26')).toEqual(sample)
  })

  it('a write-back never replaces a day already held', async () => {
    await store.storeDay(ORG, '2026-11-26', sample)
    expect(await store.storeDay(ORG, '2026-11-26', { ...sample, incidents: [], source: 'db' }, { onlyIfAbsent: true })).toBe(false)
    store.resetStoreMemo()
    expect((await store.readDays(ORG, ['2026-11-26'])).get('2026-11-26')!.incidents).toHaveLength(1)
    expect(await store.storeDay(ORG, '2026-11-25', { ...sample, source: 'db' }, { onlyIfAbsent: true })).toBe(true)
  })

  it('the camera list round-trips; none written reads as null', async () => {
    expect(await store.readCameras(ORG)).toBeNull()
    await store.storeCameras(ORG, ['veh_1', 'veh_2'])
    expect(await store.readCameras(ORG)).toEqual(['veh_1', 'veh_2'])
  })

  it('a link key resolves to its VSS address, kept 15 days', async () => {
    store.rememberFile('k1', ORG, 'https://vss/f?token=T')
    await new Promise((r) => setImmediate(r))
    expect(redis.kv.get('vss:file:v1:k1')!.ex).toBe(15 * 86_400)
    expect(await store.storedFile('k1')).toEqual({ orgId: ORG, url: 'https://vss/f?token=T' })
    expect(await store.storedFile('nope')).toBeNull()
  })
})

describe('database days', () => {
  it('only days captured, typed as the live answer would be', async () => {
    prismaMock.dashcamCaptureDay.findMany.mockResolvedValue([{ day: '2026-11-24', partial: false, capturedAt: new Date('2026-11-25T22:30:00Z') }] as never)
    prismaMock.dashcamAlarm.findMany.mockResolvedValue([
      { id: 'X', organisationId: ORG, vehicleId: null, plate: 'KCJ 099T', deviceId: '7', occurredAt: new Date('2026-11-24T05:00:00Z'),
        code: 0, label: '', group: '', severity: '', category: '', speedKmh: null, lat: null, lng: null, capturedAt: new Date(), typedAt: null },
    ] as never)
    const got = await store.dbDays(ORG, ['2026-11-23', '2026-11-24'])
    expect([...got.keys()]).toEqual(['2026-11-24'])
    const [x] = got.get('2026-11-24')!.incidents
    expect(x).toMatchObject({ id: 'X', code: 0, label: 'Unknown', vehicleId: '', occurredAt: '2026-11-24T05:00:00Z', videos: [], photos: [] })
  })

  it('a database problem reads as nothing held', async () => {
    prismaMock.dashcamCaptureDay.findMany.mockRejectedValue(new Error('relation does not exist'))
    expect((await store.dbDays(ORG, ['2026-11-24'])).size).toBe(0)
  })
})

describe('fleet days', () => {
  it('the sync captures today, and yesterday in today’s first hour', () => {
    expect(syncDays(Date.parse('2026-11-26T12:00:00+03:00'))).toEqual(['2026-11-26'])
    expect(syncDays(Date.parse('2026-11-26T00:20:00+03:00'))).toEqual(['2026-11-25', '2026-11-26'])
  })
  it('every fleet day a window touches', () => {
    expect(daysBetween(Date.parse('2026-11-24T23:00:00+03:00'), Date.parse('2026-11-26T01:00:00+03:00'))).toEqual(['2026-11-24', '2026-11-25', '2026-11-26'])
    expect(daysBetween(Date.parse('2026-11-26T00:00:00+03:00'), Date.parse('2026-11-27T00:00:00+03:00'))).toEqual(['2026-11-26'])
  })
})

describe('capture into the cache', () => {
  it('a later capture VSS cut short keeps the alarms an earlier one cached', async () => {
    const { captureDay, resetCaptureState } = await import('../../src/modules/dashcam/dashcam-capture.js')
    const svc = await import('../../src/modules/dashcam/dashcam.service.js')
    resetCaptureState()
    prismaMock.$queryRaw.mockResolvedValue([{ ok: true }] as never)
    prismaMock.dashcamAlarm.createMany.mockResolvedValue({ count: 0 } as never)
    prismaMock.dashcamAlarm.updateMany.mockResolvedValue({ count: 0 } as never)
    prismaMock.dashcamCaptureDay.upsert.mockResolvedValue({} as never)
    const a = { ...sample.incidents[0], id: 'A', occurredAt: '2026-11-26T05:00:00Z' }
    const b = { ...sample.incidents[0], id: 'B', occurredAt: '2026-11-26T06:00:00Z' }
    const now = Date.parse('2026-11-26T12:00:00+03:00')
    const spy = vi.spyOn(svc, 'searchAlarms')
    spy.mockResolvedValueOnce({ incidents: [a, b], cameras: 3, from: '', to: '' })
    await captureDay(ORG, '2026-11-26', { now })
    spy.mockResolvedValueOnce({ incidents: [b], cameras: 3, from: '', to: '', partial: true })
    await captureDay(ORG, '2026-11-26', { now: now + 300_000 })
    const got = (await store.readDays(ORG, ['2026-11-26'], now + 300_000)).get('2026-11-26')!
    expect(got.incidents.map((i) => i.id)).toEqual(['B', 'A'])
    expect(got.partial).toBe(true)
    spy.mockRestore()
  })
})

describe('missed days', () => {
  it('days with no capture row, or one marked partial', async () => {
    const { missedDays } = await import('../../src/modules/dashcam/dashcam-capture.js')
    prismaMock.dashcamCaptureDay.findMany.mockResolvedValue([{ day: '2026-11-13', partial: false }, { day: '2026-11-14', partial: true }] as never)
    expect(await missedDays(ORG, ['2026-11-13', '2026-11-14', '2026-11-15'])).toEqual(['2026-11-14', '2026-11-15'])
  })
})
