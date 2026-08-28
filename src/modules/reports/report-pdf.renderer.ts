// Branded PDF report renderer — the layout engine behind the downloadable
// Analytics / Drivers / Maintenance reports. Dark themed, real multi-page
// document (running header/footer, "Page X of Y" numbering): brand header,
// labeled KPI tile groups, an "operational + probes" donut/gauge row, a
// bar-list card beside a donut card, a ranked two-column card, stat panels,
// category & combo charts, a daily bar chart, a dark "what stands out"
// insight band, and one or more log tables that flow across pages when they
// don't fit. Each report kind supplies the same ReportData shape
// (report-pdf.service.ts) and this module draws it.
//
// Pure drawing — no DB access. Uses pdfkit's bufferPages mode: content is
// drawn first (adding pages as sections overflow), then a final pass walks
// every buffered page to stamp the footer with the correct "Page X of Y".

import PDFDocument from 'pdfkit'

// ── data contract ────────────────────────────────────────────────────────────

export interface ReportKpi {
  label: string
  value: string
  unit?: string
  sub: string
  dark?: boolean            // the one highlighted deep-green tile
}

export interface ReportKpiGroup {
  label: string             // section label, e.g. "TODAY ON THE GROUND"
  kpis: ReportKpi[]
}

export interface ReportBarRow {
  label: string
  note?: string             // faint suffix after the label ("· 20 L jerricans")
  value: string             // bold part of the right figure ("263.8")
  valueNote?: string        // faint part ("t · 16")
  frac: number              // bar fill 0..1
}

export interface ReportDonut {
  centerValue: string       // "91%"
  centerLabel: string       // "ON TIME"
  segments: { label: string; value: string; frac: number; color: string }[]
}

export interface ReportGauge {
  value: number                                     // 0..100, needle position
  bands: { frac: number; color: string }[]          // arc segments, fracs sum to 1, drawn left→right
  footnotes?: { value: string; label: string }[]     // "2 tracker silent", "1 probe dead" …
}

export interface ReportGaugePanel {
  sectionLabel?: string                             // e.g. "OPERATIONAL TODAY & PROBES"
  donutTitle: string
  donutNote?: string
  donut: ReportDonut
  donutAccent?: string                              // left-edge accent stripe color
  gaugeTitle: string
  gaugeNote?: string                                // "27 of 32"
  gauge: ReportGauge
  gaugeAccent?: string
}

export interface ReportStatPanel {
  title: string
  underline?: boolean       // thin green rule under the title (template's right panel)
  bigs: { value: string; unit?: string; caption: string }[]   // 2 or 4 (2×2)
  rows?: { label: string; value: string }[]                   // light pill rows
}

export interface ReportDailyChart {
  title: string
  legend: { label: string; color: string }[]
  bars: { frac: number; alert?: boolean }[]
}

export interface ReportCategoryBarChart {
  title: string
  note?: string
  legend: { label: string; color: string }[]
  bars: { category: string; frac: number; colorIndex?: number }[]   // colorIndex → legend
  footnotes?: string[]
}

export interface ReportComboChart {
  title: string
  legend: { label: string; color: string; type: 'bar' | 'line' }[]  // bar series + 1 line, in that order
  categories: string[]
  seriesA: number[]
  seriesB: number[]
  line: number[]
}

export interface ReportInsight { title: string; body: string }

export interface ReportTable {
  title: string
  note?: string
  columns: { label: string; width: number; align?: 'left' | 'right' }[]  // widths are fractions summing ~1
  rows: { cells: string[]; alert?: boolean; lastCellColor?: 'good' | 'bad' }[]
}

export interface ReportData {
  title: string             // "Fleet Analytics Report"
  orgName: string
  orgRegion: string         // "CENTRAL RIFT · KENYA"
  windowLabel: string       // "Trailing 30 days"
  kpiLabel?: string         // section label above the primary KPI row, e.g. "SUMMARY"
  kpis: ReportKpi[]
  kpiGroups?: ReportKpiGroup[]                      // additional labeled KPI rows, e.g. "TODAY ON THE GROUND"
  gaugePanel?: ReportGaugePanel                     // paired donut + gauge row
  bars: { title: string; note?: string; rows: ReportBarRow[] }
  donut: { title: string; note?: string; data: ReportDonut }
  ranked?: { title: string; titleNote?: string; note?: string; rows: ReportBarRow[] }
  panels: ReportStatPanel[]
  daily?: ReportDailyChart
  categoryChart?: ReportCategoryBarChart            // e.g. "Fuel per operating hour"
  comboChart?: ReportComboChart                     // e.g. "Fuel by day" (two bar series + trend line)
  insights: ReportInsight[]
  table: ReportTable
  extraTables?: ReportTable[]                       // additional tables (e.g. "Fleet composition by prefix")
}

// ── theme (dark, sampled from the template) ─────────────────────────────────

const W = 870
const PAGE_H = 1150          // one printable page (A4-ish proportions at this width)
const M = 30                 // page margin
const PAD = 22               // card padding
const GAP = 16               // gap between cards
const FOOTER_H = 34           // reserved footer band at the bottom of every page
const TOP_STRIP_H = 5

const C = {
  bg: '#0a0b0c',
  card: '#15171a',
  border: '#26292c',
  track: '#24272a',
  ink: '#f4f3f0',
  sub: '#9a9994',
  faint: '#6d6c68',
  green: '#1e6f4e',
  greenBright: '#2fae7a',
  greenDeep: '#173d2f',
  greenSoft: '#cfe0d6',
  amber: '#d97706',
  red: '#cf4a3d',
  redSoft: '#eec7c2',
  chipInk: '#e8c98a',
  pillBg: '#1c1f22',
}

const F = { reg: 'Helvetica', bold: 'Helvetica-Bold' }

const fmtDate = (d: Date) =>
  d.toLocaleString('en-KE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' })

// ── State pill rendering ────────────────────────────────────────────────────

const stateColors: Record<string, string> = {
  WORKING: '#2fae7a',        // bright green
  STATIONARY: '#8a6fd6',     // violet
  IDLING: '#d97706',         // amber
  PARKED: '#6d6c68',         // grey
  OFFLINE: '#cf4a3d',        // red
}

function renderStatePill(doc: PDFKit.PDFDocument, state: string, x: number, y: number): void {
  const color = stateColors[state] || '#6d6c68'
  doc.circle(x + 2, y + 4, 3).fill(color)
  const label = state.charAt(0) + state.slice(1).toLowerCase()
  doc.font(F.reg).fontSize(8.8).fillColor(C.ink).text(label, x + 10, y, { lineBreak: false })
}

function renderStatusPill(doc: PDFKit.PDFDocument, status: string, x: number, y: number): void {
  const isOp = status === 'Operational'
  const color = isOp ? C.greenBright : C.red
  doc.circle(x + 2, y + 4, 3).fill(color)
  doc.font(F.reg).fontSize(8.8).fillColor(C.ink).text(status, x + 10, y, { lineBreak: false })
}

// ── renderer ─────────────────────────────────────────────────────────────────

export async function renderReportPdf(data: ReportData): Promise<Buffer> {
  const doc = new PDFDocument({ size: [W, PAGE_H], margin: 0, bufferPages: true })
  const inner = W - M * 2
  const pager = new Pager(doc)
  pager.newPage(true)

  // ── header (page 1 only) ──
  doc.font(F.bold).fontSize(30).fillColor(C.ink).text(data.title, M, pager.y)
  doc.font(F.bold).fontSize(14).fillColor(C.ink)
    .text(data.orgName.toUpperCase(), W / 2, pager.y + 6, { width: W / 2 - M, align: 'right' })
  doc.font(F.reg).fontSize(7.5).fillColor(C.faint)
    .text(data.orgRegion.toUpperCase(), W / 2, pager.y + 24, { width: W / 2 - M, align: 'right', characterSpacing: 2 })
  pager.y += 42
  doc.font(F.reg).fontSize(10.5).fillColor(C.sub)
    .text(`${data.orgName}  ·  ${data.windowLabel}  ·  Generated ${fmtDate(new Date())}`, M, pager.y)
  pager.y += 34

  // ── primary KPI row ──
  if (data.kpiLabel) pager.y = sectionLabel(doc, data.kpiLabel, M, pager.y, inner)
  pager.ensure(92)
  kpiRow(doc, data.kpis, M, pager.y, inner)
  pager.y += 92 + GAP

  // ── additional labeled KPI groups ──
  for (const group of data.kpiGroups ?? []) {
    pager.ensure(16 + 16 + 92)
    pager.y = sectionLabel(doc, group.label, M, pager.y, inner)
    kpiRow(doc, group.kpis, M, pager.y, inner)
    pager.y += 92 + GAP
  }

  // ── paired donut + gauge row (e.g. Fleet state now / Probes & sensors) ──
  if (data.gaugePanel) {
    const gp = data.gaugePanel
    if (gp.sectionLabel) pager.y = sectionLabel(doc, gp.sectionLabel, M, pager.y, inner)
    const rowH = 250
    pager.ensure(rowH)
    const leftW2 = Math.round(inner * 0.5)
    const rightW2 = inner - leftW2 - GAP
    donutCard(doc, { title: gp.donutTitle, note: gp.donutNote, data: gp.donut }, M, pager.y, leftW2, rowH, gp.donutAccent)
    gaugeCard(doc, gp, M + leftW2 + GAP, pager.y, rightW2, rowH, gp.gaugeAccent)
    pager.y += rowH + GAP
  }

  // ── bar-list card + donut card ──
  if (data.bars.rows.length > 0) {
    const leftW = Math.round(inner * 0.56)
    const rightW = inner - leftW - GAP
    const donutLegendH = data.donut.data.segments.length * 22 + 10
    const donutMinH = PAD * 2 + 30 + donutLegendH + 132
    const rowH = Math.max(measureBarList(data.bars.rows.length), donutMinH)
    pager.ensure(rowH)
    barListCard(doc, data.bars, M, pager.y, leftW, rowH)
    donutCard(doc, data.donut, M + leftW + GAP, pager.y, rightW, rowH)
    pager.y += rowH + GAP
  }

  // ── ranked two-column card ──
  if (data.ranked && data.ranked.rows.length > 0) {
    const h = measureRanked(data.ranked.rows.length)
    pager.ensure(h)
    rankedCard(doc, data.ranked, M, pager.y, inner)
    pager.y += h + GAP
  }

  // ── stat panels ──
  if (data.panels.length === 2) {
    const pw = (inner - GAP) / 2
    const h1 = statPanel(doc, data.panels[0]!, 0, 0, pw, true)
    const h2 = statPanel(doc, data.panels[1]!, 0, 0, pw, true)
    const hp = Math.max(h1, h2)
    pager.ensure(hp)
    statPanel(doc, data.panels[0]!, M, pager.y, pw, false, hp)
    statPanel(doc, data.panels[1]!, M + pw + GAP, pager.y, pw, false, hp)
    pager.y += hp + GAP
  }

  // ── category bar chart (e.g. Fuel per operating hour) ──
  if (data.categoryChart && data.categoryChart.bars.length > 0) {
    const h = measureCategoryChart(data.categoryChart)
    pager.ensure(h)
    categoryBarCard(doc, data.categoryChart, M, pager.y, inner)
    pager.y += h + GAP
  }

  // ── combo chart — two bar series + trend line (e.g. Fuel by day) ──
  if (data.comboChart && data.comboChart.categories.length > 0) {
    const h = PAD * 2 + 34 + 160 + 20
    pager.ensure(h)
    comboChartCard(doc, data.comboChart, M, pager.y, inner)
    pager.y += h + GAP
  }

  // ── daily activity chart ──
  if (data.daily && data.daily.bars.length > 0) {
    const h = PAD * 2 + 30 + 118
    pager.ensure(h)
    dailyChartCard(doc, data.daily, M, pager.y, inner)
    pager.y += h + GAP
  }

  // ── insight band ──
  if (data.insights.length > 0) {
    doc.font(F.reg).fontSize(8.6)
    const colGap = 26
    const colW = (inner - PAD * 2 - colGap * 2) / 3
    const bodyH = Math.max(...data.insights.slice(0, 3).map(i => doc.heightOfString(i.body, { width: colW, lineGap: 2.6 })))
    const h = PAD * 2 + 16 + 18 + bodyH
    pager.ensure(h)
    insightBand(doc, data.insights, M, pager.y, inner)
    pager.y += h + GAP
  }

  // ── log tables (flow across pages as needed) ──
  for (const table of [data.table, ...(data.extraTables ?? [])]) {
    if (table.rows.length === 0) continue
    flowTable(doc, pager, table, M, inner)
    pager.y += 26
  }

  // ── stamp footers on every buffered page ──
  const range = doc.bufferedPageRange()
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i)
    drawFooter(doc, data, i + 1, range.count)
  }

  return toBuffer(doc)
}

function toBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    doc.end()
  })
}

// ── pagination ───────────────────────────────────────────────────────────────

class Pager {
  y = 0
  constructor(private doc: PDFKit.PDFDocument) {}

  /** Starts a fresh page: background, top strip, and (page 2+) a slim repeated brand bar. */
  newPage(first: boolean) {
    const doc = this.doc
    if (!first) doc.addPage()
    doc.rect(0, 0, W, PAGE_H).fill(C.bg)
    doc.rect(0, 0, W * 0.74, TOP_STRIP_H).fill(C.greenDeep)
    doc.rect(W * 0.74, 0, W * 0.26, TOP_STRIP_H).fill(C.amber)
    this.y = 34
    doc.circle(M + 4, this.y + 4, 3.5).fill(C.green)
    doc.font(F.bold).fontSize(9).fillColor(C.green).text('FLEET TRACKING', M + 16, this.y, { characterSpacing: 3 })
    const chipW = 118
    doc.roundedRect(W - M - chipW, this.y - 6, chipW, 22, 4).lineWidth(1).stroke(C.border)
    doc.font(F.bold).fontSize(7.5).fillColor(C.chipInk)
      .text('CONFIDENTIAL', W - M - chipW, this.y + 1, { width: chipW, align: 'center', characterSpacing: 2 })
    this.y += first ? 26 : 40
  }

  /** Advances to a new page if `need` more px won't fit before the footer band. */
  ensure(need: number) {
    if (this.y + need > PAGE_H - FOOTER_H) this.newPage(false)
  }
}

function drawFooter(doc: PDFKit.PDFDocument, data: ReportData, page: number, total: number) {
  const y = PAGE_H - FOOTER_H
  doc.moveTo(M, y).lineTo(W - M, y).lineWidth(1).stroke(C.border)
  doc.font(F.reg).fontSize(7.5).fillColor(C.faint)
    .text('FLEET TRACKING — CONFIDENTIAL', M, y + 12, { characterSpacing: 1.5, lineBreak: false })
  doc.text(`${data.orgName.toUpperCase()} · ${data.windowLabel.toUpperCase()}`, W / 2 - 150, y + 12, { width: 300, align: 'center', characterSpacing: 1.5, lineBreak: false })
  doc.text(`Page ${page} of ${total}`, W - M - 120, y + 12, { width: 120, align: 'right', lineBreak: false })
  doc.rect(0, PAGE_H - TOP_STRIP_H, W, TOP_STRIP_H).fill(C.greenDeep)
}

// ── sections ─────────────────────────────────────────────────────────────────

function sectionLabel(doc: PDFKit.PDFDocument, text: string, x: number, y: number, w: number): number {
  doc.font(F.bold).fontSize(8.5).fillColor(C.sub).text(text.toUpperCase(), x, y, { characterSpacing: 2, width: w })
  const ly = y + 15
  doc.moveTo(x, ly).lineTo(x + w, ly).lineWidth(1).stroke(C.border)
  return ly + 16
}

function kpiRow(doc: PDFKit.PDFDocument, kpis: ReportKpi[], x0: number, y: number, inner: number) {
  const n = Math.max(1, kpis.length)
  const w = (inner - GAP * (n - 1)) / n
  const h = 92
  kpis.forEach((k, i) => {
    const x = x0 + i * (w + GAP)
    card(doc, x, y, w, h, k.dark ? C.greenDeep : C.card)
    const label = k.dark ? C.greenSoft : C.faint
    const ink = k.dark ? '#ffffff' : C.ink
    const sub = k.dark ? C.greenSoft : C.sub
    doc.font(F.bold).fontSize(7.5).fillColor(label)
      .text(k.label.toUpperCase(), x + PAD, y + 17, { characterSpacing: 1.6, width: w - PAD * 2 })
    doc.font(F.bold).fontSize(27).fillColor(ink)
    const vw = doc.widthOfString(k.value)
    doc.text(k.value, x + PAD, y + 33, { lineBreak: false })
    if (k.unit) doc.font(F.reg).fontSize(12).fillColor(sub).text(k.unit, x + PAD + vw + 5, y + 33 + 11, { lineBreak: false })
    doc.font(F.reg).fontSize(8.5).fillColor(sub).text(k.sub, x + PAD, y + 66, { width: w - PAD * 2 })
  })
}

function cardTitle(doc: PDFKit.PDFDocument, x: number, y: number, w: number, title: string, note?: string, titleNote?: string) {
  doc.font(F.bold).fontSize(13.5).fillColor(C.ink).text(title, x + PAD, y + PAD - 4, { continued: !!titleNote })
  if (titleNote) doc.font(F.reg).fontSize(9.5).fillColor(C.faint).text(`  ${titleNote}`)
  if (note) {
    doc.font(F.reg).fontSize(7).fillColor(C.faint)
      .text(note.toUpperCase(), x, y + PAD, { width: w - PAD, align: 'right', characterSpacing: 1 })
  }
}

function measureBarList(rows: number): number {
  const rowH = 29
  return PAD * 2 + 18 + rows * rowH
}

function barListCard(doc: PDFKit.PDFDocument, s: ReportData['bars'], x: number, y: number, w: number, minH = 0): number {
  const h = Math.max(minH, measureBarList(s.rows.length))
  card(doc, x, y, w, h)
  cardTitle(doc, x, y, w, s.title, s.note)
  let ry = y + PAD + 22
  const bw = w - PAD * 2
  for (const r of s.rows) {
    doc.font(F.bold).fontSize(8.8).fillColor(C.ink).text(r.label, x + PAD, ry, { continued: !!r.note, lineBreak: false })
    if (r.note) doc.font(F.reg).fontSize(8).fillColor(C.faint).text(` · ${r.note}`, { lineBreak: false })
    const vFaint = r.valueNote ? ` ${r.valueNote}` : ''
    doc.font(F.reg).fontSize(8)
    const wFaint = doc.widthOfString(vFaint)
    doc.font(F.bold).fontSize(8.8)
    const wBold = doc.widthOfString(r.value)
    doc.fillColor(C.ink).text(r.value, x + PAD + bw - wBold - wFaint, ry, { lineBreak: false })
    if (vFaint) doc.font(F.reg).fontSize(8).fillColor(C.faint).text(vFaint, x + PAD + bw - wFaint, ry + 0.5, { lineBreak: false })
    const by = ry + 13
    doc.roundedRect(x + PAD, by, bw, 5, 2.5).fill(C.track)
    const fw = Math.max(3, bw * Math.min(1, Math.max(0, r.frac)))
    doc.roundedRect(x + PAD, by, fw, 5, 2.5).fill(C.green)
    ry += 29
  }
  return h
}

function donutCard(doc: PDFKit.PDFDocument, s: ReportData['donut'], x: number, y: number, w: number, h: number, accent?: string): number {
  card(doc, x, y, w, h, C.card, accent)
  const tx = accent ? x + 14 : x
  const tw = accent ? w - 14 : w
  cardTitle(doc, tx, y, tw, s.title)
  if (s.note) doc.font(F.reg).fontSize(8.5).fillColor(C.faint).text(s.note, tx + PAD, y + PAD + 16)

  const d = s.data
  const legendH = d.segments.length * 22 + 10
  const cx = tx + tw / 2
  const cy = y + PAD + 30 + (h - PAD * 2 - 30 - legendH) / 2
  const rOut = Math.min(64, (h - PAD * 2 - 30 - legendH) / 2 - 4)
  const ring = 17

  if (rOut > 24) {
    const r = rOut - ring / 2
    doc.circle(cx, cy, r).lineWidth(ring).stroke(C.track)
    let a0 = -Math.PI / 2
    for (const seg of d.segments) {
      const a1 = a0 + Math.PI * 2 * Math.min(1, Math.max(0, seg.frac))
      arc(doc, cx, cy, r, a0, a1).lineWidth(ring).stroke(seg.color)
      a0 = a1
    }
    doc.font(F.bold).fontSize(21).fillColor(C.ink)
      .text(d.centerValue, cx - r, cy - 12, { width: r * 2, align: 'center' })
    doc.font(F.reg).fontSize(6.5).fillColor(C.faint)
      .text(d.centerLabel.toUpperCase(), cx - r, cy + 10, { width: r * 2, align: 'center', characterSpacing: 1.2 })
  }

  let ly = y + h - PAD - d.segments.length * 22 + 6
  for (const seg of d.segments) {
    doc.roundedRect(tx + PAD, ly + 1, 8, 8, 2).fill(seg.color)
    doc.font(F.reg).fontSize(9).fillColor(C.ink).text(seg.label, tx + PAD + 15, ly)
    doc.font(F.bold).fontSize(9).fillColor(C.ink)
      .text(seg.value, tx + PAD, ly, { width: tw - PAD * 2, align: 'right' })
    ly += 22
  }
  return h
}

/** Semi-circle gauge with a full 0–100% tick ring, colored bands, and a needle. */
function gaugeCard(doc: PDFKit.PDFDocument, gp: ReportGaugePanel, x: number, y: number, w: number, h: number, accent?: string): number {
  card(doc, x, y, w, h, C.card, accent)
  const tx = accent ? x + 14 : x
  const tw = accent ? w - 14 : w
  cardTitle(doc, tx, y, tw, gp.gaugeTitle, gp.gaugeNote)

  const d = gp.gauge
  const cx = tx + tw / 2
  const r = Math.min(76, tw / 2 - PAD - 36)
  const cy = y + PAD + 48 + r
  const ring = 15

  let a0 = Math.PI
  for (const band of d.bands) {
    const a1 = a0 + Math.PI * Math.min(1, Math.max(0, band.frac))
    arc(doc, cx, cy, r, a0, a1).lineWidth(ring).stroke(band.color)
    a0 = a1
  }

  for (let t = 0; t <= 100; t += 10) {
    const ang = Math.PI + Math.PI * (t / 100)
    const tickX = cx + (r + 22) * Math.cos(ang)
    const tickY = cy + (r + 22) * Math.sin(ang)
    doc.font(F.reg).fontSize(6.5).fillColor(C.faint)
      .text(`${t}%`, tickX - 14, tickY - 4, { width: 28, align: 'center', lineBreak: false })
  }

  const angle = Math.PI + Math.PI * Math.min(1, Math.max(0, d.value / 100))
  const inner = r - ring / 2 - 6
  doc.moveTo(cx, cy).lineTo(cx + inner * Math.cos(angle), cy + inner * Math.sin(angle))
    .lineWidth(2.5).stroke('#ffffff')
  doc.circle(cx, cy, 3.5).fill(C.ink)

  doc.font(F.bold).fontSize(26).fillColor(C.ink)
    .text(`${Math.round(d.value)}%`, cx - 70, cy + 16, { width: 140, align: 'center' })

  if (d.footnotes?.length) {
    let fx = tx + PAD
    const fy = y + h - PAD - 12
    for (const f of d.footnotes) {
      doc.font(F.bold).fontSize(8.5).fillColor(C.ink)
      const vw = doc.widthOfString(f.value)
      doc.text(f.value, fx, fy, { lineBreak: false })
      fx += vw + 4
      doc.font(F.reg).fontSize(8.5).fillColor(C.sub)
      const lw = doc.widthOfString(f.label)
      doc.text(f.label, fx, fy, { lineBreak: false })
      fx += lw + 16
    }
  }
  return h
}

function measureRanked(rows: number): number {
  const rowsPerCol = Math.ceil(rows / 2)
  return PAD * 2 + 20 + rowsPerCol * 27
}

function rankedCard(doc: PDFKit.PDFDocument, s: NonNullable<ReportData['ranked']>, x: number, y: number, w: number): number {
  const rowH = 27
  const h = measureRanked(s.rows.length)
  card(doc, x, y, w, h)
  cardTitle(doc, x, y, w, s.title, s.note, s.titleNote)
  const colW = (w - PAD * 2 - 36) / 2
  s.rows.forEach((r, i) => {
    const col = i % 2
    const row = Math.floor(i / 2)
    const rx = x + PAD + col * (colW + 36)
    const ry = y + PAD + 24 + row * rowH
    doc.font(F.reg).fontSize(7.5).fillColor(C.faint).text(String(i + 1).padStart(2, '0'), rx, ry + 1)
    doc.font(F.bold).fontSize(8.8).fillColor(C.ink).text(r.label, rx + 20, ry, { lineBreak: false, width: colW - 90, ellipsis: true })
    const vFaint = r.valueNote ? ` ${r.valueNote}` : ''
    doc.font(F.reg).fontSize(8)
    const wFaint = doc.widthOfString(vFaint)
    doc.font(F.bold).fontSize(8.8)
    const wBold = doc.widthOfString(r.value)
    doc.fillColor(C.ink).text(r.value, rx + 20 + (colW - 20) - wBold - wFaint, ry, { lineBreak: false })
    if (vFaint) doc.font(F.reg).fontSize(8).fillColor(C.faint).text(vFaint, rx + 20 + (colW - 20) - wFaint, ry + 0.5, { lineBreak: false })
    const by = ry + 12
    doc.roundedRect(rx + 20, by, colW - 20, 4, 2).fill(C.track)
    doc.roundedRect(rx + 20, by, Math.max(3, (colW - 20) * Math.min(1, Math.max(0, r.frac))), 4, 2).fill(C.amber)
  })
  return h
}

function statPanel(doc: PDFKit.PDFDocument, p: ReportStatPanel, x: number, y: number, w: number, measure: boolean, forceH = 0): number {
  const bigRows = Math.ceil(p.bigs.length / 2)
  const rowsH = (p.rows?.length ?? 0) * 30
  const h = forceH || PAD * 2 + 24 + bigRows * 58 + (rowsH ? rowsH + 8 : 0)
  if (measure) return h
  card(doc, x, y, w, h)
  doc.font(F.bold).fontSize(13.5).fillColor(C.ink).text(p.title, x + PAD, y + PAD - 4)
  if (p.underline) {
    doc.moveTo(x + PAD, y + PAD + 16).lineTo(x + w - PAD, y + PAD + 16).lineWidth(1.5).stroke(C.green)
  }
  const colW = (w - PAD * 2) / 2
  p.bigs.forEach((b, i) => {
    const bx = x + PAD + (i % 2) * colW
    const by = y + PAD + 26 + Math.floor(i / 2) * 58
    doc.font(F.bold).fontSize(22).fillColor(C.ink)
    const vw = doc.widthOfString(b.value)
    doc.text(b.value, bx, by, { lineBreak: false })
    if (b.unit) doc.font(F.reg).fontSize(11).fillColor(C.sub).text(b.unit, bx + vw + 4, by + 8, { lineBreak: false })
    doc.font(F.reg).fontSize(8.5).fillColor(C.sub).text(b.caption, bx, by + 27)
  })
  if (p.rows?.length) {
    let ry = y + h - PAD - p.rows.length * 30 + 4
    for (const r of p.rows) {
      doc.roundedRect(x + PAD, ry, w - PAD * 2, 25, 4).fill(C.pillBg)
      doc.font(F.reg).fontSize(9).fillColor(C.ink).text(r.label, x + PAD + 12, ry + 8)
      doc.font(F.bold).fontSize(9).fillColor(C.ink)
        .text(r.value, x + PAD, ry + 8, { width: w - PAD * 2 - 12, align: 'right' })
      ry += 30
    }
  }
  return h
}

function dailyChartCard(doc: PDFKit.PDFDocument, s: ReportDailyChart, x: number, y: number, w: number): number {
  const chartH = 118
  const h = PAD * 2 + 30 + chartH
  card(doc, x, y, w, h)
  doc.font(F.bold).fontSize(13.5).fillColor(C.ink).text(s.title, x + PAD, y + PAD - 4)
  let lx = x + w - PAD
  for (const item of [...s.legend].reverse()) {
    doc.font(F.reg).fontSize(7.5)
    const tw = doc.widthOfString(item.label)
    lx -= tw
    doc.fillColor(C.sub).text(item.label, lx, y + PAD - 1, { lineBreak: false })
    lx -= 12
    doc.roundedRect(lx, y + PAD, 7, 7, 1.5).fill(item.color)
    lx -= 14
  }
  const base = y + PAD + 26 + chartH
  const n = s.bars.length
  const slot = (w - PAD * 2) / n
  const bw = Math.max(2, Math.min(26, slot * 0.55))
  for (let g = 0; g <= 3; g++) {
    const gy = base - (chartH * g) / 3
    doc.moveTo(x + PAD, gy).lineTo(x + w - PAD, gy).lineWidth(0.5).stroke(C.border)
  }
  s.bars.forEach((b, i) => {
    const bh = Math.max(3, chartH * Math.min(1, Math.max(0, b.frac)))
    const bx = x + PAD + i * slot + (slot - bw) / 2
    doc.roundedRect(bx, base - bh, bw, bh, 2).fill(b.alert ? C.red : C.green)
  })
  return h
}

function measureCategoryChart(s: ReportCategoryBarChart): number {
  const footH = s.footnotes?.length ? s.footnotes.length * 14 + 10 : 0
  return PAD * 2 + 34 + 130 + 16 + footH
}

function categoryBarCard(doc: PDFKit.PDFDocument, s: ReportCategoryBarChart, x: number, y: number, w: number): number {
  const chartH = 130
  const h = measureCategoryChart(s)
  card(doc, x, y, w, h)
  cardTitle(doc, x, y, w, s.title, s.note)

  let lx = x + w - PAD
  for (const item of [...s.legend].reverse()) {
    doc.font(F.reg).fontSize(7.5)
    const tw = doc.widthOfString(item.label)
    lx -= tw
    doc.fillColor(C.sub).text(item.label, lx, y + PAD + 14, { lineBreak: false })
    lx -= 12
    doc.roundedRect(lx, y + PAD + 15, 7, 7, 1.5).fill(item.color)
    lx -= 14
  }

  const base = y + PAD + 34 + chartH
  const n = Math.max(1, s.bars.length)
  const slot = (w - PAD * 2) / n
  const bw = Math.max(4, Math.min(48, slot * 0.5))
  for (let g = 0; g <= 4; g++) {
    const gy = base - (chartH * g) / 4
    doc.moveTo(x + PAD, gy).lineTo(x + w - PAD, gy).lineWidth(0.5).stroke(C.border)
  }
  s.bars.forEach((b, i) => {
    const bh = Math.max(3, chartH * Math.min(1, Math.max(0, b.frac)))
    const bx = x + PAD + i * slot + (slot - bw) / 2
    const color = s.legend[b.colorIndex ?? 0]?.color ?? C.green
    doc.roundedRect(bx, base - bh, bw, bh, 2).fill(color)
    doc.font(F.reg).fontSize(7.5).fillColor(C.faint)
      .text(b.category, x + PAD + i * slot, base + 8, { width: slot, align: 'center' })
  })

  if (s.footnotes?.length) {
    let fy = base + 28
    for (const line of s.footnotes) {
      doc.font(F.reg).fontSize(8.5).fillColor(C.sub).text(line, x + PAD, fy)
      fy += 14
    }
  }
  return h
}

function comboChartCard(doc: PDFKit.PDFDocument, s: ReportComboChart, x: number, y: number, w: number): number {
  const chartH = 160
  const h = PAD * 2 + 34 + chartH + 20
  card(doc, x, y, w, h)
  cardTitle(doc, x, y, w, s.title)

  let lx = x + w - PAD
  for (const item of [...s.legend].reverse()) {
    doc.font(F.reg).fontSize(7.5)
    const tw = doc.widthOfString(item.label)
    lx -= tw
    doc.fillColor(C.sub).text(item.label, lx, y + PAD - 1, { lineBreak: false })
    lx -= 12
    if (item.type === 'line') {
      doc.moveTo(lx, y + PAD + 3.5).lineTo(lx + 10, y + PAD + 3.5).lineWidth(2).stroke(item.color)
    } else {
      doc.roundedRect(lx, y + PAD, 7, 7, 1.5).fill(item.color)
    }
    lx -= 14
  }

  const base = y + PAD + 30 + chartH
  const n = Math.max(1, s.categories.length)
  const slot = (w - PAD * 2) / n
  const maxVal = Math.max(1, ...s.seriesA, ...s.seriesB, ...s.line)
  const barW = Math.max(2, Math.min(14, slot * 0.32))
  const labelEvery = Math.max(1, Math.ceil(n / 12))

  for (let g = 0; g <= 3; g++) {
    const gy = base - (chartH * g) / 3
    doc.moveTo(x + PAD, gy).lineTo(x + w - PAD, gy).lineWidth(0.5).stroke(C.border)
  }

  const colorA = s.legend.filter(l => l.type === 'bar')[0]?.color ?? C.green
  const colorB = s.legend.filter(l => l.type === 'bar')[1]?.color ?? C.red
  const colorLine = s.legend.find(l => l.type === 'line')?.color ?? '#8a6fd6'

  s.categories.forEach((cat, i) => {
    const slotCx = x + PAD + i * slot + slot / 2
    const ah = Math.max(1, chartH * Math.min(1, (s.seriesA[i] ?? 0) / maxVal))
    const bh = Math.max(1, chartH * Math.min(1, (s.seriesB[i] ?? 0) / maxVal))
    doc.rect(slotCx - barW - 1, base - ah, barW, ah).fill(colorA)
    doc.rect(slotCx + 1, base - bh, barW, bh).fill(colorB)
    if (i % labelEvery === 0) {
      doc.font(F.reg).fontSize(6.8).fillColor(C.faint)
        .text(cat, x + PAD + i * slot, base + 6, { width: slot, align: 'center' })
    }
  })

  doc.lineWidth(1.8)
  s.line.forEach((v, i) => {
    const lxp = x + PAD + i * slot + slot / 2
    const lyp = base - chartH * Math.min(1, v / maxVal)
    if (i === 0) doc.moveTo(lxp, lyp)
    else doc.lineTo(lxp, lyp)
  })
  doc.stroke(colorLine)

  return h
}

function insightBand(doc: PDFKit.PDFDocument, insights: ReportInsight[], x: number, y: number, w: number): number {
  const colGap = 26
  const colW = (w - PAD * 2 - colGap * 2) / 3
  doc.font(F.reg).fontSize(8.6)
  const bodyH = Math.max(...insights.slice(0, 3).map(i =>
    doc.heightOfString(i.body, { width: colW, lineGap: 2.6 })))
  const h = PAD * 2 + 16 + 18 + bodyH
  doc.roundedRect(x, y, w, h, 12).fill(C.greenDeep)
  doc.font(F.bold).fontSize(8).fillColor(C.greenSoft)
    .text('WHAT STANDS OUT', x + PAD, y + PAD - 2, { characterSpacing: 2.5 })
  insights.slice(0, 3).forEach((ins, i) => {
    const cx = x + PAD + i * (colW + colGap)
    const cy = y + PAD + 18
    doc.font(F.bold).fontSize(9.5).fillColor('#e5a34c')
      .text(`0${i + 1} · ${ins.title}`, cx, cy, { width: colW })
    doc.font(F.reg).fontSize(8.6).fillColor('#d6e2da')
      .text(ins.body, cx, cy + 16, { width: colW, lineGap: 2.6 })
  })
  return h
}

// ── Table flow with pill support ───────────────────────────────────────────

/** Draws a table's header + rows, adding new pages (and re-drawing the header) as needed.
 *  Tables sit flush on the page background (no card box) with zebra-striped rows, matching
 *  the "Fuel by day" / "Fleet state" log tables in the template.
 *  Supports State and Status pills based on column labels. */
function flowTable(doc: PDFKit.PDFDocument, pager: Pager, t: ReportTable, x: number, w: number) {
  const rowH = 25.5
  pager.ensure(PAD + 24 + 18 + rowH * Math.min(3, t.rows.length))
  const usable = w - PAD * 2 - 14
  const widths = t.columns.map(c => c.width * usable)

  let continuedHeader = false
  let hy = 0

  const drawHeader = () => {
    const y = pager.y
    doc.font(F.bold).fontSize(13.5).fillColor(C.ink)
      .text(t.title, x + PAD, y - 4, { continued: continuedHeader })
    if (continuedHeader) doc.font(F.reg).fontSize(9.5).fillColor(C.faint).text('  — continued')
    if (t.note && !continuedHeader) {
      doc.font(F.reg).fontSize(7).fillColor(C.faint)
        .text(t.note.toUpperCase(), x, y, { width: w - PAD, align: 'right', characterSpacing: 1 })
    }
    let cx = x + PAD + 14
    const headY = y + 26
    t.columns.forEach((c, i) => {
      doc.font(F.bold).fontSize(7).fillColor(C.faint)
        .text(c.label.toUpperCase(), cx, headY, { width: widths[i]! - 8, align: c.align ?? 'left', characterSpacing: 1 })
      cx += widths[i]!
    })
    doc.moveTo(x + PAD, headY + 15).lineTo(x + w - PAD, headY + 15).lineWidth(1).stroke(C.border)
    return headY + 22
  }

  hy = drawHeader()

  t.rows.forEach((r, i) => {
    if (hy + rowH > PAGE_H - FOOTER_H) {
      pager.newPage(false)
      continuedHeader = true
      hy = drawHeader()
    }
    if (i % 2 === 1) doc.rect(x, hy - 4, w, rowH).fill(C.card)
    doc.circle(x + PAD + 4, hy + 4, 2.6).fill(r.alert ? C.red : '#43474b')
    let cx = x + PAD + 14
    r.cells.forEach((cell, ci) => {
      const col = t.columns[ci]!
      const isState = col.label === 'State'
      const isStatus = col.label === 'Status'
      const last = ci === r.cells.length - 1
      const color = last && r.lastCellColor ? (r.lastCellColor === 'bad' ? C.red : C.green) : C.ink

      if (isState) {
        renderStatePill(doc, cell, cx, hy)
      } else if (isStatus) {
        renderStatusPill(doc, cell, cx, hy)
      } else {
        doc.font(last && r.lastCellColor ? F.bold : F.reg).fontSize(8.8).fillColor(color)
          .text(cell, cx, hy, { width: widths[ci]! - 8, align: col.align ?? 'left', lineBreak: false, ellipsis: true })
      }
      cx += widths[ci]!
    })
    hy += rowH
  })
  pager.y = hy
}

// ── primitives ───────────────────────────────────────────────────────────────

function card(doc: PDFKit.PDFDocument, x: number, y: number, w: number, h: number, bg = C.card, accent?: string) {
  doc.roundedRect(x, y, w, h, 10).fill(bg)
  if (accent) {
    doc.save()
    doc.roundedRect(x, y, w, h, 10).clip()
    doc.rect(x, y, 4, h).fill(accent)
    doc.restore()
  }
  if (bg === C.card) doc.roundedRect(x, y, w, h, 10).lineWidth(1).stroke(C.border)
}

/** Circular arc path (radians, clockwise from a0 to a1) ready to stroke. */
function arc(doc: PDFKit.PDFDocument, cx: number, cy: number, r: number, a0: number, a1: number) {
  const steps = Math.max(2, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 64))
  doc.moveTo(cx + r * Math.cos(a0), cy + r * Math.sin(a0))
  for (let i = 1; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps
    doc.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
  }
  return doc
}