/**
 * The Logbook as a PDF — a vehicle tracking report, laid out the way the
 * hand-built KDP 365T report (Aug–Sep 2026) was (operator, 2026-10-09: "the
 * type of information in the PowerPoint, organised in our PDF"):
 *
 *   Page 1 — the cover (vehicle, subject, period, prepared) and the executive
 *            summary: six headline figures, four key findings and Time
 *            Utilisation (the period's hours as a donut).
 *   Then, flowing on from page 2 — a section starts a new page only when it
 *   does not fit below the last (operator, 2026-10-09: no extra white space):
 *     Where the Vehicle Spent its Time, place by place with home first; Daily
 *     Distance against the active-day mean and median; Overnight Locations;
 *     Driving Patterns (trips by weekday and by start hour), Most Frequent
 *     Routes;
 *     Top Sites at a Glance, with what each is (a bank, a restaurant, a
 *     clinic) and median arrival and departure;
 *     Site Visits: each time it went onto a site plan or a company geofence,
 *     when it arrived, the areas inside it stood in and for how long, and
 *     when it left;
 *     Route Map and Key Locations: the route with its places numbered and
 *     named.
 *   Titles in Title Case (operator, 2026-10-09).
 *
 * In black and white, with green and amber in the charts only (see C); the
 * map in grey under a black route (operator, 2026-10-09).
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
import type { SiteVisit } from './usage-review.siteplans.js'
import { reportFigures, shortPlaceName, WEEKDAYS } from './usage-review.report.js'

/* Hallmark · component: report charts (PDF) · genre: editorial · theme: custom
 * vibe: "black-and-white report, green for work, amber to look at"
 * anchor hue: 150 (green) · accent: oklch(50% 0.12 150) · second: oklch(80% 0.15 78) amber
 * axes: light / sans (Helvetica) / chromatic-other (green)
 * pre-emit critique: P4 H5 E4 S5 R5 V4
 */
// Black and white with two colours in the charts only (operator, 2026-10-09:
// a black-and-white report, colour in the bar and pie charts, green never
// beside blue, red or purple, no purple bars). Green is work — driving and
// the work sites; amber is what to look at — other places, idling, round
// trips, the quiet day. No red or purple anywhere; the one blue is the mean
// line on Daily Distance, asked for by name. Greys lean to the green (hue 150), never flat; the
// paper is a tinted white, not #fff. Values are OKLCH, written as hex because
// pdfkit takes no OKLCH.
const C = {
  ink: '#121813',       // oklch(20% 0.012 150)
  sub: '#545a55',       // oklch(46% 0.010 150)
  faint: '#959a96',     // oklch(68% 0.008 150)
  line: '#d8dcd9',      // oklch(89% 0.006 150)
  panel: '#f1f5f1',     // oklch(96.5% 0.006 150)
  paper: '#fafdfa',     // oklch(99% 0.004 150)
  dark: '#343a35',      // oklch(34% 0.012 150): home
  light: '#cdd2ce',     // oklch(86% 0.008 150)
  pale: '#e5e9e6',      // oklch(93% 0.006 150): nothing to show
  green: '#21763c',     // oklch(50% 0.12 150): work, driving, the peak
  greenSoft: '#63a471', // oklch(66% 0.10 150): the ordinary bars
  amber: '#f2b036',     // oklch(80% 0.15 78): elsewhere, idling, the low point
  // Daily Distance's reference lines only (operator, 2026-10-09: "the median
  // a yellow line, the mean a sky blue line").
  yellow: '#debb19',    // oklch(80% 0.16 95): the median
  sky: '#37aae3',       // oklch(70% 0.13 235): the mean
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

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (b: Buffer) => {
  let c = 0xffffffff
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * A tile in grey, for the black-and-white report. OpenStreetMap's tiles are
 * paletted PNGs, so only the palette is rewritten — each colour to its
 * luminance — and the pixels are not touched. Any other PNG comes back as it
 * was. Exported for the tests.
 */
export function greyPng(buf: Buffer): Buffer {
  if (buf.length < 33 || buf.toString('latin1', 1, 4) !== 'PNG' || buf[25] !== 3) return buf
  const out = Buffer.from(buf)
  for (let o = 8; o + 12 <= out.length;) {
    const len = out.readUInt32BE(o), type = out.toString('latin1', o + 4, o + 8)
    if (type === 'PLTE') {
      for (let i = o + 8; i + 3 <= o + 8 + len; i += 3) {
        const g = Math.round(0.299 * out[i]! + 0.587 * out[i + 1]! + 0.114 * out[i + 2]!)
        out[i] = out[i + 1] = out[i + 2] = g
      }
      out.writeUInt32BE(crc32(out.subarray(o + 4, o + 8 + len)), o + 8 + len)
      return out
    }
    if (type === 'IDAT' || type === 'IEND') break
    o += 12 + len
  }
  return buf
}

const tileCache = new Map<string, Buffer | null>()
async function tile(z: number, x: number, y: number): Promise<Buffer | null> {
  const k = `${z}/${x}/${y}`
  if (tileCache.has(k)) return tileCache.get(k) ?? null
  try {
    const res = await fetch(`https://tile.openstreetmap.org/${k}.png`, { headers: { 'User-Agent': TILE_UA }, signal: AbortSignal.timeout(8_000) })
    const buf = res.ok ? greyPng(Buffer.from(await res.arrayBuffer())) : null
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

/** Fetch what the map needs before drawing (pdfkit draws synchronously). */
async function prepareMap(rv: ReadyReview, boxW: number, boxH: number) {
  const pts: [number, number][] = rv.tracks.flatMap(t => t.path)
  for (const p of rv.places.slice(0, 10)) pts.push([p.lat, p.lng])
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
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const eatDate = (ms: number) => new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10)
/** "Mon 5 Oct 07:12" in EAT; only "07:12" on the same day as `sameDayAs`. */
const when = (ms: number, sameDayAs?: number) => {
  const d = new Date(ms + TZ_OFFSET_MS)
  const t = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  if (sameDayAs != null && eatDate(sameDayAs) === eatDate(ms)) return t
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${t}`
}
/** "45 min", "9 h 26 min", "3 d 4 h". */
const span = (ms: number) => {
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60), r = m % 60
  if (h < 48) return r ? `${h} h ${r} min` : `${h} h`
  return `${Math.floor(h / 24)} d ${h % 24} h`
}

// ── drawing ──────────────────────────────────────────────────────────────────

const KIND_COLOR: Record<PlaceKind, string> = { home: C.dark, work: C.green, elsewhere: C.amber }
/** The number on a place's circle: paper on the dark fills, ink on amber. */
const KIND_TEXT: Record<PlaceKind, string> = { home: C.paper, work: C.paper, elsewhere: C.ink }
const KIND_SHORT: Record<PlaceKind, string> = { work: 'Work site', home: 'Home area', elsewhere: 'Other places' }
const kindOf = (p: ReviewPlace): PlaceKind => p.kind ?? 'elsewhere'

/**
 * @param subject the driver on the vehicle, as the page knows it; null when
 *   none is assigned. The cover's subject is always "Highlights", the page
 *   the report comes from.
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
  /** One line of text, never wrapped: the guard against rows running together.
   *  pdfkit wraps any text given a width, `lineBreak: false` or not, and its
   *  word-by-word measure runs a hair wider than widthOfString — a label cut to
   *  fit exactly still dropped "Services…" onto the row below (2026-10-09). So
   *  the text is cut with a margin, and the box is one line high: a second
   *  line is never drawn. */
  const line = (text: string, x: number, yy: number, width: number, o: { font?: string; size?: number; color?: string; align?: 'left' | 'right' | 'center' } = {}) => {
    const font = o.font ?? F.reg, size = o.size ?? 8
    doc.font(font).fontSize(size).fillColor(o.color ?? C.ink)
      .text(fit(text, width - 2, font, size), x, yy, { width, height: size * 1.4, align: o.align ?? 'left', lineBreak: false })
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
      doc.moveTo(cx + ri * Math.cos(a0), cy + ri * Math.sin(a0)).lineTo(cx + r * Math.cos(a0), cy + r * Math.sin(a0)).lineWidth(1.2).stroke(C.paper)
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
  /** Vertical bars in a box, a value over each, a label under. With `axis`,
   *  a scale up the left side (counts, light gridlines) instead of a value
   *  over each bar, captioned `axis`. Returns the value the box's top stands for. */
  const vbars = (box: { x: number; y: number; w: number; h: number }, vals: number[], colors: string[], labels: string[], o: { every?: number; values?: boolean; axis?: string; labelSize?: number } = {}) => {
    let top = Math.max(1, ...vals)
    if (o.axis) {
      const raw = top / 4, mag = 10 ** Math.floor(Math.log10(raw))
      const step = Math.max(1, [1, 2, 5, 10].map(k => k * mag).find(k => k >= raw) ?? 10 * mag)
      top = Math.ceil(top / step) * step
      for (let v = 0; v <= top; v += step) {
        const yy = box.y + box.h - (v / top) * box.h
        if (v > 0) doc.moveTo(box.x, yy).lineTo(box.x + box.w, yy).lineWidth(0.3).stroke(C.line)
        line(String(v), box.x - 22, yy - 3, 18, { size: 6.3, color: C.sub, align: 'right' })
      }
      line(o.axis, box.x - 22, box.y - 12, 40, { size: 6.3, color: C.sub })
    }
    const bw = box.w / vals.length
    doc.moveTo(box.x, box.y + box.h).lineTo(box.x + box.w, box.y + box.h).lineWidth(0.6).stroke(C.faint)
    vals.forEach((v, i) => {
      const h = (v / top) * box.h
      if (h > 0) doc.rect(box.x + i * bw + bw * 0.14, box.y + box.h - h, bw * 0.72, h).fill(colors[i]!)
      if (!o.axis && o.values !== false && v > 0) line(String(v), box.x + i * bw, box.y + box.h - h - 9, bw, { size: 6.5, color: C.sub, align: 'center' })
      if (i % (o.every ?? 1) === 0) line(labels[i]!, box.x + i * bw - 4, box.y + box.h + 4, bw + 8, { size: o.labelSize ?? 6.5, color: C.sub, align: 'center' })
    })
    return top
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
    doc.rect(mx, my, w, h).fill(C.panel)
    if (!map) return null
    const { frame, tiles: tl } = map
    const size = 256 * frame.scale
    for (const t of tl) {
      if (!t.buf) continue
      try { doc.image(t.buf, mx + (t.x * 256 - frame.x0) * frame.scale, my + (t.y * 256 - frame.y0) * frame.scale, { width: size, height: size }) } catch { /* a bad tile is skipped */ }
    }
    doc.rect(mx, my, w, h).fillOpacity(soften).fill(C.paper).fillOpacity(1)
    return {
      px: (lng: number) => mx + (lon2x(lng, frame.z) - frame.x0) * frame.scale,
      py: (lat: number) => my + (lat2y(lat, frame.z) - frame.y0) * frame.scale,
    }
  }
  /** A place as a numbered circle, in its kind's shade. */
  const placeDot = (p: ReviewPlace, x: number, yy: number, r: number) => {
    doc.circle(x, yy, r).fill(KIND_COLOR[kindOf(p)])
    doc.circle(x, yy, r).lineWidth(1.2).stroke(C.paper)
    doc.font(F.bold).fontSize(r > 9 ? 8 : 7).fillColor(KIND_TEXT[kindOf(p)]).text(String(p.id), x - 10, yy - (r > 9 ? 4 : 3.5), { width: 20, align: 'center', lineBreak: false })
  }

  const period = `${dayLabel(rv.period.from, true)} – ${dayLabel(rv.period.to, true)}`
  const prepared = (() => { const d = new Date(rv.builtAt + TZ_OFFSET_MS); return `${String(d.getUTCDate()).padStart(2, '0')} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getUTCMonth()]} ${d.getUTCFullYear()}` })()

  /** Overnight Locations' height: title, strip, dates, key and the note. */
  const NIGHTS_H = 128
  /** A new section: on the same page when `need` points fit below what is
   *  there, else on a fresh page under the running head. */
  const section = (y: number, need: number, name: string) => {
    if (y + need <= BOTTOM) return y + 8
    doc.addPage()
    return head(name)
  }

  /** The running head on pages 2 on: logos, the plate and the period. */
  const head = (section: string) => {
    doc.rect(0, 0, 595.28, 4).fill(C.ink)
    const rai = logo('rai-group-logo.jpeg'), ogc = logo('ogc-logo.png')
    if (rai) try { doc.image(rai, M, M - 14, { fit: [26, 26] }) } catch { /* no logo */ }
    if (ogc) try { doc.image(ogc, M + W - 25, M - 10, { fit: [25, 18], align: 'right', valign: 'center' }) } catch { /* no logo */ }
    line(`${veh.plate}  ·  ${section}`, M + 34, M - 9, W * 0.6, { font: F.bold, size: 9 })
    line(period, M + 34, M + 2, W * 0.6, { size: 7.5, color: C.sub })
    doc.moveTo(M, M + 18).lineTo(M + W, M + 18).lineWidth(0.6).stroke(C.line)
    return M + 30
  }

  // ════ page 1: cover and executive summary ════
  {
    doc.rect(0, 0, 595.28, 6).fill(C.ink)
    const rai = logo('rai-group-logo.jpeg'), ogc = logo('ogc-logo.png')
    if (rai) try { doc.image(rai, M, M - 6, { fit: [64, 64] }) } catch { /* no logo */ }
    if (ogc) try { doc.image(ogc, M + W - 50, M + 10, { fit: [50, 36], align: 'right', valign: 'center' }) } catch { /* no logo */ }
    line('VEHICLE TRACKING REPORT', M + 76, M + 4, W - 170, { font: F.bold, size: 9, color: C.sub })
    line(veh.plate, M + 76, M + 16, W - 170, { font: F.bold, size: 30 })
    line([veh.organisation, veh.wialonName && veh.wialonName !== veh.plate ? veh.wialonName : null].filter(Boolean).join('  ·  '), M + 76, M + 48, W - 170, { size: 8.5, color: C.sub })
  }
  let y = M + 78
  {
    // The subject is the Highlights page the report comes from (operator,
    // 2026-10-09); the driver, when the page knows one, beside it. Each
    // column as wide as its value needs — the period was cut short at a
    // quarter of the width.
    const driver = subject?.trim()
    const meta: [string, string][] = [
      ['SUBJECT', 'Highlights'], ...(driver ? [['DRIVER', driver] as [string, string]] : []),
      ['REVIEW PERIOD', period], ['PREPARED', prepared], ['PREPARED BY', PREPARED_BY],
    ]
    // The values' own widths, the room left shared out evenly; the type a
    // little smaller only when even that does not fit.
    let size = 9.5
    const need = () => meta.map(([l, v]) => {
      const lw = doc.font(F.bold).fontSize(6.8).widthOfString(l)
      return Math.max(lw, doc.font(F.bold).fontSize(size).widthOfString(v)) + 20
    })
    let widths = need()
    while (widths.reduce((a, w) => a + w, 0) > W && size > 7.5) { size -= 0.5; widths = need() }
    const spare = Math.max(0, W - widths.reduce((a, w) => a + w, 0)) / meta.length
    doc.rect(M, y, W, 40).fill(C.panel)
    let mx = M
    meta.forEach(([l, v], i) => {
      const cw = widths[i]! + spare
      line(l, mx + 10, y + 8, cw - 14, { font: F.bold, size: 6.8, color: C.sub })
      line(v, mx + 10, y + 20, cw - 14, { font: F.bold, size })
      mx += cw
    })
    y += 58
  }

  y = title('Executive Summary', `${veh.plate} over ${rv.period.days} days`, y)
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
      doc.rect(x, yy, 3, ch).fill(C.ink)
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
      doc.circle(M + 11, yy + 12, 11).fill(C.ink)
      line(String(i + 1), M, yy + 7.5, 22, { font: F.bold, size: 10, color: C.paper, align: 'center' })
      line(f.title, M + 32, yy + 2, W - 190, { font: F.bold, size: 10 })
      doc.font(F.reg).fontSize(8.5).fillColor(C.sub).text(f.text, M + 32, yy + 16, { width: W - 200, height: 24, ellipsis: true })
      line(f.stat, M + W - 150, yy + 2, 150, { font: F.bold, size: 18, align: 'right' })
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
    y += 32 + 16
  }

  /** Time Utilisation: the period's hours as a donut with its key. `R` is
   *  the donut's outer radius; returns the y under it. */
  const timeUse = (y0: number, R: number) => {
    const sp = fig.split
    const all = sp.driving + (sp.idling ?? 0) + sp.home + sp.away
    let yy = title('Time Utilisation', `Driving ${pct(sp.driving, all)}  ·  Idling ${sp.idling != null ? pct(sp.idling, all) : '-'}  ·  Stopped ${pct(sp.home + sp.away, all)}  ·  ${s.activeDays}/${s.calendarDays} active days`, y0)
    const parts = [
      { l: 'Driving', v: sp.driving, c: C.green },
      { l: 'Idling', v: sp.idling ?? 0, c: C.amber },
      { l: 'Stopped at home', v: sp.home, c: C.dark },
      { l: 'Stopped away', v: sp.away, c: C.light },
    ]
    const total = parts.reduce((a, p) => a + p.v, 0)
    const ri = R * 0.62, cx = M + R + 10, cy = yy + R
    donut(cx, cy, R, ri, parts.map(p => ({ v: p.v, c: p.c })))
    line(`${nf(total, 0)} h`, cx - ri, cy - 9, 2 * ri, { font: F.bold, size: 13, align: 'center' })
    line('accounted for', cx - ri, cy + 6, 2 * ri, { size: 6.8, color: C.sub, align: 'center' })
    let ly = cy - 2 * 18 + 1
    const lx = M + 2 * R + 34
    for (const p of parts) {
      doc.rect(lx, ly + 1, 9, 9).fill(p.c)
      line(`${p.l} – ${nf(p.v, 0)} h (${pct(p.v, total)})`, lx + 15, ly, 220, { size: 9 })
      ly += 18
    }
    if (sp.idling == null) line('No ignition on this tracker, so idling cannot be told from stopped.', lx, ly + 2, 240, { size: 7, color: C.sub })
    yy += 2 * R + 18
    return yy
  }
  // On the first page, in the room under the summary (operator, 2026-10-09:
  // "the pie chart can cover the space on the first page"), as large as that
  // room allows; on page 2 only if the first page has too little left.
  const roomR = Math.min(70, (BOTTOM - y - 28 - 18) / 2)
  const timeOnCover = roomR >= 46
  if (timeOnCover) y = timeUse(y, roomR)

  // ════ page 2: where the time went, how it divided, day by day ════
  doc.addPage()
  y = head('Time and Distance')
  y = title('Where the Vehicle Spent its Time', `${nf(fig.stoppedH, 0)} h stopped at ${s.places} places · stops of 10 min or more`, y)
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

  if (!timeOnCover) y = timeUse(y, 58)

  y = title('Daily Distance', 'km per day · lines over the days it moved', y)
  {
    const days = rv.days
    // The key sits on its own line above the bars, never over them.
    // Room kept below for Overnight Locations, when the chart can spare it.
    const room = BOTTOM - y - 44
    const box = { x: M + 30, y: y + 14, w: W - 40, h: Math.min(180, areas && room - NIGHTS_H >= 110 ? room - NIGHTS_H : room) }
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
      if (h > 0) doc.rect(box.x + i * bw + bw * 0.15, box.y + box.h - h, Math.max(0.8, bw * 0.7), h).fill(C.greenSoft)
    })
    const ref = (v: number | null, c: string, dash: [number, number], label: string, ly: number, lx: number) => {
      if (v == null) return
      const yy = box.y + box.h - (v / ceil) * box.h
      doc.moveTo(box.x, yy).lineTo(box.x + box.w, yy).lineWidth(1.6).dash(dash[0], { space: dash[1] }).stroke(c).undash()
      doc.moveTo(lx, ly + 4).lineTo(lx + 18, ly + 4).lineWidth(1.6).dash(dash[0], { space: dash[1] }).stroke(c).undash()
      line(label, lx + 22, ly, 128, { size: 7.5 })
    }
    ref(fig.activeKm.mean, C.sky, [5, 3], `Mean active: ${nf(fig.activeKm.mean, 0)} km`, box.y - 16, box.x + box.w - 150)
    ref(fig.activeKm.median, C.yellow, [3, 2], `Median active: ${nf(fig.activeKm.median, 0)} km`, box.y - 16, box.x + box.w - 300)
    const every = Math.max(1, Math.ceil(days.length / 10))
    days.forEach((d, i) => { if (i % every === 0) line(dayLabel(d.date), box.x + i * bw - 12, box.y + box.h + 4, 34, { size: 6.5, color: C.sub, align: 'center' }) })
    y = box.y + box.h + 20
  }

  // Overnight Locations, below Daily Distance (operator, 2026-10-09).
  if (areas) {
    y = section(y - 8, NIGHTS_H - 8, 'Overnight Locations')
    y = title('Overnight Locations', 'where the unit stood at 02:00, each night of the period', y)
    const n = areas.nightly.length
    const cw = W / n
    areas.nightly.forEach((d, i) => {
      const x = M + i * cw
      doc.rect(x + 0.6, y, Math.max(1, cw - 1.2), 18).fill(d.kind ? KIND_COLOR[d.kind] : C.pale)
    })
    const every = Math.max(1, Math.ceil(n / 15))
    areas.nightly.forEach((d, i) => { if (i % every === 0) line(dayLabel(d.date), M + i * cw - 8, y + 22, cw + 16, { size: 6.3, color: C.sub, align: 'center' }) })
    y += 36
    let kx = M
    for (const k of ['home', 'work', 'elsewhere', null] as (PlaceKind | null)[]) {
      const count = k ? areas.nights[k] : areas.nightly.filter(d => !d.kind).length
      const label = `${k ? (k === 'home' ? 'Home area' : KIND_SHORT[k]) : 'Moving or no stop'}  ${count}`
      doc.rect(kx, y + 1, 7, 7).fill(k ? KIND_COLOR[k] : C.pale)
      line(label, kx + 11, y, 140, { size: 7.5 })
      doc.font(F.reg).fontSize(7.5)
      kx += doc.widthOfString(label) + 28
    }
    y += 16
    doc.font(F.reg).fontSize(6.8).fillColor(C.sub).text(
      'Work sites are the company\'s factories and weighbridge yards and its own site fences. The home area is the place away from work where the unit spends the most nights, and anywhere within 3 km of it; nothing on record names a driver\'s house, so read it as where the unit sleeps.',
      M, y, { width: W, lineGap: 1 })
    y = doc.y + 10
  }


  // ════ when it drives, and the routes ════
  y = section(y, 230, 'Driving Patterns')
  y = title('Driving Patterns', fig.busiestDay != null && fig.peakHour != null
    ? `Busiest day ${WEEKDAYS[fig.busiestDay]} · Peak start hour ${String(fig.peakHour).padStart(2, '0')}:00 · ${pct0(fig.beforeNoonShare)} of trips start before noon`
    : 'no trips in the period', y)
  {
    const half = (W - 20) / 2
    line('Trips by Day of Week', M, y, half, { font: F.bold, size: 9, align: 'center' })
    line('Trips by Hour of Day', M + half + 20, y, half, { font: F.bold, size: 9, align: 'center' })
    const h = 150
    const wcol = fig.byWeekday.map((_, i) => (i === fig.busiestDay ? C.green : i === fig.quietestDay ? C.amber : C.greenSoft))
    vbars({ x: M + 6, y: y + 22, w: half - 12, h }, fig.byWeekday, wcol, WEEKDAYS.map(d => d.slice(0, 3)))
    const hcol = fig.byHour.map((_, i) => (i === fig.peakHour ? C.green : C.greenSoft))
    // Every hour named under its bar, and a scale of trips up the side
    // (operator, 2026-10-09: "add the hours on the axis").
    const top = vbars({ x: M + half + 26, y: y + 22, w: half - 12, h }, fig.byHour, hcol, fig.byHour.map((_, i) => String(i).padStart(2, '0')), { axis: 'trips', labelSize: 5.8 })
    line('hour of day', M + half + 26, y + 22 + h + 13, half - 12, { size: 6.3, color: C.sub, align: 'center' })
    if (fig.peakHour != null) {
      const bw = (half - 12) / 24
      line(`Peak ${String(fig.peakHour).padStart(2, '0')}:00`, M + half + 26 + fig.peakHour * bw - 25, y + 22 + h - (fig.byHour[fig.peakHour]! / top) * h - 10, 50 + bw, { size: 6.8, align: 'center' })
    }
    y += 22 + h + 30
  }

  // Its own page when its rows would not fit under Driving Patterns.
  y = section(y - 8, 40 + 16 * Math.max(1, Math.min(12, fig.routes.length)) + 26, 'Most Frequent Routes')
  y = title('Most Frequent Routes', 'between places where it stopped 10 min or more', y)
  if (fig.routes.length) {
    const rows = fig.routes.slice(0, 12).map(r => ({
      // Helvetica's WinAnsi has no →; › is in it.
      label: r.round ? `Round trip · ${r.from}` : `${r.from}  ›  ${r.to}`, v: r.trips, c: r.round ? C.amber : C.greenSoft,
      note: `${r.trips} trip${r.trips === 1 ? '' : 's'} · ${nf(r.km, 0)} km · ${nf(r.hours, 1)} h`,
    }))
    y = hbars(rows, y, 230, 16)
    doc.rect(M + 236, y + 7, 8, 8).fill(C.greenSoft)
    line('Point-to-point route', M + 248, y + 7, 110, { size: 7.5, color: C.sub })
    doc.rect(M + 360, y + 7, 8, 8).fill(C.amber)
    line('Round trip (returned to the same place)', M + 372, y + 7, 160, { size: 7.5, color: C.sub })
    y += 26
  } else {
    line('No trips between stops in the period.', M, y, W, { size: 8.5, color: C.sub })
    y += 16
  }

  // ════ sites ════
  y = section(y, 40 + 15 * (1 + Math.min(11, fig.sites.length)), 'Top Sites')
  y = title('Top Sites at a Glance', 'home and the top 10 other places · activity read from each name and Google Maps · times are median arrival / departure', y)
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

  // ════ site visits ════
  /* Hallmark · component: site-visits ledger (PDF) · genre: editorial · theme: custom (the report's C tokens)
   * vibe: "an austere ledger, a day at a time" · redesign of the row-per-area table
   * structure: day band › visit block (time gutter · site, stay bar, stays in order · time on site)
   * pre-emit critique: P5 H5 E4 S5 R5 V4
   */
  // Each time it went onto a site plan or one of the organisation's geofences
  // (operator, 2026-10-09: "at what time did it arrive, which area within the
  // organisation was it seen, for how long, when it departed"), read from the
  // track itself (usage-review.siteplans siteVisits).
  //
  // A ledger, a day at a time. Each visit is one block: arrival over departure
  // in the gutter; the site, a bar of where on it the time went and the stays
  // in order beneath; the time on site on the right. The bar is the one chart
  // here, so it alone carries the green: the longest stay full, the other
  // named areas soft, the site's own ground grey, the moves between them pale.
  // The row-per-area table it replaced read a month as one long even list. A
  // block never splits over a page, and a day carried over says so.
  {
    const visits = rv.siteVisits ?? []
    const MAX_VISITS = 150
    const shown = visits.slice(0, MAX_VISITS)
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
    const bySite = new Map<string, { n: number; ms: number }>()
    for (const v of visits) {
      const t = bySite.get(v.site) ?? { n: 0, ms: 0 }
      t.n++; t.ms += v.end - v.start
      bySite.set(v.site, t)
    }

    // Geometry: the time gutter, the site column, the time on site.
    const GUT = 64, RIGHT = 84, SX = M + GUT, SW = W - GUT - RIGHT - 10
    const BAR_H = 6, LINE_H = 10, ITEM = 7.4
    const clock = (ms: number) => when(ms, ms)
    const departed = (v: SiteVisit) => {
      if (v.endsAfter) return 'still in'
      if (eatDate(v.end) === eatDate(v.start)) return clock(v.end)
      const d = new Date(v.end + TZ_OFFSET_MS)
      return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${clock(v.end)}`
    }
    /** The stays in order as lines of items, at most two; what does not fit
     *  is counted at the end. */
    const stayLines = (v: SiteVisit) => {
      const named = v.areas.filter(a => a.name != null)
      const longest = named.length ? named.reduce((x, a) => (a.end - a.start > x.end - x.start ? a : x)) : null
      const items = v.areas.map(a => ({ name: a.name ?? 'Site grounds', dur: span(a.end - a.start), strong: a === longest }))
      const width = (it: { name: string; dur: string; strong: boolean }) =>
        doc.font(it.strong ? F.bold : F.reg).fontSize(ITEM).widthOfString(it.name) + doc.font(F.reg).fontSize(ITEM).widthOfString(` ${it.dur}`)
      const SEP = doc.font(F.reg).fontSize(ITEM).widthOfString('  ›  ')
      const MORE = doc.font(F.reg).fontSize(ITEM).widthOfString('  +99 more')
      const lines: (typeof items)[] = [[]]
      let used = 0, more = 0
      items.forEach((it, i) => {
        if (more) { more++; return }
        if (!lines[0]!.length) { lines[0]!.push(it); used = width(it); return }
        const w = width(it) + (lines[lines.length - 1]!.length ? SEP : 0)
        const roomFor = SW - (lines.length === 2 && i < items.length - 1 ? MORE : 0)
        if (used + w <= roomFor) { lines[lines.length - 1]!.push(it); used += w; return }
        if (lines.length < 2 && lines[0]!.length) { lines.push([it]); used = width(it); return }
        more = 1
      })
      return { lines: lines.filter(l => l.length), more, longest }
    }
    const blockH = (v: SiteVisit) => (v.areas.length ? 15 + BAR_H + 6 + stayLines(v).lines.length * LINE_H : 26) + 8

    let day = ''
    const dayBand = (v: SiteVisit, carried: boolean) => {
      const d = eatDate(v.start)
      const same = shown.filter(x => eatDate(x.start) === d)
      doc.rect(M, y, W, 16).fill(C.panel)
      const dt = new Date(v.start + TZ_OFFSET_MS)
      line(`${WD[dt.getUTCDay()]} ${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}${carried ? ' (continued)' : ''}`, M + 8, y + 4.5, 200, { font: F.bold, size: 8 })
      line(`${plural(same.length, 'visit')} · ${span(same.reduce((t, x) => t + x.end - x.start, 0))} on site`, M + W - 260, y + 5, 252, { size: 7, color: C.sub, align: 'right' })
      y += 16 + 9
    }
    const fresh = () => { doc.addPage(); y = head('Site Visits') }

    y = section(y, 40 + 34 + 26 + 25 + 2 * 44, 'Site Visits')
    y = title('Site Visits', visits.length
      ? `${plural(visits.length, 'visit')} to ${plural(bySite.size, 'site')} · site plans and company geofences · 5 min or longer · times in EAT`
      : 'site plans and company geofences', y)
    if (!visits.length) {
      // Not worked out (the build logs why) is not the same as none.
      line(rv.siteVisits ? 'It did not go onto any site plan or company geofence in the period.' : 'The site visits could not be worked out for this review.', M, y, W, { size: 8.5, color: C.sub })
      y += 20
    } else {
      // The sites, most time first: the period's answer before its detail, in
      // the cover's label-over-value band.
      const sites = [...bySite.entries()].sort((p1, p2) => p2[1].ms - p1[1].ms)
      const cells: [string, { n: number; ms: number }][] = sites.length > 4
        ? [...sites.slice(0, 3), [`${sites.length - 3} more sites`, sites.slice(3).reduce((t, [, x]) => ({ n: t.n + x.n, ms: t.ms + x.ms }), { n: 0, ms: 0 })]]
        : sites
      const cw = W / 4
      doc.rect(M, y, W, 34).fill(C.panel)
      cells.forEach(([name, t], i) => {
        const x = M + i * cw
        if (i) doc.moveTo(x, y + 7).lineTo(x, y + 27).lineWidth(0.5).stroke(C.line)
        line(name.toUpperCase(), x + 10, y + 7, cw - 16, { font: F.bold, size: 6.8, color: C.sub })
        line(`${plural(t.n, 'visit')} · ${span(t.ms)}`, x + 10, y + 18, cw - 16, { font: F.bold, size: 9 })
      })
      y += 34 + 10

      // The bar's key, and how to read the gutter.
      {
        let kx = M
        for (const [c, label] of [[C.green, 'Longest stay'], [C.greenSoft, 'Other areas'], [C.light, 'Site grounds (no named area)'], [C.pale, 'Moving between areas']] as const) {
          doc.rect(kx, y + 1.5, 12, 5).fill(c)
          line(label, kx + 16, y, 140, { size: 7, color: C.sub })
          kx += 16 + doc.font(F.reg).fontSize(7).widthOfString(label) + 14
        }
        const note = 'times on the left: arrival over departure'
        if (kx + doc.font(F.reg).fontSize(7).widthOfString(note) + 8 <= M + W) line(note, M + W - 150, y, 150, { size: 7, color: C.sub, align: 'right' })
        y += 16
      }

      shown.forEach((v, i) => {
        const h = blockH(v)
        const d = eatDate(v.start)
        if (d !== day) {
          // A day band is not left alone at the foot of a page.
          if (y + 25 + h > BOTTOM) fresh()
          day = d
          dayBand(v, false)
        } else if (y + h > BOTTOM) {
          fresh()
          dayBand(v, true)
        } else if (i) {
          doc.moveTo(SX, y - 6).lineTo(M + W, y - 6).lineWidth(0.4).stroke(C.line)
        }
        const y0 = y
        // The gutter: arrival over departure, joined by a hairline.
        line(v.startsBefore ? 'at start' : clock(v.start), M, y0, GUT - 6, { font: v.startsBefore ? F.reg : F.bold, size: 9, color: v.startsBefore ? C.sub : C.ink })
        const dy = v.areas.length ? 15 + BAR_H + 6 : 12
        doc.moveTo(M + 2.5, y0 + 12).lineTo(M + 2.5, y0 + dy - 1.5).lineWidth(0.6).stroke(C.light)
        line(departed(v), M, y0 + dy, GUT - 6, { size: 9, color: C.sub })
        // The site, and the time on site.
        line(v.site, SX, y0 - 0.5, SW, { font: F.bold, size: 9.5 })
        if (v.from === 'geofence') {
          const nw = doc.font(F.bold).fontSize(9.5).widthOfString(v.site)
          line('company geofence', SX + nw + 8, y0 + 1.5, SW - nw - 8, { size: 7, color: C.sub })
        }
        line(span(v.end - v.start), M + W - RIGHT, y0 - 0.5, RIGHT, { font: F.bold, size: 10, align: 'right' })
        if (v.startsBefore || v.endsAfter) line('at least', M + W - RIGHT, y0 + 12, RIGHT, { size: 6.8, color: C.sub, align: 'right' })

        if (v.areas.length) {
          const { lines, more, longest } = stayLines(v)
          // The bar: the visit end to end, each stay where it fell.
          const by = y0 + 15, dur = Math.max(1, v.end - v.start)
          doc.rect(SX, by, SW, BAR_H).fill(C.pale)
          for (const a of v.areas) {
            const x0 = SX + ((a.start - v.start) / dur) * SW
            const w = Math.max(1.5, ((a.end - a.start) / dur) * SW)
            doc.rect(x0, by, Math.min(w, SX + SW - x0), BAR_H).fill(a === longest ? C.green : a.name ? C.greenSoft : C.light)
            if (x0 > SX + 0.5) doc.moveTo(x0, by).lineTo(x0, by + BAR_H).lineWidth(0.8).stroke(C.paper)
          }
          // The stays in order, the longest named one in bold.
          lines.forEach((items, li) => {
            let x = SX
            const ly = by + BAR_H + 5 + li * LINE_H
            items.forEach((it, k) => {
              if (k) {
                doc.font(F.reg).fontSize(ITEM).fillColor(C.faint).text('  ›  ', x, ly, { lineBreak: false })
                x += doc.widthOfString('  ›  ')
              }
              doc.font(it.strong ? F.bold : F.reg).fontSize(ITEM).fillColor(it.name === 'Site grounds' ? C.sub : C.ink).text(it.name, x, ly, { lineBreak: false })
              x += doc.widthOfString(it.name)
              doc.font(F.reg).fontSize(ITEM).fillColor(C.sub).text(` ${it.dur}`, x, ly, { lineBreak: false })
              x += doc.widthOfString(` ${it.dur}`)
            })
            if (more && li === lines.length - 1) doc.font(F.reg).fontSize(ITEM).fillColor(C.sub).text(`  +${more} more`, x, ly, { lineBreak: false })
          })
        }
        y = y0 + h
      })
      if (visits.length > shown.length) {
        line(`${visits.length - shown.length} later visits are not shown.`, M, y, W, { size: 7.5, color: C.sub })
        y += 12
      }
      y += 6
    }
  }

  // ════ evidence ════
  const mapH = 400
  y = section(y, 40 + mapH + 8 + 7 * 11 + 14, 'Route Map')
  y = title('Route Map and Key Locations', 'the route over the period, places numbered by time spent', y)
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
        doc.lineWidth(1.6).strokeOpacity(0.8).lineJoin('round').stroke(C.ink)
      }
      doc.strokeOpacity(1)
      const top = rv.places.slice(0, 14)
      const maxH = Math.max(1, ...top.slice(0, 2).map(p => p.hours))
      const dots = top.map(p => ({ p, x: px(p.lng), y: py(p.lat), r: 6 + 6 * Math.sqrt(Math.min(1, p.hours / maxH)) }))
      for (const d of [...dots].reverse()) placeDot(d.p, d.x, d.y, d.r)
      // Each place's name beside its circle (operator, 2026-10-09: the exact
      // names on the map itself), the most hours first. A name that would
      // cover another name or a circle, or run off the map, is left to the key.
      type Box = { x: number; y: number; w: number; h: number }
      const taken: Box[] = dots.map(d => ({ x: d.x - d.r, y: d.y - d.r, w: 2 * d.r, h: 2 * d.r }))
      const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
      for (const d of dots) {
        const text = fit(shortPlaceName(d.p), 130, F.bold, 6.8)
        const w = doc.widthOfString(text) + 6, h = 10
        const box = [
          { x: d.x + d.r + 2, y: d.y - h / 2 }, { x: d.x - d.r - 2 - w, y: d.y - h / 2 },
          { x: d.x - w / 2, y: d.y - d.r - h - 1 }, { x: d.x - w / 2, y: d.y + d.r + 1 },
        ].map(b => ({ ...b, w, h }))
          .find(b => b.x >= mx + 2 && b.x + w <= mx + W - 2 && b.y >= my + 2 && b.y + h <= my + mapH - 12 && !taken.some(o => hit(b, o)))
        if (!box) continue
        taken.push(box)
        doc.rect(box.x, box.y, w, h).fillOpacity(0.85).fill(C.paper).fillOpacity(1)
        line(text, box.x + 3, box.y + 2, w - 4, { font: F.bold, size: 6.8 })
      }
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
      line(`${p.id}. ${shortPlaceName(p)}${p.activity ? ` · ${p.activity}` : ''}`, x + 12, yy, cw - 60, { size: 7.2 })
      line(`${nf(p.hours, 1)} h`, x + cw - 56, yy, 44, { size: 7.2, color: C.sub, align: 'right' })
    })
    y += half * 11 + 14
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
