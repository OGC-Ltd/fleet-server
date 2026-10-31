/**
 * The trip report drawn as a PDF on the server, the layout the dashboard used
 * to draw in the browser.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { buildTripReport } from '../../src/modules/trips/trip-report.build.js'
import { renderTripReportPdf, reportFileName } from '../../src/modules/trips/trip-report.pdf.js'
import { lon2x, lat2y } from '../../src/modules/usage-review/usage-review.pdf.js'
const T0 = Date.parse('2026-10-28T05:00:00Z'), MIN = 60_000
const yard = { lat: -0.8234, lng: 34.3845, name: 'Ndhiwa' }
const dest = { lat: -0.7234, lng: 34.3845, name: 'NYAONDO', spreadM: 300 }
function data(mode: 'trip' | 'day', withMap: boolean) {
  const pts: any[] = []; let t = T0, lat = yard.lat
  const push = (s: number, ig = 1) => pts.push([t, lat, yard.lng + Math.sin(lat * 400) * 0.01, s, ig])
  for (let i = 0; i < 30; i++) { push(40); lat += 0.0015; t += 2 * MIN }
  for (let i = 0; i < 10; i++) { push(0, 0); t += 2 * MIN }
  for (let i = 0; i < 25; i++) { push(45); lat += 0.0022; t += 2 * MIN }
  lat = dest.lat; for (let i = 0; i < 21; i++) { push(0, 1); t += 2 * MIN }
  let map = null
  if (withMap) {
    const z = 12, png = fs.readFileSync('assets/report/ogc-logo.png').toString('base64')
    const cx = lon2x(yard.lng, z), cy = (lat2y(yard.lat, z) + lat2y(dest.lat, z)) / 2
    const x0 = cx - 320, y0 = cy - 160, tiles: any[] = []
    for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + 320) / 256); ty++)
      for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + 640) / 256); tx++) tiles.push({ x: tx, y: ty, src: `data:image/png;base64,${png}` })
    map = { z, x0, y0, w: 640, h: 320, tiles, attribution: '© OpenStreetMap contributors' }
  }
  const day = mode === 'day'
  return {
    mode, generatedAt: T0 + 360 * MIN, companyName: 'SUKARI INDUSTRIES', vehicle: { id: 'v', plate: 'KCP 145P', type: 'TRACTOR' },
    dispatch: day ? { externalId: null, serialNumber: null, kind: null, status: null, driverName: 'Joel Kibet', destination: null, dispatchedAt: T0, returnedAt: null, tonnageT: null, bags: null, cargoName: null }
      : { externalId: 'd-1', serialNumber: 'S-4471', kind: 'SALES', status: 'DISPATCHED', driverName: 'Joel Kibet', destination: 'NYAONDO', dispatchedAt: T0, returnedAt: null, tonnageT: 29, bags: 580, cargoName: 'Processed Sugar' },
    fromName: null, toName: null, window: { from: T0, to: pts.at(-1)[0], clipped: false }, day: {}, yard: day ? null : yard, dest: day ? null : dest, arrivedAt: day ? null : T0 + 140 * MIN,
    track: pts, legTrack: [], map, altitude: pts.map((p: any, i: number) => [p[0], 1500 + Math.sin(i / 8) * 40 + i]),
    fuel: { hasProbe: true, series: pts.map((p: any, i: number) => [p[0], 200 - i * 0.25 - (i > 35 ? 12 : 0)]), usedByCounterL: null, fillings: [{ t: T0 + 20 * MIN, litres: 40, after: 230, place: 'Ndhiwa depot' }], drains: [{ t: T0 + 70 * MIN, litres: 12, after: 180, place: null, review: null }] },
    dashcam: { fitted: true, complete: false, alarms: [] },
    speeding: [{ t: T0 + 10 * MIN, durationSec: 120, distanceM: 1900, peakKmh: 62, limitKmh: 40, lat: null, lng: null }],
    escalatedThefts: [], harsh: [{ t: T0 + 100 * MIN, type: 'brake', lat: null, lng: null, speedKmh: 38 }],
    zones: { timedOut: false, visits: [{ name: 'Awendo restricted belt', enteredAt: T0 + 60 * MIN, leftAt: T0 + 90 * MIN, enforced: true }] },
    weighments: [{ ticket: '1000906522', tokenAt: T0 - 60 * MIN, netKg: 29040, cargo: 'Sugar', weighings: [
      { kind: 'Tare', kg: 10440, at: T0 - 50 * MIN, bridge: 'NDHIWA · bridge 1', doubtful: false },
      { kind: 'Gross', kg: 39480, at: T0 - 20 * MIN, bridge: 'NDHIWA · bridge 1', doubtful: false }] }],
  } as any
}

/** Pages in a pdfkit file: one `/Type /Page` object each. */
const pages = (buf: Buffer) => (buf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length

describe('the trip report PDF (trips/trip-report.pdf)', () => {
  it('draws a whole trip on one A4 page, the route on plain white even when tiles were sent', async () => {
    const buf = await renderTripReportPdf(buildTripReport(data('trip', true)))
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pages(buf)).toBe(1)
  })

  it('draws a whole day on one page too, without a destination', async () => {
    const buf = await renderTripReportPdf(buildTripReport(data('day', false)))
    expect(pages(buf)).toBe(1)
  })

  it('continues on a second page rather than shrinking the type, when a trip has a lot in it', async () => {
    const d = data('trip', false)
    const T0 = d.window.from
    d.zones.visits = Array.from({ length: 30 }, (_, i) => ({ name: `Zone ${i}`, enteredAt: T0 + (5 + i * 3) * 60_000, leftAt: T0 + (6 + i * 3) * 60_000, enforced: false }))
    d.harsh = Array.from({ length: 20 }, (_, i) => ({ t: T0 + (3 + i * 5) * 60_000, type: 'brake', lat: null, lng: null, speedKmh: 30 }))
    const buf = await renderTripReportPdf(buildTripReport(d))
    expect(pages(buf)).toBe(2)
  })

  it('names the file after the plate, the day and the departure', () => {
    expect(reportFileName(buildTripReport(data('trip', false)))).toBe('Trip report KCP 145P 2026-10-28 0800.pdf')
    expect(reportFileName(buildTripReport(data('day', false)))).toBe('Day report KCP 145P 2026-10-28.pdf')
  })
})
