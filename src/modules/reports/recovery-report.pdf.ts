import PDFDocument from 'pdfkit'
import { MM, SIDE, C, F, DASH, num, drawLetterhead, ReportWriter, sheetOf } from '../../lib/pdf/letterhead.js'
import { lat2y, lon2x, tile as loadOsmTile } from '../usage-review/usage-review.pdf.js'
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

const TILE_SIZE = 256
const MAP_SCALE = 0.55
const MAX_MAP_TILES = 48
const MAX_MAP_ZOOM = 15
const MIN_MAP_ZOOM = 3

interface RecoveryMap {
  z: number
  x0: number
  y0: number
  scale: number
  tiles: { x: number; y: number; image: Buffer | null }[]
}

async function prepareRecoveryMap(
  route: RecoveryVehicle['route'], width: number, height: number,
): Promise<RecoveryMap | null> {
  if (!route.length) return null

  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity
  for (const [lat, lng] of route) {
    minLng = Math.min(minLng, lng)
    maxLng = Math.max(maxLng, lng)
    minLat = Math.min(minLat, lat)
    maxLat = Math.max(maxLat, lat)
  }
  const pixelWidth = width / MAP_SCALE, pixelHeight = height / MAP_SCALE
  let z = MAX_MAP_ZOOM
  for (; z > MIN_MAP_ZOOM; z--) {
    const dx = lon2x(maxLng, z) - lon2x(minLng, z)
    const dy = lat2y(minLat, z) - lat2y(maxLat, z)
    if (dx <= pixelWidth * 0.84 && dy <= pixelHeight * 0.84) break
  }

  const centerX = (lon2x(minLng, z) + lon2x(maxLng, z)) / 2
  const centerY = (lat2y(maxLat, z) + lat2y(minLat, z)) / 2
  const x0 = centerX - pixelWidth / 2, y0 = centerY - pixelHeight / 2
  const worldTiles = 2 ** z
  const tiles: RecoveryMap['tiles'] = []
  for (let tileY = Math.floor(y0 / TILE_SIZE); tileY <= Math.floor((y0 + pixelHeight) / TILE_SIZE); tileY++) {
    if (tileY < 0 || tileY >= worldTiles) continue
    for (let tileX = Math.floor(x0 / TILE_SIZE); tileX <= Math.floor((x0 + pixelWidth) / TILE_SIZE); tileX++) {
      tiles.push({ x: tileX, y: tileY, image: null })
    }
  }
  if (tiles.length <= MAX_MAP_TILES) {
    for (let index = 0; index < tiles.length; index += 6) {
      await Promise.all(tiles.slice(index, index + 6).map(async (item) => {
        const wrappedX = ((item.x % worldTiles) + worldTiles) % worldTiles
        item.image = await loadOsmTile(z, wrappedX, item.y)
      }))
    }
  } else {
    tiles.length = 0
  }
  return { z, x0, y0, scale: MAP_SCALE, tiles }
}

function drawRoute(
  doc: Doc, vehicle: RecoveryVehicle, map: RecoveryMap | null,
  y: number, width: number, height: number,
) {
  const x = SIDE
  doc.save().rect(x, y, width, height).clip()
  doc.rect(x, y, width, height).fill(C.shade)
  if (map) {
    const tileSize = TILE_SIZE * map.scale
    for (const tile of map.tiles) {
      if (!tile.image) continue
      try {
        doc.image(tile.image, x + (tile.x * TILE_SIZE - map.x0) * map.scale,
          y + (tile.y * TILE_SIZE - map.y0) * map.scale, { width: tileSize, height: tileSize })
      } catch {
        // Skip an unreadable tile; the route remains available over the plain ground.
      }
    }
  }
  doc.restore()
  doc.save().rect(x, y, width, height).lineWidth(0.6).strokeColor(C.rule).stroke().restore()
  const points = vehicle.route
  if (!points.length) return

  const xy = ([lat, lng]: [number, number]) => map
    ? [x + (lon2x(lng, map.z) - map.x0) * map.scale, y + (lat2y(lat, map.z) - map.y0) * map.scale] as const
    : [x + width / 2, y + height / 2] as const

  doc.save().lineWidth(2.2).lineCap('round').lineJoin('round').strokeColor('#111111')
  points.forEach((point, index) => {
    const [px, py] = xy(point)
    if (index === 0) doc.moveTo(px, py)
    else doc.lineTo(px, py)
  })
  doc.stroke().restore()
  for (const [point, fill] of [[points[0]!, '#ffffff'], [points[points.length - 1]!, '#111111']] as const) {
    const [px, py] = xy(point)
    doc.save().circle(px, py, 3.4).fill(fill).lineWidth(1.2).strokeColor('#111111').stroke().restore()
  }
  doc.save().rect(x + width - 95, y + height - 12, 91, 9).fillOpacity(0.88).fill('#ffffff').fillOpacity(1).restore()
  doc.font(F.reg).fontSize(5.5).fillColor('#111111')
    .text('© OpenStreetMap contributors', x + width - 92, y + height - 10, { lineBreak: false })
}

export const recoveryReportFileName = (day: string, vehicle?: string) =>
  `Recovery Vehicle Report${vehicle ? ` ${vehicle}` : ''} ${day}.pdf`

export async function renderRecoveryReportPdf(report: RecoveryReport, landscape = false): Promise<Buffer> {
  const title = `Daily Recovery Vehicle Report — ${report.day}`
  const sheet = sheetOf(landscape)
  const doc = new PDFDocument({
    size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 0, bufferPages: true,
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
  w.note('Daily distance and stops are measured from GPS fixes. Fuel used is taken from the vehicle fuel counter or probe when available. The route follows recorded GPS positions over a grayscale OpenStreetMap background.')
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
    const routeMap = await prepareRecoveryMap(vehicle.route, sheet.body, routeHeight)
    drawRoute(doc, vehicle, routeMap, w.y, sheet.body, routeHeight)
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
