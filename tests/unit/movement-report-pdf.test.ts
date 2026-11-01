/**
 * The movement report end to end over mocked records shaped like the
 * operator's sheet: CPO tankers on the Mombasa road to MORL, some leaving it,
 * some parked at it, one that stopped reporting.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import fs from 'node:fs'

vi.mock('../../src/lib/prisma.js')
const snapshot = vi.hoisted(() => ({ rows: [] as unknown[] }))
vi.mock('../../src/modules/telemetry/fleet-snapshot.cache.js', () => ({ getFleetSnapshotCached: vi.fn(async () => snapshot.rows) }))
vi.mock('../../src/lib/geocode.js', () => ({
  cachedPlace: vi.fn((lat: number) => (lat > -3 ? 'Mombasa Road, Makueni, Kiboko' : 'Kismayu Road, Mombasa, Makupa')),
  reverseGeocode: vi.fn(async () => null),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { getMovementReport, type MovementReport } from '../../src/modules/reports/movement-report.service.js'
import { renderMovementReportPdf, movementReportNo, movementFileName } from '../../src/modules/reports/movement-report.pdf.js'

const NOW = Date.now()
const MORL = { lat: -4.05, lng: 39.65 }
const unit = (plate: string, name: string, lat: number, speed: number, minsAgo = 1) => ({
  vehicleId: plate.replace(/\s/g, ''), plate, name, lat, lng: 39.65, speedKmh: speed,
  capturedAt: new Date(NOW - minsAgo * 60_000).toISOString(),
})
const pages = (buf: Buffer) => (buf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length

let report: MovementReport
beforeAll(async () => {
  snapshot.rows = [
    unit('KCV 039A', 'CPO - Menengai - KCV 039A', -2.30, 62),   // on the road, was further: to MORL
    unit('KCV 044A', 'CPO - Menengai - KCV 044A', -2.35, 61),
    unit('KCN 912F', 'CPO - Menengai KCN 912F', -2.40, 43),
    unit('KCN 914F', 'CPO - Menengai - KCN 914F', -4.00, 9),     // just left MORL
    unit('KCT 510W', 'CPO - Menengai - KCT 510W', -3.20, 0),     // parked on the road
    unit('KCF 180A', 'CPO - Menengai - KCF 180A', MORL.lat, 0),   // at MORL
    unit('KCN 910F', 'CPO - Menengai - KCN 910F', MORL.lat, 0, 60 * 23),  // at MORL, silent for a day
    unit('KCA 227M', 'FG - Menengai - KCA 227M', -0.28, 0),      // another grouping
  ]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.organisation.findUnique as any).mockResolvedValue({ name: 'Menengai Oil Refineries Ltd', code: 'MENENGAI' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.geofence.findMany as any).mockResolvedValue([
    { name: 'MORL Farm', type: 'CIRCLE', centerLat: -0.1989, centerLng: 35.8661, radiusM: 2000, polygonCoords: null, widthM: null },
    { name: 'MORL', type: 'CIRCLE', centerLat: MORL.lat, centerLng: MORL.lng, radiusM: 800, polygonCoords: null, widthM: null },
  ])
  // Where each unit was when the window began.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.$queryRaw as any).mockResolvedValue([
    { vehicle_id: 'KCV039A', lat: -1.90, lng: 39.65 }, { vehicle_id: 'KCV044A', lat: -1.95, lng: 39.65 },
    { vehicle_id: 'KCN912F', lat: -2.10, lng: 39.65 }, { vehicle_id: 'KCN914F', lat: -4.04, lng: 39.65 },
    { vehicle_id: 'KCT510W', lat: -3.20, lng: 39.65 }, { vehicle_id: 'KCF180A', lat: -4.05, lng: 39.65 },
  ])
  report = await getMovementReport('org1', 2)
})

describe('the movement report', () => {
  it('reads each unit against the MORL fence, not MORL Farm', () => {
    expect(report.morl).toBe('MORL')
    const cpo = report.groups[0]!
    expect(cpo.name).toBe('CPO - Menengai')
    const byPlate = Object.fromEntries(cpo.rows.map(r => [r.plate, r]))
    expect(byPlate['KCV 039A']!.state).toBe('to')
    expect(byPlate['KCN 914F']!.state).toBe('from')
    expect(byPlate['KCT 510W']!.state).toBe('stopped')
    expect(byPlate['KCF 180A']).toMatchObject({ state: 'at', location: 'MORL' })
  })

  it('flags a unit that has not reported in the window', () => {
    const silent = report.groups[0]!.rows.find(r => r.plate === 'KCN 910F')!
    expect(silent.stale).toBe(true)
    expect(report.counts.stale).toBe(1)
  })

  it('orders a group to MORL first, fastest first, then leaving, stopped and at MORL', () => {
    expect(report.groups[0]!.rows.map(r => r.state)).toEqual(['to', 'to', 'to', 'from', 'stopped', 'at', 'at'])
    expect(report.groups[0]!.rows[0]!.speedKmh).toBe(62)
  })

  it('puts CPO before the other groupings', () => {
    expect(report.groups.map(g => g.name)).toEqual(['CPO - Menengai', 'FG - Menengai'])
  })

  it('draws the report, and names it for the fleet and the window', async () => {
    const buf = await renderMovementReportPdf(report)
    if (process.env.OUT) fs.writeFileSync(process.env.OUT, buf)
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pages(buf)).toBe(1)
    expect(movementReportNo(report)).toMatch(/^MV-MENENGAI-\d{8}-\d{4}$/)
    expect(movementFileName(report)).toMatch(/^Movement Report Menengai Oil Refineries Ltd \d{8}-\d{4} last 2 hours\.pdf$/)
  })

  it('runs onto a second page under the running head when the fleet is long', async () => {
    const long = { ...report, groups: [{ name: 'CPO - Menengai', rows: Array.from({ length: 80 }, (_, i) => ({ ...report.groups[0]!.rows[i % 7]!, plate: `K${i}` })) }] }
    const buf = await renderMovementReportPdf(long)
    if (process.env.OUT2) fs.writeFileSync(process.env.OUT2, buf)
    expect(pages(buf)).toBe(2)
  })

  it('takes only the units a scoped caller may see', async () => {
    const scoped = await getMovementReport('org1', 4, new Set(['KCV039A']))
    expect(scoped.counts.total).toBe(1)
    expect(scoped.hours).toBe(4)
  })
})
