/**
 * The Logbook as a PDF — a vehicle tracking report, laid out the way the
 * hand-built KDP 365T report (Aug–Sep 2026) was (operator, 2026-10-09: "the
 * type of information in the PowerPoint, organised in our PDF"):
 *
 *   Page 1 — the cover (vehicle, subject, period, prepared) and the executive
 *            summary: six headline figures and four key findings.
 *   Page 2 — where the vehicle spent its time, place by place with home
 *            first; how the period's hours divided; distance day by day
 *            against the active-day mean and median.
 *   Page 3 — when it drives (trips by weekday and by start hour), the most
 *            frequent routes, and the movement web: the same drives on the
 *            map, place to place, an arrow per direction, width by trips.
 *   Page 4 — the top sites with what each is (a bank, a restaurant, a
 *            clinic — Google's type for it) and median arrival and departure,
 *            and where it stood each night.
 *   Page 5 — fleet tracking evidence: the route on the map with its places
 *            numbered, and the gate times to check against CCTV.
 *
 * The figures are usage-review.report's; the map is OpenStreetMap tiles
 * stitched under the route. Tiles are fetched with an identifying User-Agent
 * and kept in memory; if they cannot be fetched the route is drawn on a plain
 * ground instead — the PDF never fails for a map, nor for a missing logo.
 */

import fs from 'node:fs'
import path from 'node:path'
import PDFDocument from 'pdfkit'
import { fuelOf, TZ_OFFSET_MS, type ReviewPlace } from './usage-review.compute.js'
import type { PlaceKind } from './usage-review.areas.js'
import type { ReadyReview } from './usage-review.service.js'
import { reportFigures, shortPlaceName, WEEKDAYS } from './usage-review.report.js'

const C = {
  ink: '#111827', sub: '#6b7280', faint: '#9ca3af', line: '#e5e7eb', panel: '#f8fafc',
  // The report's palette (the KDP 365T deck): home a deep green, driving a
  // brighter one, other places orange, work sites blue, the low day red.
  green: '#2e7d32', deep: '#1b5e20', orange: '#f57c00', blue: '#1565c0', red: '#c62828', violet: '#6a1b9a',
  route: '#3b6fd4',
}
const F = { reg: 'Helvetica', bold: 'Helvetica-Bold' }
const M = 36
const W = 595.28 - 2 * M
/** Who prepares the report — the deck's own byline. */
const PREPARED_BY = 'Off-Grid Consulting Ltd.'

// ── logos ────────────────────────────────────────────────────────────────────

/** Read from <repo>/assets/report, where the server runs; null if absent. */
const logoCache = new Map<string, Buffer | null>()
function logo(file: string): Buffer | null {
  if (!logoCache.has(file)) {
    try { logoCache.set(file, fs.readFileSync(path.resolve(process.cwd(), 'assets', 'report', file))) } catch { logoCache.set(file, null) }
  }
  return logoCache.get(file) ?? null
}

// ── tiles ────────────────────────────────────────────────────────────────────

const TILE_UA = 'fleettrack-usage-review/1.0 (logistics.raioperations.com)'
const tileCache = new Map<string, Buffer | null>()
async function tile(z: number, x: number, y: number): Promise<Buffer | null> {
  const k = `${z}/${x}/${y}`
  if (tileCache.has(k)) return tileCache.get(k) ?? null
  try {
    const res = await fetch(`https://tile.openstreetmap.org/${k}.png`, { headers: { 'User-Agent': TILE_UA }, signal: AbortSignal.timeout(8_000) })
    const buf = res.ok ? Buffer.from(await res.arrayBuffer()) : null
    if (tileCache.size > 2_000) tileCache.delete(tileCache.keys().next().value!)
    tileCache.set(k, buf)
    return buf
  } catch { return null }
}

const lon2x = (lng: number, z: number) => ((lng + 180) / 360) * 256 * 2 ** z
const lat2y = (lat: number, z: number) => {
  const s = Math.sin((lat * Math.PI) / 180)
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z
}

interface MapFrame { z: number; x0: number; y0: number; scale: number }

/** Fetch what the map needs before drawing (pdfkit draws synchronously).
 *  Framed on `frameOn` ([lat, lng] points) when given, else on the route and
 *  the top places. */
async function prepareMap(rv: ReadyReview, boxW: number, boxH: number, frameOn?: [number, number][]) {
  const pts: [number, number][] = frameOn ? [...frameOn] : rv.tracks.flatMap(t => t.path)
  if (!frameOn) for (const p of rv.places.slice(0, 10)) pts.push([p.lat, p.lng])
  if (!pts.length) return null
  let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity
  for (const [la, lo] of pts) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo) }
  const scale = 0.55                                      // pt per tile pixel: crisp in print
  const pxW = boxW / scale, pxH = boxH / scale
  let z = 15
  for (; z > 3; z--) {
    const dx = lon2x(e, z) - lon2x(w, z), dy = lat2y(s, z) - lat2y(n, z)
    if (dx <= pxW * 0.88 && dy <= pxH * 0.88) break
  }
  const cx = (lon2x(w, z) + lon2x(e, z)) / 2, cy = (lat2y(n, z) + lat2y(s, z)) / 2
  const frame: MapFrame = { z, x0: cx - pxW / 2, y0: cy - pxH / 2, scale }
  const tiles: { x: number; y: number; buf: Buffer | null }[] = []
  const max = 2 ** z
  for (let ty = Math.floor(frame.y0 / 256); ty <= Math.floor((frame.y0 + pxH) / 256); ty++) {
    for (let tx = Math.floor(frame.x0 / 256); tx <= Math.floor((frame.x0 + pxW) / 256); tx++) {
      if (ty < 0 || ty >= max) continue
      tiles.push({ x: tx, y: ty, buf: null })
    }
  }
  if (tiles.length <= 48) {
    for (let i = 0; i < tiles.length; i += 6) {
      await Promise.all(tiles.slice(i, i + 6).map(async t => { t.buf = await tile(z, ((t.x % max) + max) % max, t.y) }))
    }
  }
  return { frame, tiles }
}

// ── formatting ───────────────────────────────────────────────────────────────

const nf = (v: number | null | undefined, d = 1) =>
  v == null || !Number.isFinite(v) ? '-' : v.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d })
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "24 Sep", or with the year "24 Sep 2026" — en-GB's own short month is "Sept". */
const dayLabel = (d: string, year = false) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}${year ? ` ${d.slice(0, 4)}` : ''}`
const pct = (v: number, of: number) => (of > 0 ? `${nf((v / of) * 100, 1)}%` : '-')
const pct0 = (v: number | null) => (v == null ? '-' : `${Math.round(v * 100)}%`)
const hhmm = (m: number | null) => (m == null ? '-' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
const eatClock = (ms: number) => new Date(ms + TZ_OFFSET_MS).toISOString().slice(11, 16)
const eatDate = (ms: number) => new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10)
const dur = (min: number) => { const m = Math.round(min); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` }

// ── drawing ──────────────────────────────────────────────────────────────────

const KIND_COLOR: Record<PlaceKind, string> = { work: C.blue, home: C.deep, elsewhere: C.orange }
const KIND_SHORT: Record<PlaceKind, string> = { work: 'Work site', home: 'Home area', elsewhere: 'Other places' }
const kindOf = (p: ReviewPlace): PlaceKind => p.kind ?? 'elsewhere'

/**
 * @param subject who the report is about — the driver on the vehicle, as the
 *   page knows it; "-" when none is assigned.
 */
export async function renderUsageReviewPdf(rv: ReadyReview, kmpl: number | null, subject: string | null = null): Promise<Buffer> {
  const s = rv.summary, q = rv.quality, veh = rv.vehicle
  const fuelTot = fuelOf(s.km, kmpl)
  const areas = rv.areas ?? null
  const fig = reportFigures(rv, areas)
  const PAGE_H = 841.89, BOTTOM = PAGE_H - M - 18

  const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, info: { Title: `${veh.plate} vehicle tracking report`, Author: PREPARED_BY } })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>(res => doc.on('end', () => res(Buffer.concat(chunks))))

  /** `text` cut to `width` on one line, with an ellipsis when it had to be. */
  const fit = (text: string, width: number, font: string, size: number) => {
    doc.font(font).fontSize(size)
    if (doc.widthOfString(text) <= width) return text
    let t = text
    while (t.length > 1 && doc.widthOfString(`${t}…`) > width) t = t.slice(0, -1)
    return `${t.trimEnd()}…`
  }
  /** One line of text, never wrapped: the guard against rows running together. */
  const line = (text: string, x: number, yy: number, width: number, o: { font?: string; size?: number; color?: string; align?: 'left' | 'right' | 'center' } = {}) => {
    const font = o.font ?? F.reg, size = o.size ?? 8
    doc.font(font).fontSize(size).fillColor(o.color ?? C.ink)
      .text(fit(text, width, font, size), x, yy, { width, align: o.align ?? 'left', lineBreak: false })
  }
  /** A section title with a note on the right, over a hairline. */
  const title = (t: string, note: string | null, yy: number) => {
    line(t, M, yy, W * 0.6, { font: F.bold, size: 13 })
    if (note) line(note, M + W * 0.35, yy + 4, W * 0.65, { size: 7.5, color: C.sub, align: 'right' })
    doc.moveTo(M, yy + 19).lineTo(M + W, yy + 19).lineWidth(0.6).stroke(C.line)
    return yy + 28
  }
  const sub = (t: string, yy: number) => { line(t, M, yy, W, { font: F.bold, size: 9, color: C.sub }); return yy + 14 }

  /** A donut of parts, drawn from 12 o'clock clockwise. */
  const donut = (cx: number, cy: number, r: number, ri: number, parts: { v: number; c: string }[]) => {
    const total = parts.reduce((a, p) => a + p.v, 0)
    if (total <= 0) { doc.circle(cx, cy, (r + ri) / 2).lineWidth(r - ri).stroke(C.line); return }
    const shown = parts.filter(p => p.v > 0)
    if (shown.length === 1) { doc.circle(cx, cy, (r + ri) / 2).lineWidth(r - ri).stroke(shown[0]!.c); return }
    let a0 = -Math.PI / 2
    for (const p of shown) {
      const a1 = a0 + (p.v / total) * Math.PI * 2
      const large = a1 - a0 > Math.PI ? 1 : 0
      const P = (rr: number, a: number) => `${(cx + rr * Math.cos(a)).toFixed(2)} ${(cy + rr * Math.sin(a)).toFixed(2)}`
      doc.path(`M ${P(r, a0)} A ${r} ${r} 0 ${large} 1 ${P(r, a1)} L ${P(ri, a1)} A ${ri} ${ri} 0 ${large} 0 ${P(ri, a0)} Z`).fill(p.c)
      a0 = a1
    }
    a0 = -Math.PI / 2
    for (const p of shown) {
      doc.moveTo(cx + ri * Math.cos(a0), cy + ri * Math.sin(a0)).lineTo(cx + r * Math.cos(a0), cy + r * Math.sin(a0)).lineWidth(1.2).stroke('#ffffff')
      a0 += (p.v / total) * Math.PI * 2
    }
  }

  /** Horizontal bars, label left, figures after the bar. */
  const hbars = (rows: { label: string; v: number; c: string; note: string }[], yy: number, labelW: number, rowH: number) => {
    const max = Math.max(1, ...rows.map(r => r.v))
    const x0 = M + labelW + 6, bw = W - labelW - 6 - 150
    rows.forEach((r, i) => {
      const y = yy + i * rowH
      line(r.label, M, y + (rowH - 8) / 2 - 1, labelW, { size: 8, align: 'right' })
      const w = Math.max(1.5, (r.v / max) * bw)
      doc.rect(x0, y + 2, w, rowH - 5).fill(r.c)
      line(r.note, x0 + w + 5, y + (rowH - 8) / 2 - 1, 150 + bw - w - 5, { size: 7.5, color: C.sub })
    })
    doc.moveTo(x0, yy).lineTo(x0, yy + rows.length * rowH).lineWidth(0.6).stroke(C.faint)
    return yy + rows.length * rowH
  }

  /** Vertical bars in a box, a value over each, a label under. */
  const vbars = (box: { x: number; y: number; w: number; h: number }, vals: number[], colors: string[], labels: string[], o: { every?: number; values?: boolean } = {}) => {
    const top = Math.max(1, ...vals)
    const bw = box.w / vals.length
    doc.moveTo(box.x, box.y + box.h).lineTo(box.x + box.w, box.y + box.h).lineWidth(0.6).stroke(C.faint)
    vals.forEach((v, i) => {
      const h = (v / top) * box.h
      if (h > 0) doc.rect(box.x + i * bw + bw * 0.14, box.y + box.h - h, bw * 0.72, h).fill(colors[i]!)
      if (o.values !== false && v > 0) line(String(v), box.x + i * bw, box.y + box.h - h - 9, bw, { size: 6.5, color: C.sub, align: 'center' })
      if (i % (o.every ?? 1) === 0) line(labels[i]!, box.x + i * bw - 4, box.y + box.h + 4, bw + 8, { size: 6.5, color: C.sub, align: 'center' })
    })
  }

  /** A table: header row, zebra rows, one line per cell. */
  type Col = { h: string; w: number; r?: boolean }
  const table = (cols: Col[], rows: { cells: string[]; dot?: string; bold?: boolean }[], yy: number, rowH = 15) => {
    const draw = (vals: string[], y: number, head: boolean, dot?: string, bold?: boolean) => {
      let x = M
      cols.forEach((c, i) => {
        const pad = i === 0 && dot ? 12 : 4
        if (i === 0 && dot) doc.circle(x + 6, y + 3.6, 2.8).fill(dot)
        line(vals[i] ?? '', x + pad, y, c.w - pad - 4, { font: head || (bold && i === 0) ? F.bold : F.reg, size: head ? 7 : 7.8, color: head ? C.sub : C.ink, align: c.r ? 'right' : 'left' })
        x += c.w
      })
    }
    draw(cols.map(c => c.h), yy, true)
    doc.moveTo(M, yy + 11).lineTo(M + W, yy + 11).lineWidth(0.6).stroke(C.line)
    let y = yy + 16
    rows.forEach((r, i) => {
      if (i % 2 === 0) doc.rect(M, y - 4, W, rowH).fill(C.panel)
      draw(r.cells, y, false, r.dot, r.bold)
      y += rowH
    })
    return y + 4
  }

  type Prepared = NonNullable<Awaited<ReturnType<typeof prepareMap>>>
  /** The tiles, softened, in the box; returns the projection. Call inside
   *  doc.save()/restore() with the box clipped. */
  const mapGround = (map: Prepared | null, mx: number, my: number, w: number, h: number, soften: number) => {
    doc.rect(mx, my, w, h).fill('#eef2f0')
    if (!map) return null
    const { frame, tiles: tl } = map
    const size = 256 * frame.scale
    for (const t of tl) {
      if (!t.buf) continue
      try { doc.image(t.buf, mx + (t.x * 256 - frame.x0) * frame.scale, my + (t.y * 256 - frame.y0) * frame.scale, { width: size, height: size }) } catch { /* a bad tile is skipped */ }
    }
    doc.rect(mx, my, w, h).fillOpacity(soften).fill('#ffffff').fillOpacity(1)
    return {
      px: (lng: number) => mx + (lon2x(lng, frame.z) - frame.x0) * frame.scale,
      py: (lat: number) => my + (lat2y(lat, frame.z) - frame.y0) * frame.scale,
    }
  }
  /** A place as a numbered circle, in its kind's colour. */
  const placeDot = (p: ReviewPlace, x: number, yy: number, r: number) => {
    doc.circle(x, yy, r).fill(KIND_COLOR[kindOf(p)])
    doc.circle(x, yy, r).lineWidth(1.2).stroke('#ffffff')
    doc.font(F.bold).fontSize(r > 9 ? 8 : 7).fillColor('#ffffff').text(String(p.id), x - 10, yy - (r > 9 ? 4 : 3.5), { width: 20, align: 'center', lineBreak: false })
  }

  const period = `${dayLabel(rv.period.from, true)} – ${dayLabel(rv.period.to, true)}`
  const prepared = (() => { const d = new Date(rv.builtAt + TZ_OFFSET_MS); return `${String(d.getUTCDate()).padStart(2, '0')} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getUTCMonth()]} ${d.getUTCFullYear()}` })()

  /** The running head on pages 2 on: logos, the plate and the period. */
  const head = (section: string) => {
    doc.rect(0, 0, 595.28, 4).fill(C.green)
    const rai = logo('rai-group-logo.jpeg'), ogc = logo('ogc-logo.png')
    if (rai) try { doc.image(rai, M, M - 14, { fit: [26, 26] }) } catch { /* no logo */ }
    if (ogc) try { doc.image(ogc, M + W - 34, M - 12, { fit: [34, 24] }) } catch { /* no logo */ }
    line(`${veh.plate}  ·  ${section}`, M + 34, M - 9, W * 0.6, { font: F.bold, size: 9 })
    line(period, M + 34, M + 2, W * 0.6, { size: 7.5, color: C.sub })
    doc.moveTo(M, M + 18).lineTo(M + W, M + 18).lineWidth(0.6).stroke(C.line)
    return M + 30
  }

  // ════ page 1: cover and executive summary ════
  {
    doc.rect(0, 0, 595.28, 6).fill(C.green)
    const rai = logo('rai-group-logo.jpeg'), ogc = logo('ogc-logo.png')
    if (rai) try { doc.image(rai, M, M - 6, { fit: [64, 64] }) } catch { /* no logo */ }
    if (ogc) try { doc.image(ogc, M + W - 84, M, { fit: [84, 60] }) } catch { /* no logo */ }
    line('VEHICLE TRACKING REPORT', M + 76, M + 4, W - 170, { font: F.bold, size: 9, color: C.green })
    line(veh.plate, M + 76, M + 16, W - 170, { font: F.bold, size: 30 })
    line([veh.organisation, veh.wialonName && veh.wialonName !== veh.plate ? veh.wialonName : null].filter(Boolean).join('  ·  '), M + 76, M + 48, W - 170, { size: 8.5, color: C.sub })
  }
  let y = M + 78
  {
    const meta: [string, string][] = [['SUBJECT', subject?.trim() || '-'], ['REVIEW PERIOD', period], ['PREPARED', prepared], ['PREPARED BY', PREPARED_BY]]
    const cw = W / meta.length
    doc.rect(M, y, W, 40).fill(C.panel)
    meta.forEach(([l, v], i) => {
      line(l, M + i * cw + 10, y + 8, cw - 16, { font: F.bold, size: 6.8, color: C.sub })
      line(v, M + i * cw + 10, y + 20, cw - 16, { font: F.bold, size: 9.5 })
    })
    y += 58
  }

  y = title('Executive summary', `${veh.plate} over ${rv.period.days} days`, y)
  {
    const quiet = s.calendarDays - s.activeDays
    const tiles: { l: string; v: string; sub: string }[] = [
      { l: 'TOTAL DISTANCE', v: `${nf(s.km, 0)} km`, sub: s.kmPerActiveDay != null ? `${nf(s.kmPerActiveDay, 0)} km / active day` : '-' },
      { l: 'TIME DRIVING', v: `${nf(s.driveH, 1)} h`, sub: `${nf(s.driveHPerDay, 2)} h / day` },
      { l: 'TRIPS', v: nf(s.trips, 0), sub: s.activeDays ? `${nf(s.trips / s.activeDays, 1)} / active day` : '-' },
      { l: 'ACTIVE DAYS', v: `${s.activeDays} / ${s.calendarDays}`, sub: `${quiet} quiet day${quiet === 1 ? '' : 's'}` },
      { l: 'TIME AT HOME', v: fig.homeH > 0 ? `${nf(fig.homeH, 0)} h` : '-', sub: fig.homeShare != null ? `${nf(fig.homeShare * 100, 1)}% of stopped time` : 'no home area found' },
      { l: 'TOP-3 PLACES', v: pct0(fig.top3Share), sub: 'of all stopped time' },
    ]
    const cw = (W - 2 * 10) / 3, ch = 62
    tiles.forEach((t, i) => {
      const x = M + (i % 3) * (cw + 10), yy = y + Math.floor(i / 3) * (ch + 10)
      doc.rect(x, yy, cw, ch).lineWidth(0.6).stroke(C.line)
      doc.rect(x, yy, 3, ch).fill(C.green)
      line(t.l, x + 12, yy + 9, cw - 20, { font: F.bold, size: 7, color: C.sub })
      line(t.v, x + 12, yy + 21, cw - 20, { font: F.bold, size: 20 })
      line(t.sub, x + 12, yy + 46, cw - 20, { size: 7.8, color: C.sub })
    })
    y += 2 * ch + 10 + 22
  }

  y = sub('KEY FINDINGS', y)
  {
    const rh = 50
    fig.findings.forEach((f, i) => {
      const yy = y + i * rh
      if (i) doc.moveTo(M, yy - 4).lineTo(M + W, yy - 4).lineWidth(0.5).stroke(C.line)
      doc.circle(M + 11, yy + 12, 11).fill(C.green)
      line(String(i + 1), M, yy + 7.5, 22, { font: F.bold, size: 10, color: '#ffffff', align: 'center' })
      line(f.title, M + 32, yy + 2, W - 190, { font: F.bold, size: 10 })
      doc.font(F.reg).fontSize(8.5).fillColor(C.sub).text(f.text, M + 32, yy + 16, { width: W - 200, height: 24, ellipsis: true })
      line(f.stat, M + W - 150, yy + 2, 150, { font: F.bold, size: 18, color: C.green, align: 'right' })
      line(f.statLabel, M + W - 150, yy + 24, 150, { size: 7.5, color: C.sub, align: 'right' })
    })
    y += 4 * rh + 6
  }

  {
    const minis: [string, string][] = [
      ['Engine on', s.engineH != null ? `${nf(s.engineH, 1)} h` : '-'],
      ['Idling', s.idleH != null ? `${nf(s.idleH, 1)} h` : '-'],
      ['Avg moving speed', s.avgMovingKmh != null ? `${nf(s.avgMovingKmh, 0)} km/h` : '-'],
      ['Top speed', `${s.maxKmh} km/h`],
      ['Fuel (est.)', fuelTot != null ? `${nf(fuelTot, 0)} L at ${kmpl} km/L` : 'no km/L rate'],
      ['Places', `${s.places}`],
    ]
    doc.rect(M, y, W, 32).fill(C.panel)
    const mw = W / minis.length
    minis.forEach(([l, v], i) => {
      line(l, M + i * mw + 8, y + 6, mw - 12, { size: 6.8, color: C.sub })
      line(v, M + i * mw + 8, y + 17, mw - 12, { font: F.bold, size: 8.8 })
    })
  }

  // ════ page 2: where the time went, how it divided, day by day ════
  doc.addPage()
  y = head('where the time went')
  y = title('Where the vehicle spent its time', `${nf(fig.stoppedH, 0)} h stopped at ${s.places} places · stops of 10 min or more`, y)
  {
    const rows = fig.sites.slice(0, 15).map(x => ({
      label: x.name, v: x.hours, c: KIND_COLOR[x.home ? 'home' : x.kind],
      note: `${nf(x.hours, 1)} h · ${x.visits} visit${x.visits === 1 ? '' : 's'} · ${x.days} day${x.days === 1 ? '' : 's'}`,
    }))
    y = hbars(rows, y, 150, 14.5)
    let kx = M + 156
    for (const k of ['home', 'work', 'elsewhere'] as PlaceKind[]) {
      doc.rect(kx, y + 6, 8, 8).fill(KIND_COLOR[k])
      line(k === 'home' ? 'Home' : KIND_SHORT[k], kx + 12, y + 6, 80, { size: 7.5, color: C.sub })
      kx += 82
    }
    y += 26
  }

  {
    const sp = fig.split
    const all = sp.driving + (sp.idling ?? 0) + sp.home + sp.away
    y = title('How time was divided', `Driving ${pct(sp.driving, all)}  ·  Idling ${sp.idling != null ? pct(sp.idling, all) : '-'}  ·  Stopped ${pct(sp.home + sp.away, all)}  ·  ${s.activeDays}/${s.calendarDays} active days`, y)
    const parts = [
      { l: 'Driving', v: sp.driving, c: C.green },
      { l: 'Idling', v: sp.idling ?? 0, c: C.orange },
      { l: 'Stopped at home', v: sp.home, c: C.deep },
      { l: 'Stopped away', v: sp.away, c: C.blue },
    ]
    const total = parts.reduce((a, p) => a + p.v, 0)
    const R = 58, cx = M + R + 10, cy = y + R
    donut(cx, cy, R, 36, parts.map(p => ({ v: p.v, c: p.c })))
    line(`${nf(total, 0)} h`, cx - 36, cy - 9, 72, { font: F.bold, size: 13, align: 'center' })
    line('accounted for', cx - 36, cy + 6, 72, { size: 6.8, color: C.sub, align: 'center' })
    let ly = y + 10
    const lx = M + 2 * R + 34
    for (const p of parts) {
      doc.rect(lx, ly + 1, 9, 9).fill(p.c)
      line(`${p.l} – ${nf(p.v, 0)} h (${pct(p.v, total)})`, lx + 15, ly, 220, { size: 9 })
      ly += 18
    }
    if (sp.idling == null) line('No ignition on this tracker, so idling cannot be told from stopped.', lx, ly + 2, 240, { size: 7, color: C.sub })
    y += 2 * R + 18
  }

  y = title('Daily distance', 'km per day · lines over the days it moved', y)
  {
    const days = rv.days
    // The key sits on its own line above the bars, never over them.
    const box = { x: M + 30, y: y + 14, w: W - 40, h: Math.min(180, BOTTOM - y - 44) }
    const top = Math.max(50, ...days.map(d => d.km))
    const step = top > 300 ? 100 : top > 120 ? 50 : 20
    const ceil = Math.ceil(top / step) * step
    for (let v = 0; v <= ceil; v += step) {
      const yy = box.y + box.h - (v / ceil) * box.h
      doc.moveTo(box.x, yy).lineTo(box.x + box.w, yy).lineWidth(0.3).stroke(C.line)
      line(String(v), box.x - 30, yy - 3, 26, { size: 6.5, color: C.sub, align: 'right' })
    }
    const bw = box.w / days.length
    days.forEach((d, i) => {
      const h = (d.km / ceil) * box.h
      if (h > 0) doc.rect(box.x + i * bw + bw * 0.15, box.y + box.h - h, Math.max(0.8, bw * 0.7), h).fill(C.green)
    })
    const ref = (v: number | null, c: string, dash: [number, number], label: string, ly: number, lx: number) => {
      if (v == null) return
      const yy = box.y + box.h - (v / ceil) * box.h
      doc.moveTo(box.x, yy).lineTo(box.x + box.w, yy).lineWidth(1.2).dash(dash[0], { space: dash[1] }).stroke(c).undash()
      doc.moveTo(lx, ly + 4).lineTo(lx + 18, ly + 4).lineWidth(1.2).dash(dash[0], { space: dash[1] }).stroke(c).undash()
      line(label, lx + 22, ly, 128, { size: 7.5 })
    }
    ref(fig.activeKm.mean, C.orange, [5, 3], `Mean active: ${nf(fig.activeKm.mean, 0)} km`, box.y - 16, box.x + box.w - 150)
    ref(fig.activeKm.median, C.red, [1.5, 2], `Median active: ${nf(fig.activeKm.median, 0)} km`, box.y - 16, box.x + box.w - 300)
    const every = Math.max(1, Math.ceil(days.length / 10))
    days.forEach((d, i) => { if (i % every === 0) line(dayLabel(d.date), box.x + i * bw - 12, box.y + box.h + 4, 34, { size: 6.5, color: C.sub, align: 'center' }) })
    y = box.y + box.h + 20
  }

  // ════ page 3: when it drives, and the routes ════
  doc.addPage()
  y = head('when it drives')
  y = title('When it drives', fig.busiestDay != null && fig.peakHour != null
    ? `Busiest day ${WEEKDAYS[fig.busiestDay]} · Peak start hour ${String(fig.peakHour).padStart(2, '0')}:00 · ${pct0(fig.beforeNoonShare)} of trips start before noon`
    : 'no trips in the period', y)
  {
    const half = (W - 20) / 2
    line('Trips by day of week', M, y, half, { font: F.bold, size: 9, align: 'center' })
    line('Trips by hour of day (trip start)', M + half + 20, y, half, { font: F.bold, size: 9, align: 'center' })
    const h = 150
    const wcol = fig.byWeekday.map((_, i) => (i === fig.busiestDay ? C.deep : i === fig.quietestDay ? C.red : C.blue))
    vbars({ x: M + 6, y: y + 22, w: half - 12, h }, fig.byWeekday, wcol, WEEKDAYS.map(d => d.slice(0, 3)))
    const hcol = fig.byHour.map((_, i) => (i === fig.peakHour ? C.deep : C.violet))
    vbars({ x: M + half + 26, y: y + 22, w: half - 12, h }, fig.byHour, hcol, fig.byHour.map((_, i) => String(i).padStart(2, '0')), { every: 3, values: false })
    if (fig.peakHour != null) {
      const bw = (half - 12) / 24
      const top = Math.max(1, ...fig.byHour)
      line(`Peak ${String(fig.peakHour).padStart(2, '0')}:00`, M + half + 26 + fig.peakHour * bw - 25, y + 22 + h - (fig.byHour[fig.peakHour]! / top) * h - 10, 50 + bw, { size: 6.8, align: 'center' })
    }
    y += 22 + h + 30
  }

  y = title('Most frequent routes', 'between places where it stopped 10 min or more', y)
  if (fig.routes.length) {
    const rows = fig.routes.slice(0, 12).map(r => ({
      // Helvetica's WinAnsi has no →; › is in it.
      label: r.round ? `Round trip · ${r.from}` : `${r.from}  ›  ${r.to}`, v: r.trips, c: r.round ? C.orange : C.green,
      note: `${r.trips} trip${r.trips === 1 ? '' : 's'} · ${nf(r.km, 0)} km · ${nf(r.hours, 1)} h`,
    }))
    y = hbars(rows, y, 230, 16)
    doc.rect(M + 236, y + 7, 8, 8).fill(C.green)
    line('Point-to-point route', M + 248, y + 7, 110, { size: 7.5, color: C.sub })
    doc.rect(M + 360, y + 7, 8, 8).fill(C.orange)
    line('Round trip (returned to the same place)', M + 372, y + 7, 160, { size: 7.5, color: C.sub })
    y += 26
  } else {
    line('No trips between stops in the period.', M, y, W, { size: 8.5, color: C.sub })
    y += 16
  }

  // ── the movement web: the drives on the map, place to place ──
  {
    const byId = new Map(rv.places.map(p => [p.id, p]))
    const edgeMap = new Map<string, { from: number; to: number; trips: number; min: number; km: number }>()
    for (const t of rv.trips) {
      if (t.fromPlace === t.toPlace || !byId.has(t.fromPlace) || !byId.has(t.toPlace)) continue
      const k = `${t.fromPlace}>${t.toPlace}`
      const e = edgeMap.get(k) ?? { from: t.fromPlace, to: t.toPlace, trips: 0, min: 0, km: 0 }
      e.trips++; e.min += t.min; e.km += t.km
      edgeMap.set(k, e)
    }
    const edges = [...edgeMap.values()].sort((a, b) => b.trips - a.trips).slice(0, 30)
    if (edges.length) {
      const ids = [...new Set(edges.flatMap(e => [e.from, e.to]))].sort((a, b) => a - b)
      const keyRows = Math.ceil(Math.min(ids.length, 16) / 2)
      let webH = BOTTOM - y - 28 - keyRows * 11 - 12
      if (webH < 230) { doc.addPage(); y = head('movement web'); webH = Math.min(500, BOTTOM - y - 28 - keyRows * 11 - 12) }
      y = title('Movement web', 'each drive between two places · width = trips · the arrow shows the way', y)
      const nodes = ids.map(id => byId.get(id)!)
      const map = await prepareMap(rv, W, webH, nodes.map(p => [p.lat, p.lng]))
      const mx = M, my = y
      doc.save()
      doc.rect(mx, my, W, webH).clip()
      const proj = mapGround(map, mx, my, W, webH, 0.45)
      if (proj) {
        const max = Math.max(1, ...edges.map(e => e.trips))
        const at = (p: ReviewPlace) => ({ x: proj.px(p.lng), y: proj.py(p.lat) })
        const labels: { pt: (t: number) => { x: number; y: number }; text: string }[] = []
        // Quietest first, so the busy connections lie on top.
        const quietFirst = [...edges].reverse()
        quietFirst.forEach((e, k) => {
          const a = at(byId.get(e.from)!), b = at(byId.get(e.to)!)
          const w = 1.2 + 5 * Math.sqrt(e.trips / max)
          // Bowed to one side of the way it goes, so the drive back, going
          // the other way, bows to the other.
          const dx = b.x - a.x, dy = b.y - a.y
          const c = { x: (a.x + b.x) / 2 + dy * 0.16, y: (a.y + b.y) / 2 - dx * 0.16 }
          const pt = (t: number) => ({ x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t * t * b.x, y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t * t * b.y })
          doc.moveTo(a.x, a.y).quadraticCurveTo(c.x, c.y, b.x, b.y).lineWidth(w).strokeOpacity(0.75).lineCap('round').stroke(C.route)
          doc.strokeOpacity(1)
          // The arrowhead at 62%, turned along the curve.
          const p0 = pt(0.6), p1 = pt(0.64)
          const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x)
          const L = 5 + w, Wd = 3 + w * 0.7
          const tip = { x: p1.x + Math.cos(ang) * L * 0.5, y: p1.y + Math.sin(ang) * L * 0.5 }
          const back = { x: tip.x - Math.cos(ang) * L, y: tip.y - Math.sin(ang) * L }
          doc.polygon([tip.x, tip.y], [back.x + Math.sin(ang) * Wd, back.y - Math.cos(ang) * Wd], [back.x - Math.sin(ang) * Wd, back.y + Math.cos(ang) * Wd])
            .lineWidth(0.8).fillAndStroke(C.route, '#ffffff')
          // The six busiest connections carry their count and drive time.
          if (quietFirst.length - 1 - k < 6) labels.push({ pt, text: `${e.trips}× · ${dur(e.min / e.trips)}` })
        })
        const maxH = Math.max(1, ...nodes.map(p => p.hours))
        for (const p of [...nodes].sort((a, b) => b.id - a.id)) {
          const q = at(p)
          placeDot(p, q.x, q.y, 6 + 6 * Math.sqrt(Math.min(1, p.hours / maxH)))
        }
        // Labels, busiest first, each at the first point along its curve
        // where it covers neither another label nor a place; else left off.
        const taken: { x: number; y: number; w: number; h: number }[] = nodes.map(p => { const q = at(p); return { x: q.x - 12, y: q.y - 12, w: 24, h: 24 } })
        const meets = (b: { x: number; y: number; w: number; h: number }) => taken.some(o => b.x < o.x + o.w && o.x < b.x + b.w && b.y < o.y + o.h && o.y < b.y + b.h)
        for (const l of labels.reverse()) {
          doc.font(F.bold).fontSize(6.8)
          const tw = doc.widthOfString(l.text) + 8
          for (const t of [0.5, 0.4, 0.6, 0.32, 0.68, 0.25, 0.75]) {
            const m = l.pt(t)
            const box = { x: m.x - tw / 2, y: m.y - 6, w: tw, h: 12 }
            if (meets(box)) continue
            taken.push(box)
            doc.roundedRect(box.x, box.y, tw, 12, 3).fillOpacity(0.92).fill('#ffffff').fillOpacity(1)
            line(l.text, box.x, m.y - 3.5, tw, { font: F.bold, size: 6.8, color: C.route, align: 'center' })
            break
          }
        }
      }
      doc.restore()
      doc.rect(mx, my, W, webH).lineWidth(0.6).stroke(C.line)
      line('© OpenStreetMap contributors', mx, my + webH - 10, W - 6, { size: 6, color: C.sub, align: 'right' })
      y = my + webH + 8
      const shown = nodes.slice(0, 16), cw = W / 2
      shown.forEach((p, i) => {
        const x = M + Math.floor(i / keyRows) * cw, yy = y + (i % keyRows) * 11
        doc.circle(x + 5, yy + 3.5, 3.5).fill(KIND_COLOR[kindOf(p)])
        line(`${p.id}. ${shortPlaceName(p)}`, x + 12, yy, cw - 60, { size: 7.2 })
        line(`${nf(p.hours, 1)} h`, x + cw - 56, yy, 44, { size: 7.2, color: C.sub, align: 'right' })
      })
      y += keyRows * 11 + 8
    }
  }

  // ════ page 4: sites, nights ════
  doc.addPage()
  y = head('sites')
  y = title('Top sites at a glance', 'home and the top 10 other places · activity from Google Maps · times are median arrival / departure', y)
  {
    const homeRow = fig.sites.find(x => x.home)
    const rows = [...(homeRow ? [homeRow] : []), ...fig.sites.filter(x => !x.home).slice(0, 10)]
    y = table([
      { h: 'Site', w: 168 }, { h: 'Activity', w: 76 }, { h: 'Hours', w: 40, r: true }, { h: 'Visits', w: 38, r: true }, { h: 'Days', w: 34, r: true },
      { h: 'Avg / visit', w: 54, r: true }, { h: 'Arrive', w: 44, r: true }, { h: 'Depart', w: W - 454, r: true },
    ], rows.map(x => ({
      dot: KIND_COLOR[x.home ? 'home' : x.kind], bold: x.home,
      cells: [x.name, x.home ? 'Home' : x.activity ?? '-', nf(x.hours, 1), String(x.visits), String(x.days), `${nf(x.avgH, 2)} h`, hhmm(x.arrive), hhmm(x.depart)],
    })), y)
    y += 10
  }

  if (areas && y + 110 < BOTTOM) {
    y = title('Where it spent each night', 'where the unit stood at 02:00, each night of the period', y)
    const n = areas.nightly.length
    const cw = W / n
    areas.nightly.forEach((d, i) => {
      const x = M + i * cw
      doc.rect(x + 0.6, y, Math.max(1, cw - 1.2), 18).fill(d.kind ? KIND_COLOR[d.kind] : C.line)
    })
    const every = Math.max(1, Math.ceil(n / 15))
    areas.nightly.forEach((d, i) => { if (i % every === 0) line(dayLabel(d.date), M + i * cw - 8, y + 22, cw + 16, { size: 6.3, color: C.sub, align: 'center' }) })
    y += 36
    let kx = M
    for (const k of ['home', 'work', 'elsewhere', null] as (PlaceKind | null)[]) {
      const count = k ? areas.nights[k] : areas.nightly.filter(d => !d.kind).length
      const label = `${k ? (k === 'home' ? 'Home area' : KIND_SHORT[k]) : 'Moving or no stop'}  ${count}`
      doc.rect(kx, y + 1, 7, 7).fill(k ? KIND_COLOR[k] : C.line)
      line(label, kx + 11, y, 140, { size: 7.5 })
      doc.font(F.reg).fontSize(7.5)
      kx += doc.widthOfString(label) + 28
    }
    y += 16
    doc.font(F.reg).fontSize(6.8).fillColor(C.sub).text(
      'Work sites are the company\'s factories and weighbridge yards and its own site fences. The home area is the place away from work where the unit spends the most nights, and anywhere within 3 km of it; nothing on record names a driver\'s house, so read it as where the unit sleeps.',
      M, y, { width: W, lineGap: 1 })
  }

  // ════ page 5: evidence ════
  doc.addPage()
  y = head('evidence')
  y = title('Fleet tracking evidence', 'the route over the period, places numbered by time spent', y)
  const mapH = 400
  const map = await prepareMap(rv, W, mapH)
  {
    const mx = M, my = y
    doc.save()
    doc.rect(mx, my, W, mapH).clip()
    const proj = mapGround(map, mx, my, W, mapH, 0.3)
    if (proj) {
      const { px, py } = proj
      for (const t of rv.tracks) {
        if (t.path.length < 2) continue
        doc.moveTo(px(t.path[0]![1]), py(t.path[0]![0]))
        for (const [la, lo] of t.path.slice(1)) doc.lineTo(px(lo), py(la))
        doc.lineWidth(1.6).strokeOpacity(0.75).lineJoin('round').stroke(C.route)
      }
      doc.strokeOpacity(1)
      const top = rv.places.slice(0, 14)
      const maxH = Math.max(1, ...top.slice(0, 2).map(p => p.hours))
      for (const p of [...top].reverse()) placeDot(p, px(p.lng), py(p.lat), 6 + 6 * Math.sqrt(Math.min(1, p.hours / maxH)))
    }
    doc.restore()
    doc.rect(mx, my, W, mapH).lineWidth(0.6).stroke(C.line)
    line('© OpenStreetMap contributors', mx, my + mapH - 10, W - 6, { size: 6, color: C.sub, align: 'right' })
    y = my + mapH + 8
    // The numbers' key, two columns.
    const top = rv.places.slice(0, 14)
    const half = Math.ceil(top.length / 2), cw = W / 2
    top.forEach((p, i) => {
      const x = M + Math.floor(i / half) * cw, yy = y + (i % half) * 11
      doc.circle(x + 5, yy + 3.5, 3.5).fill(KIND_COLOR[kindOf(p)])
      line(`${p.id}. ${shortPlaceName(p)}`, x + 12, yy, cw - 60, { size: 7.2 })
      line(`${nf(p.hours, 1)} h`, x + cw - 56, yy, 44, { size: 7.2, color: C.sub, align: 'right' })
    })
    y += half * 11 + 14
  }

  // Gate times: when it came and went at work sites — the times to pull CCTV for.
  {
    type Gate = { site: string; start: number; end: number; min: number }
    const gates: Gate[] = rv.stops.filter(st => rv.places.find(p => p.id === st.place)?.kind === 'work')
      .map(st => ({ site: shortPlaceName(rv.places.find(p => p.id === st.place)!), start: st.start, end: st.end, min: st.min }))
    const rows = gates.sort((a, b) => b.start - a.start).slice(0, Math.max(0, Math.floor((BOTTOM - y - 50) / 15)))
    if (rows.length) {
      y = title('Gate times to check against CCTV', 'the latest arrivals at and departures from work sites', y)
      table([
        { h: 'Site', w: 210 }, { h: 'Date', w: 90 }, { h: 'Arrived', w: 70, r: true }, { h: 'Left', w: 70, r: true }, { h: 'Inside', w: W - 440, r: true },
      ], rows.map(g => ({ cells: [g.site, dayLabel(eatDate(g.start), true), eatClock(g.start), eatClock(g.end), dur(g.min)] })), y)
    }
  }

  // ── footers ──
  const source = [
    // The source is named as the operator's platform (operator, 2026-10-08),
    // not the tracking provider or our own table behind it.
    'Rai Operations',
    q.distanceSource === 'odometer' ? 'distance: tracker odometer' : q.distanceSource === 'mixed' ? 'distance: odometer + GPS' : 'distance: GPS track',
    q.gpsVsOdometerPct != null ? `GPS agrees within ${nf(q.gpsVsOdometerPct, 1)}%` : null,
    fuelTot != null ? `fuel estimated at ${kmpl} km/L` : null,
    rv.incompleteDays.length ? `${rv.incompleteDays.length} day(s) incomplete (tracker history unreachable)` : null,
  ].filter(Boolean).join('  ·  ')
  const built = new Date(rv.builtAt + TZ_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')
  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    doc.page.margins.bottom = 0          // the footer sits in the margin; do not let it spill a page
    const fy = PAGE_H - M + 6
    doc.moveTo(M, fy - 6).lineTo(M + W, fy - 6).lineWidth(0.5).stroke(C.line)
    line(source, M, fy, W - 160, { size: 6.5, color: C.sub })
    line(`${PREPARED_BY}  ·  built ${built} EAT  ·  ${i + 1}/${range.count}`, M + W - 220, fy, 220, { size: 6.5, color: C.sub, align: 'right' })
  }
  doc.end()
  return done
}
