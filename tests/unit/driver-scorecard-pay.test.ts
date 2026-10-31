/**
 * The scorecard's pay package end to end (driver-score.service): trips priced
 * by route, fuel on the driver who held the unit, the retainer pro-rated to
 * the period, and zero tolerance counted from the first of the month.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/modules/dashcam/dashcam.service.js', () => ({
  getAlarms: vi.fn(async () => ({ cameras: 0, incidents: [], partial: false, stale: false })),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { getDriverScorecard } from '../../src/modules/driver-score/driver-score.service.js'

const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+03:00`)
const assignment = { vehicleId: 'v1', userId: 'u1', assignedAt: new Date('2026-01-01T00:00:00Z'), unassignedAt: null, notes: null,
  user: { fullName: 'Wilson Koskey' } }

beforeEach(() => {
  prismaMock.organisation.findUnique.mockResolvedValue({ name: 'Kabras Bioenergy', code: 'KABRAS' } as never)
  prismaMock.vehicle.findMany.mockResolvedValue([{ id: 'v1', registrationPlate: 'KCA 227M' }] as never)
  prismaMock.vehicleAssignment.findMany.mockResolvedValue([assignment] as never)
})

describe('getDriverScorecard — the pay package', () => {
  it('pays completed trips by route, lunch on trip days, and the pro-rated retainer', async () => {
    prismaMock.dispatch.findMany.mockResolvedValue([
      { vehicleId: 'v1', dispatchedAt: at('2026-10-20', '07:00'), factoryCode: null, destination: 'KABRAS DISTILLERY', externalId: 'd1', serialNumber: null },
      { vehicleId: 'v1', dispatchedAt: at('2026-10-20', '10:00'), factoryCode: null, destination: 'KABRAS DISTILLERY', externalId: 'd2', serialNumber: null },
      { vehicleId: 'v1', dispatchedAt: at('2026-10-21', '07:00'), factoryCode: 'NDHIWA', destination: null, externalId: 'd3', serialNumber: null },
    ] as never)
    const r = await getDriverScorecard('org1', '2026-10-20', '2026-10-21')
    const d = r.drivers[0]!
    expect(d.name).toBe('Wilson Koskey')
    expect(d.trips).toBe(3)
    expect(d.pay.tripPay).toBe(208 + 208 + 950)
    expect(d.pay.lunch).toBe(400)
    expect(d.pay.retainer).toBe(Math.round((25_000 / 31) * 2))
    expect(d.pay.gross).toBe(d.pay.retainer + d.pay.tripPay + d.pay.lunch + d.pay.speedKes + d.pay.fuelKes + d.pay.safetyKes)
    expect(d.pay.net).toBe(Math.round(d.pay.gross * 0.85))
    expect(r.organisation).toBe('Kabras Bioenergy')
  })

  it("scores the day's fuel from the probe, with Kabras's 40 km/h qualifier", async () => {
    prismaMock.dispatch.findMany.mockResolvedValue([
      { vehicleId: 'v1', dispatchedAt: at('2026-10-20', '07:00'), factoryCode: null, destination: 'KABRAS', externalId: 'd1', serialNumber: null },
    ] as never)
    // 210 km on 100 L = 2.1 km/L; 4 h moving of 5 h engine = 52.5 km/h.
    prismaMock.fuelDailyTrend.findMany.mockResolvedValue([
      { vehicleId: 'v1', day: new Date('2026-10-20T00:00:00Z'), distanceM: 210_000, engineBurnMl: 100_000, engineSeconds: 5 * 3600 },
    ] as never)
    prismaMock.vehicleDailyStat.findMany.mockResolvedValue([
      { vehicleId: 'v1', day: new Date('2026-10-20T00:00:00Z'), engineFixes: 100, idleFixes: 20 },
    ] as never)
    const d = (await getDriverScorecard('org1', '2026-10-20', '2026-10-20')).drivers[0]!
    expect(d.kmpl).toBe(2.1)
    expect(d.fuelPoints).toBe(5)
    expect(d.pay.fuelKes).toBe(250)
    expect(d.byDay[0]!.fuel.avgKmh).toBe(52.5)
  })

  it('counts zero tolerance from the 1st, and charges the suspension in the period that crosses 5', async () => {
    const harsh = (day: string, hm: string) => ({ vehicleId: 'v1', createdAt: at(day, hm), raw: { ms2: 0.6 } })
    // 3 before the period (1–19 Oct), 2 inside it: the 5th falls on the 20th.
    prismaMock.providerAlert.findMany.mockResolvedValue([
      harsh('2026-10-03', '08:00'), harsh('2026-10-05', '08:00'), harsh('2026-10-07', '08:00'),
      harsh('2026-10-20', '08:00'), harsh('2026-10-20', '09:00'),
    ] as never)
    const d = (await getDriverScorecard('org1', '2026-10-20', '2026-10-21')).drivers[0]!
    expect(d.violations.harshBrake).toBe(2)                    // the period's own
    expect(d.months[0]).toMatchObject({ month: '2026-10', violations: 5, standing: 'suspension', suspendedHere: true })
    expect(d.pay.suspension).toBe(-1_250)

    // Already over the line before the period: not charged again.
    const later = (await getDriverScorecard('org1', '2026-10-21', '2026-10-21')).drivers
    expect(later).toHaveLength(0)
  })

  it('counts a trip on a unit nobody held, without paying anyone for it', async () => {
    prismaMock.vehicleAssignment.findMany.mockResolvedValue([] as never)
    prismaMock.dispatch.findMany.mockResolvedValue([
      { vehicleId: 'v1', dispatchedAt: at('2026-10-20', '07:00'), factoryCode: null, destination: 'KABRAS', externalId: 'd1', serialNumber: null },
    ] as never)
    const r = await getDriverScorecard('org1', '2026-10-20', '2026-10-20')
    expect(r.drivers).toHaveLength(0)
    expect(r.coverage.unattributed.trips).toBe(1)
  })
})
