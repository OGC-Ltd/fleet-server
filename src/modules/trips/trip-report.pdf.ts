// The trip report on the RAI Group / OGC letterhead, as a PDF — the layout
// signed off on 28 Oct 2026 (plain document style, numbered sections, ruled
// tables), drawn with pdfkit on the server. It used to be laid out as HTML in
// the browser and photographed into a PDF there (new-ui lib/tripReportHtml);
// the sections, their order and their wording are the same.
//
// Pure drawing: takes what trip-report.build makes and returns the file. A
// trip that fits on one sheet gets one page. The browser shrank an overfull
// page to fit; here the remaining sections continue on a second page instead,
// so the type never drops below what prints legibly.

import PDFDocument from 'pdfkit'
import type { TripReport } from './trip-report.build.js'

import { MM, PAGE_W, PAGE_H, SIDE, BODY_W, FOOT_H, BOTTOM, C, F, DASH, num, drawLetterhead } from '../../lib/pdf/letterhead.js'

const TZ = 'Africa/Nairobi'
const fmtHM = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
const fmtDayHM = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
const fmtDate = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' })
const fmtDM = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const dayOf = new Intl.DateTimeFormat('en-CA', { timeZone: TZ })

export function dur(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return DASH
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h} h ${String(m % 60).padStart(2, '0')} min` : `${Math.floor(h / 24)} d ${h % 24} h`
}
const coords = (lat: number | null | undefined, lng: number | null | undefined) =>
  lat != null && lng != null ? `${lat.toFixed(4)}, ${lng.toFixed(4)}` : DASH
const placeOf = (x: { place?: string | null; lat?: number | null; lng?: number | null }) => x.place ?? coords(x.lat, x.lng)
const t2 = (kg: number | null | undefined) => (kg != null ? `${num(kg / 1000, 2)} t` : DASH)

/** The file name the browser saves it under. */
export function reportFileName(r: TripReport): string {
  const day = dayOf.format(r.window.from)
  const hm = r.mode === 'day' ? '' : ` ${fmtHM.format(r.window.from).replace(':', '')}`
  return `${r.mode === 'day' ? 'Day' : 'Trip'} report ${r.vehicle.plate} ${day}${hm}.pdf`
}

interface Col { w: number; align?: 'left' | 'right' | 'center' }
interface Cell { text: string; bold?: boolean; color?: string }

export async function renderTripReportPdf(r: TripReport): Promise<Buffer> {
  const day = r.mode === 'day'
  const w = r.window
  const multi = dayOf.format(w.from) !== dayOf.format(w.to)
  const T = (t: number | null | undefined) => (t == null ? DASH : (multi ? fmtDayHM : fmtHM).format(t))
  const S = r.summary
  const title = `${day ? 'Day' : 'Trip'} Report ${r.vehicle.plate} ${dayOf.format(w.from)}`

  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: title, Author: 'Off-Grid Consulting Ltd.' } })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>(res => doc.on('end', () => res(Buffer.concat(chunks))))

  // ── primitives ──

  /** `text` cut to `width` on one line, with an ellipsis when it had to be. */
  const fit = (text: string, width: number, font: string, size: number) => {
    doc.font(font).fontSize(size)
    // A hair of margin: pdfkit's word measure runs a little wider than widthOfString.
    if (doc.widthOfString(text) <= width - 1) return text
    let t = text
    while (t.length > 1 && doc.widthOfString(`${t}…`) > width - 1) t = t.slice(0, -1)
    return `${t.trimEnd()}…`
  }
  /** One line, never wrapped. */
  const line = (text: string, x: number, y: number, width: number,
    o: { font?: string; size?: number; color?: string; align?: 'left' | 'right' | 'center' } = {}) => {
    const font = o.font ?? F.reg, size = o.size ?? 8.6
    doc.font(font).fontSize(size).fillColor(o.color ?? C.ink)
      .text(fit(text, width, font, size), x, y, { width, align: o.align ?? 'left', lineBreak: false, height: size * 1.4 })
  }
  const hr = (x1: number, x2: number, y: number, color: string, weight: number) => {
    doc.save().moveTo(x1, y).lineTo(x2, y).lineWidth(weight).strokeColor(color).stroke().restore()
  }

  let y = 0
  let page = 1
  /** Room for `h` below the cursor, or a fresh page. */
  const room = (h: number) => {
    if (y + h <= BOTTOM) return
    doc.addPage({ size: 'A4', margin: 0 })
    page++
    y = 12 * MM
  }

  /** A numbered section heading, with an aside on the right. */
  const h2 = (text: string, small?: string, x = SIDE, width = BODY_W) => {
    y += 3.2 * MM
    line(text.toUpperCase(), x, y, width * (small ? 0.5 : 1), { font: F.bold, size: 8.6, color: C.hd })
    if (small) line(small, x + width * 0.4, y + 0.6, width * 0.6, { size: 7.6, color: C.mut, align: 'right' })
    y += 11
    hr(x, x + width, y, C.rule, 0.6)
    y += 1.4 * MM
  }
  const none = (text: string, x = SIDE, width = BODY_W) => {
    line(text, x, y + 1, width, { font: F.ital, size: 8.2, color: C.mut })
    y += 13
  }
  const more = (text: string, x = SIDE, width = BODY_W, color = C.mut) => {
    line(text, x, y + 1, width, { size: 7, color })
    y += 11
  }

  /** A row of ruled boxes: a small label over a bold figure. */
  const cells = (items: [string, string][]) => {
    const cw = BODY_W / items.length, h = 9.6 * MM
    items.forEach(([k, v], i) => {
      const x = SIDE + i * cw
      doc.save().rect(x, y, cw, h).lineWidth(0.6).strokeColor(C.rule).stroke().restore()
      line(k, x + 1.6 * MM, y + 1 * MM, cw - 3.2 * MM, { size: 7, color: C.mut })
      line(v, x + 1.6 * MM, y + 1 * MM + 10, cw - 3.2 * MM, { font: F.bold, size: 9.4 })
    })
    y += h
  }

  /** A ruled list: muted bold heads, soft rules between rows, a firm one under the last. */
  const table = (x: number, width: number, cols: Col[], head: string[], rows: Cell[][]) => {
    const fixed = cols.reduce((a, c) => a + c.w, 0)
    const flex = cols.filter(c => c.w === 0).length
    const widths = cols.map(c => (c.w === 0 ? (width - fixed) / flex : c.w))
    const pad = 1.4 * MM
    const rowH = 11.2
    const cellsAt = (yy: number, items: Cell[], o: { font?: string; size: number; color?: string }) => {
      let cx = x
      items.forEach((c, i) => {
        const cw = widths[i]!
        const left = i === 0 ? 0 : pad
        line(c.text, cx + left, yy, cw - left - pad, {
          font: c.bold ? F.bold : o.font ?? F.reg, size: o.size, color: c.color ?? o.color, align: cols[i]!.align,
        })
        cx += cw
      })
    }
    cellsAt(y + 1.6, head.map(text => ({ text })), { font: F.bold, size: 7.6, color: C.mut })
    y += rowH
    hr(x, x + width, y, C.rule, 0.6)
    rows.forEach((row, ri) => {
      cellsAt(y + 2, row, { size: 8.2 })
      y += rowH
      hr(x, x + width, y, ri === rows.length - 1 ? C.rule : C.soft, ri === rows.length - 1 ? 0.6 : 0.4)
    })
  }

  /** Label / value pairs, one to a ruled row. */
  const kv = (x: number, width: number, rows: [string, string][]) => {
    for (const [k, v] of rows) {
      line(k, x, y + 2, 27 * MM, { size: 8.2, color: C.mut })
      line(v, x + 27 * MM, y + 2, width - 27 * MM, { font: F.bold, size: 8.2 })
      y += 11.6
      hr(x, x + width, y, C.soft, 0.4)
    }
  }

  // ── letterhead ──
  y = drawLetterhead(doc)

  // ── title ──
  const tripDate = fmtDate.format(w.from)
  line(day ? 'DAY REPORT' : 'TRIP REPORT', SIDE, y, BODY_W / 2, { font: F.bold, size: 15 })
  {
    const ref = `${day ? 'Date' : 'Trip date'} ${tripDate}`
    const no = `Report no. ${r.reportNo}   ·   `
    doc.font(F.reg).fontSize(8)
    const refW = doc.font(F.bold).widthOfString(ref)
    const noW = doc.font(F.reg).widthOfString(no)
    line(no, SIDE + BODY_W - refW - noW, y + 6, noW + 2, { size: 8, color: C.mut })
    line(ref, SIDE + BODY_W - refW, y + 6, refW + 2, { font: F.bold, size: 8 })
  }
  y += 19
  hr(SIDE, SIDE + BODY_W, y, C.ink, 1.2)
  y += 2.2 * MM

  // ── who and where ──
  const arrived = r.to.arrivedAt ? `${r.to.name ?? DASH}, arrived ${T(r.to.arrivedAt)}` : `${r.to.name ?? DASH} (not yet arrived)`
  const taken = r.toDestinationMs != null ? dur(r.toDestinationMs) : `${dur(S.durationMs)} so far`
  const right: [string, string][] = day
    ? [['Period', `${tripDate}, ${fmtHM.format(w.from)} to ${fmtHM.format(w.to)}`], ['', ''], ['', '']]
    : [['From', `${r.from.name ?? DASH}, departed ${T(r.from.at)}`], ['To', arrived], ['Time taken', taken]]
  const left: [string, string][] = [
    ['Vehicle', `${r.vehicle.plate}${r.vehicle.type ? `, ${r.vehicle.type}` : ''}`],
    ['Driver', r.vehicle.driver ?? 'Not recorded'],
    ['Fleet', r.companyName ?? DASH],
  ]
  const half = BODY_W / 2
  for (let i = 0; i < 3; i++) {
    line(left[i]![0], SIDE, y, 23 * MM, { color: C.mut })
    line(left[i]![1], SIDE + 23 * MM, y, half - 26 * MM, { font: F.bold })
    line(right[i]![0], SIDE + half, y, 23 * MM, { color: C.mut })
    line(right[i]![1], SIDE + half + 23 * MM, y, half - 23 * MM, { font: F.bold })
    y += 12
  }
  if (w.clipped) more('This dispatch is older than 7 days; the report covers its last 7 days.')

  // ── 1. summary ──
  h2(`1. ${day ? 'Day' : 'Trip'} summary`, `${T(w.from)} to ${T(w.to)}`)
  cells([
    ['Distance', S.distanceKm != null ? `${num(S.distanceKm, 1)} km` : DASH],
    ['Moving time', dur(S.movingMs)],
    ['Stopped time', dur(S.stoppedMs)],
    ['Average speed', S.avgKmh != null ? `${num(S.avgKmh, 1)} km/h` : DASH],
    ['Maximum speed', S.maxKmh != null ? `${num(S.maxKmh)} km/h` : DASH],
    ['Fuel used', S.fuelUsedL != null ? `${num(S.fuelUsedL, 1)} L` : DASH],
  ])

  // ── 2. load details: always printed, what the dispatch says and what was weighed ──
  h2('2. Load details')
  const L = r.load
  cells([
    ['Cargo', L.cargo ?? DASH],
    ['Tag number', L.ref ?? DASH],
    ['Destination', r.to.name ?? DASH],
    ['Bags', L.bags ? num(L.bags) : DASH],
    ['Declared tonnage', t2(L.declaredKg)],
    ['Weighed net', t2(L.weighedKg)],
  ])

  // ── 3–6: route and chart on the left; stops, fuel and weighbridge on the right ──
  const gap = 6 * MM
  const lw = (BODY_W - gap) * 0.475
  const rx = SIDE + lw + gap, rw = BODY_W - lw - gap
  const colTop = y

  // The right column first, so the chart on the left can take the height it leaves.
  const ST = (t: number) => (multi ? fmtDM.format(t).replace(',', '') : fmtHM.format(t))
  h2('4. Stops', `Stopped ${dur(S.stoppedMs)}${S.idleMs != null ? ` · idling ${dur(S.idleMs)}` : ''}`, rx, rw)
  if (r.stops.length) {
    const tw = multi ? 20 * MM : 13 * MM
    table(rx, rw, [{ w: 4 * MM }, { w: 0 }, { w: tw }, { w: tw }, { w: 16 * MM }, { w: 21 * MM }],
      ['#', 'Location', 'Arrived', 'Left', 'Duration', 'Remark'],
      r.stops.map(s => [{ text: String(s.n) }, { text: placeOf(s) }, { text: ST(s.t) }, { text: ST(s.endT) },
        { text: dur(s.ms) }, { text: s.remark, color: s.flag ? C.flag : undefined, bold: s.flag }]))
    if (r.stopsTotal > r.stops.length) more(`Showing the ${r.stops.length} longest of ${r.stopsTotal} stops over 5 min.`, rx, rw)
  } else none('No stops over 5 minutes.', rx, rw)

  const Fu = r.fuel
  h2('5. Fuel', `Used on trip: ${S.fuelUsedL != null ? `${num(S.fuelUsedL, 1)} L` : DASH}`, rx, rw)
  if (!Fu.hasProbe && !Fu.rows.length) none('No fuel level sensor readings for this trip.', rx, rw)
  else {
    const rows: Cell[][] = []
    if (Fu.startL != null) rows.push([{ text: T(w.from) }, { text: 'Start level' }, { text: '' }, { text: '' }, { text: `${num(Fu.startL)} L` }])
    for (const x of Fu.rows) {
      rows.push([{ text: T(x.t) }, { text: x.label, color: x.flag ? C.flag : undefined, bold: x.flag }, { text: placeOf(x) },
        // A plain hyphen: Helvetica has no Unicode minus, which printed as a quote mark.
        { text: x.litres != null ? `${x.kind === 'refill' ? '+' : '-'}${num(x.litres)} L` : DASH },
        { text: x.after != null ? `${num(x.after)} L` : '' }])
    }
    if (Fu.endL != null) {
      rows.push([{ text: T(w.to) }, { text: r.to.arrivedAt != null ? 'Level on arrival' : day ? 'Level at end' : 'Level now' },
        { text: '' }, { text: '' }, { text: `${num(Fu.endL)} L` }])
    }
    table(rx, rw, [{ w: multi ? 22 * MM : 10 * MM }, { w: 27 * MM }, { w: 0 }, { w: 13 * MM, align: 'right' }, { w: 12 * MM, align: 'right' }],
      ['Time', 'Event', 'Location', 'Litres', 'Level'], rows)
    if (Fu.more) more(`+ ${Fu.more} more fuel events.`, rx, rw)
    if (Fu.drainL > 0) more(`Note: ${num(Fu.drainL)} L recorded as drained during this trip.`, rx, rw, C.flag)
  }

  const WB = r.weighbridge
  h2('6. Weighbridge', 'Loading ticket and weighings during the trip', rx, rw)
  if (WB.rows.length) {
    kv(rx, rw, [['Weighbridge', WB.bridges.join(', ') || DASH], ['Tickets · weighings', `${WB.tickets} · ${WB.weighings}`], ['Net tonnage', t2(WB.netKg)]])
    y += 1 * MM
    table(rx, rw, [{ w: 18 * MM }, { w: 0 }, { w: 13 * MM, align: 'right' }, { w: 22 * MM }, { w: 19 * MM }],
      ['Ticket', 'Weighing', 'Weight', 'Time', 'Since prev.'],
      WB.rows.map(x => [{ text: x.sameTicketAsPrev ? '' : x.ticket }, { text: x.kind }, { text: num(x.kg) },
        { text: fmtDayHM.format(x.at), color: x.doubtful ? C.flag : undefined }, { text: x.sinceMs != null ? dur(x.sinceMs) : DASH }]))
    if (WB.more) more(`+ ${WB.more} more weighings.`, rx, rw)
    if (WB.doubtful) more('Times in red were stamped before their ticket was raised; the weighbridge clock is wrong.', rx, rw)
  } else none('No loading ticket and no weighing during the trip.', rx, rw)
  const rightBottom = y

  // The left column.
  y = colTop
  h2('3. Route', undefined, SIDE, lw)
  const mapH = 44 * MM
  drawRoute(doc, r, SIDE, y, lw, mapH)
  y += mapH + 2
  line(day ? 'A: first fix   B: last fix' : `A: departure   B: ${r.to.arrivedAt != null ? 'arrival' : 'latest position'}`,
    SIDE, y + 1, lw, { size: 7, color: C.mut })
  y += 12
  drawChart(doc, r, SIDE, y, lw, Math.max(22 * MM, rightBottom - y - 2), line)
  y = Math.max(rightBottom, y + 22 * MM + 14)

  // ── 7. geofence ──
  const G = r.geo
  room(60)
  h2('7. Geofence alerts')
  const gMulti = multi || G.rows.some(g => dayOf.format(g.t) !== dayOf.format(w.from))
  if (G.rows.length) {
    table(SIDE, BODY_W, [{ w: gMulti ? 22 * MM : 10 * MM }, { w: 42 * MM }, { w: 0 }], ['Time', 'Alert', 'Zone'],
      G.rows.map(g => [{ text: (gMulti ? fmtDayHM : fmtHM).format(g.t) }, { text: g.label, color: g.flag ? C.flag : undefined, bold: g.flag },
        { text: g.zone ?? DASH }]))
    if (G.more) more(`+ ${G.more} more zone crossings.`)
    if (G.timedOut) more('Other zone crossings could not be read in time for this report.')
  } else none(G.timedOut ? 'Zone crossings could not be read in time for this report.' : 'No geofence alerts during this trip.')

  // ── 8. driver conduct, during the trip ──
  const B = r.breaches
  room(80)
  const span = `${fmtDayHM.format(w.from)} to ${r.to.arrivedAt != null ? 'arrival' : day ? 'end' : 'now'}, ${fmtDayHM.format(w.to)}`
  h2('8. Driver conduct', `${r.vehicle.driver ?? 'Driver not recorded'} on ${r.vehicle.plate}, ${span}`)
  const cam = B.dashcam
  const counts: [string, string, boolean][] = [
    ['Escalated fuel theft', String(B.counts.theft ?? 0), false],
    ['Harsh braking', String(B.counts.brake ?? 0), false],
    ['Overspeeding', String(B.counts.speed ?? 0), false],
    ['Time overspeeding', B.counts.speed ? dur(B.overspeedMs) : '0 min', false],
    ['Distance overspeeding', B.overspeedKm != null ? `${num(B.overspeedKm, 1)} km` : DASH, false],
    ['Harsh acceleration', String(B.counts.accel ?? 0), false],
    // A dashcam unit only: no seat belt, phone use, hands off the wheel.
    ...B.kinds.filter(k => !['theft', 'brake', 'speed', 'accel'].includes(k.key))
      .map(k => [k.label, cam.complete ? String(B.counts[k.key] ?? 0) : DASH, !cam.complete] as [string, string, boolean]),
  ]
  {
    const cw = BODY_W / counts.length, headH = 9 * MM, valH = 6.4 * MM
    counts.forEach(([k, v, na], i) => {
      const x = SIDE + i * cw
      doc.save().rect(x, y, cw, headH).fillAndStroke(C.shade, C.rule).restore()
      doc.save().rect(x, y + headH, cw, valH).lineWidth(0.6).strokeColor(C.rule).stroke().restore()
      doc.font(F.reg).fontSize(7.2).fillColor(C.mut)
        .text(k, x + 2, y + 3, { width: cw - 4, align: 'center', height: headH - 3, ellipsis: true })
      line(v, x + 2, y + headH + 4, cw - 4, { font: na ? F.reg : F.bold, size: na ? 7 : 10, color: na ? C.mut : C.ink, align: 'center' })
    })
    y += headH + valH + 1.4 * MM
  }
  if (cam.fitted && !cam.complete) more('The dashcam server did not answer in time; its columns are left blank, not zero.')
  if (B.rows.length) {
    room(16 + B.rows.length * 11.2)
    table(SIDE, BODY_W, [{ w: 22 * MM }, { w: 34 * MM }, { w: 0 }, { w: 44 * MM }], ['Time', 'Event', 'Location', 'Detail'],
      B.rows.map(b => [{ text: fmtDayHM.format(b.t) }, { text: b.label, color: b.key === 'theft' ? C.flag : undefined, bold: b.key === 'theft' },
        { text: placeOf(b) }, { text: b.detail ?? '' }]))
    if (B.more) more(`+ ${B.more} more.`)
  } else none('Nothing recorded against the unit in this time.')

  // ── 9. summary: lines to write on, and the sign-off ──
  const LINE_GAP = 5.6 * MM, SIGN_GAP = 7 * MM
  room(26 + 4 * LINE_GAP + 2 * SIGN_GAP)
  h2('9. Summary')
  for (let i = 0; i < 4; i++) { y += LINE_GAP; hr(SIDE, SIDE + BODY_W, y, C.rule, 0.6) }
  // The signature lines sit at the foot of the page when there is room for it.
  const signY = Math.max(y + 2 * SIGN_GAP, BOTTOM - 6 * MM)
  for (const [i, label] of ['Reviewed by', 'Signature & date'].entries()) {
    const x = SIDE + i * (BODY_W / 2 + 2.5 * MM)
    const sw = BODY_W / 2 - 2.5 * MM
    line(label, x, signY - SIGN_GAP + 1, sw, { size: 7.4, color: C.mut })
    hr(x, x + sw, signY, C.ink, 0.6)
  }

  // ── footer on every page, now that the count is known ──
  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    hr(SIDE, SIDE + BODY_W, PAGE_H - FOOT_H + 2 * MM, C.rule, 0.6)
    line(`Generated ${fmtDayHM.format(r.generatedAt)}`, SIDE, PAGE_H - FOOT_H + 4 * MM, BODY_W / 2, { size: 7, color: C.mut })
    line(`Page ${i - range.start + 1} of ${range.count}`, SIDE + BODY_W / 2, PAGE_H - FOOT_H + 4 * MM, BODY_W / 2, { size: 7, color: C.mut, align: 'right' })
  }
  void page
  doc.end()
  return done
}

type Doc = InstanceType<typeof PDFDocument>
type LineFn = (text: string, x: number, y: number, width: number,
  o?: { font?: string; size?: number; color?: string; align?: 'left' | 'right' | 'center' }) => void

/** The route drawn to scale on a plain white box: no base map, nothing invented. */
function drawRoute(doc: Doc, r: TripReport, x: number, y: number, w: number, h: number) {
  const pts = r.track
  doc.save().rect(x, y, w, h).lineWidth(0.6).strokeColor(C.rule).stroke().restore()
  if (pts.length < 2) {
    doc.font(F.reg).fontSize(7).fillColor(C.mut).text('No positions recorded for this trip', x, y + h / 2 - 4, { width: w, align: 'center', lineBreak: false })
    return
  }
  const PAD = 8
  let P: (p: [number, number]) => [number, number]
  let kmPerPt: number
  doc.save().rect(x, y, w, h).clip()
  {
    // Plain white, the route to scale (operator, 2026-10-31: no base map).
    const extra = [r.yard, r.dest].filter((p): p is { lat: number; lng: number } => !!p).map(p => [p.lat, p.lng] as [number, number])
    const all = [...pts, ...extra]
    const lat0 = all.reduce((a, p) => a + p[0], 0) / all.length
    const kx = Math.cos((lat0 * Math.PI) / 180)
    const xs = all.map(p => p[1] * kx), ys = all.map(p => p[0])
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
    const spanX = Math.max(maxX - minX, (maxY - minY) * ((w - 2 * PAD) / (h - 2 * PAD)), 1e-4)
    const s = (w - 2 * PAD) / spanX
    const ox = x + PAD + ((w - 2 * PAD) - (maxX - minX) * s) / 2
    const oy = y + PAD + ((h - 2 * PAD) - (maxY - minY) * s) / 2
    P = ([lat, lng]) => [ox + (lng * kx - minX) * s, oy + (maxY - lat) * s]
    kmPerPt = 111.32 / s
  }
  if (r.dest) {
    const [dx, dy] = P([r.dest.lat, r.dest.lng])
    doc.save().circle(dx, dy, 7).fillOpacity(0.18).fill(C.route).restore()
  }
  const poly = (color: string, width: number, opacity = 1) => {
    doc.save()
    pts.forEach((p, i) => { const [px, py] = P(p); if (i) doc.lineTo(px, py); else doc.moveTo(px, py) })
    doc.lineWidth(width).lineJoin('round').lineCap('round').strokeOpacity(opacity).strokeColor(color).stroke().restore()
  }
  poly(C.route, 1.7)
  const label = (text: string, cx: number, cy: number, size: number) => {
    doc.font(F.bold).fontSize(size).fillColor(C.paper).text(text, cx - 6, cy - size * 0.36, { width: 12, align: 'center', lineBreak: false })
  }
  for (const s of r.stops) {
    if (s.lat == null) continue
    const [sx, sy] = P([s.lat, s.lng])
    doc.circle(sx, sy, 4.6).fill(s.flag ? C.flag : C.ink)
    label(String(s.n), sx, sy, 5.8)
  }
  const [ax, ay] = P(pts[0]!)
  const [bx, by] = P(pts[pts.length - 1]!)
  doc.rect(ax - 5, ay - 5, 10, 10).fill(C.ink); label('A', ax, ay, 6)
  doc.rect(bx - 5, by - 5, 10, 10).fill(C.route); label('B', bx, by, 6)
  // Scale bar: a round number of km near a quarter of the width.
  const nice = [0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200].find(k => k / kmPerPt >= w / 6) ?? 200
  const bar = nice / kmPerPt
  doc.save().rect(x + w - PAD - bar - 3, y + h - 15, bar + 6, 12).fillOpacity(0.8).fill(C.paper).restore()
  doc.save().moveTo(x + w - PAD - bar, y + h - 5).lineTo(x + w - PAD, y + h - 5).lineWidth(1).strokeColor(C.mut).stroke().restore()
  doc.font(F.reg).fontSize(6).fillColor(C.mut).text(`${nice} km`, x + w - PAD - 40, y + h - 13, { width: 40, align: 'right', lineBreak: false })
  doc.restore()
}

/**
 * Fuel and altitude on one graph (operator, 2026-10-30): fuel in litres on the
 * left scale as the line, altitude in metres on the right as a shaded profile
 * behind it, so a fall in the tank can be read against a climb. With only one
 * of the two, that one is drawn alone; with neither, nothing.
 */
function drawChart(doc: Doc, r: TripReport, x: number, y: number, w: number, h: number, line: LineFn) {
  const win = r.window
  const fuel = r.fuel.series ?? []
  const alt = r.altitude ?? []
  const hasF = fuel.length >= 2, hasA = alt.length >= 2
  if (!hasF && !hasA) return
  const key = hasF && hasA ? 'Fuel level (litres, left)   ·   Altitude (m above sea level, right, shaded)'
    : hasF ? 'Fuel level (litres)' : 'Altitude (m above sea level)'
  line(key, x, y, w, { size: 7.4, color: C.mut })
  const left = x + 7.5 * MM, right = x + w - (hasF && hasA ? 9 * MM : 1.5 * MM)
  const top = y + 12, bottom = y + h - 10
  const X = (t: number) => left + ((t - win.from) / Math.max(1, win.to - win.from)) * (right - left)
  const scale = (vals: number[], step: number, minPad: number, floor: number | null) => {
    let lo = Math.min(...vals), hi = Math.max(...vals)
    const pad = Math.max(minPad, (hi - lo) * 0.12)
    lo = floor != null ? Math.max(floor, lo - pad) : lo - pad; hi += pad
    const Y = (v: number) => top + ((hi - v) / (hi - lo)) * (bottom - top)
    const ticks = [0.2, 0.5, 0.8].map(k => Math.round((lo + (hi - lo) * k) / step) * step)
    return { Y, ticks }
  }
  const main = hasF ? scale(fuel.map(p => p[1]), 5, 5, 0) : scale(alt.map(p => p[1]), 10, 15, null)
  const A = hasF && hasA ? scale(alt.map(p => p[1]), 10, 15, null) : null

  if (A) {
    doc.save()
    doc.moveTo(X(alt[0]![0]), bottom)
    for (const [t, v] of alt) doc.lineTo(X(t), A.Y(v))
    doc.lineTo(X(alt[alt.length - 1]![0]), bottom).closePath().fillOpacity(0.85).fill(C.soft).restore()
    for (const v of A.ticks) line(num(v), right + 1 * MM, A.Y(v) - 3, 9 * MM, { size: 5.6, color: C.mut })
  }
  for (const v of main.ticks) {
    doc.save().moveTo(left, main.Y(v)).lineTo(right, main.Y(v)).lineWidth(0.5).strokeColor(C.soft).stroke().restore()
    line(num(v), x, main.Y(v) - 3, 6.5 * MM, { size: 5.6, color: C.mut, align: 'right' })
  }
  doc.save().moveTo(left, bottom).lineTo(right, bottom).lineWidth(0.6).strokeColor(C.rule).stroke().restore()
  const series = hasF ? fuel : alt
  doc.save()
  series.forEach(([t, v], i) => { if (i) doc.lineTo(X(t), main.Y(v)); else doc.moveTo(X(t), main.Y(v)) })
  doc.lineWidth(hasF ? 1.2 : 0.9).lineJoin('round').strokeColor(hasF ? C.route : C.mut).stroke().restore()
  if (hasF) {
    for (const d of r.fuel.rows.filter(row => row.kind === 'drain')) {
      const near = fuel.reduce((b, q) => (Math.abs(q[0] - d.t) < Math.abs(b[0] - d.t) ? q : b), fuel[0]!)
      doc.circle(X(d.t), main.Y(near[1]), 2).fill(C.flag)
    }
  }
  const multi = dayOf.format(win.from) !== dayOf.format(win.to)
  const fmt = multi ? fmtDayHM : fmtHM
  ;[0, 0.5, 1].forEach(k => {
    const t = win.from + (win.to - win.from) * k
    const lw = 24 * MM
    const lx = k === 0 ? left : k === 1 ? right - lw : (left + right) / 2 - lw / 2
    line(fmt.format(t), lx, bottom + 2, lw, { size: 5.6, color: C.mut, align: k === 0 ? 'left' : k === 1 ? 'right' : 'center' })
  })
}
