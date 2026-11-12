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
import { getDay, getDays, daysBetween, saveDay, lastDayBefore, getOrders, saveOrder, ORDERS_KEEP_DAYS } from '../../src/modules/deliveries/deliveries.service.js'
import { dayKey, keep, DAY_TTL_S } from '../../src/modules/deliveries/delivery-days.cache.js'
import { daysQuerySchema, MAX_RANGE_DAYS } from '../../src/modules/deliveries/deliveries.schema.js'

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
    prismaMock.deliveryDay.findUnique.mockReturnValue(new Promise((r) => { release = r }) as never)
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
