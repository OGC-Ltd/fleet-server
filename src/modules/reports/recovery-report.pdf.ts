import PDFDocument from 'pdfkit'
import { MM, SIDE, C, F, DASH, num, drawLetterhead, ReportWriter, sheetOf } from '../../lib/pdf/letterhead.js'
import type { getRecoveryVehicleReport } from './recovery-report.service.js'

type RecoveryReport = Awaited<ReturnType<typeof getRecoveryVehicleReport>>
type RecoveryVehicle = RecoveryReport['vehicles'][number]
type Doc = InstanceType<typeof PDFDocument>

const TZ = 'Africa/Nairobi'
const dayLabel = (day: string) => new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, day: '2-digit', month: 'long', year: 'numeric',
}).format(new Date(`${day}T00:00:00+03:00`))
const timeLabel = (ms: number) => new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
}).format(ms)
const durationLabel = (ms: number) => {
  const minutes = Math.round(ms / 60_000)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

function drawRoute(doc: Doc, vehicle: RecoveryVehicle, y: number, width: number, height: number) {
  const x = SIDE
  doc.save().rect(x, y, width, height).lineWidth(0.6).strokeColor(C.rule).stroke().restore()
  const points = vehicle.route
  if (!points.length) return

  const pad = 12 * MM
  const lngs = points.map(p => p[1])
  const lats = points.map(p => p[0])
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs)
  const minLat = Math.min(...lats), maxLat = Math.max(...lats)
  const spanLng = Math.max(maxLng - minLng, 0.00001)
  const spanLat = Math.max(maxLat - minLat, 0.00001)
  const scale = Math.min((width - 2 * pad) / spanLng, (height - 2 * pad) / spanLat)
  const midLng = (minLng + maxLng) / 2, midLat = (minLat + maxLat) / 2
  const xy = ([lat, lng]: [number, number]) => [
    x + width / 2 + (lng - midLng) * scale,
    y + height / 2 - (lat - midLat) * scale,
  ] as const

  doc.save().lineWidth(2).lineCap('round').lineJoin('round').strokeColor(C.route)
  points.forEach((point, index) => {
    const [px, py] = xy(point)
    if (index === 0) doc.moveTo(px, py)
    else doc.lineTo(px, py)
  })
  doc.stroke().restore()
  for (const [point, color] of [[points[0]!, C.good], [points[points.length - 1]!, C.flag]] as const) {
    const [px, py] = xy(point)
    doc.save().circle(px, py, 3.2).fill(color).restore()
  }
}

export const recoveryReportFileName = (day: string) => `Recovery Vehicle Report ${day}.pdf`

export async function renderRecoveryReportPdf(report: RecoveryReport): Promise<Buffer> {
  const title = `Daily Recovery Vehicle Report — ${report.day}`
  const sheet = sheetOf()
  const doc = new PDFDocument({
    size: 'A4', margin: 0, bufferPages: true,
    info: { Title: title, Author: 'Off-Grid Consulting Ltd.' },
  })
  const chunks: Buffer[] = []
  doc.on('data', (chunk: Buffer) => chunks.push(chunk))
  const done = new Promise<Buffer>(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))))
  const w = new ReportWriter(doc, sheet)
  w.y = drawLetterhead(doc, sheet)
  w.line('DAILY RECOVERY VEHICLE REPORT', SIDE, w.y, sheet.body * 0.65, { font: F.bold, size: 15 })
  w.line(dayLabel(report.day), SIDE + sheet.body * 0.65, w.y + 4, sheet.body * 0.35, { size: 9, color: C.mut, align: 'right' })
  w.y += 21
  w.hr(SIDE, SIDE + sheet.body, w.y, C.ink, 1)
  w.y += 2 * MM
  w.note('Daily distance and stops are measured from GPS fixes. Fuel used is taken from the vehicle fuel counter or probe when available. The route sketch joins recorded GPS positions; it is not a road map.')
  w.runningHead = { title: 'Daily Recovery Vehicle Report', right: report.day }

  for (const [index, vehicle] of report.vehicles.entries()) {
    if (index > 0) w.newPage()
    w.h2(`${vehicle.plate} · ${vehicle.recoveryType} recovery`)
    if (!vehicle.available) {
      w.none('Vehicle unavailable in this organisation or within your vehicle scope.')
      continue
    }

    w.cells([
      ['Distance covered', vehicle.distanceKm == null ? DASH : `${num(vehicle.distanceKm, 1)} km`],
      ['Fuel consumed', vehicle.fuelConsumedL == null ? DASH : `${num(vehicle.fuelConsumedL, 1)} L`],
      ['Stops over 5 min', vehicle.stopsTotal == null ? DASH : num(vehicle.stopsTotal)],
    ])
    if (!vehicle.hasTelemetry) {
      w.none('No GPS telemetry was recorded for this vehicle on the selected day.')
      continue
    }

    w.y += 2 * MM
    w.h2('Recorded route', 'GPS trace · start to end')
    const routeHeight = 75 * MM
    w.room(routeHeight + 20)
    drawRoute(doc, vehicle, w.y, sheet.body, routeHeight)
    w.y += routeHeight + 2
    const start = vehicle.route[0]
    const end = vehicle.route[vehicle.route.length - 1]
    if (start && end) {
      w.line(`Start: ${start[0].toFixed(5)}, ${start[1].toFixed(5)}`, SIDE, w.y, sheet.body / 2, { size: 7.5, color: C.mut })
      w.line(`End: ${end[0].toFixed(5)}, ${end[1].toFixed(5)}`, SIDE + sheet.body / 2, w.y, sheet.body / 2, { size: 7.5, color: C.mut, align: 'right' })
      w.y += 12
    }

    w.h2('Stops', vehicle.stopsTotal != null && vehicle.stopsTotal > vehicle.stops.length
      ? `Showing ${vehicle.stops.length} longest of ${vehicle.stopsTotal}`
      : undefined)
    if (!vehicle.stops.length) {
      w.none('No stops over 5 minutes.')
      continue
    }
    w.table(
      [{ w: 12 * MM }, { w: 0, wrap: true }, { w: 18 * MM }, { w: 18 * MM }, { w: 20 * MM }, { w: 25 * MM, wrap: true }],
      ['#', 'Location', 'Arrived', 'Left', 'Duration', 'Remark'],
      vehicle.stops.map((stop, i) => [
        { text: String(i + 1) },
        { text: stop.location ?? (stop.lat != null && stop.lng != null ? `${stop.lat.toFixed(4)}, ${stop.lng.toFixed(4)}` : DASH) },
        { text: timeLabel(stop.arrivedAt) },
        { text: timeLabel(stop.leftAt) },
        { text: durationLabel(stop.durationMs) },
        { text: stop.remark },
      ]),
      { size: 7.5 },
    )
  }

  w.footers(`Daily Recovery Vehicle Report · ${report.day} · Generated ${new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, dateStyle: 'short', timeStyle: 'short',
  }).format(report.generatedAt)}`)
  doc.end()
  return done
}
