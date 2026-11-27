/**
 * Fuelling: plan vs actual as a PDF (operator 2026-11-27: "a report like this
 * that will have our logo, a well organized report like that for logbook").
 * Laid out after FactorySuite's own day report for Mufindi (25 Nov 2026) and
 * drawn the way the Logbook's PDF is (usage-review.pdf): the two logos and a
 * cover head, a strip of the report's particulars, then
 *
 *   the opening sentence and five figure tiles;
 *   Where Every Planned Machine Stands — the day's machines as one bar by status;
 *   Progress by Site — machines fuelled of machines planned, site by site;
 *   (no heading) Mufindi's planting plan, the estate drawing in black and white, each site
 *     the report names marked on it with its progress (operator 2026-11-27);
 *   Litres by Equipment Type — litres fuelled against litres planned;
 *   Machines Fuelled: How Close to Plan — each fuelled machine's plan as a
 *     track and what went in as the fill, the biggest shortfall first;
 *   Fuelled Off Plan — machines the pumps fuelled that no plan named;
 *   Machine List — every planned machine, by status.
 *
 * A section moves to a new page only when it does not fit below the last;
 * a long list carries on over pages with its heading repeated. Status colours
 * as FactorySuite's: red not fuelled, amber short, green as planned.
 */

import fs from 'node:fs'
import path from 'node:path'
import PDFDocument from 'pdfkit'
import { AS_PLANNED_SHARE, fuellingLead, type FuellingPlan, type FuellingStatus } from './fuelling-plan.js'

const C = {
  ink: '#121813',
  sub: '#545a55',
  faint: '#959a96',
  line: '#d8dcd9',
  panel: '#f1f5f1',
  paper: '#fafdfa',
  track: '#e5e9e6',
  red: '#c8102e',
  amber: '#f2a11f',
  amberInk: '#b45f06',
  green: '#16855a',
  blue: '#2a5bd7',
  sky: '#37aae3',
  violet: '#6b4fbb',
}
const STATUS_COLOR: Record<FuellingStatus, string> = {
  'Fuelling now': C.sky,
  Short: C.amber,
  Over: C.violet,
  'Not fuelled': C.red,
  'As planned': C.green,
}
const F = { reg: 'Helvetica', bold: 'Helvetica-Bold' }
const M = 36
const PAGE_W = 595.28
const PAGE_H = 841.89
const W = PAGE_W - 2 * M
const BOTTOM = PAGE_H - M - 18
const PREPARED_BY = 'Off-Grid Consulting Ltd.'
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const logoCache = new Map<string, Buffer | null>()
function logo(file: string): Buffer | null {
  if (!logoCache.has(file)) {
    try { logoCache.set(file, fs.readFileSync(path.resolve(process.cwd(), 'assets', 'report', file))) } catch { logoCache.set(file, null) }
  }
  return logoCache.get(file) ?? null
}

// ── the planting plan ──
/** The factory whose estate drawing is on file (assets/report/kasulu-planting-plan.geojson). */
const PLANTING_PLAN_FACTORY = 'MUFINDI PAPER MILLS'
type PlanFeature = { properties: { c: string; n: string | null }; geometry: { type: 'Polygon'; coordinates: [number, number][][] } | { type: 'LineString'; coordinates: [number, number][] } }
let planCache: PlanFeature[] | null | undefined
/** Kasulu's planting plan, as the site's map draws it (new-ui public/estate-plan.geojson, the
 *  hectare blocks and farm areas left out); null if the file is absent. */
function plantingPlan(): PlanFeature[] | null {
  if (planCache === undefined) {
    try {
      const fc = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'assets', 'report', 'kasulu-planting-plan.geojson'), 'utf8')) as { features: PlanFeature[] }
      planCache = fc.features.filter(f => f.geometry.type === 'Polygon' || f.geometry.type === 'LineString')
    } catch { planCache = null }
  }
  return planCache
}
/** Black and white (operator 2026-11-27): greys for the ground, black for the lines that frame it. */
const PLAN_GREYS: Record<string, { fill?: string; stroke?: string; width?: number; dash?: [number, number] }> = {
  planted: { fill: '#dcdcdc', stroke: '#a8a8a8', width: 0.25 },
  rainfed: { fill: '#f0f0f0', stroke: '#8c8c8c', width: 0.4, dash: [2, 1.5] },
  nursery: { fill: '#b8b8b8', stroke: '#555555', width: 0.5 },
  factory: { fill: '#9a9a9a', stroke: '#333333', width: 0.6 },
  water: { fill: '#7a7a7a', stroke: '#5a5a5a', width: 0.7 },
  reservoir: { fill: '#5e5e5e', stroke: '#3a3a3a', width: 0.6 },
  flood: { stroke: '#8c8c8c', width: 0.6, dash: [3, 2] },
  irrigation: { stroke: '#8c8c8c', width: 0.45, dash: [1.5, 1.2] },
  road: { fill: '#c4c4c4', stroke: '#3d3d3d', width: 1.1 },
  headcontrol: { stroke: '#555555', width: 0.6 },
  zone: { stroke: '#1a1a1a', width: 0.9 },
  boundary: { stroke: '#000000', width: 1.6 },
}
const PLAN_ORDER = ['rainfed', 'planted', 'nursery', 'factory', 'water', 'reservoir', 'road', 'flood', 'irrigation', 'headcontrol', 'zone', 'boundary']
const PLAN_KEY: [string, string][] = [
  ['planted', 'Irrigation block'], ['nursery', 'Nursery'], ['rainfed', 'Rainfed area'], ['water', 'Water'], ['reservoir', 'Reservoir'],
  ['factory', 'Factory'], ['road', 'Road'], ['irrigation', 'Irrigation line'], ['headcontrol', 'Head-control area'], ['zone', 'Zone'], ['boundary', 'Estate boundary'],
]
/** Areas a site's name can be: "Zone 4", "Nursery B", "Factory site", "Commercial area (1600)". */
const PLACE_CLASSES = new Set(['zone', 'nursery', 'factory', 'headcontrol', 'reservoir', 'rainfed'])
/** A ring's middle (area-weighted) and its area, in degrees. */
function centroid(ring: [number, number][]): { lng: number; lat: number; area: number } {
  let a = 0, cx = 0, cy = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x0, y0] = ring[j]!, [x1, y1] = ring[i]!
    const f = x0 * y1 - x1 * y0
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f
  }
  if (Math.abs(a) < 1e-12) return { lng: ring[0]![0], lat: ring[0]![1], area: 0 }
  return { lng: cx / (3 * a), lat: cy / (3 * a), area: Math.abs(a / 2) }
}

const nf = (v: number, d = 0) => v.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: d })
const litres = (v: number) => nf(v, 2)
const signed = (v: number) => (v > 0 ? `+${litres(v)}` : litres(v))
const pct = (v: number, of: number) => (of > 0 ? `${Math.round((v / of) * 100)}%` : '-')
const plural = (n: number, w: string) => `${nf(n)} ${w}${n === 1 ? '' : 's'}`
export const dayWords = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase())

export function fuellingPlanFileName(p: Pick<FuellingPlan, 'day'>, factoryName: string) {
  return `Fuelling plan vs actual ${factoryName} ${p.day}.pdf`
}

export async function renderFuellingPlanPdf(p: FuellingPlan, o: { factoryName: string; orgName: string; now?: number }): Promise<Buffer> {
  const now = o.now ?? Date.now()
  const t = p.totals
  const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, info: { Title: `Fuelling: plan vs actual, ${o.factoryName}, ${dayWords(p.day)}`, Author: PREPARED_BY } })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>(res => doc.on('end', () => res(Buffer.concat(chunks))))

  const fit = (text: string, width: number, font: string, size: number) => {
    doc.font(font).fontSize(size)
    if (doc.widthOfString(text) <= width) return text
    let s = text
    while (s.length > 1 && doc.widthOfString(`${s}…`) > width) s = s.slice(0, -1)
    return `${s.trimEnd()}…`
  }
  /** One line, never wrapped (see usage-review.pdf `line`). */
  const line = (text: string, x: number, yy: number, width: number, s: { font?: string; size?: number; color?: string; align?: 'left' | 'right' | 'center' } = {}) => {
    const font = s.font ?? F.reg, size = s.size ?? 8
    doc.font(font).fontSize(size).fillColor(s.color ?? C.ink)
      .text(fit(text, width - 2, font, size), x, yy, { width, height: size * 1.4, align: s.align ?? 'left', lineBreak: false })
  }
  /** Rich text in one paragraph: [text, bold] runs. Returns the y under it. */
  const para = (runs: [string, boolean][], yy: number, size = 10.5) => {
    doc.fillColor(C.ink)
    runs.forEach(([s, bold], i) => {
      doc.font(bold ? F.bold : F.reg).fontSize(size)
      if (i === 0) doc.text(s, M, yy, { width: W, continued: i < runs.length - 1, lineGap: 2 })
      else doc.text(s, { continued: i < runs.length - 1, lineGap: 2 })
    })
    return doc.y + 4
  }
  const rule = (yy: number) => doc.moveTo(M, yy).lineTo(M + W, yy).lineWidth(0.6).stroke(C.line)

  const period = dayWords(p.day)
  /** The running head on pages 2 on. */
  const head = (section: string) => {
    doc.rect(0, 0, PAGE_W, 4).fill(C.ink)
    const rai = logo('rai-group-logo.jpeg'), ogc = logo('ogc-logo.png')
    if (rai) try { doc.image(rai, M, M - 14, { fit: [26, 26] }) } catch { /* no logo */ }
    if (ogc) try { doc.image(ogc, M + W - 25, M - 10, { fit: [25, 18], align: 'right', valign: 'center' }) } catch { /* no logo */ }
    line(`Fuelling: plan vs actual  ·  ${section}`, M + 34, M - 9, W * 0.7, { font: F.bold, size: 9 })
    line(`${o.factoryName}  ·  ${period}`, M + 34, M + 2, W * 0.7, { size: 7.5, color: C.sub })
    rule(M + 18)
    return M + 30
  }
  let current = 'Summary'
  /** Room for `need` points below `yy`, else a new page under the running head. */
  const room = (yy: number, need: number) => {
    if (yy + need <= BOTTOM) return yy
    doc.addPage()
    return head(current)
  }
  /** A section title over a hairline, with its note under it. */
  const title = (name: string, note: string, yy: number, need: number) => {
    current = name
    yy = room(yy + 10, 44 + need)
    line(name, M, yy, W, { font: F.bold, size: 13 })
    line(note, M, yy + 17, W, { size: 7.8, color: C.sub })
    rule(yy + 30)
    return yy + 40
  }

  // ════ cover ════
  doc.rect(0, 0, PAGE_W, 6).fill(C.ink)
  {
    const rai = logo('rai-group-logo.jpeg'), ogc = logo('ogc-logo.png')
    if (rai) try { doc.image(rai, M, M - 6, { fit: [64, 64] }) } catch { /* no logo */ }
    if (ogc) try { doc.image(ogc, M + W - 50, M + 10, { fit: [50, 36], align: 'right', valign: 'center' }) } catch { /* no logo */ }
    line('FUELLING REPORT', M + 76, M + 4, W - 170, { font: F.bold, size: 9, color: C.sub })
    line('Plan vs Actual', M + 76, M + 16, W - 170, { font: F.bold, size: 30 })
    line(`${titleCase(o.factoryName)}  ·  ${o.orgName}`, M + 76, M + 48, W - 170, { size: 8.5, color: C.sub })
  }
  let y = M + 78
  {
    const prepared = (() => { const d = new Date(now + 3 * 3_600_000); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${d.toISOString().slice(11, 16)}` })()
    const meta: [string, string][] = [
      ['DAY', period], ['SITES', nf(p.bySite.length)], ['STATE', p.closed ? 'Day closed' : 'So far today'],
      ['PREPARED', prepared], ['PREPARED BY', PREPARED_BY],
    ]
    const widths = meta.map(([l, v]) => Math.max(doc.font(F.bold).fontSize(6.8).widthOfString(l), doc.font(F.bold).fontSize(9.5).widthOfString(v)) + 20)
    const spare = Math.max(0, W - widths.reduce((a, w) => a + w, 0)) / meta.length
    doc.rect(M, y, W, 40).fill(C.panel)
    let mx = M
    meta.forEach(([l, v], i) => {
      const cw = widths[i]! + spare
      line(l, mx + 10, y + 8, cw - 14, { font: F.bold, size: 6.8, color: C.sub })
      line(v, mx + 10, y + 20, cw - 14, { font: F.bold, size: 9.5 })
      mx += cw
    })
    y += 54
  }

  // The opening sentence, its figures in bold
  {
    const lead = fuellingLead(p)
    // The figures in bold, and the site named at the end whole (a site's own
    // number, "Zone 4", is part of its name, not a figure)
    const site = p.bySite.map(g => g.name).filter(n => lead.includes(`${n} has the most`)).sort((x, z) => z.length - x.length)[0]
    const runs: [string, boolean][] = []
    const figures = (text: string) => {
      let at = 0
      for (const m of text.matchAll(/\d[\d,.]*/g)) {
        if (m.index! > at) runs.push([text.slice(at, m.index), false])
        runs.push([m[0], true])
        at = m.index! + m[0].length
      }
      if (at < text.length) runs.push([text.slice(at), false])
    }
    if (site) {
      const i = lead.indexOf(`${site} has the most`)
      figures(lead.slice(0, i))
      runs.push([site, true])
      figures(lead.slice(i + site.length))
    } else figures(lead)
    y = para(runs, y) + 8
  }

  // ── five figure tiles ──
  {
    const tiles: { l: string; v: string; sub: string; c: string }[] = [
      { l: 'MACHINES FUELLED', v: nf(t.fuelled), sub: `${pct(t.fuelled, t.planned)} of ${nf(t.planned)} planned`, c: C.ink },
      { l: 'LITRES DELIVERED', v: nf(t.fuelledOnFiguresL), sub: t.plannedL > 0 ? `${pct(t.fuelledOnFiguresL, t.plannedL)} of ${nf(t.plannedL)} L planned` : 'no litres planned', c: C.ink },
      { l: 'NOT FUELLED', v: nf(t.notFuelled), sub: t.fullTankWaiting ? `incl. ${nf(t.fullTankWaiting)} "full tank" plan${t.fullTankWaiting === 1 ? '' : 's'}` : t.fuellingNow ? `${nf(t.fuellingNow)} fuelling now` : `of ${nf(t.planned)} planned`, c: C.red },
      { l: 'FUELLED SHORT', v: nf(t.short), sub: t.short ? `${nf(t.shortfallL)} L under their plan` : 'none under plan', c: C.amberInk },
      { l: 'AS PLANNED', v: nf(t.asPlanned), sub: t.over ? `${nf(t.over)} over plan` : `within ${Math.round(AS_PLANNED_SHARE * 100)}% of plan`, c: C.green },
    ]
    const gap = 8, cw = (W - gap * 4) / 5, ch = 66
    tiles.forEach((tile, i) => {
      const x = M + i * (cw + gap)
      doc.rect(x, y, cw, ch).lineWidth(0.6).stroke(C.line)
      doc.rect(x, y, 3, ch).fill(tile.c)
      line(tile.l, x + 10, y + 9, cw - 14, { font: F.bold, size: 6.6, color: C.sub })
      line(tile.v, x + 10, y + 21, cw - 14, { font: F.bold, size: 21, color: tile.c })
      doc.font(F.reg).fontSize(7).fillColor(C.sub).text(tile.sub, x + 10, y + 46, { width: cw - 16, height: 18, lineGap: 0.5 })
    })
    y += ch + 8
  }

  // ── where every planned machine stands ──
  if (t.planned) {
    y = title('Where Every Planned Machine Stands', `Share of the day's ${nf(t.planned)}-machine plan by fuelling status`, y, 40)
    const parts = (['Not fuelled', 'Fuelling now', 'Short', 'Over', 'As planned'] as FuellingStatus[])
      .map(s => ({ s, n: p.machines.filter(m => m.status === s).length }))
      .filter(x => x.n > 0)
    let x = M
    parts.forEach((part, i) => {
      const w = (part.n / t.planned) * W
      doc.rect(x, y, w, 16).fill(STATUS_COLOR[part.s])
      if (i) doc.moveTo(x, y).lineTo(x, y + 16).lineWidth(1.2).stroke(C.paper)
      x += w
    })
    y += 26
    let kx = M
    for (const part of parts) {
      const label = `${part.s}  ${nf(part.n)}  (${pct(part.n, t.planned)})`
      doc.circle(kx + 4, y + 3.5, 3.6).fill(STATUS_COLOR[part.s])
      line(label, kx + 11, y, 160, { size: 8, color: C.sub })
      kx += doc.font(F.reg).fontSize(8).widthOfString(label) + 28
    }
    y += 18
  }

  /** A labelled track with a fill: label left, figure right, the bar under. */
  const track = (label: string, figure: string, of: number, fill: number, max: number, color: string, yy: number, o: { faint?: boolean } = {}) => {
    line(label, M, yy, W - 150, { size: 8.5, color: o.faint ? C.faint : C.ink })
    line(figure, M + W - 150, yy, 150, { size: 8.5, color: C.sub, align: 'right' })
    const tw = max > 0 ? Math.max(6, (of / max) * W) : W
    doc.roundedRect(M, yy + 13, tw, 5, 2.5).fill(C.track)
    if (fill > 0 && max > 0) doc.roundedRect(M, yy + 13, Math.max(5, Math.min(W, (fill / max) * W)), 5, 2.5).fill(color)
    return yy + 26
  }

  /** The estate drawing in greys, the report's sites marked on it by name. */
  const drawPlantingPlan = (features: PlanFeature[], yy: number) => {
    const pts: [number, number][] = features.flatMap(f => (f.geometry.type === 'Polygon' ? f.geometry.coordinates.flat() : f.geometry.coordinates))
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const [lng, lat] of pts) { x0 = Math.min(x0, lng); x1 = Math.max(x1, lng); y0 = Math.min(y0, lat); y1 = Math.max(y1, lat) }
    const kx = Math.cos(((y0 + y1) / 2) * Math.PI / 180)
    const spanX = (x1 - x0) * kx, spanY = y1 - y0
    const boxH = Math.min(540, W * (spanY / spanX))
    const scale = Math.min(W / spanX, boxH / spanY)
    const ox = M + (W - spanX * scale) / 2
    // No heading of its own (operator 2026-11-27): the map follows Progress by Site
    yy = room(yy + 14, boxH + 60)
    const top = yy
    const px = (lng: number) => ox + (lng - x0) * kx * scale
    const py = (lat: number) => top + (y1 - lat) * scale
    const trace = (pts2: [number, number][], close: boolean) => {
      pts2.forEach(([lng, lat], i) => (i ? doc.lineTo(px(lng), py(lat)) : doc.moveTo(px(lng), py(lat))))
      if (close) doc.closePath()
    }
    for (const cls of PLAN_ORDER) {
      const st = PLAN_GREYS[cls]!
      for (const f of features) {
        if (f.properties.c !== cls) continue
        doc.save()
        if (st.dash) doc.dash(st.dash[0], { space: st.dash[1] })
        if (f.geometry.type === 'Polygon') {
          for (const ring of f.geometry.coordinates) trace(ring, true)
          if (st.fill && st.stroke) doc.lineWidth(st.width ?? 0.4).fillAndStroke(st.fill, st.stroke)
          else if (st.fill) doc.fill(st.fill)
          else doc.lineWidth(st.width ?? 0.4).stroke(st.stroke ?? C.ink)
        } else {
          trace(f.geometry.coordinates, false)
          doc.lineWidth(st.width ?? 0.5).stroke(st.stroke ?? C.ink)
        }
        doc.restore()
      }
    }

    // Each site matched by name to an area of the drawing, marked at the largest such area's middle
    const fold = (t: string | null | undefined) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const off: string[] = []
    const marks: { x: number; y: number; label: string }[] = []
    for (const g of p.bySite) {
      const fig = `${nf(g.fuelled)} of ${nf(g.planned)}`
      const hits = features.filter(f => f.geometry.type === 'Polygon' && PLACE_CLASSES.has(f.properties.c) && fold(f.properties.n) === fold(g.name))
      if (!hits.length) { if (!/no site/i.test(g.name)) off.push(`${g.name} (${fig})`); continue }
      const best = hits
        .map(f => centroid((f.geometry.coordinates as [number, number][][])[0]!))
        .sort((a, z) => z.area - a.area)[0]!
      marks.push({ x: px(best.lng), y: py(best.lat), label: `${g.name}  ${fig}` })
    }
    // A label beside its dot where it clears the labels already set: right, left, above, below, then further out
    const placed: { x: number; y: number; w: number; h: number }[] = []
    const clear = (b: { x: number; y: number; w: number; h: number }) => b.x >= M && b.x + b.w <= M + W &&
      placed.every(o => b.x + b.w + 2 <= o.x || o.x + o.w + 2 <= b.x || b.y + b.h + 2 <= o.y || o.y + o.h + 2 <= b.y)
    for (const m of marks) doc.circle(m.x, m.y, 3.4).lineWidth(1.4).fillAndStroke(C.ink, '#ffffff')
    for (const m of marks) {
      doc.font(F.bold).fontSize(7.4)
      const w = doc.widthOfString(m.label) + 10, h = 14
      const tries = [0, 1, 2].flatMap(k => [
        { x: m.x + 7, y: m.y - 7 + k * 16 }, { x: m.x - 7 - w, y: m.y - 7 + k * 16 },
        { x: m.x - w / 2, y: m.y - 22 - k * 16 }, { x: m.x - w / 2, y: m.y + 8 + k * 16 },
      ])
      const at = tries.map(t => ({ ...t, w, h })).find(clear) ?? { x: m.x + 7, y: m.y - 7, w, h }
      placed.push(at)
      if (Math.abs(at.y + h / 2 - m.y) > 9) doc.moveTo(m.x, m.y).lineTo(at.x + w / 2, at.y + (at.y > m.y ? 0 : h)).lineWidth(0.6).stroke(C.ink)
      doc.roundedRect(at.x, at.y, w, h, 2).lineWidth(0.7).fillAndStroke('#ffffff', C.ink)
      doc.fillColor(C.ink).text(m.label, at.x + 5, at.y + 3.4, { width: w - 6, lineBreak: false })
    }
    yy = top + boxH + 10

    // The key, then the sites the drawing has no area for
    let kx2 = M
    for (const [cls, words] of PLAN_KEY) {
      const st = PLAN_GREYS[cls]!
      const w = doc.font(F.reg).fontSize(7).widthOfString(words) + 22
      if (kx2 + w > M + W) { kx2 = M; yy += 12 }
      doc.save()
      if (st.dash) doc.dash(st.dash[0], { space: st.dash[1] })
      if (st.fill) doc.rect(kx2, yy + 1, 10, 7).lineWidth(0.4).fillAndStroke(st.fill, st.stroke ?? st.fill)
      else doc.moveTo(kx2, yy + 4.5).lineTo(kx2 + 10, yy + 4.5).lineWidth(Math.max(0.8, st.width ?? 0.8)).stroke(st.stroke ?? C.ink)
      doc.restore()
      line(words, kx2 + 13, yy, w - 13, { size: 7, color: C.sub })
      kx2 += w
    }
    yy += 14
    if (off.length) {
      doc.font(F.reg).fontSize(7.4).fillColor(C.sub).text(`Not on the drawing: ${off.join(', ')}.`, M, yy, { width: W, lineGap: 1 })
      yy = doc.y + 4
    }
    return yy
  }

  // ── progress by site ──
  if (p.bySite.length) {
    y = title('Progress by Site', 'Machines fuelled out of machines planned at each site', y, 26 * Math.min(4, p.bySite.length))
    for (const g of p.bySite) {
      y = room(y, 26)
      y = track(g.name, `${nf(g.fuelled)} of ${nf(g.planned)} fuelled`, g.planned, g.fuelled, g.planned, C.blue, y, { faint: /no site/i.test(g.name) })
    }
  }

  // ── the planting plan, in black and white, each site's progress on it ──
  const estate = p.factory === PLANTING_PLAN_FACTORY ? plantingPlan() : null
  if (estate && p.bySite.length) y = drawPlantingPlan(estate, y)

  // ── litres by equipment type ──
  if (p.byType.length) {
    const max = Math.max(...p.byType.map(g => Math.max(g.plannedL, g.fuelledL)))
    y = title('Litres by Equipment Type', 'Litres fuelled against litres planned. "Full tank" plans with no litre figure are left out.', y, 26 * Math.min(4, p.byType.length))
    for (const g of p.byType) {
      y = room(y, 26)
      y = track(g.name, `${litres(g.fuelledL)} / ${litres(g.plannedL)} L`, g.plannedL, g.fuelledL, max, g.fuelledL > g.plannedL * (1 + AS_PLANNED_SHARE) ? C.violet : C.blue, y, { faint: g.name === 'Unspecified' })
    }
  }

  // ── machines fuelled: how close to plan ──
  const fuelled = p.machines.filter(m => m.fuelledL > 0)
    .sort((a, b) => (a.diffL ?? Infinity) - (b.diffL ?? Infinity) || a.machine.localeCompare(b.machine, undefined, { numeric: true }))
  if (fuelled.length) {
    const max = Math.max(...fuelled.map(m => Math.max(m.plannedL ?? 0, m.fuelledL)))
    y = title('Machines Fuelled: How Close to Plan', 'Each bar is the planned amount; the fill is what was actually put in. Biggest shortfalls first.', y, 26 * Math.min(4, fuelled.length))
    for (const m of fuelled) {
      y = room(y, 26)
      const label = [m.machine, m.type ?? 'Unspecified', m.site].filter(Boolean).join('  ·  ')
      const figure = m.plannedL == null
        ? `${litres(m.fuelledL)} L, full tank`
        : `${litres(m.fuelledL)} / ${litres(m.plannedL)} L${m.diffL ? ` (${signed(m.diffL)})` : ''}`
      y = track(label, figure, m.plannedL ?? m.fuelledL, m.fuelledL, max, STATUS_COLOR[m.status], y)
    }
  }

  // ── a table, carried over pages with its head repeated ──
  type Col = { h: string; w: number; r?: boolean }
  const table = (cols: Col[], rows: { cells: string[]; dot?: string; tone?: (string | null)[] }[], yy: number) => {
    const scale = W / cols.reduce((a, c) => a + c.w, 0)
    const ws = cols.map(c => c.w * scale)
    const rowH = 15
    const drawHead = (hy: number) => {
      doc.rect(M, hy - 4, W, 16).fill(C.panel)
      let x = M
      cols.forEach((c, i) => { line(c.h, x + 4, hy, ws[i]! - 8, { font: F.bold, size: 6.8, color: C.sub, align: c.r ? 'right' : 'left' }); x += ws[i]! })
      return hy + 16
    }
    yy = drawHead(yy)
    rows.forEach((r, n) => {
      if (yy + rowH > BOTTOM) { doc.addPage(); yy = drawHead(head(current)) }
      if (n % 2 === 1) doc.rect(M, yy - 4, W, rowH).fill(C.panel)
      let x = M
      cols.forEach((c, i) => {
        const dot = i === 2 && r.dot
        if (dot) doc.circle(x + 7, yy + 3.2, 3).fill(r.dot!)
        line(r.cells[i] ?? '', x + (dot ? 14 : 4), yy, ws[i]! - (dot ? 18 : 8), { size: 7.6, color: r.tone?.[i] ?? C.ink, align: c.r ? 'right' : 'left' })
        x += ws[i]!
      })
      yy += rowH
    })
    return yy + 6
  }

  // ── fuelled off plan ──
  if (p.offPlan.length) {
    y = title('Fuelled Off Plan', `${plural(p.offPlan.length, 'machine')} fuelled that no approved plan or vehicle request named: ${litres(t.offPlanL)} L, not in the figures above`, y, 60)
    y = table(
      [{ h: 'MACHINE', w: 16 }, { h: 'TYPE', w: 22 }, { h: 'SITE', w: 22 }, { h: 'DEPARTMENT', w: 20 }, { h: 'FUELLINGS', w: 10, r: true }, { h: 'FUELLED L', w: 12, r: true }],
      p.offPlan.map(m => ({ cells: [m.machine, m.type ?? 'Unspecified', m.site ?? '-', m.department ? titleCase(m.department) : '-', nf(m.fuellings), litres(m.fuelledL)], tone: [null, m.type ? null : C.faint] })),
      y,
    )
  }

  // ── machine list ──
  if (p.machines.length) {
    y = title('Machine List', `All ${nf(t.planned)} machines, in fuelling status order: fuelling now, short, over, not fuelled, as planned.`, y, 80)
    y = table(
      [{ h: 'MACHINE', w: 13.5 }, { h: 'TYPE', w: 19.5 }, { h: 'STATUS', w: 13 }, { h: 'SITE', w: 20 }, { h: 'PLAN', w: 8.8 }, { h: 'PLANNED L', w: 11.5, r: true }, { h: 'FUELLED L', w: 10.5, r: true }, { h: 'VARIANCE L', w: 12, r: true }],
      p.machines.map(m => ({
        dot: STATUS_COLOR[m.status],
        cells: [m.machine, m.type ?? 'Unspecified', m.status, m.site ?? '-', m.plannedL == null ? 'Full tank' : m.request ? 'Request' : 'Litres',
          m.plannedL == null ? '' : litres(m.plannedL), litres(m.fuelledL), m.diffL == null ? '' : signed(m.diffL)],
        tone: [null, m.type ? null : C.faint, null, null, m.plannedL == null ? C.faint : null, null, null, m.diffL != null && m.diffL < 0 ? C.red : null],
      })),
      y,
    )
  }

  // ── footers ──
  const built = new Date(now + 3 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')
  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    doc.page.margins.bottom = 0
    const fy = PAGE_H - M + 6
    doc.moveTo(M, fy - 6).lineTo(M + W, fy - 6).lineWidth(0.5).stroke(C.line)
    line('Rai Operations  ·  plans, requests and fuellings from FactorySuite', M, fy, W - 220, { size: 6.5, color: C.sub })
    line(`${PREPARED_BY}  ·  built ${built} EAT  ·  ${i + 1}/${range.count}`, M + W - 220, fy, 220, { size: 6.5, color: C.sub, align: 'right' })
  }
  doc.end()
  return done
}
