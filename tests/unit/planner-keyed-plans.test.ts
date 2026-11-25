import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/lib/prisma.js')
import { prismaMock } from '../helpers/prisma.mock.js'
import { keyedStops, fenceMiddle, syncKeyedPlans, customerWrite, priorFor, KEYED_SOURCE } from '../../src/modules/planner/keyed-plans.js'
import { sheetReplaces } from '../../src/modules/planner/planner.service.js'

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
    prismaMock.plannerCustomer.create.mockImplementation(((a: { data: { customerCode: string } }) => Promise.resolve({ id: `c-${a.data.customerCode}` })) as never)
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
    expect(prismaMock.plannerCustomer.create.mock.calls[0][0].data).toMatchObject({ customerCode: 'GF:f1', geofenceId: 'f1' })
    expect(prismaMock.geofence.create).not.toHaveBeenCalled()
  })

  it('a Van Sales vehicle (list "vs") is planned like any other', async () => {
    prismaMock.geofence.findMany.mockResolvedValue([fence('f1', 'MENENGAI_VS: JOJAC')] as never)
    prismaMock.vehicle.findMany.mockResolvedValue([{ id: 'v1' }] as never)
    prismaMock.plannerCustomer.create.mockImplementation(((a: { data: { customerCode: string } }) => Promise.resolve({ id: `c-${a.data.customerCode}` })) as never)
    prismaMock.deliveryPlan.create.mockResolvedValue({ id: 'p1' } as never)

    const vs = { key: 'kdm', plate: 'KDM 119L', vehicleIds: ['v1'], customers: ['MENENGAI_VS: JOJAC'], list: 'vs' as const }
    expect(await syncKeyedPlans(ORG, DAY, [vs], 'u1')).toEqual({ made: 1, updated: 0, removed: 0 })
    expect(prismaMock.deliveryPlan.create.mock.calls[0][0].data).toMatchObject({ plate: 'KDM 119L', vehicleId: 'v1', source: KEYED_SOURCE })
  })

  it('a stop changed keeps the outcome marked on the stops that remain; a vehicle taken off loses its plan', async () => {
    prismaMock.geofence.findMany.mockResolvedValue([fence('f1', 'Shop A'), fence('f3', 'Shop C')] as never)
    prismaMock.plannerCustomer.findMany.mockResolvedValue([
      { id: 'c-GF:f1', customerCode: 'GF:f1', name: 'Shop A', lat: -0.3, lng: 36.1, geofenceId: 'f1' },
    ] as never)
    prismaMock.plannerCustomer.create.mockImplementation(((a: { data: { customerCode: string } }) => Promise.resolve({ id: `c-${a.data.customerCode}` })) as never)
    prismaMock.deliveryPlan.findMany.mockResolvedValue([
      { id: 'p1', plate: 'KCA 224M', source: KEYED_SOURCE, planDate: new Date(`${DAY}T00:00:00Z`) },
      { id: 'p9', plate: 'KDE 127E', source: KEYED_SOURCE, planDate: new Date(`${DAY}T00:00:00Z`) },
    ] as never)
    prismaMock.deliveryPlan.update.mockResolvedValue({ id: 'p1' } as never)
    prismaMock.deliveryPlanStop.findMany.mockResolvedValue([
      { planId: 'p1', customerId: 'c-GF:f1', outcome: 'FULL', remarks: 'paid', outcomeBy: 'u2', outcomeAt: new Date(), dueDay: null },
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

  it('a plan whose stops did not change is left alone, its stops keeping their ids; known customers are not rewritten', async () => {
    prismaMock.geofence.findMany.mockResolvedValue([fence('f1', 'Shop A')] as never)
    prismaMock.vehicle.findMany.mockResolvedValue([{ id: 'v1' }] as never)
    prismaMock.plannerCustomer.findMany.mockResolvedValue([
      { id: 'c1', customerCode: 'GF:f1', name: 'Shop A', lat: -0.3, lng: 36.1, geofenceId: 'f1' },
    ] as never)
    prismaMock.deliveryPlan.findMany.mockResolvedValue([
      { id: 'p1', plate: 'KCA 224M', source: KEYED_SOURCE, planDate: new Date(`${DAY}T00:00:00Z`), vehicleId: 'v1' },
    ] as never)
    prismaMock.deliveryPlanStop.findMany.mockResolvedValue([{ planId: 'p1', customerId: 'c1' }] as never)

    const did = await syncKeyedPlans(ORG, DAY, [{ plate: 'KCA 224M', vehicleIds: ['v1'], customers: ['Shop A'] }], 'u1')

    expect(did).toEqual({ made: 0, updated: 0, removed: 0 })
    expect(prismaMock.deliveryPlanStop.deleteMany).not.toHaveBeenCalled()
    expect(prismaMock.deliveryPlanStop.createMany).not.toHaveBeenCalled()
    expect(prismaMock.plannerCustomer.update).not.toHaveBeenCalled()
    expect(prismaMock.plannerCustomer.create).not.toHaveBeenCalled()
  })

  it('takes the day\'s lock before reading the plans', async () => {
    await syncKeyedPlans(ORG, DAY, [], null)
    expect(prismaMock.$executeRaw).toHaveBeenCalledOnce()
    expect(prismaMock.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.deliveryPlan.findMany.mock.invocationCallOrder[0])
  })
})

describe('a point fenced in the Planner', () => {
  const pin = { code: 'PIN:-0.30000,36.10000', name: '-0.30000, 36.10000', lat: -0.3, lng: 36.1, geofenceId: null }
  const row = { customerCode: pin.code, name: pin.name, lat: -0.3, lng: 36.1, geofenceId: null as string | null }

  it('keeps its fence and the name given it when the list is saved again', () => {
    expect(customerWrite({ ...row, name: 'Kamau Stores', geofenceId: 'f9' }, pin)).toBeNull()
  })

  it('an unfenced point still follows the list', () => {
    expect(customerWrite(row, { ...pin, name: 'Kamau' })).toEqual({ name: 'Kamau', lat: -0.3, lng: 36.1, geofenceId: null })
  })

  it('a geofence stop still follows its fence', () => {
    const gf = { code: 'GF:f2', name: 'Shop B', lat: -0.3, lng: 36.1, geofenceId: 'f2' }
    expect(customerWrite({ ...row, customerCode: 'GF:f2', name: 'Shop B', geofenceId: 'f1' }, gf)).toMatchObject({ geofenceId: 'f2' })
  })
})

// Operator, 2026-11-25: "we need the unit for that day to have its vs records, but for FG it judges its
// own stops ... vs was planned 11 routes on vs but on fg the vs car was planned 2 routes, on fg should
// focus and only display the two routes attached to it"
describe('Van Sales and Finished Goods each keep their own plan for a unit', () => {
  const VS_FENCES = Array.from({ length: 11 }, (_, i) => fence(`vs${i + 1}`, `MENENGAI_VS: SHOP ${i + 1}`))
  const FG_FENCES = [fence('fg1', 'MENENGAI_FG: NAIVAS'), fence('fg2', 'MENENGAI_FG: QUICKMART')]
  // KDE 268P is a Van Sales truck on Menengai's fleet list, KCA 224M a Finished Goods one
  const onVs = { key: 'KDE268P', plate: 'KDE 268P', vehicleIds: ['v1'], customers: VS_FENCES.map((f) => f.name), list: 'vs' as const }
  const onFg = { key: 'KDE268P', plate: 'KDE 268P', vehicleIds: ['v1'], customers: FG_FENCES.map((f) => f.name) }
  const itinerary = { id: 'it1', plate: 'KDE 268P', source: 'itinerary', planDate: new Date(`${DAY}T00:00:00Z`), vehicleId: 'v1', list: null }

  const setUp = (plans: unknown[] = []) => {
    prismaMock.geofence.findMany.mockResolvedValue([...VS_FENCES, ...FG_FENCES] as never)
    prismaMock.vehicle.findMany.mockResolvedValue([{ id: 'v1' }] as never)
    prismaMock.plannerCustomer.create.mockImplementation(((a: { data: { customerCode: string } }) => Promise.resolve({ id: `c-${a.data.customerCode}` })) as never)
    prismaMock.deliveryPlan.create.mockImplementation(((a: { data: { list: string } }) => Promise.resolve({ id: `p-${a.data.list}` })) as never)
    prismaMock.deliveryPlan.findMany.mockResolvedValue(plans as never)
  }
  const stopsOf = (planId: string) => prismaMock.deliveryPlanStop.createMany.mock.calls
    .map((c) => c[0]!.data as Array<{ planId: string, customerId: string }>)
    .filter((rows) => rows[0]?.planId === planId)
    .flat().map((r) => r.customerId)

  it('VS only: one plan on VS with its 11 stops; its VS itinerary still wins on VS', async () => {
    setUp()
    expect(await syncKeyedPlans(ORG, DAY, [onVs], 'u1')).toEqual({ made: 1, updated: 0, removed: 0 })
    expect(prismaMock.deliveryPlan.create.mock.calls[0][0].data).toMatchObject({ plate: 'KDE 268P', list: 'vs', source: KEYED_SOURCE })
    expect(stopsOf('p-vs')).toHaveLength(11)

    prismaMock.deliveryPlan.create.mockClear()
    setUp([itinerary])
    expect(await syncKeyedPlans(ORG, DAY, [onVs], 'u1')).toEqual({ made: 0, updated: 0, removed: 0 })
    expect(prismaMock.deliveryPlan.create).not.toHaveBeenCalled()
  })

  it('FG only: one plan on FG with its own stops; an FG sales sheet still wins on FG', async () => {
    const fgTruck = { key: 'KCA224M', plate: 'KCA 224M', vehicleIds: ['v1'], customers: FG_FENCES.map((f) => f.name) }
    setUp()
    expect(await syncKeyedPlans(ORG, DAY, [fgTruck], 'u1')).toEqual({ made: 1, updated: 0, removed: 0 })
    expect(prismaMock.deliveryPlan.create.mock.calls[0][0].data).toMatchObject({ plate: 'KCA 224M', list: 'fg' })
    expect(stopsOf('p-fg')).toEqual(['c-GF:fg1', 'c-GF:fg2'])

    prismaMock.deliveryPlan.create.mockClear()
    setUp([{ id: 's1', plate: 'KCA 224M', source: 'sheet', planDate: new Date('2026-11-11T00:00:00Z'), list: null }])
    expect(await syncKeyedPlans(ORG, DAY, [fgTruck], 'u1')).toEqual({ made: 0, updated: 0, removed: 0 })
    expect(prismaMock.deliveryPlan.create).not.toHaveBeenCalled()
  })

  it('VS then added to FG: two plans, FG judged on its 2 stops only, none of the 11 VS stops', async () => {
    setUp()
    expect(await syncKeyedPlans(ORG, DAY, [onVs, onFg], 'u1')).toEqual({ made: 2, updated: 0, removed: 0 })
    const made = prismaMock.deliveryPlan.create.mock.calls.map((c) => c[0].data as { plate: string, list: string })
    expect(made.map((d) => [d.plate, d.list]).sort()).toEqual([['KDE 268P', 'fg'], ['KDE 268P', 'vs']])
    expect(stopsOf('p-fg')).toEqual(['c-GF:fg1', 'c-GF:fg2'])
    expect(stopsOf('p-vs')).toHaveLength(11)
  })

  it('VS then added to FG, with a VS itinerary: the itinerary keeps VS, and FG still gets its own plan', async () => {
    setUp([itinerary])
    expect(await syncKeyedPlans(ORG, DAY, [onVs, onFg], 'u1')).toEqual({ made: 1, updated: 0, removed: 0 })
    expect(prismaMock.deliveryPlan.create.mock.calls[0][0].data).toMatchObject({ plate: 'KDE 268P', list: 'fg' })
    expect(stopsOf('p-fg')).toEqual(['c-GF:fg1', 'c-GF:fg2'])
  })

  it('an itinerary moved to FG in the Planner wins on FG instead', async () => {
    setUp([{ ...itinerary, list: 'fg' }])
    expect(await syncKeyedPlans(ORG, DAY, [onVs, onFg], 'u1')).toEqual({ made: 1, updated: 0, removed: 0 })
    expect(prismaMock.deliveryPlan.create.mock.calls[0][0].data).toMatchObject({ list: 'vs' })
  })

  it('taken off FG, the unit loses its FG plan only', async () => {
    setUp([
      { id: 'pv', plate: 'KDE 268P', source: KEYED_SOURCE, planDate: new Date(`${DAY}T00:00:00Z`), vehicleId: 'v1', list: 'vs' },
      { id: 'pf', plate: 'KDE 268P', source: KEYED_SOURCE, planDate: new Date(`${DAY}T00:00:00Z`), vehicleId: 'v1', list: 'fg' },
    ])
    prismaMock.plannerCustomer.findMany.mockResolvedValue(VS_FENCES.map((f) => ({ id: `c-GF:${f.id}`, customerCode: `GF:${f.id}`, name: f.name.replace('MENENGAI_VS: ', ''), lat: -0.3, lng: 36.1, geofenceId: f.id })) as never)
    prismaMock.deliveryPlanStop.findMany.mockResolvedValue(VS_FENCES.map((f) => ({ planId: 'pv', customerId: `c-GF:${f.id}` })) as never)
    expect(await syncKeyedPlans(ORG, DAY, [onVs], 'u1')).toEqual({ made: 0, updated: 0, removed: 1 })
    expect(prismaMock.deliveryPlan.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['pf'] } } })
  })

  it('a plan kept before plans had a list is taken over by its list, marks kept', () => {
    const keyed = [
      { id: 'old', plate: 'KDE268P', list: null },
      { id: 'vs', plate: 'KDE 268P', list: 'vs' },
    ]
    const taken = new Set<string>()
    expect(priorFor(keyed, 'vs', 'KDE 268P', taken)?.id).toBe('vs')
    taken.add('vs')
    expect(priorFor(keyed, 'fg', 'KDE 268P', taken)?.id).toBe('old')
    taken.add('old')
    expect(priorFor(keyed, 'fg', 'KDE 268P', taken)).toBeNull()
  })
})

describe('the plan a sheet upload replaces', () => {
  it('its earlier sheet first; else the keyed plan of its own report, never the other report’s', () => {
    const keyedFg = { id: 'kf', plate: 'KDE 268P', source: KEYED_SOURCE, list: 'fg' }
    const keyedVs = { id: 'kv', plate: 'KDE 268P', source: KEYED_SOURCE, list: 'vs' }
    const sheet = { id: 'it', plate: 'KDE268P', source: 'itinerary', list: null }
    // A Van Sales truck's itinerary
    expect(sheetReplaces([keyedFg, sheet, keyedVs], 'KDE 268P')?.id).toBe('it')
    expect(sheetReplaces([keyedFg, keyedVs], 'KDE 268P')?.id).toBe('kv')
    expect(sheetReplaces([keyedFg], 'KDE 268P')).toBeNull()
    // A Finished Goods truck's sheet replaces its FG keyed plan, as before
    expect(sheetReplaces([{ id: 'k', plate: 'KCA 224M', source: KEYED_SOURCE, list: null }], 'KCA 224M')?.id).toBe('k')
  })
})
