/**
 * The Logbook as a PDF: figures and pictures, few words.
 *
 *   Page 1 — the headline figures, where the stopped time went (by kind of
 *            place: work site, home area, elsewhere — and the top places) as
 *            two pies, and the map with its places in those colours.
 *   Page 2 — every place with its kind and nights, where it stood each night,
 *            then distance and driving day by day, the hour-of-day profile and
 *            how the period's time divided (onto a third page when it runs over).
 *
 * The map is OpenStreetMap tiles stitched under the route. Tiles are fetched
 * with an identifying User-Agent and kept in memory; if they cannot be fetched
 * the route is drawn on a plain ground instead — the PDF never fails for a map.
 */

import PDFDocument from 'pdfkit'
import { fuelOf, TZ_OFFSET_MS, type ReviewPlace } from './usage-review.compute.js'
import type { PlaceKind } from './usage-review.areas.js'
import type { ReadyReview } from './usage-review.service.js'

const C = {
  ink: '#111827', sub: '#6b7280', faint: '#9ca3af', line: '#e5e7eb', panel: '#f8fafc',
  green: '#1e6f4e', greenSoft: '#d1fae5', blue: '#2563eb', amber: '#d97706', red: '#dc2626', violet: '#7c3aed',
  // Kinds of place (usage-review.areas): work green, home burnt orange,
  // elsewhere blue; each with a lighter partner for neighbouring pie slices.
  home: '#c2410c', homeSoft: '#fb923c', workSoft: '#4fa37c', elsewhereSoft: '#7aa7f5',
  route: '#475569',
}
const F = { reg: 'Helvetica', bold: 'Helvetica-Bold' }
const M = 36
const W = 595.28 - 2 * M

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
  if (tiles.length <= 40) {
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
const pct = (v: number, of: number) => (of > 0 ? `${Math.round((v / of) * 100)}%` : '-')

// ── drawing ──────────────────────────────────────────────────────────────────

/**
 * Hallmark · redesign 2026-10-08 · scope: Logbook PDF
 * macrostructure: report ledger — verdict, two pies, the map, the ledger.
 * pre-emit critique: P4 H5 E4 S5 R4 V4
 *
 * Operator: rows ran into each other (a long area name wrapped onto the next
 * row) and the PDF did not show whether the time went to work, to the
 * driver's house or elsewhere. Every cell is now cut to its column on ONE
 * line (fit), and page 1 opens on where the stopped time went by KIND of
 * place (usage-review.areas) as two pies — by kind, and the top places —
 * with the map's markers in the same three colours. Page 2 is the ledger of
 * places with their kind and nights, and a strip of where it stood each
 * night; then the day-by-day charts.
 */
const KIND_COLOR: Record<PlaceKind, string> = { work: C.green, home: C.home, elsewhere: C.blue }
const KIND_LABEL: Record<PlaceKind, string> = { work: 'Work sites', home: 'Home area', elsewhere: 'Outside work sites' }
const KIND_SHORT: Record<PlaceKind, string> = { work: 'Work site', home: 'Home area', elsewhere: 'Outside work' }
const KINDS: PlaceKind[] = ['home', 'work', 'elsewhere']
const kindOf = (p: ReviewPlace): PlaceKind => p.kind ?? 'elsewhere'

export async function renderUsageReviewPdf(rv: ReadyReview, kmpl: number | null): Promise<Buffer> {
  const mapW = W
  const s = rv.summary, q = rv.quality, veh = rv.vehicle
  const fuelTot = fuelOf(s.km, kmpl)
  const areas = rv.areas ?? null
  const PAGE_H = 841.89, BOTTOM = PAGE_H - M - 18

  const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, info: { Title: `${veh.plate} logbook`, Author: 'FleetTrack' } })
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
  const title = (t: string, note: string | null, yy: number) => {
    line(t, M, yy, W * 0.55, { font: F.bold, size: 11 })
    if (note) line(note, M + W * 0.4, yy + 2, W * 0.6, { size: 7.5, color: C.sub, align: 'right' })
    doc.moveTo(M, yy + 16).lineTo(M + W, yy + 16).lineWidth(0.6).stroke(C.line)
    return yy + 24
  }

  /** A donut of parts, drawn from 12 o'clock clockwise. */
  const donut = (cx: number, cy: number, r: number, ri: number, parts: { v: number; c: string }[]) => {
    const total = parts.reduce((a, p) => a + p.v, 0)
    if (total <= 0) { doc.circle(cx, cy, r).lineWidth(r - ri).stroke(C.line); return }
    const shown = parts.filter(p => p.v > 0)
    if (shown.length === 1) {
      doc.circle(cx, cy, (r + ri) / 2).lineWidth(r - ri).stroke(shown[0]!.c)
      return
    }
    let a0 = -Math.PI / 2
    for (const p of shown) {
      const a1 = a0 + (p.v / total) * Math.PI * 2
      const large = a1 - a0 > Math.PI ? 1 : 0
      const P = (rr: number, a: number) => `${(cx + rr * Math.cos(a)).toFixed(2)} ${(cy + rr * Math.sin(a)).toFixed(2)}`
      doc.path(`M ${P(r, a0)} A ${r} ${r} 0 ${large} 1 ${P(r, a1)} L ${P(ri, a1)} A ${ri} ${ri} 0 ${large} 0 ${P(ri, a0)} Z`).fill(p.c)
      a0 = a1
    }
    // A hairline of paper between the parts.
    a0 = -Math.PI / 2
    for (const p of shown) {
      doc.moveTo(cx + ri * Math.cos(a0), cy + ri * Math.sin(a0)).lineTo(cx + r * Math.cos(a0), cy + r * Math.sin(a0)).lineWidth(1.2).stroke('#ffffff')
      a0 += (p.v / total) * Math.PI * 2
    }
  }

  const period = `${dayLabel(rv.period.from, true)} - ${dayLabel(rv.period.to, true)}`

  // ── header ──
  const header = (subtitle: string) => {
    doc.rect(0, 0, 595.28, 4).fill(C.green)
    line('Logbook', M, M - 10, 200, { font: F.bold, size: 8, color: C.green })
    line(veh.plate, M, M + 2, W * 0.5, { font: F.bold, size: 22 })
    line([veh.organisation, veh.vehicleType && veh.vehicleType !== 'UNSPECIFIED' ? veh.vehicleType.replace(/_/g, ' ').toLowerCase() : null, subtitle].filter(Boolean).join('  ·  '),
      M, M + 29, W * 0.62, { size: 8.5, color: C.sub })
    line(period, M + W * 0.5, M + 6, W * 0.5, { font: F.bold, size: 11, align: 'right' })
    line(`${rv.period.days} days  ·  ${s.activeDays} with movement`, M + W * 0.5, M + 22, W * 0.5, { size: 8.5, color: C.sub, align: 'right' })
    doc.moveTo(M, M + 44).lineTo(M + W, M + 44).lineWidth(0.6).stroke(C.line)
  }
  header(veh.wialonName ?? '')

  // ── headline figures: four cells on hairlines ──
  let y = M + 54
  const figs: { v: string; u: string; l: string; sub: string; hi?: boolean }[] = [
    { v: nf(s.driveHPerDay, 2), u: 'h', l: 'Drive time per day', sub: `${nf(s.driveHPerActiveDay, 2)} h per active day`, hi: true },
    { v: nf(s.km, 0), u: 'km', l: 'Total distance', sub: `${nf(s.driveH, 1)} h driving` },
    { v: nf(s.kmPerDay, 1), u: 'km', l: 'Distance per day', sub: `${nf(s.kmPerActiveDay, 1)} km per active day` },
    {
      v: fuelTot != null ? nf(fuelTot / s.calendarDays, 1) : '-', u: fuelTot != null ? 'L' : '', l: 'Fuel per day (est.)',
      sub: fuelTot != null ? `${nf(fuelTot, 0)} L at ${kmpl} km/L` : 'no km/L rate set',
    },
  ]
  const fw = W / 4, fh = 52
  figs.forEach((t, i) => {
    const x = M + i * fw
    if (i) doc.moveTo(x, y + 2).lineTo(x, y + fh - 4).lineWidth(0.6).stroke(C.line)
    const pad = i ? 12 : 0
    line(t.l, x + pad, y, fw - pad - 6, { size: 7.5, color: C.sub })
    doc.font(F.bold).fontSize(20).fillColor(t.hi ? C.green : C.ink).text(t.v, x + pad, y + 12, { lineBreak: false })
    const vw = doc.widthOfString(t.v)
    line(t.u, x + pad + vw + 3, y + 21, 24, { size: 9, color: C.sub })
    line(t.sub, x + pad, y + 38, fw - pad - 6, { size: 7.5, color: C.sub })
  })
  y += fh + 6

  const minis: [string, string][] = [
    ['Active days', `${s.activeDays} / ${s.calendarDays}`],
    ['Engine on', s.engineH != null ? `${nf(s.engineH, 1)} h` : '-'],
    ['Idling', s.idleH != null ? `${nf(s.idleH, 1)} h` : '-'],
    ['Avg moving speed', s.avgMovingKmh != null ? `${nf(s.avgMovingKmh, 1)} km/h` : '-'],
    ['Top speed', `${s.maxKmh} km/h`],
    ['Trips', String(s.trips)],
    ['Longest day', s.longestDay ? `${nf(s.longestDay.km, 0)} km · ${dayLabel(s.longestDay.date)}` : '-'],
  ]
  doc.rect(M, y, W, 30).fill(C.panel)
  const mw = W / minis.length
  minis.forEach(([l, v], i) => {
    const x = M + i * mw + 8
    line(l, x, y + 6, mw - 10, { size: 6.8, color: C.sub })
    line(v, x, y + 16, mw - 10, { font: F.bold, size: 9 })
  })
  y += 30 + 16

  // ── where the stopped time went: two pies ──
  const stopped = rv.places.reduce((a, p) => a + p.hours, 0)
  if (areas && stopped > 0) {
    const lead = KINDS.slice().sort((a, b) => areas.hours[b] - areas.hours[a])[0]!
    const verdict = `${pct(areas.hours[lead], stopped)} of its stopped time was ${lead === 'home' ? 'at the home area' : lead === 'work' ? 'at work sites' : 'outside work sites'}`
    y = title('Where It Spent Its Time', `${nf(stopped, 0)} h stopped at ${s.places} places (stops of 10 min or more)`, y)
    line(verdict, M, y, W, { font: F.bold, size: 10, color: KIND_COLOR[lead] })
    y += 18

    const R = 46, RI = 26, colL = W * 0.44, colR = W - colL
    // Left: by kind.
    {
      const cx = M + R, cy = y + R
      donut(cx, cy, R, RI, KINDS.map(k => ({ v: areas.hours[k], c: KIND_COLOR[k] })))
      line(pct(areas.hours[lead], stopped), cx - RI, cy - 6, RI * 2, { font: F.bold, size: 11, align: 'center', color: KIND_COLOR[lead] })
      let ly = y + 6
      const lx = M + 2 * R + 14, lw = colL - 2 * R - 24
      line('By kind of place', lx, ly - 2, lw, { font: F.bold, size: 8, color: C.sub })
      ly += 14
      for (const k of KINDS) {
        doc.rect(lx, ly + 1, 7, 7).fill(KIND_COLOR[k])
        line(KIND_LABEL[k], lx + 11, ly, lw - 11, { size: 8 })
        line(`${nf(areas.hours[k], 1)} h  ·  ${pct(areas.hours[k], stopped)}  ·  ${areas.nights[k]} night${areas.nights[k] === 1 ? '' : 's'}`, lx + 11, ly + 10, lw - 11, { size: 7.5, color: C.sub })
        ly += 25
      }
    }
    // Right: the top places, coloured by their kind.
    {
      const top = rv.places.slice(0, 5)
      const rest = Math.max(0, stopped - top.reduce((a, p) => a + p.hours, 0))
      const shade = (k: PlaceKind, i: number) => (i % 2 ? C[`${k}Soft` as const] : KIND_COLOR[k])
      const seen: Record<PlaceKind, number> = { work: 0, home: 0, elsewhere: 0 }
      const parts = top.map(p => { const k = kindOf(p); return { p, c: shade(k, seen[k]++) } })
      const cx = M + colL + R, cy = y + R
      donut(cx, cy, R, RI, [...parts.map(x => ({ v: x.p.hours, c: x.c })), { v: rest, c: C.line }])
      line(String(top.length), cx - RI, cy - 6, RI * 2, { font: F.bold, size: 11, align: 'center' })
      let ly = y + 6
      const lx = M + colL + 2 * R + 14, lw = colR - 2 * R - 14
      line('Top places', lx, ly - 2, lw, { font: F.bold, size: 8, color: C.sub })
      ly += 14
      for (const { p, c } of parts) {
        doc.rect(lx, ly + 1, 7, 7).fill(c)
        const fig = `${nf(p.hours, 0)} h · ${pct(p.hours, stopped)}`
        doc.font(F.bold).fontSize(7.5)
        const fwid = doc.widthOfString(fig) + 4
        line(`${p.id}. ${p.exactName ?? p.name ?? `Place ${p.id}`}`, lx + 11, ly, lw - 11 - fwid, { size: 7.5 })
        line(fig, lx + lw - fwid, ly, fwid, { font: F.bold, size: 7.5, align: 'right' })
        ly += 12.5
      }
      if (rest > 0) {
        doc.rect(lx, ly + 1, 7, 7).fill(C.line)
        line(`${Math.max(0, s.places - top.length)} other places`, lx + 11, ly, lw - 60, { size: 7.5, color: C.sub })
        line(`${nf(rest, 0)} h · ${pct(rest, stopped)}`, lx + lw - 56, ly, 56, { size: 7.5, color: C.sub, align: 'right' })
      }
    }
    y += 2 * R + 18
  } else {
    y = title('Where It Spent Its Time', `${nf(stopped, 0)} h stopped at ${s.places} places`, y)
  }

  // ── map: the rest of page 1 ──
  const mapH = Math.max(200, BOTTOM - y - 6)
  const map = await prepareMap(rv, mapW, mapH)
  const mx = M, my = y
  doc.save()
  doc.rect(mx, my, mapW, mapH).clip()
  doc.rect(mx, my, mapW, mapH).fill('#eef2f0')
  if (map) {
    const { frame, tiles: tl } = map
    const px = (lng: number) => mx + (lon2x(lng, frame.z) - frame.x0) * frame.scale
    const py = (lat: number) => my + (lat2y(lat, frame.z) - frame.y0) * frame.scale
    const size = 256 * frame.scale
    for (const t of tl) {
      if (!t.buf) continue
      try { doc.image(t.buf, mx + (t.x * 256 - frame.x0) * frame.scale, my + (t.y * 256 - frame.y0) * frame.scale, { width: size, height: size }) } catch { /* a bad tile is skipped */ }
    }
    // Soften the base so the route and the places read first.
    doc.rect(mx, my, mapW, mapH).fillOpacity(0.45).fill('#ffffff').fillOpacity(1)
    for (const t of rv.tracks) {
      if (t.path.length < 2) continue
      doc.moveTo(px(t.path[0]![1]), py(t.path[0]![0]))
      for (const [la, lo] of t.path.slice(1)) doc.lineTo(px(lo), py(la))
      doc.lineWidth(1.4).strokeOpacity(0.7).lineJoin('round').stroke(C.route)
    }
    doc.strokeOpacity(1)
    const top = rv.places.slice(0, 10)
    const maxH = Math.max(1, ...top.slice(0, 2).map(p => p.hours))
    for (const p of [...top].reverse()) {
      const r = 6 + 8 * Math.sqrt(Math.min(1, p.hours / maxH))
      const x = px(p.lng), yy = py(p.lat)
      doc.circle(x, yy, r).fill(KIND_COLOR[kindOf(p)])
      doc.circle(x, yy, r).lineWidth(1.2).stroke('#ffffff')
      doc.font(F.bold).fontSize(r > 9 ? 8 : 7).fillColor('#ffffff').text(String(p.id), x - 10, yy - (r > 9 ? 4 : 3.5), { width: 20, align: 'center', lineBreak: false })
    }
  }
  doc.restore()
  doc.rect(mx, my, mapW, mapH).lineWidth(0.6).stroke(C.line)
  // Key, on the map's own ground.
  {
    let kx = mx + 6
    doc.rect(mx + 4, my + 4, areas ? 300 : 90, 14).fillOpacity(0.85).fill('#ffffff').fillOpacity(1)
    doc.moveTo(kx, my + 11).lineTo(kx + 14, my + 11).lineWidth(1.6).stroke(C.route)
    line('Route', kx + 18, my + 7.5, 40, { size: 7, color: C.sub })
    kx += 52
    if (areas) for (const k of KINDS) {
      doc.circle(kx + 3.5, my + 11, 3.5).fill(KIND_COLOR[k])
      line(KIND_SHORT[k], kx + 10, my + 7.5, 70, { size: 7, color: C.sub })
      kx += 78
    }
  }
  line('© OpenStreetMap contributors', mx, my + mapH - 10, mapW - 6, { size: 6, color: C.sub, align: 'right' })
  y = my + mapH + 10

  // ── page 2: the ledger of places, and the nights ──
  doc.addPage()
  header('places and nights')
  y = M + 58

  const cols = [
    { h: '#', w: 18 },
    // Google's name for the spot where it has one ("West Kenya Sugar - Lake
    // Agro workshop"), the OpenStreetMap area only where it has none
    // (operator, 2026-10-08: not "Kadenge Sublocation" for the workshop).
    { h: 'Place', w: 170 },
    { h: 'Kind', w: 86 },
    { h: 'County', w: 52 },
    { h: 'Hours', w: 34, r: true }, { h: 'Nights', w: 32, r: true }, { h: 'Stops', w: 30, r: true }, { h: 'Days', w: 28, r: true },
  ]
  cols.push({ h: 'Coordinates', w: W - cols.reduce((a, c) => a + c.w, 0) })
  const RH = 15
  const row = (vals: string[], yy: number, head = false, kind: PlaceKind | null = null) => {
    let x = M
    cols.forEach((c, i) => {
      if (kind && c.h === 'Kind') doc.circle(x + 6, yy + 3.6, 2.8).fill(KIND_COLOR[kind])
      const pad = kind && c.h === 'Kind' ? 12 : 3
      line(vals[i] ?? '', x + pad, yy, c.w - pad - 3, { font: head ? F.bold : F.reg, size: head ? 6.8 : 7.6, color: head ? C.sub : C.ink, align: 'r' in c && c.r ? 'right' : 'left' })
      x += c.w
    })
  }
  y = title('Every Place', `${s.places} places, most time first`, y)
  row(cols.map(c => c.h), y, true)
  y += 12
  const maxRows = Math.min(rv.places.length, 17)
  rv.places.slice(0, maxRows).forEach((p, i) => {
    if (i % 2 === 0) doc.rect(M, y - 4, W, RH).fill(C.panel)
    const k = kindOf(p)
    row([
      String(p.id),
      p.exactName ?? p.name ?? `Place ${p.id}`,
      areas ? (k === 'work' && p.site ? p.site : KIND_SHORT[k]) : '-',
      (p.county ?? '').replace(/ County$/, ''),
      nf(p.hours, 1), String(p.nights ?? 0), String(p.visits), String(p.days),
      `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`,
    ], y, false, areas ? k : null)
    y += RH
  })
  if (rv.places.length > maxRows) {
    line(`and ${rv.places.length - maxRows} smaller places, ${nf(rv.places.slice(maxRows).reduce((a, p) => a + p.hours, 0), 1)} h between them (all of them in the Excel download)`, M, y, W, { size: 7.5, color: C.sub })
    y += 12
  }
  y += 14

  // Where it stood at 02:00 each night.
  if (areas) {
    y = title('Where It Spent Each Night', 'where the unit stood at 02:00, each night of the period', y)
    const n = areas.nightly.length
    const cw = W / n
    areas.nightly.forEach((d, i) => {
      const x = M + i * cw
      doc.rect(x + 0.6, y, Math.max(1, cw - 1.2), 18).fill(d.kind ? KIND_COLOR[d.kind] : C.line)
      if (cw >= 14 && d.place != null) line(String(d.place), x, y + 5, cw, { font: F.bold, size: 6.5, color: '#ffffff', align: 'center' })
    })
    const every = Math.max(1, Math.ceil(n / 15))
    areas.nightly.forEach((d, i) => {
      if (i % every) return
      line(dayLabel(d.date), M + i * cw - 8, y + 22, cw + 16, { size: 6.3, color: C.sub, align: 'center' })
    })
    y += 36
    let kx = M
    for (const k of [...KINDS, null] as (PlaceKind | null)[]) {
      const count = k ? areas.nights[k] : areas.nightly.filter(d => !d.kind).length
      const label = `${k ? KIND_SHORT[k] : 'Moving or no stop'}  ${count}`
      doc.rect(kx, y + 1, 7, 7).fill(k ? KIND_COLOR[k] : C.line)
      line(label, kx + 11, y, 140, { size: 7.5 })
      doc.font(F.reg).fontSize(7.5)
      kx += doc.widthOfString(label) + 28
    }
    y += 16
    doc.font(F.reg).fontSize(6.8).fillColor(C.sub).text(
      'Work sites are the company\'s factories and weighbridge yards (within 1.5 km) and its own area geofences. The home area is the place away from work where the unit spends the most nights, and anywhere within 3 km of it; nothing on record names a driver\'s house, so read it as where the unit sleeps. Outside work sites is every other stop of 10 minutes or more.',
      M, y, { width: W, lineGap: 1 })
    y = doc.y + 16
  }

  // How the period's hours divided: one pie, its legend beside it.
  {
    if (y + 172 > BOTTOM) { doc.addPage(); header('day by day'); y = M + 58 }
    y = title('How the Time Divided', `${rv.period.days * 24} h in the period`, y)
    const total = rv.period.days * 24
    const drive = s.driveH, idle = s.idleH ?? 0
    const parts = [
      { l: 'Driving', v: drive, c: C.green },
      { l: 'Idling', v: idle, c: C.amber },
      { l: 'Stopped 10 min or more', v: Math.max(0, Math.min(s.stoppedH, total - drive - idle)), c: C.blue },
    ]
    parts.push({ l: 'Other (short stops, no signal)', v: Math.max(0, total - parts.reduce((a, p) => a + p.v, 0)), c: C.line })
    // Centred: the pie, then its legend as one row of four under it.
    const R = 48, cx = M + W / 2
    donut(cx, y + R, R, 27, parts)
    line(pct(s.driveH, total), cx - 27, y + R - 6, 54, { font: F.bold, size: 11, align: 'center', color: C.green })
    line('driving', cx - 27, y + R + 7, 54, { size: 6.5, color: C.sub, align: 'center' })
    y += 2 * R + 14
    const cell = W / parts.length
    parts.forEach((p, i) => {
      const x = M + i * cell
      doc.font(F.reg).fontSize(8)
      const lw = Math.min(cell - 20, doc.widthOfString(p.l))
      const left = x + (cell - (lw + 11)) / 2
      doc.rect(left, y + 1, 7, 7).fill(p.c)
      line(p.l, left + 11, y, cell - 20, { size: 8 })
      line(`${nf(p.v, 0)} h  ·  ${nf((p.v / total) * 100, 1)}%`, x, y + 12, cell, { font: F.bold, size: 8, align: 'center' })
    })
    y += 34
  }

  // ── day by day ──
  const chart = (t: string, note: string, h: number) => {
    if (y + h + 60 > BOTTOM) { doc.addPage(); header('day by day'); y = M + 58 }
    y = title(t, note, y)
    const box = { x: M + 28, y, w: W - 56, h }
    y += h + 24
    return box
  }
  const days = rv.days
  {
    const b = chart('Distance and Driving per Day', 'bars: km  ·  dots: drive hours', 140)
    const maxKm = Math.max(10, ...days.map(d => d.km))
    const maxH = Math.max(1, ...days.map(d => d.driveH))
    const kmTop = Math.ceil(maxKm / 100) * 100, hTop = Math.ceil(maxH / 4) * 4
    for (let k = 0; k <= 4; k++) {
      const yy = b.y + b.h - (b.h * k) / 4
      doc.moveTo(b.x, yy).lineTo(b.x + b.w, yy).lineWidth(0.4).stroke(C.line)
      line(String(Math.round((kmTop * k) / 4)), b.x - 28, yy - 3, 24, { size: 6.5, color: C.sub, align: 'right' })
      line(nf((hTop * k) / 4, 0), b.x + b.w + 4, yy - 3, 24, { size: 6.5, color: C.sub })
    }
    const bw = b.w / days.length
    days.forEach((d, i) => {
      const hgt = (d.km / kmTop) * b.h
      if (hgt > 0) doc.rect(b.x + i * bw + bw * 0.15, b.y + b.h - hgt, Math.max(0.8, bw * 0.7), hgt).fill(d.moved ? C.green : C.faint)
    })
    days.forEach((d, i) => {
      if (d.driveH <= 0) return
      doc.circle(b.x + (i + 0.5) * bw, b.y + b.h - (d.driveH / hTop) * b.h, Math.min(2.2, bw * 0.35)).fill(C.amber)
    })
    const every = Math.max(1, Math.ceil(days.length / 12))
    days.forEach((d, i) => {
      if (i % every) return
      line(dayLabel(d.date), b.x + i * bw - 10, b.y + b.h + 4, 28, { size: 6.5, color: C.sub, align: 'center' })
    })
  }

  {
    const b = chart('Driving by Hour', 'average minutes of driving in each hour of the day (EAT)', 90)
    const per = Array.from({ length: 24 }, (_, hr) => rv.hours.filter(h => h.hour === hr).reduce((a, h) => a + h.driveMin, 0) / Math.max(1, rv.period.days))
    const top = Math.max(1, ...per)
    const bw = b.w / 24
    per.forEach((v, hr) => {
      const hgt = (v / top) * b.h
      doc.rect(b.x + hr * bw + bw * 0.12, b.y + b.h - hgt, bw * 0.76, hgt).fill(C.blue)
      if (v >= top * 0.15) line(nf(v, v < 10 ? 1 : 0), b.x + hr * bw, b.y + b.h - hgt - 9, bw, { size: 6, color: C.sub, align: 'center' })
      line(String(hr).padStart(2, '0'), b.x + hr * bw, b.y + b.h + 4, bw, { size: 6.5, color: C.sub, align: 'center' })
    })
    doc.moveTo(b.x, b.y + b.h).lineTo(b.x + b.w, b.y + b.h).lineWidth(0.6).stroke(C.line)
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
    line(source, M, fy, W - 130, { size: 6.5, color: C.sub })
    line(`Built ${built} EAT  ·  ${i + 1}/${range.count}`, M + W - 130, fy, 130, { size: 6.5, color: C.sub, align: 'right' })
  }
  doc.end()
  return done
}
