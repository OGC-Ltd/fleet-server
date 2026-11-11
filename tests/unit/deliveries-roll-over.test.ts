import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/lib/prisma.js')
const { saveDay } = vi.hoisted(() => ({ saveDay: vi.fn(async () => ({})) }))
vi.mock('../../src/modules/deliveries/deliveries.service.js', () => ({ saveDay }))
import { prismaMock } from '../helpers/prisma.mock.js'
import { mergeLeftovers, leftoversOf, rollDay, rollOver, fleetDay, dayAfter, SETTLE_MS } from '../../src/modules/deliveries/roll-over.js'

const ORG = 'org1'
const DAY = '2026-11-12'
const pin = (name: string, lat: number) => ({ name, lat, lng: 36.1, radiusM: 50 })

describe('the next day\'s list with the leftovers', () => {
  it('a plate already listed gets the carried stops first, without repeats; a new plate only its leftovers', () => {
    const next = [{ key: 'kca', plate: 'KCA 224M', vehicleIds: ['v1'], customers: ['Shop B', 'Shop C'] }]
    const out = mergeLeftovers(next, [
      { v: { key: 'kca', plate: 'KCA 224M', vehicleIds: ['v1'], customers: [] }, customers: ['Shop A', 'Shop B'], pins: [pin('Gate', -0.3)] },
      { v: { key: 'kbb', plate: 'KBB 880A', vehicleIds: ['v2'], customers: [], group: 'Van Sales' }, customers: ['Shop D'], pins: [] },
    ], DAY)
    expect(out[0]).toMatchObject({ customers: ['Shop A', 'Shop B', 'Shop C'], carried: ['Shop A', 'Gate'], carriedFrom: DAY })
    expect(out[0]!.pins).toHaveLength(1)
    expect(out[1]).toEqual({ key: 'kbb', plate: 'KBB 880A', vehicleIds: ['v2'], customers: ['Shop D'], group: 'Van Sales', carried: ['Shop D'], carriedFrom: DAY })
    expect(next[0]!.customers).toEqual(['Shop B', 'Shop C'])
  })

  it('a plate matches whatever its spacing', () => {
    const out = mergeLeftovers([{ key: 'x', plate: 'kca224m', vehicleIds: [], customers: [] }],
      [{ v: { key: 'kca', plate: 'KCA 224M', vehicleIds: [], customers: [] }, customers: ['Shop A'], pins: [] }], DAY)
    expect(out).toHaveLength(1)
    expect(out[0]!.customers).toEqual(['Shop A'])
  })
})

describe('the stops not done on the day', () => {
  it('reached by the tracker or marked on the Planner is done; a name no fence carries is dropped', async () => {
    prismaMock.geofence.findMany.mockResolvedValue([
      { id: 'f1', name: 'Shop A', isActive: true }, { id: 'f2', name: 'Shop B', isActive: true }, { id: 'f3', name: 'Shop C', isActive: true },
    ] as never)
    prismaMock.deliveryPlan.findMany.mockResolvedValue([{ plate: 'KCA 224M', stops: [{ customer: { customerCode: 'GF:f3' } }] }] as never)
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ id: 'f1' }] as never)   // fences reached
      .mockResolvedValueOnce([{ i: 2n }] as never)      // second pin reached (1-based)
    const left = await leftoversOf(ORG, DAY, [{
      key: 'kca', plate: 'KCA 224M', vehicleIds: ['v1'],
      customers: ['Shop A', 'Shop B', 'Shop C', 'Gone'], pins: [pin('P1', -0.3), pin('P2', -0.4)],
    }])
    expect(left).toHaveLength(1)
    expect(left[0]!.customers).toEqual(['Shop B'])
    expect(left[0]!.pins.map((p) => p.name)).toEqual(['P1'])
    // The day is the fleet day: 00:00 to 24:00 Nairobi
    const call = prismaMock.$queryRaw.mock.calls[0] as unknown[]
    expect((call as unknown[]).some((x) => x instanceof Date && x.toISOString() === '2026-11-11T21:00:00.000Z')).toBe(true)
  })

  it('a vehicle listed without units is found by its plate; none and nothing reached rolls every stop', async () => {
    prismaMock.geofence.findMany.mockResolvedValue([{ id: 'f1', name: 'Shop A', isActive: true }] as never)
    prismaMock.deliveryPlan.findMany.mockResolvedValue([] as never)
    prismaMock.vehicle.findMany.mockResolvedValue([{ id: 'u9', registrationPlate: 'KDE268P' }] as never)
    prismaMock.$queryRaw.mockResolvedValue([] as never)
    const left = await leftoversOf(ORG, DAY, [
      { key: 'a', plate: 'KDE 268P', vehicleIds: [], customers: ['Shop A'] },
      { key: 'b', plate: 'KXX 000X', vehicleIds: [], customers: ['Shop A'] },
    ])
    expect(left.map((l) => l.customers)).toEqual([['Shop A'], ['Shop A']])
    // Only the unit that carries the plate is read; a plate with no unit reads nothing
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
  })
})

describe('rolling a day', () => {
  it('claims the day once: a second roll does nothing', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([] as never)
    expect(await rollDay(ORG, DAY)).toBeNull()
    expect(saveDay).not.toHaveBeenCalled()
  })

  it('carries the leftovers onto the next day through saveDay', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ vehicles: [{ key: 'kca', plate: 'KCA 224M', vehicleIds: ['v1'], customers: ['Shop A'] }] }] as never)
      .mockResolvedValueOnce([] as never)   // nothing reached
    prismaMock.geofence.findMany.mockResolvedValue([{ id: 'f1', name: 'Shop A', isActive: true }] as never)
    prismaMock.deliveryPlan.findMany.mockResolvedValue([] as never)
    prismaMock.deliveryDay.findUnique.mockResolvedValue(null as never)
    expect(await rollDay(ORG, DAY)).toBe(1)
    expect(saveDay).toHaveBeenCalledWith(ORG, '2026-11-13', null, {
      vehicles: [{ key: 'kca', plate: 'KCA 224M', vehicleIds: ['v1'], customers: ['Shop A'], carried: ['Shop A'], carriedFrom: DAY }],
    })
  })

  it('a failure frees the day for the next check', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ vehicles: [{ key: 'kca', plate: 'KCA 224M', vehicleIds: ['v1'], customers: ['Shop A'] }] }] as never)
      .mockRejectedValueOnce(new Error('db away'))
    prismaMock.geofence.findMany.mockResolvedValue([{ id: 'f1', name: 'Shop A', isActive: true }] as never)
    prismaMock.deliveryPlan.findMany.mockResolvedValue([] as never)
    await expect(rollDay(ORG, DAY)).rejects.toThrow('db away')
    expect(prismaMock.$executeRaw).toHaveBeenCalledOnce()
  })

  it('waits for the day to settle, then rolls yesterday only', async () => {
    const midnight = Date.parse('2026-11-12T21:00:00Z')   // 00:00 on 13 Nov in Nairobi
    expect(fleetDay(midnight)).toBe('2026-11-13')
    expect(dayAfter(DAY)).toBe('2026-11-13')
    await rollOver(midnight + 5 * 60_000)
    expect(prismaMock.deliveryDay.findMany).not.toHaveBeenCalled()
    prismaMock.deliveryDay.findMany.mockResolvedValue([] as never)
    await rollOver(midnight + SETTLE_MS)
    expect(prismaMock.deliveryDay.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { day: DAY, rolledAt: null } }))
  })
})
