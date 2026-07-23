// Branded PDF report renderer — the layout engine behind the downloadable
// Analytics / Drivers / Maintenance reports. One generic single-page design
// (modelled on the "Fleet Analytics Report" template): brand header, KPI tile
// row, a bar-list card beside a donut card, a ranked two-column card, two stat
// panels, a daily bar chart, a dark "what stands out" insight band, a log
// table and a footer. Each report kind supplies the same ReportData shape
// (report-pdf.service.ts) and this module draws it.
//
// Pure drawing — no DB access. The page is one tall sheet (like the template),
// so the renderer runs TWICE: a measuring pass on an oversized page to learn
// the content height, then the real pass on a page cut to fit.

import PDFDocument from 'pdfkit'

// ── data contract ────────────────────────────────────────────────────────────

export interface ReportKpi {
  label: string
  value: string
  unit?: string
  sub: string
  dark?: boolean            // the one highlighted deep-green tile
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
  kpis: ReportKpi[]
  bars: { title: string; note?: string; rows: ReportBarRow[] }
  donut: { title: string; note?: string; data: ReportDonut }
  ranked?: { title: string; titleNote?: string; note?: string; rows: ReportBarRow[] }
  panels: ReportStatPanel[]
  daily?: ReportDailyChart
  insights: ReportInsight[]
  table: ReportTable
}

// ── theme (sampled from the template) ────────────────────────────────────────

const W = 870
const M = 30                 // page margin
const PAD = 22               // card padding
const GAP = 16               // gap between cards

const C = {
  bg: '#f7f4ee',
  card: '#ffffff',
  border: '#e9e3d8',
  track: '#eee9df',
  ink: '#1d1a16',
  sub: '#7d766b',
  faint: '#a9a294',
  green: '#1e6f4e',
  greenDeep: '#173d2f',
  greenSoft: '#cfe0d6',      // light text on deep green
  amber: '#d97706',
  red: '#cf4a3d',
  redSoft: '#eec7c2',
  chipInk: '#8a6a3a',
  pillBg: '#f4f1ea',
}

const F = { reg: 'Helvetica', bold: 'Helvetica-Bold' }

const fmtDate = (d: Date) =>
  d.toLocaleString('en-KE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' })

// ── renderer ─────────────────────────────────────────────────────────────────

export async function renderReportPdf(data: ReportData): Promise<Buffer> {
  // Pass 1: measure on an oversized page, pass 2: draw on an exact-height page.
  const probe = draw(data, 20000)
  await toBuffer(probe.doc) // finalize the probe so nothing leaks
  return toBuffer(draw(data, Math.ceil(probe.contentHeight)).doc)
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

function draw(data: ReportData, pageH: number): { doc: PDFKit.PDFDocument; contentHeight: number } {
  const doc = new PDFDocument({ size: [W, pageH], margin: 0 })
  const inner = W - M * 2

  doc.rect(0, 0, W, pageH).fill(C.bg)

  // Top strip — deep green with an amber tail (template's top edge).
  doc.rect(0, 0, W * 0.74, 5).fill(C.greenDeep)
  doc.rect(W * 0.74, 0, W * 0.26, 5).fill(C.amber)

  let y = 34

  // ── header ──
  doc.circle(M + 4, y + 4, 3.5).fill(C.green)
  doc.font(F.bold).fontSize(9).fillColor(C.green)
    .text('FLEET TRACKING', M + 16, y, { characterSpacing: 3 })

  // CONFIDENTIAL chip, top right
  const chipW = 118
  doc.roundedRect(W - M - chipW, y - 6, chipW, 22, 4).lineWidth(1).stroke(C.border)
  doc.font(F.bold).fontSize(7.5).fillColor(C.chipInk)
    .text('CONFIDENTIAL', W - M - chipW, y + 1, { width: chipW, align: 'center', characterSpacing: 2 })

  y += 26
  doc.font(F.bold).fontSize(30).fillColor(C.ink).text(data.title, M, y)

  // Org block, right-aligned
  doc.font(F.bold).fontSize(14).fillColor(C.ink)
    .text(data.orgName.toUpperCase(), W / 2, y + 6, { width: W / 2 - M, align: 'right' })
  doc.font(F.reg).fontSize(7.5).fillColor(C.faint)
    .text(data.orgRegion.toUpperCase(), W / 2, y + 24, { width: W / 2 - M, align: 'right', characterSpacing: 2 })

  y += 42
  doc.font(F.reg).fontSize(10.5).fillColor(C.sub)
    .text(`${data.orgName}  ·  ${data.windowLabel}  ·  Generated ${fmtDate(new Date())}`, M, y)
  y += 34

  // ── KPI tiles ──
  y = kpiRow(doc, data.kpis, y, inner)

  // ── bar-list card + donut card ──
  const leftW = Math.round(inner * 0.56)
  const rightW = inner - leftW - GAP
  // The donut card is sized to the bar card — but with only a few bar rows
  // (e.g. an org with 3 product lines) that card is too short for the ring,
  // whose draw guard then skips it (and the big center % with it). Give the
  // pair a floor tall enough for a legible donut + legend.
  const donutLegendH = data.donut.data.segments.length * 22 + 10
  const donutMinH = PAD * 2 + 30 + donutLegendH + 132
  const hBars = barListCard(doc, data.bars, M, y, leftW, donutMinH)
  const hDonut = donutCard(doc, data.donut, M + leftW + GAP, y, rightW, hBars)
  y += Math.max(hBars, hDonut) + GAP

  // ── ranked two-column card ──
  if (data.ranked && data.ranked.rows.length > 0) {
    y += rankedCard(doc, data.ranked, M, y, inner) + GAP
  }

  // ── stat panels ──
  if (data.panels.length === 2) {
    const pw = (inner - GAP) / 2
    const h1 = statPanel(doc, data.panels[0]!, M, y, pw, true)
    const h2 = statPanel(doc, data.panels[1]!, M + pw + GAP, y, pw, true, Math.max(h1, 0))
    // Redraw the shorter one at the max height so the cards line up.
    const hp = Math.max(h1, h2)
    statPanel(doc, data.panels[0]!, M, y, pw, false, hp)
    statPanel(doc, data.panels[1]!, M + pw + GAP, y, pw, false, hp)
    y += hp + GAP
  }

  // ── daily activity chart ──
  if (data.daily && data.daily.bars.length > 0) {
    y += dailyChartCard(doc, data.daily, M, y, inner) + GAP
  }

  // ── insight band ──
  if (data.insights.length > 0) {
    y += insightBand(doc, data.insights, M, y, inner) + GAP
  }

  // ── log table ──
  y += tableCard(doc, data.table, M, y, inner) + 26

  // ── footer ──
  doc.moveTo(M, y).lineTo(W - M, y).lineWidth(1).stroke(C.border)
  y += 14
  doc.font(F.reg).fontSize(7.5).fillColor(C.faint)
    .text('FLEET TRACKING — CONFIDENTIAL', M, y, { characterSpacing: 1.5 })
  doc.text(`${data.orgName.toUpperCase()} · ${data.windowLabel.toUpperCase()}`,
    W / 2, y - 8, { width: W / 2 - M, align: 'right', characterSpacing: 1.5 })
  // (text() advanced the cursor; the explicit y keeps both on one line)
  y += 18
  doc.rect(0, pageH - 5, W, 5).fill(C.greenDeep)

  return { doc, contentHeight: y + 5 }
}

// ── sections ─────────────────────────────────────────────────────────────────

function kpiRow(doc: PDFKit.PDFDocument, kpis: ReportKpi[], y: number, inner: number): number {
  const n = Math.max(1, kpis.length)
  const w = (inner - GAP * (n - 1)) / n
  const h = 92
  kpis.forEach((k, i) => {
    const x = M + i * (w + GAP)
    card(doc, x, y, w, h, k.dark ? C.greenDeep : C.card)
    const label = k.dark ? C.greenSoft : C.faint
    const ink = k.dark ? '#ffffff' : C.ink
    const sub = k.dark ? C.greenSoft : C.sub
    doc.font(F.bold).fontSize(7.5).fillColor(label)
      .text(k.label.toUpperCase(), x + PAD, y + 17, { characterSpacing: 1.6, width: w - PAD * 2 })
    doc.font(F.bold).fontSize(27).fillColor(ink)
    const vw = doc.widthOfString(k.value)
    doc.text(k.value, x + PAD, y + 33, { lineBreak: false })
    // Unit sits on the number's baseline (0.72 ≈ Helvetica ascent ratio).
    if (k.unit) doc.font(F.reg).fontSize(12).fillColor(sub).text(k.unit, x + PAD + vw + 5, y + 33 + 11, { lineBreak: false })
    doc.font(F.reg).fontSize(8.5).fillColor(sub).text(k.sub, x + PAD, y + 66, { width: w - PAD * 2 })
  })
  return y + h + GAP
}

function cardTitle(doc: PDFKit.PDFDocument, x: number, y: number, w: number, title: string, note?: string, titleNote?: string) {
  doc.font(F.bold).fontSize(13.5).fillColor(C.ink).text(title, x + PAD, y + PAD - 4, { continued: !!titleNote })
  if (titleNote) doc.font(F.reg).fontSize(9.5).fillColor(C.faint).text(`  ${titleNote}`)
  if (note) {
    doc.font(F.reg).fontSize(7).fillColor(C.faint)
      .text(note.toUpperCase(), x, y + PAD, { width: w - PAD, align: 'right', characterSpacing: 1 })
  }
}

function barListCard(doc: PDFKit.PDFDocument, s: ReportData['bars'], x: number, y: number, w: number, minH = 0): number {
  const rowH = 29
  const h = Math.max(minH, PAD * 2 + 18 + s.rows.length * rowH)
  card(doc, x, y, w, h)
  cardTitle(doc, x, y, w, s.title, s.note)
  let ry = y + PAD + 22
  const bw = w - PAD * 2
  for (const r of s.rows) {
    doc.font(F.bold).fontSize(8.8).fillColor(C.ink).text(r.label, x + PAD, ry, { continued: !!r.note, lineBreak: false })
    if (r.note) doc.font(F.reg).fontSize(8).fillColor(C.faint).text(` · ${r.note}`, { lineBreak: false })
    // right-aligned value: bold part + faint part
    const vFaint = r.valueNote ? ` ${r.valueNote}` : ''
    doc.font(F.reg).fontSize(8)
    const wFaint = doc.widthOfString(vFaint)
    doc.font(F.bold).fontSize(8.8)
    const wBold = doc.widthOfString(r.value)
    doc.fillColor(C.ink).text(r.value, x + PAD + bw - wBold - wFaint, ry, { lineBreak: false })
    if (vFaint) doc.font(F.reg).fontSize(8).fillColor(C.faint).text(vFaint, x + PAD + bw - wFaint, ry + 0.5, { lineBreak: false })
    // track + fill
    const by = ry + 13
    doc.roundedRect(x + PAD, by, bw, 5, 2.5).fill(C.track)
    const fw = Math.max(3, bw * Math.min(1, Math.max(0, r.frac)))
    doc.roundedRect(x + PAD, by, fw, 5, 2.5).fill(C.green)
    ry += rowH
  }
  return h
}

function donutCard(doc: PDFKit.PDFDocument, s: ReportData['donut'], x: number, y: number, w: number, h: number): number {
  card(doc, x, y, w, h)
  cardTitle(doc, x, y, w, s.title)
  if (s.note) doc.font(F.reg).fontSize(8.5).fillColor(C.faint).text(s.note, x + PAD, y + PAD + 16)

  const d = s.data
  const legendH = d.segments.length * 22 + 10
  const cx = x + w / 2
  const cy = y + PAD + 30 + (h - PAD * 2 - 30 - legendH) / 2
  const rOut = Math.min(64, (h - PAD * 2 - 30 - legendH) / 2 - 4)
  const ring = 17

  if (rOut > 24) {
    const r = rOut - ring / 2
    // full track ring in the first segment's soft complement, then arcs
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

  // legend rows pinned to the card bottom
  let ly = y + h - PAD - d.segments.length * 22 + 6
  for (const seg of d.segments) {
    doc.roundedRect(x + PAD, ly + 1, 8, 8, 2).fill(seg.color)
    doc.font(F.reg).fontSize(9).fillColor(C.ink).text(seg.label, x + PAD + 15, ly)
    doc.font(F.bold).fontSize(9).fillColor(C.ink)
      .text(seg.value, x + PAD, ly, { width: w - PAD * 2, align: 'right' })
    ly += 22
  }
  return h
}

function rankedCard(doc: PDFKit.PDFDocument, s: NonNullable<ReportData['ranked']>, x: number, y: number, w: number): number {
  const rowH = 27
  const rowsPerCol = Math.ceil(s.rows.length / 2)
  const h = PAD * 2 + 20 + rowsPerCol * rowH
  card(doc, x, y, w, h)
  cardTitle(doc, x, y, w, s.title, s.note, s.titleNote)
  const colW = (w - PAD * 2 - 36) / 2
  s.rows.forEach((r, i) => {
    // Template order runs across the columns (01 left, 02 right, 03 left …)
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
  // legend, right-aligned
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
  // faint gridlines
  for (let g = 0; g <= 3; g++) {
    const gy = base - (chartH * g) / 3
    doc.moveTo(x + PAD, gy).lineTo(x + w - PAD, gy).lineWidth(0.5).stroke('#efeae0')
  }
  s.bars.forEach((b, i) => {
    const bh = Math.max(3, chartH * Math.min(1, Math.max(0, b.frac)))
    const bx = x + PAD + i * slot + (slot - bw) / 2
    doc.roundedRect(bx, base - bh, bw, bh, 2).fill(b.alert ? C.red : C.green)
  })
  return h
}

function insightBand(doc: PDFKit.PDFDocument, insights: ReportInsight[], x: number, y: number, w: number): number {
  const colGap = 26
  const colW = (w - PAD * 2 - colGap * 2) / 3
  // measure body heights
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

function tableCard(doc: PDFKit.PDFDocument, t: ReportTable, x: number, y: number, w: number): number {
  const rowH = 25.5
  const h = PAD * 2 + 24 + 18 + t.rows.length * rowH
  card(doc, x, y, w, h)
  cardTitle(doc, x, y, w, t.title, t.note)

  const usable = w - PAD * 2 - 14 // 14 for the status dot gutter
  const widths = t.columns.map(c => c.width * usable)
  let hy = y + PAD + 26
  // header
  let cx = x + PAD + 14
  t.columns.forEach((c, i) => {
    doc.font(F.bold).fontSize(7).fillColor(C.faint)
      .text(c.label.toUpperCase(), cx, hy, { width: widths[i]! - 8, align: c.align ?? 'left', characterSpacing: 1 })
    cx += widths[i]!
  })
  hy += 16
  for (const r of t.rows) {
    doc.moveTo(x + PAD, hy - 4).lineTo(x + w - PAD, hy - 4).lineWidth(0.5).stroke('#f0ebe1')
    doc.circle(x + PAD + 4, hy + 4, 2.6).fill(r.alert ? C.red : '#d6d0c4')
    cx = x + PAD + 14
    r.cells.forEach((cell, i) => {
      const col = t.columns[i]!
      const last = i === r.cells.length - 1
      const color = last && r.lastCellColor ? (r.lastCellColor === 'bad' ? C.red : C.green) : C.ink
      doc.font(last && r.lastCellColor ? F.bold : F.reg).fontSize(8.8).fillColor(color)
        .text(cell, cx, hy, { width: widths[i]! - 8, align: col.align ?? 'left', lineBreak: false, ellipsis: true })
      cx += widths[i]!
    })
    hy += rowH
  }
  return h
}

// ── primitives ───────────────────────────────────────────────────────────────

function card(doc: PDFKit.PDFDocument, x: number, y: number, w: number, h: number, bg = C.card) {
  doc.roundedRect(x, y, w, h, 10).fill(bg)
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
