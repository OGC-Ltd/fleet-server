/**
 * The operations report — four sections, scoped to the caller's vehicles.
 *
 * The scoping assertions matter most. A dispatcher restricted to eleven units
 * who is handed fleet totals has been given exactly the information the
 * restriction exists to withhold, and it arrives looking like their own figures,
 * which is worse than an obvious leak.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')

import { prismaMock } from '../helpers/prisma.mock.js'
import { collectOperations } from '../../src/modules/reports/operations-report.js'

const ORG = 'org_a'

function arrange(over: Record<string, unknown> = {}) {
  const m = prismaMock as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>
  m['notification']!['findMany']!.mockResolvedValue([{ vehicleId: 'v1' }, { vehicleId: 'v2' }])
  m['notification']!['count']!.mockResolvedValue(7)
  m['trip']!['count']!.mockResolvedValue(12)
  m['trip']!['aggregate']!.mockResolvedValue({ _sum: { mileageKm: 480.5 } })
  m['fuelFilling']!['findMany']!.mockResolvedValue([])
  m['vehicleSensor']!['findMany']!.mockResolvedValue([])
  m['vehicleDailyStat']!['groupBy']!.mockResolvedValue([])
  for (const [k, v] of Object.entries(over)) {
    const [model, fn] = k.split('.') as [string, string]
    m[model]![fn]!.mockResolvedValue(v)
  }
}

const kpi = (data: Awaited<ReturnType<typeof collectOperations>>, label: string) => {
  const k = data.kpis.find((x) => x.label === label)
  if (!k) throw new Error(`No KPI "${label}"`)
  return k
}

beforeEach(() => { vi.clearAllMocks() })

describe('the four sections', () => {
  it('counts units off the premises, and how often they left', async () => {
    arrange()
    const data = await collectOperations(ORG, 30)
    expect(kpi(data, 'Units off premises').value).toBe('2')
    expect(kpi(data, 'Units off premises').sub).toContain('7 departures')
  })

  it('counts completed trips and the distance behind them', async () => {
    arrange()
    const data = await collectOperations(ORG, 30)
    expect(kpi(data, 'Trips completed').value).toBe('12')
    expect(kpi(data, 'Trips completed').sub).toContain('481 km')
  })

  it('totals refills and breaks them down per unit', async () => {
    arrange({ 'fuelFilling.findMany': [
      { vehicleId: 'v1', filledMl: 120_000, vehicle: { registrationPlate: 'KDX 001' } },
      { vehicleId: 'v1', filledMl:  80_000, vehicle: { registrationPlate: 'KDX 001' } },
      { vehicleId: 'v2', filledMl:  50_000, vehicle: { registrationPlate: 'KDX 002' } },
    ] })
    const data = await collectOperations(ORG, 30)

    expect(kpi(data, 'Fuel refilled').value).toBe('250')      // 250 L
    // Ordered by volume, and a unit's several fills collapse to one row.
    expect(data.bars.rows.map((r) => r.label)).toEqual(['KDX 001', 'KDX 002'])
    expect(data.bars.rows[0]!.note).toBe('2 fills')
    expect(data.bars.rows[1]!.note).toBe('1 fill')
    // The longest bar is full; the rest are relative to it.
    expect(data.bars.rows[0]!.frac).toBe(1)
    expect(data.bars.rows[1]!.frac).toBeCloseTo(0.25)
  })

  it('separates working, silent and uncalibrated sensors', async () => {
    arrange({
      'vehicleSensor.findMany': [
        { vehicleId: 'v1', calibrationPoints: 8, vehicle: { registrationPlate: 'KDX 001' } },
        { vehicleId: 'v2', calibrationPoints: 8, vehicle: { registrationPlate: 'KDX 002' } },
        { vehicleId: 'v3', calibrationPoints: 0, vehicle: { registrationPlate: 'KDX 003' } },
      ],
      'vehicleDailyStat.groupBy': [{ vehicleId: 'v1', _sum: { levelPings: 4_100 } }],
    })
    const data = await collectOperations(ORG, 30)

    const states = Object.fromEntries(data.table.rows.map((r) => [r.cells[0], r.cells[2]]))
    expect(states).toEqual({ 'KDX 001': 'WORKING', 'KDX 002': 'FAULTY', 'KDX 003': 'UNCALIBRATED' })

    // Both non-working states count as needing attention in the summary tile…
    expect(kpi(data, 'Sensors faulty').value).toBe('2')
    expect(kpi(data, 'Sensors faulty').sub).toContain('1 of 3 working')
    // …but they stay distinguishable, because they call for different work.
    expect(data.donut.data.segments.map((s) => `${s.label}:${s.value}`))
      .toEqual(['Working:1', 'Faulty:1', 'Uncalibrated:1'])
  })

  it('flags every non-working unit in the table', async () => {
    arrange({
      'vehicleSensor.findMany': [
        { vehicleId: 'v1', calibrationPoints: 8, vehicle: { registrationPlate: 'KDX 001' } },
        { vehicleId: 'v2', calibrationPoints: 0, vehicle: { registrationPlate: 'KDX 002' } },
      ],
      'vehicleDailyStat.groupBy': [{ vehicleId: 'v1', _sum: { levelPings: 10 } }],
    })
    const data = await collectOperations(ORG, 30)
    expect(data.table.rows.map((r) => Boolean(r.alert))).toEqual([false, true])
  })
})

describe('it carries nothing beyond its four sections', () => {
  it('has no ranked, daily, category or combo chart', async () => {
    arrange()
    const data = await collectOperations(ORG, 30)
    expect(data.ranked).toBeUndefined()
    expect(data.daily).toBeUndefined()
    expect(data.categoryChart).toBeUndefined()
    expect(data.comboChart).toBeUndefined()
    expect(data.extraTables).toBeUndefined()
  })

  it('names itself the operations report', async () => {
    arrange()
    expect((await collectOperations(ORG, 30)).title).toBe('Operations Report')
  })
})

describe('vehicle scope reaches every figure', () => {
  const SCOPE = new Set(['v1', 'v2'])

  it('narrows departures', async () => {
    arrange()
    await collectOperations(ORG, 30, SCOPE)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where = (prismaMock.notification.findMany as any).mock.calls[0][0].where
    expect(where.vehicleId).toEqual({ in: ['v1', 'v2'] })
    expect(where.organisationId).toBe(ORG)
  })

  it('narrows trips', async () => {
    arrange()
    await collectOperations(ORG, 30, SCOPE)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((prismaMock.trip.count as any).mock.calls[0][0].where.vehicle)
      .toEqual({ organisationId: ORG, id: { in: ['v1', 'v2'] } })
  })

  it('narrows refills', async () => {
    arrange()
    await collectOperations(ORG, 30, SCOPE)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((prismaMock.fuelFilling.findMany as any).mock.calls[0][0].where.vehicle)
      .toMatchObject({ organisationId: ORG, id: { in: ['v1', 'v2'] } })
  })

  it('narrows sensors', async () => {
    arrange()
    await collectOperations(ORG, 30, SCOPE)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((prismaMock.vehicleSensor.findMany as any).mock.calls[0][0].where.vehicle)
      .toMatchObject({ organisationId: ORG, id: { in: ['v1', 'v2'] } })
  })

  it('asks for the whole organisation when the scope is null', async () => {
    arrange()
    await collectOperations(ORG, 30, null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((prismaMock.trip.count as any).mock.calls[0][0].where.vehicle)
      .toEqual({ organisationId: ORG })
  })
})

describe('an empty window still produces a document', () => {
  it('says so rather than rendering blanks', async () => {
    arrange({
      'notification.findMany': [], 'notification.count': 0,
      'trip.count': 0, 'trip.aggregate': { _sum: { mileageKm: null } },
    })
    const data = await collectOperations(ORG, 30)

    expect(kpi(data, 'Units off premises').value).toBe('0')
    expect(kpi(data, 'Trips completed').sub).toContain('0 km')
    expect(data.donut.data.centerValue).toBe('—')
    expect(data.table.note).toMatch(/no unit/i)
    // The reader is told WHY it is empty, since a missing gate coordinate and a
    // quiet month look identical in the number alone.
    expect(data.insights.some((i) => /gate coordinate/i.test(i.body))).toBe(true)
  })
})
