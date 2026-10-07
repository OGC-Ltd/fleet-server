/**
 * The review as a two-page PDF: figures and pictures, few words.
 *
 *   Page 1 — the four headline figures, the supporting ones, the map (route
 *            and the places it spent time at), the top places.
 *   Page 2 — distance and driving day by day, the hour-of-day profile, how the
 *            period's time divided, and one line saying where the data came from.
 *
 * The map is OpenStreetMap tiles stitched under the route. Tiles are fetched
 * with an identifying User-Agent and kept in memory; if they cannot be fetched
 * the route is drawn on a plain ground instead — the PDF never fails for a map.
 */

import PDFDocument from 'pdfkit'
import { fuelOf, TZ_OFFSET_MS } from './usage-review.compute.js'
import type { ReadyReview } from './usage-review.service.js'

const C = {
  ink: '#111827', sub: '#6b7280', faint: '#9ca3af', line: '#e5e7eb', panel: '#f8fafc',
  green: '#1e6f4e', greenSoft: '#d1fae5', blue: '#2563eb', amber: '#d97706', red: '#dc2626', violet: '#7c3aed',
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

// ── drawing ──────────────────────────────────────────────────────────────────

export async function renderUsageReviewPdf(rv: ReadyReview, kmpl: number | null): Promise<Buffer> {
  const mapW = W, mapH = 300
  const map = await prepareMap(rv, mapW, mapH)
  const s = rv.summary, q = rv.quality, veh = rv.vehicle
  const fuelTot = fuelOf(s.km, kmpl)

  const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, info: { Title: `${veh.plate} motor report`, Author: 'FleetTrack' } })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>(res => doc.on('end', () => res(Buffer.concat(chunks))))

  const period = `${dayLabel(rv.period.from, true)} - ${dayLabel(rv.period.to, true)}`

  // ── header ──
  const header = (subtitle: string) => {
    doc.rect(0, 0, 595.28, 6).fill(C.green)
    doc.font(F.bold).fontSize(8).fillColor(C.green).text('MOTOR REPORT', M, M - 8, { characterSpacing: 2, lineBreak: false })
    doc.font(F.bold).fontSize(22).fillColor(C.ink).text(veh.plate, M, M + 4, { lineBreak: false })
    doc.font(F.reg).fontSize(9).fillColor(C.sub)
      .text([veh.organisation, veh.vehicleType?.replace(/_/g, ' ').toLowerCase(), subtitle].filter(Boolean).join('  ·  '), M, M + 31, { lineBreak: false })
    doc.font(F.bold).fontSize(11).fillColor(C.ink).text(period, M, M + 8, { width: W, align: 'right', lineBreak: false })
    doc.font(F.reg).fontSize(9).fillColor(C.sub).text(`${rv.period.days} days  ·  ${s.activeDays} with movement`, M, M + 24, { width: W, align: 'right', lineBreak: false })
    doc.moveTo(M, M + 48).lineTo(M + W, M + 48).lineWidth(0.6).stroke(C.line)
  }
  header(veh.wialonName ?? '')

  // ── headline tiles ──
  let y = M + 60
  const tiles: { v: string; u: string; l: string; sub: string; hi?: boolean }[] = [
    { v: nf(s.driveHPerDay, 2), u: 'h', l: 'DRIVE TIME PER DAY', sub: `${nf(s.driveHPerActiveDay, 2)} h per active day`, hi: true },
    { v: nf(s.km, 0), u: 'km', l: 'TOTAL DISTANCE', sub: `${nf(s.driveH, 1)} h driving` },
    { v: nf(s.kmPerDay, 1), u: 'km', l: 'DISTANCE PER DAY', sub: `${nf(s.kmPerActiveDay, 1)} km per active day` },
    {
      v: fuelTot != null ? nf(fuelTot / s.calendarDays, 1) : '-', u: fuelTot != null ? 'L' : '', l: 'FUEL PER DAY (EST.)',
      sub: fuelTot != null ? `${nf(fuelTot, 0)} L at ${kmpl} km/L` : 'no km/L rate set',
    },
  ]
  const tw = (W - 3 * 10) / 4, th = 70
  tiles.forEach((t, i) => {
    const x = M + i * (tw + 10)
    doc.roundedRect(x, y, tw, th, 6).fill(t.hi ? C.green : C.panel)
    const ink = t.hi ? '#ffffff' : C.ink, sub = t.hi ? C.greenSoft : C.sub
    doc.font(F.bold).fontSize(7).fillColor(sub).text(t.l, x + 10, y + 9, { characterSpacing: 0.8, lineBreak: false })
    doc.font(F.bold).fontSize(22).fillColor(ink).text(t.v, x + 10, y + 21, { lineBreak: false, continued: false })
    const vw = doc.font(F.bold).fontSize(22).widthOfString(t.v)
    doc.font(F.reg).fontSize(10).fillColor(sub).text(t.u, x + 13 + vw, y + 31, { lineBreak: false })
    doc.font(F.reg).fontSize(7.5).fillColor(sub).text(t.sub, x + 10, y + 53, { width: tw - 16, lineBreak: false })
  })
  y += th + 10

  // ── supporting figures ──
  const minis: [string, string][] = [
    ['Active days', `${s.activeDays} / ${s.calendarDays}`],
    ['Engine on', s.engineH != null ? `${nf(s.engineH, 1)} h` : '-'],
    ['Idling', s.idleH != null ? `${nf(s.idleH, 1)} h` : '-'],
    ['Avg moving speed', s.avgMovingKmh != null ? `${nf(s.avgMovingKmh, 1)} km/h` : '-'],
    ['Top speed', `${s.maxKmh} km/h`],
    ['Trips', String(s.trips)],
    ['Longest day', s.longestDay ? `${nf(s.longestDay.km, 0)} km · ${dayLabel(s.longestDay.date)}` : '-'],
  ]
  const mw = W / minis.length
  minis.forEach(([l, v], i) => {
    const x = M + i * mw
    doc.font(F.reg).fontSize(7).fillColor(C.sub).text(l.toUpperCase(), x, y, { width: mw - 4, lineBreak: false })
    doc.font(F.bold).fontSize(10).fillColor(C.ink).text(v, x, y + 10, { width: mw - 4, lineBreak: false })
  })
  y += 32

  // ── map ──
  const mx = M, my = y
  doc.save()
  doc.roundedRect(mx, my, mapW, mapH, 6).clip()
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
    // Soften the base so the route reads first.
    doc.rect(mx, my, mapW, mapH).fillOpacity(0.35).fill('#ffffff').fillOpacity(1)
    for (const t of rv.tracks) {
      if (t.path.length < 2) continue
      doc.moveTo(px(t.path[0]![1]), py(t.path[0]![0]))
      for (const [la, lo] of t.path.slice(1)) doc.lineTo(px(lo), py(la))
      doc.lineWidth(1.6).strokeOpacity(0.75).lineJoin('round').stroke(C.blue)
    }
    doc.strokeOpacity(1)
    const top = rv.places.slice(0, 10)
    const maxH = Math.max(1, ...top.slice(0, 2).map(p => p.hours))
    for (const p of [...top].reverse()) {
      const r = 6 + 8 * Math.sqrt(Math.min(1, p.hours / maxH))
      const x = px(p.lng), yy = py(p.lat)
      doc.circle(x, yy, r).fillOpacity(0.9).fill(p.id === 1 ? C.green : C.amber).fillOpacity(1)
      doc.circle(x, yy, r).lineWidth(1.2).stroke('#ffffff')
      doc.font(F.bold).fontSize(r > 9 ? 8 : 7).fillColor('#ffffff').text(String(p.id), x - 10, yy - (r > 9 ? 4 : 3.5), { width: 20, align: 'center', lineBreak: false })
    }
  }
  doc.restore()
  doc.roundedRect(mx, my, mapW, mapH, 6).lineWidth(0.6).stroke(C.line)
  doc.font(F.reg).fontSize(6).fillColor(C.sub).text('© OpenStreetMap contributors', mx, my + mapH - 10, { width: mapW - 6, align: 'right', lineBreak: false })
  y = my + mapH + 14

  // ── top places ──
  doc.font(F.bold).fontSize(10).fillColor(C.ink).text('Where it spent its time', M, y, { lineBreak: false })
  doc.font(F.reg).fontSize(8).fillColor(C.sub).text(`${s.places} places · ${nf(s.stoppedH, 0)} h stopped (stops of 10 min or more)`, M, y + 1, { width: W, align: 'right', lineBreak: false })
  y += 16
  const cols = [
    { h: '#', w: 18 }, { h: 'Place', w: 190 }, { h: 'County', w: 95 }, { h: 'Hours', w: 45, r: true },
    { h: 'Stops', w: 38, r: true }, { h: 'Days', w: 34, r: true }, { h: 'Coordinates', w: W - 420 },
  ]
  const row = (vals: string[], yy: number, bold = false, color = C.ink) => {
    let x = M
    cols.forEach((c, i) => {
      doc.font(bold ? F.bold : F.reg).fontSize(bold ? 7 : 8).fillColor(color)
        .text(vals[i] ?? '', x + 3, yy, { width: c.w - 6, align: c.r ? 'right' : 'left', lineBreak: false, ellipsis: true })
      x += c.w
    })
  }
  row(cols.map(c => c.h.toUpperCase()), y, true, C.sub)
  y += 11
  const rowsLeft = Math.max(0, Math.floor((842 - M - 24 - y) / 13.5))
  rv.places.slice(0, Math.min(12, rowsLeft)).forEach((p, i) => {
    if (i % 2 === 0) doc.rect(M, y - 3, W, 13.5).fill(C.panel)
    row([String(p.id), p.name ?? `Place ${p.id}`, p.county ?? '', nf(p.hours, 1), String(p.visits), String(p.days), `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`], y)
    y += 13.5
  })

  // ── page 2 ──
  doc.addPage()
  header('day by day')
  y = M + 62

  // Daily distance bars, drive hours as dots.
  const chart = (title: string, note: string, h: number) => {
    doc.font(F.bold).fontSize(10).fillColor(C.ink).text(title, M, y, { lineBreak: false })
    doc.font(F.reg).fontSize(8).fillColor(C.sub).text(note, M, y + 1, { width: W, align: 'right', lineBreak: false })
    y += 18
    const box = { x: M + 28, y, w: W - 56, h }
    y += h + 26
    return box
  }
  const days = rv.days
  {
    const b = chart('Distance and driving per day', 'bars: km  ·  dots: drive hours', 170)
    const maxKm = Math.max(10, ...days.map(d => d.km))
    const maxH = Math.max(1, ...days.map(d => d.driveH))
    const kmTop = Math.ceil(maxKm / 100) * 100, hTop = Math.ceil(maxH / 4) * 4
    for (let k = 0; k <= 4; k++) {
      const yy = b.y + b.h - (b.h * k) / 4
      doc.moveTo(b.x, yy).lineTo(b.x + b.w, yy).lineWidth(0.4).stroke(C.line)
      doc.font(F.reg).fontSize(6.5).fillColor(C.sub).text(String(Math.round((kmTop * k) / 4)), b.x - 28, yy - 3, { width: 24, align: 'right', lineBreak: false })
      doc.text(nf((hTop * k) / 4, 0), b.x + b.w + 4, yy - 3, { width: 24, lineBreak: false })
    }
    const bw = b.w / days.length
    days.forEach((d, i) => {
      const x = b.x + i * bw
      const hgt = (d.km / kmTop) * b.h
      if (hgt > 0) doc.rect(x + bw * 0.15, b.y + b.h - hgt, Math.max(0.8, bw * 0.7), hgt).fill(d.moved ? C.green : C.faint)
    })
    days.forEach((d, i) => {
      if (d.driveH <= 0) return
      doc.circle(b.x + (i + 0.5) * bw, b.y + b.h - (d.driveH / hTop) * b.h, Math.min(2.2, bw * 0.35)).fill(C.amber)
    })
    const every = Math.max(1, Math.ceil(days.length / 12))
    days.forEach((d, i) => {
      if (i % every) return
      doc.font(F.reg).fontSize(6.5).fillColor(C.sub).text(dayLabel(d.date), b.x + i * bw - 10, b.y + b.h + 4, { width: 28, align: 'center', lineBreak: false })
    })
  }

  // Hour-of-day profile: average driving minutes in each hour.
  {
    const b = chart('When it drives', 'average minutes of driving in each hour of the day (EAT)', 110)
    const per = Array.from({ length: 24 }, (_, hr) => rv.hours.filter(h => h.hour === hr).reduce((a, h) => a + h.driveMin, 0) / Math.max(1, rv.period.days))
    const top = Math.max(1, ...per)
    const bw = b.w / 24
    per.forEach((v, hr) => {
      const hgt = (v / top) * b.h
      doc.rect(b.x + hr * bw + bw * 0.12, b.y + b.h - hgt, bw * 0.76, hgt).fill(C.blue)
      if (v >= top * 0.15) doc.font(F.reg).fontSize(6).fillColor(C.sub).text(nf(v, v < 10 ? 1 : 0), b.x + hr * bw, b.y + b.h - hgt - 9, { width: bw, align: 'center', lineBreak: false })
      doc.font(F.reg).fontSize(6.5).fillColor(C.sub).text(String(hr).padStart(2, '0'), b.x + hr * bw, b.y + b.h + 4, { width: bw, align: 'center', lineBreak: false })
    })
    doc.moveTo(b.x, b.y + b.h).lineTo(b.x + b.w, b.y + b.h).lineWidth(0.6).stroke(C.line)
  }

  // How the period's hours divided.
  {
    doc.font(F.bold).fontSize(10).fillColor(C.ink).text('How the time divided', M, y, { lineBreak: false })
    y += 18
    const total = rv.period.days * 24
    const drive = s.driveH, idle = s.idleH ?? 0
    const parts = [
      { l: 'Driving', v: drive, c: C.green },
      { l: 'Idling', v: idle, c: C.amber },
      { l: 'Stopped 10 min+', v: Math.max(0, Math.min(s.stoppedH, total - drive - idle)), c: C.blue },
    ]
    parts.push({ l: 'Other', v: Math.max(0, total - parts.reduce((a, p) => a + p.v, 0)), c: C.line })
    let x = M
    for (const p of parts) {
      const w = (p.v / total) * W
      if (w > 0) doc.rect(x, y, w, 14).fill(p.c)
      x += w
    }
    y += 22
    x = M
    for (const p of parts) {
      doc.rect(x, y + 1, 7, 7).fill(p.c)
      const label = `${p.l}  ${nf(p.v, 0)} h (${nf((p.v / total) * 100, 1)}%)`
      doc.font(F.reg).fontSize(8).fillColor(C.ink).text(label, x + 11, y, { lineBreak: false })
      x += doc.widthOfString(label) + 30
    }
    y += 30
  }

  // Places by hours, top 10.
  {
    doc.font(F.bold).fontSize(10).fillColor(C.ink).text('Hours at each place', M, y, { lineBreak: false })
    y += 18
    const top = rv.places.slice(0, 10)
    const maxH = top[0]?.hours || 1
    for (const p of top) {
      if (y > 842 - M - 40) break
      doc.font(F.reg).fontSize(8).fillColor(C.ink).text(`${p.id}. ${p.name ?? `Place ${p.id}`}`, M, y, { width: 200, lineBreak: false, ellipsis: true })
      const w = (W - 270) * (p.hours / maxH)
      doc.rect(M + 205, y + 1, Math.max(1, w), 7).fill(p.id === 1 ? C.green : C.amber)
      doc.font(F.bold).fontSize(8).fillColor(C.ink).text(`${nf(p.hours, 1)} h`, M + 210 + w, y, { lineBreak: false })
      y += 14
    }
  }

  // ── footers ──
  const source = [
    q.daysFromDb && q.daysFromWialon ? `Data: FleetTrack database (${q.daysFromDb} days) + Wialon (${q.daysFromWialon} days)` : q.daysFromDb ? 'Data: FleetTrack database' : 'Data: Wialon history',
    q.distanceSource === 'odometer' ? 'distance: tracker odometer' : q.distanceSource === 'mixed' ? 'distance: odometer + GPS' : 'distance: GPS track',
    q.gpsVsOdometerPct != null ? `GPS agrees within ${nf(q.gpsVsOdometerPct, 1)}%` : null,
    fuelTot != null ? `fuel estimated at ${kmpl} km/L` : null,
    rv.incompleteDays.length ? `${rv.incompleteDays.length} day(s) incomplete (Wialon unreachable)` : null,
  ].filter(Boolean).join('  ·  ')
  const built = new Date(rv.builtAt + TZ_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')
  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    doc.page.margins.bottom = 0          // the footer sits in the margin; do not let it spill a page
    const fy = 842 - M + 6
    doc.moveTo(M, fy - 6).lineTo(M + W, fy - 6).lineWidth(0.5).stroke(C.line)
    doc.font(F.reg).fontSize(6.5).fillColor(C.sub)
      .text(source, M, fy, { width: W - 120, lineBreak: false, ellipsis: true })
      .text(`Built ${built} EAT  ·  ${i + 1}/${range.count}`, M, fy, { width: W, align: 'right', lineBreak: false })
  }
  doc.end()
  return done
}
