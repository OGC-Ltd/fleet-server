import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/lib/prisma.js')
import { prismaMock } from '../helpers/prisma.mock.js'
import { keyedStops, fenceMiddle, syncKeyedPlans, KEYED_SOURCE } from '../../src/modules/planner/keyed-plans.js'

const ORG = 'org1'
const DAY = '2026-11-12'
const fence = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, name, isActive: true, centerLat: -0.3, centerLng: 36.1, polygonCoords: null, ...extra })

describe('a keyed vehicle\'s stops', () => {
  it('geofences in the order picked, then pasted points; unknown names dropped', () => {
    const stops = keyedStops({
      plate: 'KCA 224M',
      customers: ['MENENGAI_VS: JOJAC', 'Gone shop', 'MENENGAI_FG: NAIVAS'],
      pins: [{ name: 'Gate 2', lat: -0.28802, lng: 36.04494 }],
    }, [fence('f2', 'MENENGAI_FG: NAIVAS'), fence('f1', 'MENENGAI_VS: JOJAC')])
    expect(stops.map((s) => s.code)).toEqual(['GF:f1', 'GF:f2', 'PIN:-0.28802,36.04494'])
    expect(stops[0]).toMatchObject({ name: 'JOJAC', geofenceId: 'f1', lat: -0.3, lng: 36.1 })
    expect(stops[2]).toMatchObject({ name: 'Gate 2', geofenceId: null })
  })

  it('an active fence wins over an inactive one of the same name; a polygon is placed at its middle', () => {
    const stops = keyedStops({ plate: 'X', customers: ['Shop'] }, [
      fence('old', 'Shop', { isActive: false }),
      fence('new', 'Shop', { centerLat: null, centerLng: null, polygonCoords: [[36, -1], [36.2, -1], [36.2, -1.2], [36, -1.2]] }),
    ])
    expect(stops[0].geofenceId).toBe('new')
    expect(stops[0].lat).toBeCloseTo(-1.1)
    expect(stops[0].lng).toBeCloseTo(36.1)
    expect(fenceMiddle({ centerLat: null, centerLng: null, polygonCoords: null })).toBeNull()
  })
})

describe('the day list kept in step with the Planner', () => {
  it('a vehicle with stops becomes one plan for that day, its stops tied to their fences', async () => {
    prismaMock.geofence.findMany.mockResolvedValue([fence('f1', 'Shop A'), fence('f2', 'Shop B')] as never)
    prismaMock.vehicle.findMany.mockResolvedValue([{ id: 'v1' }] as never)
    prismaMock.plannerCustomer.upsert.mockImplementation(((a: { create: { customerCode: string } }) => Promise.resolve({ id: `c-${a.create.customerCode}` })) as never)
    prismaMock.deliveryPlan.create.mockResolvedValue({ id: 'p1' } as never)

    const did = await syncKeyedPlans(ORG, DAY, [
      { plate: 'KCA 224M', vehicleIds: ['v1'], customers: ['Shop A', 'Shop B'] },
      { plate: 'KBB 880A', customers: [] },
    ], 'u1')

    expect(did).toEqual({ made: 1, updated: 0, removed: 0 })
    const made = prismaMock.deliveryPlan.create.mock.calls[0][0].data as Record<string, unknown>
    expect(made).toMatchObject({ plate: 'KCA 224M', vehicleId: 'v1', source: KEYED_SOURCE, organisationId: ORG })
    expect((made.planDate as Date).toISOString()).toBe('2026-11-12T00:00:00.000Z')
    const rows = prismaMock.deliveryPlanStop.createMany.mock.calls[0][0]!.data as Array<Record<string, unknown>>
    expect(rows.map((r) => [r.sequence, r.customerId])).toEqual([[1, 'c-GF:f1'], [2, 'c-GF:f2']])
    expect(prismaMock.plannerCustomer.upsert.mock.calls[0][0].create).toMatchObject({ customerCode: 'GF:f1', geofenceId: 'f1' })
    expect(prismaMock.geofence.create).not.toHaveBeenCalled()
  })

  it('a stop changed keeps the outcome marked on the stops that remain; a vehicle taken off loses its plan', async () => {
    prismaMock.geofence.findMany.mockResolvedValue([fence('f1', 'Shop A'), fence('f3', 'Shop C')] as never)
    prismaMock.plannerCustomer.upsert.mockImplementation(((a: { create: { customerCode: string } }) => Promise.resolve({ id: `c-${a.create.customerCode}` })) as never)
    prismaMock.deliveryPlan.findMany.mockResolvedValue([
      { id: 'p1', plate: 'KCA 224M', source: KEYED_SOURCE, planDate: new Date(`${DAY}T00:00:00Z`) },
      { id: 'p9', plate: 'KDE 127E', source: KEYED_SOURCE, planDate: new Date(`${DAY}T00:00:00Z`) },
    ] as never)
    prismaMock.deliveryPlan.update.mockResolvedValue({ id: 'p1' } as never)
    prismaMock.deliveryPlanStop.findMany.mockResolvedValue([
      { customerId: 'c-GF:f1', outcome: 'FULL', remarks: 'paid', outcomeBy: 'u2', outcomeAt: new Date(), dueDay: null },
    ] as never)

    const did = await syncKeyedPlans(ORG, DAY, [{ plate: 'KCA 224M', customers: ['Shop A', 'Shop C'] }], 'u1')

    expect(did).toEqual({ made: 0, updated: 1, removed: 1 })
    expect(prismaMock.deliveryPlan.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['p9'] } } })
    const rows = prismaMock.deliveryPlanStop.createMany.mock.calls[0][0]!.data as Array<Record<string, unknown>>
    expect(rows[0]).toMatchObject({ customerId: 'c-GF:f1', outcome: 'FULL', remarks: 'paid' })
    expect(rows[1]).toMatchObject({ customerId: 'c-GF:f3', outcome: null, remarks: '' })
  })

  it('a plate with a sheet or itinerary that day or the day before gets no keyed plan, and loses one it had', async () => {
    prismaMock.geofence.findMany.mockResolvedValue([fence('f1', 'Shop A')] as never)
    prismaMock.deliveryPlan.findMany.mockResolvedValue([
      { id: 's1', plate: 'KCA224M', source: 'sheet', planDate: new Date('2026-11-11T00:00:00Z') },
      { id: 'p1', plate: 'KCA 224M', source: KEYED_SOURCE, planDate: new Date(`${DAY}T00:00:00Z`) },
    ] as never)

    const did = await syncKeyedPlans(ORG, DAY, [{ plate: 'KCA 224M', customers: ['Shop A'] }], 'u1')

    expect(did).toEqual({ made: 0, updated: 0, removed: 1 })
    expect(prismaMock.deliveryPlan.create).not.toHaveBeenCalled()
    expect(prismaMock.deliveryPlan.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['p1'] } } })
  })

  it('takes the day\'s lock before reading the plans', async () => {
    await syncKeyedPlans(ORG, DAY, [], null)
    expect(prismaMock.$executeRaw).toHaveBeenCalledOnce()
    expect(prismaMock.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.deliveryPlan.findMany.mock.invocationCallOrder[0])
  })
})
