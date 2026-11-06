import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findVehicles: vi.fn(),
  getDayReportData: vi.fn(),
  buildTripReport: vi.fn(),
  loadOsmTile: vi.fn(),
}))

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: { vehicle: { findMany: mocks.findVehicles } },
}))
vi.mock('../../src/modules/trips/trip-report.service.js', () => ({
  fleetDayBounds: vi.fn(() => ({ from: new Date('2026-10-28T00:00:00Z'), to: new Date('2026-10-29T00:00:00Z') })),
  getDayReportData: mocks.getDayReportData,
}))
vi.mock('../../src/modules/trips/trip-report.build.js', () => ({
  buildTripReport: mocks.buildTripReport,
}))
vi.mock('../../src/modules/usage-review/usage-review.pdf.js', () => ({
  lat2y: (lat: number, z: number) => {
    const sin = Math.sin((lat * Math.PI) / 180)
    return (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 256 * 2 ** z
  },
  lon2x: (lng: number, z: number) => ((lng + 180) / 360) * 256 * 2 ** z,
  tile: mocks.loadOsmTile,
}))

import { recoveryReportQuerySchema } from '../../src/modules/reports/report.schema.js'
import { getRecoveryVehicleReport } from '../../src/modules/reports/recovery-report.service.js'
import { renderRecoveryReportPdf } from '../../src/modules/reports/recovery-report.pdf.js'
import { ConflictError } from '../../src/core/errors/errors.js'

describe('daily recovery vehicle report', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadOsmTile.mockResolvedValue(null)
    mocks.findVehicles.mockResolvedValue([
      { id: 'mechanical-id', registrationPlate: 'KDX130Y' },
      { id: 'puncture-id', registrationPlate: 'KDX 131Y' },
    ])
    mocks.getDayReportData.mockResolvedValue({ fuel: { balance: null } })
    mocks.buildTripReport.mockReturnValue({
      track: [[-1.2, 36.8], [-1.21, 36.81]],
      summary: { distanceKm: 12.3, fuelUsedL: 8.1 },
      stopsTotal: 1,
      stops: [{ t: 1, endT: 2, ms: 60_000, place: 'Roadside', remark: 'Unscheduled', lat: -1.2, lng: 36.8 }],
    })
  })

  it('includes the fixed recovery roster, classifications, and daily metrics within scope', async () => {
    const report = await getRecoveryVehicleReport('org-1', '2026-10-28', new Set(['mechanical-id', 'puncture-id']))

    expect(report.vehicles.map(({ plate, recoveryType }) => [plate, recoveryType])).toEqual([
      ['KDX 130Y', 'mechanical'],
      ['KCS 969P', 'mechanical'],
      ['KDC 099U', 'mechanical'],
      ['KDX 131Y', 'puncture'],
    ])
    expect(report.vehicles[0]).toMatchObject({
      available: true, hasTelemetry: true, distanceKm: 12.3, fuelConsumedL: 8.1,
      stopsTotal: 1, route: [[-1.2, 36.8], [-1.21, 36.81]],
      stops: [{ arrivedAt: 1, leftAt: 2, durationMs: 60_000, location: 'Roadside' }],
    })
    expect(report.vehicles[1]).toMatchObject({ available: false, distanceKm: null, fuelConsumedL: null })
    expect(mocks.getDayReportData).toHaveBeenCalledTimes(2)
    expect(mocks.getDayReportData).toHaveBeenCalledWith('org-1', 'mechanical-id', '2026-10-28', null, { withConduct: false })
    expect(mocks.findVehicles).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ organisationId: 'org-1', id: { in: ['mechanical-id', 'puncture-id'] } }),
    }))
  })

  it('returns only the selected recovery vehicle', async () => {
    const report = await getRecoveryVehicleReport('org-1', '2026-10-28', null, 'KDX 131Y')

    expect(report.vehicles.map(({ plate }) => plate)).toEqual(['KDX 131Y'])
    expect(mocks.findVehicles).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        registrationPlate: { in: ['KDX 131Y', 'KDX131Y'], mode: 'insensitive' },
      }),
    }))
    expect(mocks.getDayReportData).toHaveBeenCalledTimes(1)
    expect(mocks.getDayReportData).toHaveBeenCalledWith('org-1', 'puncture-id', '2026-10-28', null, { withConduct: false })
  })

  it('uses the Fuel Report balance for daily recovery fuel consumption', async () => {
    mocks.getDayReportData.mockResolvedValue({ fuel: { balance: { consumedL: 17.6 } } })

    const report = await getRecoveryVehicleReport('org-1', '2026-11-05', null, 'KDX 131Y')

    expect(report.vehicles[0]).toMatchObject({ fuelConsumedL: 17.6 })
  })

  it('does not substitute the legacy estimate when the Fuel Report balance is unmeasurable', async () => {
    mocks.getDayReportData.mockResolvedValue({ fuel: { balance: { consumedL: null } } })

    const report = await getRecoveryVehicleReport('org-1', '2026-11-05', null, 'KDX 131Y')

    expect(report.vehicles[0]).toMatchObject({ fuelConsumedL: null })
  })

  it('does not expose a selected vehicle outside the caller scope', async () => {
    mocks.findVehicles.mockResolvedValue([{ id: 'mechanical-id', registrationPlate: 'KDX130Y' }])
    const report = await getRecoveryVehicleReport('org-1', '2026-10-28', new Set(['mechanical-id']), 'KDX 131Y')

    expect(report.vehicles).toHaveLength(1)
    expect(report.vehicles[0]).toMatchObject({ plate: 'KDX 131Y', available: false, hasTelemetry: false })
    expect(mocks.getDayReportData).not.toHaveBeenCalled()
    expect(mocks.findVehicles).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ['mechanical-id'] } }),
    }))
  })

  it('does not query any vehicles for an empty caller scope', async () => {
    const report = await getRecoveryVehicleReport('org-1', '2026-10-28', new Set())
    expect(mocks.findVehicles).not.toHaveBeenCalled()
    expect(report.vehicles.every(v => !v.available)).toBe(true)
  })

  it('rejects ambiguous duplicate registrations instead of reporting them as missing', async () => {
    mocks.findVehicles.mockResolvedValue([
      { id: 'one', registrationPlate: 'KDX 130Y' },
      { id: 'two', registrationPlate: 'KDX130Y' },
    ])
    await expect(getRecoveryVehicleReport('org-1', '2026-10-28')).rejects.toBeInstanceOf(ConflictError)
  })

  it('validates calendar dates and rejects future dates', () => {
    expect(recoveryReportQuerySchema.safeParse({ day: '2026-10-28' }).success).toBe(true)
    expect(recoveryReportQuerySchema.safeParse({ day: '2026-10-28', landscape: '1' }).success).toBe(true)
    expect(recoveryReportQuerySchema.safeParse({ day: '2026-10-28', vehicle: 'KDX 131Y' }).success).toBe(true)
    expect(recoveryReportQuerySchema.safeParse({ day: '2026-10-28', vehicle: 'KDX 113Y' }).success).toBe(false)
    expect(recoveryReportQuerySchema.safeParse({ day: '2026-10-28', landscape: 'yes' }).success).toBe(false)
    expect(recoveryReportQuerySchema.safeParse({ day: '2026-02-30' }).success).toBe(false)
    expect(recoveryReportQuerySchema.safeParse({ day: '2999-01-01' }).success).toBe(false)
  })

  it('renders a downloadable PDF', async () => {
    const report = await getRecoveryVehicleReport('org-1', '2026-10-28')
    const pdf = await renderRecoveryReportPdf(report)
    const landscapePdf = await renderRecoveryReportPdf(report, true)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(landscapePdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(mocks.loadOsmTile).toHaveBeenCalled()
  })
})
