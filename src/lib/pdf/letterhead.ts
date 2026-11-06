// The RAI Group / OGC letterhead the printable reports share — the trip and
// day report (trips/trip-report.pdf) and the driver scorecard
// (driver-score/driver-score.pdf). One place for the band, the logos, the
// palette, the type and the page footer, so the reports cannot drift apart;
// and ReportWriter, the ruled-document primitives a report draws with.

import fs from 'node:fs'
import path from 'node:path'
import type PDFDocument from 'pdfkit'

export const MM = 72 / 25.4
export const PAGE_W = 595.28, PAGE_H = 841.89
export const SIDE = 13 * MM
export const BODY_W = PAGE_W - 2 * SIDE
export const FOOT_H = 11 * MM
export const BOTTOM = PAGE_H - FOOT_H
const BAND_H = 21 * MM

/** A page's shape: A4 upright, or turned on its side (a JPEG to read on a wide screen, 4 Nov 2026). */
export interface Sheet { w: number; h: number; body: number; bottom: number; layout: 'portrait' | 'landscape' }
export function sheetOf(landscape = false): Sheet {
  const w = landscape ? PAGE_H : PAGE_W, h = landscape ? PAGE_W : PAGE_H
  return { w, h, body: w - 2 * SIDE, bottom: h - FOOT_H, layout: landscape ? 'landscape' : 'portrait' }
}

export const C = {
  ink: '#1c1c1c', mut: '#5c5c5c', rule: '#bfbfbf', soft: '#e6e6e6', shade: '#f3f3f3',
  hd: '#1f3a5f', flag: '#b42318', good: '#1e6b3a', route: '#1f3a5f', dz: '#e4edf3', band: '#212121', paper: '#ffffff',
}
export const F = { reg: 'Helvetica', bold: 'Helvetica-Bold', ital: 'Helvetica-Oblique' }
export const DASH = '–'

export const num = (v: number | null | undefined, dp = 0) =>
  v == null || !Number.isFinite(v) ? DASH : v.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp })

type Doc = InstanceType<typeof PDFDocument>

const logoCache = new Map<string, Buffer | null>()
export function logo(file: string): Buffer | null {
  if (!logoCache.has(file)) {
    try { logoCache.set(file, fs.readFileSync(path.resolve(process.cwd(), 'assets', 'report', file))) } catch { logoCache.set(file, null) }
  }
  return logoCache.get(file) ?? null
}

/** The dark band with both logos across the top of the page. Returns where the body starts. */
export function drawLetterhead(doc: Doc, sheet: Sheet = sheetOf()): number {
  doc.rect(0, 0, sheet.w, BAND_H).fill(C.band)
  const rai = logo('rai-group-logo.jpeg')
  const ogc = logo('ogc-logo.png')
  if (rai) doc.image(rai, 12 * MM, (BAND_H - 15.5 * MM) / 2, { height: 15.5 * MM })
  if (ogc) {
    const h = 9.5 * MM, wd = h * (733 / 315)
    doc.save().opacity(0.78).image(ogc, sheet.w - 12 * MM - wd, (BAND_H - h) / 2, { height: h }).restore()
  }
  return BAND_H + 5 * MM
}

export type Align = 'left' | 'right' | 'center'
export interface Col { w: number; align?: Align; /** Long text runs onto more lines and the row grows, instead of being cut. */ wrap?: boolean }
/** A table cell; `fill` paints that cell alone, over any fill the row has. */
export interface Cell { text: string; bold?: boolean; color?: string; fill?: string; /** Where a click on the cell goes. */ link?: string }

/** Ruled-document primitives over one pdfkit document, with a running cursor. */
export class ReportWriter {
  y = 0
  /**
   * Repeated at the top of every page after the first, as the behaviour
   * report carries it: the report's title on the left, its reference on the
   * right, over a rule. Null for none.
   */
  runningHead: { title: string; right: string } | null = null
  /** Repeated at the top of a table that continues on a new page. */
  private continuing: (() => void) | null = null

  constructor(readonly doc: Doc, readonly sheet: Sheet = sheetOf()) {}

  /** `text` cut to `width` on one line, with an ellipsis when it had to be. */
  fit(text: string, width: number, font: string, size: number) {
    const doc = this.doc
    doc.font(font).fontSize(size)
    // A hair of margin: pdfkit's word measure runs a little wider than widthOfString.
    if (doc.widthOfString(text) <= width - 1) return text
    let t = text
    while (t.length > 1 && doc.widthOfString(`${t}…`) > width - 1) t = t.slice(0, -1)
    return `${t.trimEnd()}…`
  }

  /** One line, never wrapped. */
  line(text: string, x: number, y: number, width: number, o: { font?: string; size?: number; color?: string; align?: Align } = {}) {
    const font = o.font ?? F.reg, size = o.size ?? 8.6
    this.doc.font(font).fontSize(size).fillColor(o.color ?? C.ink)
      .text(this.fit(text, width, font, size), x, y, { width, align: o.align ?? 'left', lineBreak: false, height: size * 1.4 })
  }

  hr(x1: number, x2: number, y: number, color: string, weight: number) {
    this.doc.save().moveTo(x1, y).lineTo(x2, y).lineWidth(weight).strokeColor(color).stroke().restore()
  }

  /** Room for `h` below the cursor, or a fresh page. Returns whether a page was added. */
  room(h: number): boolean {
    if (this.y + h <= this.sheet.bottom) return false
    this.newPage()
    return true
  }

  /** A fresh page, under the running head when there is one. */
  newPage() {
    this.doc.addPage({ size: 'A4', layout: this.sheet.layout, margin: 0 })
    this.y = 12 * MM
    if (this.runningHead) {
      this.line(this.runningHead.title.toUpperCase(), SIDE, this.y, this.sheet.body / 2, { font: F.bold, size: 9.4 })
      this.line(this.runningHead.right, SIDE + this.sheet.body / 2, this.y + 1, this.sheet.body / 2, { size: 7.4, color: C.mut, align: 'right' })
      this.y += 13
      this.hr(SIDE, SIDE + this.sheet.body, this.y, C.ink, 0.9)
      this.y += 4 * MM
    }
  }

  /** A section heading, with an aside on the right. */
  h2(text: string, small?: string, x = SIDE, width = this.sheet.body) {
    this.y += 3.2 * MM
    this.line(text.toUpperCase(), x, this.y, width * (small ? 0.5 : 1), { font: F.bold, size: 8.6, color: C.hd })
    if (small) this.line(small, x + width * 0.4, this.y + 0.6, width * 0.6, { size: 7.6, color: C.mut, align: 'right' })
    this.y += 11
    this.hr(x, x + width, this.y, C.rule, 0.6)
    this.y += 1.4 * MM
  }

  none(text: string, x = SIDE, width = this.sheet.body) {
    this.line(text, x, this.y + 1, width, { font: F.ital, size: 8.2, color: C.mut })
    this.y += 13
  }

  more(text: string, x = SIDE, width = this.sheet.body, color = C.mut) {
    this.line(text, x, this.y + 1, width, { size: 7, color })
    this.y += 11
  }

  /** A paragraph that wraps, in the muted note style. */
  note(text: string, x = SIDE, width = this.sheet.body) {
    this.doc.font(F.reg).fontSize(7.4).fillColor(C.mut)
    const h = this.doc.heightOfString(text, { width })
    this.room(h + 4)
    this.doc.text(text, x, this.y + 1, { width })
    this.y += h + 4
  }

  /** A row of ruled boxes: a small label over a bold figure. */
  cells(items: Array<[string, string] | [string, string, string | undefined]>) {
    const cw = this.sheet.body / items.length, h = 9.6 * MM
    this.room(h)
    items.forEach(([k, v, color], i) => {
      const x = SIDE + i * cw
      this.doc.save().rect(x, this.y, cw, h).lineWidth(0.6).strokeColor(C.rule).stroke().restore()
      this.line(k, x + 1.6 * MM, this.y + 1 * MM, cw - 3.2 * MM, { size: 7, color: C.mut })
      this.line(v, x + 1.6 * MM, this.y + 1 * MM + 10, cw - 3.2 * MM, { font: F.bold, size: 9.4, color })
    })
    this.y += h
  }

  /**
   * A ruled list: muted bold heads, soft rules between rows, a firm one under
   * the last. Runs onto new pages as needed, repeating its heads there.
   */
  table(cols: Col[], head: string[], rows: Cell[][], o: { x?: number; width?: number; size?: number; fills?: Array<string | null> } = {}) {
    const x = o.x ?? SIDE, width = o.width ?? this.sheet.body, size = o.size ?? 8.2
    // A table made for a wide page and printed upright (the operator picks the
    // way up, 6 Nov 2026): the set widths shrink together so each column left
    // to fill keeps at least 24 mm, and nothing runs off the page.
    const flex = cols.filter(c => c.w === 0).length
    const set = cols.reduce((a, c) => a + c.w, 0)
    const room = Math.max(0, width - flex * 24 * MM)
    const k = set > room && set > 0 ? room / set : 1
    const fixed = set * k
    const widths = cols.map(c => (c.w === 0 ? (width - fixed) / flex : c.w * k))
    const pad = 1.4 * MM
    const rowH = Math.max(11.2, size * 1.37)
    const cellsAt = (yy: number, items: Cell[], f: { font?: string; size: number; color?: string; wrap?: boolean }) => {
      let cx = x
      items.forEach((c, i) => {
        const cw = widths[i]!
        const left = i === 0 ? 0 : pad
        const font = c.bold ? F.bold : f.font ?? F.reg
        if (f.wrap && cols[i]!.wrap) {
          this.doc.font(font).fontSize(f.size).fillColor(c.color ?? f.color ?? C.ink)
            .text(c.text, cx + left, yy, { width: cw - left - pad, align: cols[i]!.align ?? 'left' })
        } else {
          this.line(c.text, cx + left, yy, cw - left - pad, { font, size: f.size, color: c.color ?? f.color, align: cols[i]!.align })
        }
        if (c.link) this.doc.link(cx, yy - 1, cw, f.size * 1.4, c.link)
        cx += cw
      })
    }
    /** A row's height: one line, or as many as its longest wrapped cell takes. */
    const heightOf = (row: Cell[]) => row.reduce((h, c, i) => {
      if (!cols[i]?.wrap) return h
      const left = i === 0 ? 0 : pad
      this.doc.font(c.bold ? F.bold : F.reg).fontSize(size)
      return Math.max(h, this.doc.heightOfString(c.text || ' ', { width: widths[i]! - left - pad }) + 3.4)
    }, rowH)
    const heads = () => {
      cellsAt(this.y + 1.6, head.map(text => ({ text })), { font: F.bold, size: 7.2, color: C.mut })
      this.y += 11.2
      this.hr(x, x + width, this.y, C.rule, 0.6)
    }
    this.room(11.2 + rowH * Math.min(rows.length, 2))
    heads()
    rows.forEach((row, ri) => {
      const h = heightOf(row)
      if (this.room(h)) heads()
      const fill = o.fills?.[ri]
      if (fill) this.doc.save().rect(x, this.y, width, h).fill(fill).restore()
      let fx = x
      row.forEach((c, i) => {
        if (c.fill) this.doc.save().rect(fx, this.y, widths[i]!, h).fill(c.fill).restore()
        fx += widths[i]!
      })
      cellsAt(this.y + 2, row, { size, wrap: true })
      this.y += h
      const last = ri === rows.length - 1
      this.hr(x, x + width, this.y, last ? C.rule : C.soft, last ? 0.6 : 0.4)
    })
  }

  /** "Generated …" and "Page X of Y" on every page, once the count is known. */
  footers(generated: string) {
    const range = this.doc.bufferedPageRange()
    for (let i = range.start; i < range.start + range.count; i++) {
      this.doc.switchToPage(i)
      this.hr(SIDE, SIDE + this.sheet.body, this.sheet.bottom + 2 * MM, C.rule, 0.6)
      // Three quarters for the left text: a report names itself and its period there.
      this.line(generated, SIDE, this.sheet.bottom + 4 * MM, this.sheet.body * 0.75, { size: 7, color: C.mut })
      this.line(`Page ${i - range.start + 1} of ${range.count}`, SIDE + this.sheet.body * 0.75, this.sheet.bottom + 4 * MM, this.sheet.body * 0.25,
        { size: 7, color: C.mut, align: 'right' })
    }
  }
}
