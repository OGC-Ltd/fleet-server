/**
 * The movement report end to end over mocked records shaped like the
 * operator's sheet: CPO tankers on the Mombasa road to MORL, some leaving it,
 * some parked at it, one that stopped reporting.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import fs from 'node:fs'

vi.mock('../../src/lib/prisma.js')
const snapshot = vi.hoisted(() => ({ rows: [] as unknown[] }))
vi.mock('../../src/modules/telemetry/fleet-snapshot.cache.js', () => ({ getFleetSnapshotCached: vi.fn(async () => snapshot.rows) }))
vi.mock('../../src/lib/geocode.js', () => ({
  cachedPlace: vi.fn((lat: number) => (lat > -3 ? 'Mombasa Road, Makueni, Kiboko' : 'Kismayu Road, Mombasa, Makupa')),
  reverseGeocode: vi.fn(async () => null),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { getMovementReport, editedMovementReport, countRows, type MovementReport } from '../../src/modules/reports/movement-report.service.js'
import { editedMovementReportSchema } from '../../src/modules/reports/report.schema.js'
import { renderMovementReportPdf, movementReportNo, movementFileName, DIRECTION, isMoving, isLoading, locationFill, AT_MORL_FILL, MOVING_FILL, LOADING_FILL } from '../../src/modules/reports/movement-report.pdf.js'

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

  it('gives every row a status in the Direction column, never a blank', () => {
    expect(Object.values(DIRECTION).every(Boolean)).toBe(true)
    expect(DIRECTION).toMatchObject({ to: 'To MORL', from: 'From MORL', at: 'At MORL', moving: 'Moving', stopped: 'Stopped' })
  })

  it('prints the location of a moving unit green: 5 km/h or more on a fix inside the window', () => {
    const byPlate = Object.fromEntries(report.groups.flatMap(g => g.rows).map(r => [r.plate, r]))
    expect(isMoving(byPlate['KCV 039A']!)).toBe(true)
    expect(isMoving(byPlate['KCN 914F']!)).toBe(true)
    expect(isMoving(byPlate['KCT 510W']!)).toBe(false)
    expect(isMoving({ ...byPlate['KCV 039A']!, stale: true })).toBe(false)
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

describe('the movement report as edited on the Reports page', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.organisation.findUnique as any).mockResolvedValue({ name: 'Menengai Oil Refineries Ltd', code: 'MENENGAI' })
  })

  const EDITS = { changed: 1, removed: 1 }
  const request = (r: MovementReport) => ({ ...JSON.parse(JSON.stringify(r)), edits: EDITS })

  it('round-trips through the request schema as the server answered it', () => {
    expect(editedMovementReportSchema.safeParse(request(report)).success).toBe(true)
  })

  it('counts the overview again from the rows kept, and drops a group left empty', async () => {
    const cpo = report.groups[0]!
    const edited = {
      ...report,
      organisation: 'Someone Else Ltd',
      groups: [
        { ...cpo, rows: cpo.rows.filter(r => r.plate !== 'KCN 910F').map(r => (r.plate === 'KCT 510W' ? { ...r, state: 'to' as const } : r)) },
        { name: 'FG - Menengai', rows: [] },
      ],
      edits: EDITS,
    }
    const out = await editedMovementReport('org1', edited, 'Jane Operator')
    expect(out.organisation).toBe('Menengai Oil Refineries Ltd')
    expect(out.groups.map(g => g.name)).toEqual(['CPO - Menengai'])
    expect(out.counts).toEqual(countRows(out.groups))
    expect(out.counts).toMatchObject({ total: 6, to: 4, stopped: 0, stale: 0 })
  })

  it('prints the location the operator typed, at MORL included', async () => {
    const at = report.groups[0]!.rows.find(r => r.state === 'at')!
    const edited = { ...report, groups: [{ name: 'CPO - Menengai', rows: [{ ...at, location: 'MORL gate 2, offloading' }] }], edits: EDITS }
    const buf = await renderMovementReportPdf(await editedMovementReport('org1', edited, 'Jane Operator'))
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pages(buf)).toBe(1)
  })

  it('refuses a request that is not a movement report', () => {
    expect(editedMovementReportSchema.safeParse({ ...request(report), hours: 3 }).success).toBe(false)
    expect(editedMovementReportSchema.safeParse({ ...request(report), groups: [{ name: 'x', rows: [{ plate: 'K' }] }] }).success).toBe(false)
    expect(editedMovementReportSchema.safeParse({ ...request(report), edits: undefined }).success).toBe(false)
  })

  it('says who edited it and how much, from the session rather than the request', async () => {
    const out = await editedMovementReport('org1', { ...report, edits: { changed: 3, removed: 2 } }, 'Jane Operator', 1_000)
    expect(out.edited).toEqual({ by: 'Jane Operator', at: 1_000, changed: 3, removed: 2 })
    const buf = await renderMovementReportPdf(out)
    if (process.env.OUT3) fs.writeFileSync(process.env.OUT3, buf)
    expect(pages(buf)).toBe(1)
    expect((await getMovementReport('org1', 2)).edited).toBeUndefined()
  })

  it('refuses a window it did not answer: old, in the future, or not the hours asked for', () => {
    const shift = (ms: number) => ({ ...request(report), from: report.from + ms, to: report.to + ms })
    expect(editedMovementReportSchema.safeParse(shift(-25 * 3_600_000)).success).toBe(false)
    expect(editedMovementReportSchema.safeParse(shift(2 * 3_600_000)).success).toBe(false)
    expect(editedMovementReportSchema.safeParse(shift(-3 * 3_600_000)).success).toBe(true)
    expect(editedMovementReportSchema.safeParse({ ...request(report), from: report.to - 4 * 3_600_000 }).success).toBe(false)
  })

  it('reads a fresh fix within 1 km of the Mombasa loading point as loading', () => {
    const fast = report.groups[0]!.rows.find(r => r.plate === 'KCV 039A')!
    expect(isLoading({ ...fast, lat: -4.0535, lng: 39.65165 })).toBe(true)
    expect(isLoading({ ...fast, lat: -4.0558, lng: 39.65165 })).toBe(false)
    expect(isLoading({ ...fast, lat: -4.04579, lng: 39.65165, stale: true })).toBe(false)
  })

  it('fills a unit at MORL yellow, stale or not; Mombasa orange; moving green', () => {
    const fast = report.groups[0]!.rows.find(r => r.plate === 'KCV 039A')!
    expect(locationFill({ ...fast, state: 'at' })).toBe(AT_MORL_FILL)
    expect(locationFill({ ...fast, state: 'at', stale: true, speedKmh: 0 })).toBe(AT_MORL_FILL)
    expect(locationFill({ ...fast, lat: -4.04579, lng: 39.65165 })).toBe(LOADING_FILL)
    expect(locationFill(fast)).toBe(MOVING_FILL)
  })

  it('does not print green a unit the operator set to Stopped', () => {
    const fast = report.groups[0]!.rows.find(r => r.plate === 'KCV 039A')!
    expect(isMoving(fast)).toBe(true)
    expect(isMoving({ ...fast, state: 'stopped' })).toBe(false)
    expect(isMoving({ ...fast, state: 'no-fix' })).toBe(false)
  })
})
