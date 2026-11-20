import { describe, it, expect, vi, beforeEach } from 'vitest'

// A Map standing in for Redis, switchable off to prove Postgres alone still serves
const store = new Map<string, string>()
let redisOn = true
let failGet = false
const fakeRedis = {
  get: vi.fn(async (k: string) => { if (failGet) throw new Error('down'); return store.get(k) ?? null }),
  set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK' }),
  // KEEP_SCRIPT, as Redis runs it: replace only with an entry read no earlier
  eval: vi.fn(async (_script: string, _n: number, k: string, value: string, stamp: string) => {
    const cur = store.get(k)
    if (cur && JSON.parse(cur).s > Number(stamp)) return 0
    store.set(k, value)
    return 1
  }),
  del: vi.fn(async (k: string) => { store.delete(k); return 1 }),
}
vi.mock('../../src/lib/redis.js', () => ({ getCacheRedis: () => (redisOn ? fakeRedis : null) }))
vi.mock('../../src/lib/prisma.js')
// The Planner side has its own tests (planner-keyed-plans)
const { syncKeyedPlans } = vi.hoisted(() => ({ syncKeyedPlans: vi.fn(async (..._a: unknown[]) => ({ made: 0, updated: 0, removed: 0 })) }))
vi.mock('../../src/modules/planner/keyed-plans.js', () => ({ syncKeyedPlans }))
import { prismaMock } from '../helpers/prisma.mock.js'
import { getDay, getDays, daysBetween, saveDay, dayVersions, lastDayBefore, getOrders, saveOrder, ORDERS_KEEP_DAYS, VERSIONS_LIMIT } from '../../src/modules/deliveries/deliveries.service.js'
import { dayKey, keep, DAY_TTL_S } from '../../src/modules/deliveries/delivery-days.cache.js'
import { daysQuerySchema, daySaveSchema, MAX_RANGE_DAYS } from '../../src/modules/deliveries/deliveries.schema.js'

const ORG = 'org1'
const DAY = '2026-11-11'
const KCA = { key: 'kca', plate: 'KCA 226M', vehicleIds: ['v1'], customers: ['menengai: Dashama wholesalers'] }
const at = new Date('2026-11-11T09:00:00Z')

beforeEach(() => {
  store.clear(); redisOn = true; failGet = false
  fakeRedis.get.mockClear(); fakeRedis.eval.mockClear()
})

describe('a day list: persisted, then read from the cache', () => {
  it('a save goes to Postgres first, then into the cache, and the next read never touches Postgres', async () => {
    prismaMock.deliveryDay.upsert.mockResolvedValue({ vehicles: [KCA], updatedAt: at } as never)
    const saved = await saveDay(ORG, DAY, 'u1', { vehicles: [KCA] })
    expect(prismaMock.deliveryDay.upsert).toHaveBeenCalledOnce()
    expect(saved.vehicles).toEqual([KCA])
    expect(JSON.parse(store.get(dayKey(ORG, DAY))!).v.vehicles).toEqual([KCA])

    // The save read the row it replaces (for its guard and history); the read after it is all Redis
    prismaMock.deliveryDay.findUnique.mockClear()
    const read = await getDay(ORG, DAY)
    expect(read).toEqual(saved)
    expect(syncKeyedPlans).toHaveBeenCalledWith(ORG, DAY, [KCA], 'u1')
    expect(prismaMock.deliveryDay.findUnique).not.toHaveBeenCalled()
  })

  it('a miss reads Postgres once and keeps it; an empty day is kept too', async () => {
    prismaMock.deliveryDay.findUnique.mockResolvedValue(null)
    expect((await getDay(ORG, DAY)).vehicles).toEqual([])
    expect((await getDay(ORG, DAY)).vehicles).toEqual([])
    expect(prismaMock.deliveryDay.findUnique).toHaveBeenCalledOnce()
  })

  it('no Redis, or Redis failing: Postgres answers', async () => {
    prismaMock.deliveryDay.findUnique.mockResolvedValue({ vehicles: [KCA], updatedAt: at } as never)
    redisOn = false
    expect((await getDay(ORG, DAY)).vehicles).toEqual([KCA])
    redisOn = true; failGet = true
    expect((await getDay(ORG, DAY)).vehicles).toEqual([KCA])
  })

  it('a read that began before a save cannot put the old list back', async () => {
    const KBB = { key: 'kbb', plate: 'KBB 880A', vehicleIds: ['v2'], customers: [] }
    // The reader misses, starts its Postgres read, and is slow
    let release!: (v: unknown) => void
    prismaMock.deliveryDay.findUnique.mockReturnValueOnce(new Promise((r) => { release = r }) as never)
    const reading = getDay(ORG, DAY)
    await new Promise((r) => setTimeout(r, 5))
    // Meanwhile a save lands and caches the new list
    prismaMock.deliveryDay.upsert.mockResolvedValue({ vehicles: [KCA, KBB], updatedAt: at } as never)
    await saveDay(ORG, DAY, 'u1', { vehicles: [KCA, KBB] })
    // The slow read now returns the old row and tries to cache it
    release({ vehicles: [KCA], updatedAt: at })
    await reading
    expect(JSON.parse(store.get(dayKey(ORG, DAY))!).v.vehicles).toEqual([KCA, KBB])
  })

  it('two saves reaching Redis out of order: the later write stays', async () => {
    await keep(dayKey(ORG, DAY), { vehicles: ['B'] }, DAY_TTL_S, 2000)
    await keep(dayKey(ORG, DAY), { vehicles: ['A'] }, DAY_TTL_S, 1000)
    expect(JSON.parse(store.get(dayKey(ORG, DAY))!).v.vehicles).toEqual(['B'])
  })

  it('the list is saved even when the Planner sync fails', async () => {
    prismaMock.deliveryDay.upsert.mockResolvedValue({ vehicles: [KCA], updatedAt: at } as never)
    syncKeyedPlans.mockRejectedValueOnce(new Error('db down'))
    await expect(saveDay(ORG, DAY, 'u1', { vehicles: [KCA] })).resolves.toMatchObject({ vehicles: [KCA] })
  })

  it('refuses a day that is not YYYY-MM-DD', async () => {
    await expect(getDay(ORG, '11-11-2026')).rejects.toThrow(/YYYY-MM-DD/)
  })

  it('"Copy the list": the latest earlier day that has vehicles', async () => {
    prismaMock.deliveryDay.findMany.mockResolvedValue([
      { day: '2026-11-10', vehicles: [], updatedAt: at },
      { day: '2026-11-09', vehicles: [KCA], updatedAt: at },
    ] as never)
    const got = await lastDayBefore(ORG, DAY)
    expect(got?.day).toBe('2026-11-09')
    const where = prismaMock.deliveryDay.findMany.mock.calls[0][0]!.where as { day: { gte: string; lt: string } }
    expect(where.day).toEqual({ gte: '2026-10-28', lt: DAY })
  })
})

describe('Van Sales and Finished Goods in one day list (raitrack #81)', () => {
  const VS = { key: 'kdm', plate: 'KDM 119L', vehicleIds: ['v3'], customers: ['MENENGAI_VS: JOJAC'], list: 'vs' as const }

  it('a vehicle saved with list "vs" comes back with it, from the cache and from Postgres', async () => {
    // Through the route's own validation, as PUT /days/:day receives it
    const body = daySaveSchema.parse({ vehicles: [VS, KCA] })
    expect(body.vehicles[0].list).toBe('vs')
    expect(body.vehicles[1]).not.toHaveProperty('list')

    prismaMock.deliveryDay.upsert.mockImplementation((async (a: { create: { vehicles: unknown } }) =>
      ({ vehicles: a.create.vehicles, updatedAt: at })) as never)
    await saveDay(ORG, DAY, 'u1', body)
    prismaMock.deliveryDay.findUnique.mockClear()
    const written = prismaMock.deliveryDay.upsert.mock.calls[0][0]
    expect((written.create.vehicles as Array<{ list?: string }>).map((v) => v.list)).toEqual(['vs', undefined])
    expect((written.update.vehicles as Array<{ list?: string }>)[0].list).toBe('vs')
    expect(syncKeyedPlans).toHaveBeenCalledWith(ORG, DAY, body.vehicles, 'u1')

    // Read back from the cache
    expect((await getDay(ORG, DAY)).vehicles).toEqual([VS, KCA])
    expect(prismaMock.deliveryDay.findUnique).not.toHaveBeenCalled()

    // Read back from Postgres, the JSON column as stored
    store.clear()
    prismaMock.deliveryDay.findUnique.mockResolvedValue({ vehicles: JSON.parse(JSON.stringify(written.create.vehicles)), updatedAt: at } as never)
    const read = await getDay(ORG, DAY)
    expect(read.vehicles).toEqual([VS, KCA])
    expect(read.vehicles.filter((v) => v.list === 'vs').map((v) => v.plate)).toEqual(['KDM 119L'])
  })

  it('takes "fg" or no tag; refuses any other', () => {
    expect(daySaveSchema.parse({ vehicles: [{ ...KCA, list: 'fg' }] }).vehicles[0].list).toBe('fg')
    expect(daySaveSchema.safeParse({ vehicles: [{ ...KCA, list: 'xx' }] }).success).toBe(false)
  })
})

describe('a range of days: every day, both ends kept', () => {
  const KDE = { key: 'kde', plate: 'KDE 136E', vehicleIds: ['v2'], customers: ['menengai: Naivas Nakuru'] }

  it('11 Nov to 12 Nov is two days; a month boundary and a single day count right', () => {
    expect(daysBetween('2026-11-11', '2026-11-12')).toEqual(['2026-11-11', '2026-11-12'])
    expect(daysBetween('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
    expect(daysBetween('2026-11-12', '2026-11-12')).toEqual(['2026-11-12'])
  })

  it('refuses a backwards range, a bad day, and one past the cap', () => {
    expect(() => daysBetween('2026-11-12', '2026-11-11')).toThrow(/after/)
    expect(() => daysBetween('12/11/2026', '2026-11-12')).toThrow(/YYYY-MM-DD/)
    expect(() => daysBetween('2026-01-01', '2026-03-01')).toThrow(new RegExp(`${MAX_RANGE_DAYS} days`))
  })

  it('returns each day’s own list, the last day included, through the per-day cache', async () => {
    prismaMock.deliveryDay.findUnique.mockImplementation((async ({ where }: { where: { organisationId_day: { day: string } } }) => {
      const day = where.organisationId_day.day
      return day === '2026-11-11' ? { vehicles: [KCA], updatedAt: at }
        : day === '2026-11-12' ? { vehicles: [KCA, KDE], updatedAt: at } : null
    }) as never)
    const got = await getDays(ORG, '2026-11-11', '2026-11-12')
    expect(got.map((d) => [d.day, d.vehicles.map((v) => v.plate)])).toEqual([
      ['2026-11-11', ['KCA 226M']],
      ['2026-11-12', ['KCA 226M', 'KDE 136E']],
    ])
    // The same entries getDay reads: a second read is all Redis
    expect(JSON.parse(store.get(dayKey(ORG, '2026-11-12'))!).v.vehicles).toHaveLength(2)
    prismaMock.deliveryDay.findUnique.mockClear()
    expect((await getDay(ORG, '2026-11-12')).vehicles).toHaveLength(2)
    expect(prismaMock.deliveryDay.findUnique).not.toHaveBeenCalled()
  })

  it('a longer range keeps empty days in place rather than dropping them', async () => {
    prismaMock.deliveryDay.findUnique.mockImplementation((async ({ where }: { where: { organisationId_day: { day: string } } }) =>
      (where.organisationId_day.day === '2026-11-10' ? { vehicles: [KDE], updatedAt: at } : null)) as never)
    const got = await getDays(ORG, '2026-11-06', '2026-11-12')
    expect(got.map((d) => d.day)).toEqual(['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'])
    expect(got.map((d) => d.vehicles.length)).toEqual([0, 0, 0, 0, 1, 0, 0])
  })

  it('the query: before alone, or from and to together', () => {
    expect(daysQuerySchema.safeParse({ before: '2026-11-12' }).success).toBe(true)
    expect(daysQuerySchema.safeParse({ from: '2026-11-11', to: '2026-11-12' }).success).toBe(true)
    expect(daysQuerySchema.safeParse({ from: '2026-11-11' }).success).toBe(false)
    expect(daysQuerySchema.safeParse({ before: '2026-11-12', from: '2026-11-11', to: '2026-11-12' }).success).toBe(false)
    expect(daysQuerySchema.safeParse({ from: '2026-11-12', to: '2026-11-11' }).success).toBe(false)
    expect(daysQuerySchema.safeParse({}).success).toBe(false)
  })
})

describe('typed orders: by plate, kept 30 days', () => {
  const now = Date.parse('2026-11-11T12:00:00Z')
  it('saving writes Postgres, refreshes the cache, and stale values are not offered', async () => {
    prismaMock.deliveryOrder.findMany.mockResolvedValue([
      { plate: 'KCA 226M', text: '8/10', updatedAt: new Date(now - 60_000) },
      { plate: 'KBB 880A', text: '3/4', updatedAt: new Date(now - (ORDERS_KEEP_DAYS + 1) * 86_400_000) },
    ] as never)
    const got = await saveOrder(ORG, ' KCA 226M ', '8/10', 'u1', now)
    expect(prismaMock.deliveryOrder.upsert).toHaveBeenCalledOnce()
    expect(got).toEqual({ 'KCA 226M': '8/10' })
    // Served from the cache now
    prismaMock.deliveryOrder.findMany.mockClear()
    expect(await getOrders(ORG, now)).toEqual({ 'KCA 226M': '8/10' })
    expect(prismaMock.deliveryOrder.findMany).not.toHaveBeenCalled()
  })

  it('an empty value forgets the plate', async () => {
    prismaMock.deliveryOrder.findMany.mockResolvedValue([] as never)
    await saveOrder(ORG, 'KCA 226M', '  ', 'u1', now)
    expect(prismaMock.deliveryOrder.deleteMany).toHaveBeenCalledWith({ where: { organisationId: ORG, plate: 'KCA 226M' } })
    expect(prismaMock.deliveryOrder.upsert).not.toHaveBeenCalled()
  })
})

describe('a day is never emptied by mistake, and what a save replaced is kept (operator, 20 Nov 2026)', () => {
  const KDE = { key: 'kde', plate: 'KDE 140E', vehicleIds: ['v2'], customers: ['menengai: Chandarana Abc'] }
  const before = new Date('2026-11-19T23:03:04Z')
  const had = (vehicles: unknown[]) => prismaMock.deliveryDay.findUnique.mockResolvedValue({ vehicles, updatedById: 'night', updatedAt: before } as never)
  beforeEach(() => {
    prismaMock.deliveryDay.upsert.mockImplementation((async (a: { create: { vehicles: unknown } }) => ({ vehicles: a.create.vehicles, updatedAt: at })) as never)
  })

  it('an empty list does not replace one with vehicles: 409, nothing written, the Planner untouched', async () => {
    had([KCA, KDE])
    syncKeyedPlans.mockClear()
    await expect(saveDay(ORG, '2026-11-18', 'u2', { vehicles: [] })).rejects.toMatchObject({ statusCode: 409 })
    expect(prismaMock.deliveryDay.upsert).not.toHaveBeenCalled()
    expect(prismaMock.deliveryDayVersion.create).not.toHaveBeenCalled()
    expect(syncKeyedPlans).not.toHaveBeenCalled()
  })

  it('emptied when the operator confirmed it (clear), the list it held kept first', async () => {
    had([KCA, KDE])
    const saved = await saveDay(ORG, '2026-11-18', 'u2', { vehicles: [], clear: true })
    expect(saved.vehicles).toEqual([])
    expect(prismaMock.deliveryDayVersion.create).toHaveBeenCalledWith({ data: {
      organisationId: ORG, day: '2026-11-18', vehicles: [KCA, KDE], savedById: 'night', savedAt: before, replacedById: 'u2',
    } })
  })

  it('an empty day, or one never saved, takes an empty list without a word', async () => {
    had([])
    await expect(saveDay(ORG, DAY, 'u1', { vehicles: [] })).resolves.toMatchObject({ vehicles: [] })
    prismaMock.deliveryDay.findUnique.mockResolvedValue(null)
    await expect(saveDay(ORG, DAY, 'u1', { vehicles: [] })).resolves.toMatchObject({ vehicles: [] })
    expect(prismaMock.deliveryDayVersion.create).not.toHaveBeenCalled()
  })

  it('every change keeps the list it replaced; a save that changes nothing (keys reordered by jsonb) keeps none', async () => {
    had([KCA])
    await saveDay(ORG, DAY, 'u1', { vehicles: [KCA, KDE] })
    expect(prismaMock.deliveryDayVersion.create).toHaveBeenCalledOnce()
    prismaMock.deliveryDayVersion.create.mockClear()
    // Postgres hands the object back with its keys in its own order
    const reordered = Object.fromEntries(Object.entries(KCA).reverse())
    had([reordered])
    await saveDay(ORG, DAY, 'u1', { vehicles: [KCA] })
    expect(prismaMock.deliveryDayVersion.create).not.toHaveBeenCalled()
  })

  it('the list is saved even when its earlier version cannot be kept (the table not there yet)', async () => {
    had([KCA])
    prismaMock.deliveryDayVersion.create.mockRejectedValueOnce(new Error('relation "delivery_day_versions" does not exist'))
    await expect(saveDay(ORG, DAY, 'u1', { vehicles: [KDE] })).resolves.toMatchObject({ vehicles: [KDE] })
  })

  it('the clear flag passes the route’s validation; anything else is refused', () => {
    expect(daySaveSchema.parse({ vehicles: [], clear: true }).clear).toBe(true)
    expect(daySaveSchema.safeParse({ vehicles: [], clear: 'yes' }).success).toBe(false)
  })

  it('the day’s earlier versions, the latest replaced first', async () => {
    prismaMock.deliveryDayVersion.findMany.mockResolvedValue([
      { id: 'b', vehicles: [KCA, KDE], savedById: 'night', savedAt: before, replacedById: 'u2', replacedAt: new Date('2026-11-20T01:03:43Z') },
    ] as never)
    const got = await dayVersions(ORG, '2026-11-18')
    expect(got).toEqual([{ id: 'b', vehicles: [KCA, KDE], savedById: 'night', savedAt: before.toISOString(), replacedById: 'u2', replacedAt: '2026-11-20T01:03:43.000Z' }])
    expect(prismaMock.deliveryDayVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { organisationId: ORG, day: '2026-11-18' }, orderBy: { replacedAt: 'desc' }, take: VERSIONS_LIMIT,
    }))
    await expect(dayVersions(ORG, '18-11-2026')).rejects.toThrow(/YYYY-MM-DD/)
  })
})
