/** The Dormant Assets, Geofence and TAT and Fuel PDFs the server draws from the page's rows. */
import { describe, it, expect } from 'vitest'
import {
  renderDormantPdf, renderGeofencePdf, renderTatFuelPdf, renderSpeedPdf, dormantFileName, geofenceFileName, tatFileName, speedFileName, speedCells, speedSummary, peakLink, SPEED_HEADS,
  sectionDays, DORMANT_SECTIONS, stampWords, visitDuration, endsNow, tripWords, tatSummary, tatCells, TAT_HEADS, templateReportNo,
} from '../../src/modules/reports/template-report.pdf.js'
import { dormantPdfBodySchema, geofencePdfBodySchema, tatFuelPdfBodySchema, speedPdfBodySchema } from '../../src/modules/reports/report.schema.js'

const at = (s: string) => Date.parse(`${s}+03:00`)
const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-'
const pages = (b: Buffer) => (b.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length
const LONG_PLACE = 'Kakamega - Webuye Road, Lugari, Kakamega County, 3.42 km from the Kabras Sugar factory main gate, near Malava'

describe('Dormant Assets', () => {
  const NOW = at('2026-10-31T08:00:00')
  const row = (n: number) => ({ name: `WKS - Kabras - KBV ${100 + n}N`, lastAt: at('2026-10-30T11:42:05'), location: LONG_PLACE })
  const body = dormantPdfBodySchema.parse({
    fleet: 'West Kenya', now: NOW, total: 500, never: 1,
    sections: { yesterday: Array.from({ length: 120 }, (_, i) => row(i)), two: [row(1)], over: [] },
  })

  it('names the days each section covers', () => {
    expect(DORMANT_SECTIONS.map(s => sectionDays(s, NOW))).toEqual(['30/10/2026', '28/10/2026 – 29/10/2026', '27/10/2026 and earlier'])
  })
  it('runs onto more pages, upright or on its side', async () => {
    const up = await renderDormantPdf(body, { orgCode: 'KABRAS' })
    expect(isPdf(up)).toBe(true)
    expect(pages(up)).toBeGreaterThan(1)
    expect(isPdf(await renderDormantPdf(body, { orgCode: 'KABRAS', landscape: true }))).toBe(true)
  })
  it('draws with every section empty', async () => {
    const empty = dormantPdfBodySchema.parse({ fleet: 'Kabras Sugar', now: NOW, total: 109, sections: { yesterday: [], two: [], over: [] } })
    expect(pages(await renderDormantPdf(empty, { orgCode: 'KABRAS' }))).toBe(1)
  })
  it('is named for the fleet and the day', () => {
    expect(dormantFileName(body)).toBe('Dormant Assets Report West Kenya 2026-10-31.pdf')
  })
})

describe('Geofences', () => {
  const from = at('2026-10-30T00:00:00'), to = at('2026-10-31T00:00:00')
  const visit = { vehicle: 'WKS - Kabras - KCS 650G', vehicleId: 'a', place: 'Magut', in: at('2026-10-30T11:08:11'), out: at('2026-10-30T13:10:42'), open: false }

  it('writes a visit as the sheet does', () => {
    expect(stampWords(visit.in)).toBe('2026-10-30 11:08:11')
    expect(visitDuration(visit.out - visit.in)).toBe('2:02:31')
    expect(visitDuration(26 * 3600_000)).toBe('26:00:00')
  })
  it('says a period ending now is still running', () => {
    expect(endsNow(to, to + 60_000)).toBe(true)
    expect(endsNow(to, to + 3600_000)).toBe(false)
  })
  it('calls a period ending at midnight that one day', () => {
    expect(geofenceFileName({ fleet: 'West Kenya', from, to })).toBe('Geofence Report West Kenya 2026-10-30.pdf')
    expect(geofenceFileName({ fleet: 'West Kenya', from, to: to + 86_400_000 })).toBe('Geofence Report West Kenya 2026-10-30 to 2026-10-31.pdf')
  })
  it('draws rows, and nothing at all', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ ...visit, vehicleId: String(i), place: i % 9 ? 'Magut' : LONG_PLACE }))
    const full = await renderGeofencePdf(geofencePdfBodySchema.parse({ fleet: 'West Kenya', from, to, rows, places: 3 }), { orgCode: 'WESTSU', now: to })
    expect(pages(full)).toBeGreaterThan(1)
    const none = await renderGeofencePdf(geofencePdfBodySchema.parse({ fleet: 'West Kenya', from, to, rows: [] }), { orgCode: 'WESTSU', now: to + 3600_000 })
    expect(pages(none)).toBe(1)
  })
  it('turns away more rows than it draws', () => {
    expect(geofencePdfBodySchema.safeParse({ fleet: 'W', from, to, rows: Array(60_001).fill(visit) }).success).toBe(false)
  })
})

describe('TAT and Fuel', () => {
  const fuel = { initial: 100, topUps: 50, total: 150, consumption: 40, theft: 0, final: 110 }
  const trip = {
    vehicleId: 'a', plate: 'KDL 489D', group: 'Trucks', dispatchedAt: at('2026-11-03T06:00:00'), leftAt: at('2026-11-03T06:20:00'),
    returnedAt: at('2026-11-03T18:41:00'), station: 'Magut', fuel, km: 200, rate: 5, tankL: 300, comment: 'PROBE OK', base: 'Kabras',
  }
  const idle = { ...trip, vehicleId: 'b', plate: 'KTCC 782L', group: 'Tractors', dispatchedAt: null, leftAt: null, returnedAt: null, station: null, fuel: null, km: null, rate: null, tankL: null, comment: 'NO TRIP' }
  const body = tatFuelPdfBodySchema.parse({ fleet: 'Sukari Industries', day: '2026-11-03', rows: [trip, idle] })

  it('writes a trip as the sheet does', () => {
    expect(tripWords(trip)).toBe('3 Nov 06:20 to 3 Nov 18:41 (12 h 21 min)')
    expect(tripWords({ dispatchedAt: at('2026-11-03T06:00:00'), leftAt: null, returnedAt: null })).toBe('Dispatched 3 Nov 06:00')
    expect(tripWords({ dispatchedAt: null, leftAt: null, returnedAt: null })).toBe('')
  })
  it('counts the rate only from trips whose probe reads true', () => {
    const s = tatSummary(body.rows.concat({ ...trip, plate: 'X', comment: 'PROBE ISSUE', km: 999, fuel: { ...fuel, consumption: 1 } }))
    expect(s).toMatchObject({ trips: 2, litres: 40, km: 200, rate: 5, notUpdating: 0 })
  })
  it('fills every column', () => {
    expect(tatCells(body.rows[0]!)).toHaveLength(TAT_HEADS.length)
    expect(tatCells(body.rows[1]!)[8]).toBe('–')
  })
  it('draws, under the day and the fleet', async () => {
    expect(isPdf(await renderTatFuelPdf(body, { orgCode: 'SUKARI' }))).toBe(true)
    expect(tatFileName(body)).toBe('TAT and Fuel Report Sukari Industries 2026-11-03.pdf')
    expect(templateReportNo('TF', 'SUKARI', at('2026-11-04T08:00:00'))).toBe('TF-SUKARI-20261104-0800')
  })
})

describe('Speed Report', () => {
  const row = { vehicleId: 'a', name: 'WKS - Kabras - KDL 489D', group: 'Trucks', km: 212.456, maxKmh: 96.4, limitKmh: 80, overByKmh: 16.4, overKm: 3.218, occurrences: 4, peak: { lat: 0.42, lng: 34.8 } }
  const body = speedPdfBodySchema.parse({ fleet: 'West Kenya', day: '2026-10-30', rows: [row, { ...row, name: 'KTCC 782L', group: 'Tractors', peak: null }] })

  it('writes a row as the sheet does', () => {
    expect(speedCells(body.rows[0]!)).toEqual(['WKS - Kabras - KDL 489D', 'Trucks', '212.46', '96 km/h', '80 km/h', '+16 km/h', '3.22', '4'])
    expect(speedCells(body.rows[0]!)).toHaveLength(SPEED_HEADS.length)
  })
  it('links the peak to the map, when it has a fix', () => {
    expect(peakLink(body.rows[0]!)).toBe('https://www.google.com/maps?q=0.42,34.8')
    expect(peakLink(body.rows[1]!)).toBeUndefined()
  })
  it('adds up the rows', () => {
    expect(speedSummary(body.rows)).toMatchObject({ units: 2, occurrences: 8, fastest: 96.4 })
  })
  it('draws, upright or on its side, under the day and the fleet', async () => {
    expect(isPdf(await renderSpeedPdf(body, { orgCode: 'WESTSU' }))).toBe(true)
    expect(isPdf(await renderSpeedPdf(body, { orgCode: 'WESTSU', landscape: true }))).toBe(true)
    expect(pages(await renderSpeedPdf({ ...body, rows: [] }, { orgCode: 'WESTSU' }))).toBe(1)
    expect(speedFileName(body)).toBe('Speed Report West Kenya 2026-10-30.pdf')
  })
})
