import { describe, it, expect, vi } from 'vitest'
import * as XLSX from 'xlsx'
vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/zone-presence.js', () => ({ invalidateZoneCache: vi.fn() }))
import { prismaMock } from '../helpers/prisma.mock.js'
import { customerState, saveSheet, fenceCustomer, listCustomers, MOVED_M } from '../../src/modules/planner/planner.service.js'

const HEAD = ['NO.', 'REP', 'CUSTOMER ID', 'CUSTOMER NAME', 'LOCATION', 'COORDINATES', 'INVOICE NO.', 'AMOUNT', 'TONNAGE', 'FULL', 'PARTLY', 'REJECTED', 'REMARKS']
function file(): string {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Truck Number: KZZ 001A'], ['Date: 2026-11-09 09:36:16', null, null, 'Driver Name: JANE DOE'], HEAD,
    ['1', 'R', '900001', 'SHOP ONE', 'TOWN', 'LAT: -0.2650 LONG: 36.1207', 'INV1', '100', '0.01'],
    ['2', 'R', '900002', 'SHOP TWO', 'TOWN', 'LAT: -0.2700 LONG: 36.1000', 'INV2', '200', '0.02'],
    ['TOTALS'],
  ])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Delivery List')
  return (XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer).toString('base64')
}

describe('customerState', () => {
  const known = { id: 'c1', customerCode: '1', name: 'A', lat: -0.265, lng: 36.1207, geofenceId: 'g1' }
  it('a new customer with a point draws a fence; without one it cannot', () => {
    expect(customerState({ lat: -0.1, lng: 36 }, undefined, false)).toEqual({ state: 'new', movedM: null, drawsFence: true })
    expect(customerState({ lat: null, lng: null }, undefined, false).state).toBe('no_point')
  })
  it('a kept customer reuses its fence, and a point moved past the limit is flagged, not followed', () => {
    expect(customerState({ lat: -0.2651, lng: 36.1207 }, known, true)).toEqual({ state: 'known', movedM: null, drawsFence: false })
    const moved = customerState({ lat: -0.27, lng: 36.1207 }, known, true)
    expect(moved.state).toBe('moved')
    expect(moved.movedM).toBeGreaterThan(MOVED_M)
    expect(moved.drawsFence).toBe(false)
  })
  it('a kept customer whose fence was deleted gets a new one', () => {
    expect(customerState({ lat: -0.265, lng: 36.1207 }, known, false).drawsFence).toBe(true)
  })
})

describe('saveSheet', () => {
  const base = () => {
    prismaMock.vehicle.findMany.mockResolvedValue([{ id: 'v1', registrationPlate: 'KZZ 001A', name: 'FG - KZZ 001A' }] as never)
    prismaMock.user.findFirst.mockResolvedValue(null)
    prismaMock.$queryRaw.mockResolvedValue([] as never)
    prismaMock.deliveryPlanStop.createMany.mockResolvedValue({ count: 2 })
    prismaMock.plannerCustomer.upsert.mockImplementation(((a: { create: { customerCode: string } }) => Promise.resolve({ id: `c-${a.create.customerCode}` })) as never)
  }

  it('first upload draws a fence per customer and creates the plan', async () => {
    base()
    prismaMock.plannerCustomer.findMany.mockResolvedValue([])
    prismaMock.deliveryPlan.findMany.mockResolvedValue([])
    prismaMock.geofence.create.mockResolvedValue({ id: 'g-new' } as never)
    prismaMock.deliveryPlan.create.mockResolvedValue({ id: 'p1' } as never)
    const r = await saveSheet('org', 'u1', { fileName: 'KZZ.xlsx', data: file() })
    expect(r).toMatchObject({ planId: 'p1', replaced: false, fencesDrawn: 2, customersAdded: 2, moved: [] })
    const fence = prismaMock.geofence.create.mock.calls[0][0].data
    expect(fence).toMatchObject({ name: 'SHOP ONE', type: 'CIRCLE', radiusM: 100, purpose: 'shop', centerLat: -0.265 })
    expect(prismaMock.deliveryPlan.create.mock.calls[0][0].data).toMatchObject({ vehicleId: 'v1', plate: 'KZZ 001A', driverName: 'JANE DOE' })
  })

  it('re-upload of the same plate and day draws nothing, replaces the lines and keeps outcomes', async () => {
    base()
    prismaMock.plannerCustomer.findMany.mockResolvedValue([
      { id: 'c-900001', customerCode: '900001', name: 'SHOP ONE', lat: -0.265, lng: 36.1207, geofenceId: 'g1' },
      { id: 'c-900002', customerCode: '900002', name: 'SHOP TWO', lat: -0.27, lng: 36.1, geofenceId: 'g2' },
    ] as never)
    prismaMock.geofence.findMany.mockResolvedValue([{ id: 'g1', name: 'SHOP ONE' }, { id: 'g2', name: 'SHOP TWO' }] as never)
    prismaMock.deliveryPlan.findMany.mockResolvedValue([{ id: 'p1', plate: 'KZZ001A' }] as never)
    prismaMock.deliveryPlan.update.mockResolvedValue({ id: 'p1' } as never)
    prismaMock.deliveryPlanStop.findMany.mockResolvedValue([
      { customerId: 'c-900001', invoiceNo: 'INV1', outcome: 'REJECTED', remarks: 'closed', outcomeBy: 'u9', outcomeAt: new Date() },
    ] as never)
    const r = await saveSheet('org', 'u1', { fileName: 'KZZ.xlsx', data: file() })
    expect(r).toMatchObject({ planId: 'p1', replaced: true, fencesDrawn: 0, customersAdded: 0 })
    expect(prismaMock.geofence.create).not.toHaveBeenCalled()
    expect(prismaMock.deliveryPlanStop.deleteMany).toHaveBeenCalledWith({ where: { planId: 'p1' } })
    const lines = prismaMock.deliveryPlanStop.createMany.mock.calls[0]![0]!.data as Array<{ outcome: string | null, remarks: string }>
    expect(lines.map((l) => [l.outcome, l.remarks])).toEqual([['REJECTED', 'closed'], [null, '']])
  })

  it('refuses a sheet whose new customer has no point', async () => {
    base()
    prismaMock.plannerCustomer.findMany.mockResolvedValue([])
    const ws = XLSX.utils.aoa_to_sheet([['Truck Number: KZZ 001A'], ['Date: 2026-11-09'], HEAD, ['1', 'R', '9', 'NOWHERE', 'T', '', '0', '1', '0']])
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S')
    const data = (XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer).toString('base64')
    await expect(saveSheet('org', 'u1', { fileName: '', data })).rejects.toThrow(/NOWHERE/)
    // …and takes the point when the person gives one
    prismaMock.deliveryPlan.findMany.mockResolvedValue([])
    prismaMock.geofence.create.mockResolvedValue({ id: 'g' } as never)
    prismaMock.deliveryPlan.create.mockResolvedValue({ id: 'p2' } as never)
    await expect(saveSheet('org', 'u1', { fileName: '', data, points: { 9: { lat: -0.3, lng: 36.1 } } })).resolves.toMatchObject({ fencesDrawn: 1 })
  })

  it('a new customer takes an existing fence that carries its name, or the one picked on the preview, instead of drawing', async () => {
    base()
    prismaMock.plannerCustomer.findMany.mockResolvedValue([])
    prismaMock.deliveryPlan.findMany.mockResolvedValue([])
    prismaMock.geofence.create.mockResolvedValue({ id: 'g-new' } as never)
    prismaMock.deliveryPlan.create.mockResolvedValue({ id: 'p1' } as never)
    // SHOP ONE has a Wialon fence 20 m away; SHOP TWO only an unrelated one
    prismaMock.$queryRaw.mockImplementation((async (q: TemplateStringsArray, _l: number, lat: number) => (lat === -0.265
      ? [{ id: 'w1', name: 'MENENGAI_VS:SHOP ONE', distanceM: 20, areaM2: 31_000 }]
      : [{ id: 'w2', name: 'NAKURU TOWN', distanceM: 0, areaM2: 9_000_000 }])) as never)
    const r = await saveSheet('org', 'u1', { fileName: 'KZZ.xlsx', data: file() })
    expect(r).toMatchObject({ fencesReused: 1, fencesDrawn: 1 })
    const ups = prismaMock.plannerCustomer.upsert.mock.calls.map((c) => [c[0].create.customerCode, c[0].create.geofenceId])
    expect(ups).toEqual([['900001', 'w1'], ['900002', 'g-new']])

    // A person's choice wins: SHOP ONE asked for a new circle, SHOP TWO took w9
    prismaMock.plannerCustomer.upsert.mockClear()
    prismaMock.geofence.findMany.mockResolvedValue([{ id: 'w9' }] as never)
    const r2 = await saveSheet('org', 'u1', { fileName: 'KZZ.xlsx', data: file(), fences: { 900001: 'new', 900002: 'w9' } })
    expect(r2).toMatchObject({ fencesReused: 1, fencesDrawn: 1 })
    expect(prismaMock.plannerCustomer.upsert.mock.calls.map((c) => c[0].create.geofenceId)).toEqual(['g-new', 'w9'])
  })
})

describe('fenceCustomer', () => {
  const body = { name: 'Kamau Stores', lat: -0.31, lng: 36.12, radiusM: 120 }

  it('draws a circle where it is told, names a point-only customer after it and ties the two', async () => {
    prismaMock.plannerCustomer.findFirst.mockResolvedValue({ id: 'c1', customerCode: 'PIN:-0.31000,36.12000', geofenceId: null } as never)
    prismaMock.geofence.create.mockResolvedValue({ id: 'f1', name: 'Kamau Stores', centerLat: -0.31, centerLng: 36.12, radiusM: 120 } as never)
    const r = await fenceCustomer('org1', 'c1', body)
    expect(prismaMock.geofence.create.mock.calls[0][0].data).toMatchObject({ organisationId: 'org1', type: 'CIRCLE', centerLat: -0.31, centerLng: 36.12, radiusM: 120, name: 'Kamau Stores' })
    expect(prismaMock.plannerCustomer.update.mock.calls[0][0]).toMatchObject({ where: { id: 'c1' }, data: { geofenceId: 'f1', name: 'Kamau Stores' } })
    expect(r).toMatchObject({ customerId: 'c1', geofence: { id: 'f1' } })
  })

  it('a sheet customer keeps its own name', async () => {
    prismaMock.plannerCustomer.findFirst.mockResolvedValue({ id: 'c2', customerCode: '10023', geofenceId: 'gone' } as never)
    prismaMock.geofence.findFirst.mockResolvedValue(null)
    prismaMock.geofence.create.mockResolvedValue({ id: 'f2' } as never)
    await fenceCustomer('org1', 'c2', body)
    expect(prismaMock.plannerCustomer.update.mock.calls[0][0].data).toEqual({ geofenceId: 'f2' })
  })

  it('refuses a customer whose fence is still there, and one of another organisation', async () => {
    prismaMock.plannerCustomer.findFirst.mockResolvedValue({ id: 'c3', customerCode: 'PIN:1,1', geofenceId: 'f3' } as never)
    prismaMock.geofence.findFirst.mockResolvedValue({ id: 'f3' } as never)
    await expect(fenceCustomer('org1', 'c3', body)).rejects.toThrow(/already has a geofence/)
    prismaMock.plannerCustomer.findFirst.mockResolvedValue(null)
    await expect(fenceCustomer('org1', 'cx', body)).rejects.toThrow(/not found/i)
    expect(prismaMock.geofence.create).not.toHaveBeenCalled()
  })
})

describe('listCustomers', () => {
  it('fenced: only customers tied to a geofence, all of them', async () => {
    prismaMock.plannerCustomer.findMany.mockResolvedValue([] as never)
    await listCustomers('org1', 'PIN:', true)
    const a = prismaMock.plannerCustomer.findMany.mock.calls[0][0]!
    expect(a.where).toMatchObject({ organisationId: 'org1', geofenceId: { not: null } })
    expect(a.take).toBe(2000)
  })

  it('unfiltered by default', async () => {
    prismaMock.plannerCustomer.findMany.mockResolvedValue([] as never)
    await listCustomers('org1')
    const a = prismaMock.plannerCustomer.findMany.mock.calls[0][0]!
    expect(a.where).toEqual({ organisationId: 'org1' })
    expect(a.take).toBe(200)
  })
})
