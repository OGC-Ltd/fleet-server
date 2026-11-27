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
 *   Litres by Equipment Type — litres fuelled against litres planned;
 *   Machines Fuelled: How Close to Plan — each fuelled machine's plan as a
 *     track and what went in as the fill, the biggest shortfall first;
 *   Fuelled Off Plan — machines the pumps fuelled that no plan named;
 *   Machine List — every planned machine, by status;
 *   How These Numbers Are Worked Out.
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

  // ── progress by site ──
  if (p.bySite.length) {
    y = title('Progress by Site', 'Machines fuelled out of machines planned at each site', y, 26 * Math.min(4, p.bySite.length))
    for (const g of p.bySite) {
      y = room(y, 26)
      y = track(g.name, `${nf(g.fuelled)} of ${nf(g.planned)} fuelled`, g.planned, g.fuelled, g.planned, C.blue, y, { faint: /no site/i.test(g.name) })
    }
  }

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
      [{ h: 'MACHINE', w: 13 }, { h: 'TYPE', w: 19 }, { h: 'STATUS', w: 14 }, { h: 'SITE', w: 20 }, { h: 'PLAN', w: 8 }, { h: 'PLANNED L', w: 10, r: true }, { h: 'FUELLED L', w: 10, r: true }, { h: 'DIFFERENCE L', w: 13, r: true }],
      p.machines.map(m => ({
        dot: STATUS_COLOR[m.status],
        cells: [m.machine, m.type ?? 'Unspecified', m.status, m.site ?? '-', m.plannedL == null ? 'Full tank' : m.request ? 'Request' : 'Litres',
          m.plannedL == null ? '' : litres(m.plannedL), litres(m.fuelledL), m.diffL == null ? '' : signed(m.diffL)],
        tone: [null, m.type ? null : C.faint, null, null, m.plannedL == null ? C.faint : null, null, null, m.diffL != null && m.diffL < 0 ? C.red : null],
      })),
      y,
    )
  }

  // ── how these numbers are worked out ──
  {
    const notes = [
      'Planned: every machine on an approved work plan for the day whose fuel request is approved, and every approved vehicle request no plan names ("Request" in the Plan column). A machine on two shifts is one machine, its litres added; the litres are the fuel request’s.',
      'Fuelled: completed fuellings at the pumps that day, from FactorySuite.',
      '"Full tank" plans with no litre figure count in the machine totals but not in any litre total or percentage; a full tank\'s request litres are its plan where the request gives them.',
      'Litres delivered % = litres fuelled ÷ litres planned, on plans that give a litre figure.',
      `"As planned" is within ${Math.round(AS_PLANNED_SHARE * 100)}% of the planned litres; "Short" is fuelled but more than ${Math.round(AS_PLANNED_SHARE * 100)}% under, "Over" more than ${Math.round(AS_PLANNED_SHARE * 100)}% over. Shortfall is planned less fuelled on the Short machines.`,
      ...(p.pendingLines ? [`${plural(p.pendingLines, 'plan line')} whose plan or fuel request still waits for approval ${p.pendingLines === 1 ? 'is' : 'are'} not counted.`] : []),
      ...(p.rejectedLines ? [`${plural(p.rejectedLines, 'plan line')} whose fuel request was rejected or cancelled ${p.rejectedLines === 1 ? 'is' : 'are'} not counted.`] : []),
      'Machines with no type in the machine register are shown as "Unspecified"; a vehicle request names no site, so its site is the pump that fuelled it, else the pump it was last fuelled at.',
    ]
    doc.font(F.reg).fontSize(7.6)
    const h = notes.reduce((a, n) => a + doc.heightOfString(n, { width: W - 12 }) + 3, 0)
    current = 'Notes'
    y = room(y + 8, h + 20)
    line('How these numbers are worked out', M, y, W, { font: F.bold, size: 9 })
    y += 14
    for (const n of notes) {
      doc.circle(M + 3, y + 3.6, 1.3).fill(C.sub)
      doc.font(F.reg).fontSize(7.6).fillColor(C.sub).text(n, M + 10, y, { width: W - 12, lineGap: 0.5 })
      y = doc.y + 3
    }
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
