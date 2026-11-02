// The end-of-shift report as a PDF on the RAI Group / OGC letterhead, in the
// plain ruled style the trip report and the driver scorecard share.
//
// In two steps (operator, 2026-11-02): endOfShiftDoc lays the report out as a
// document of plain blocks (headings, figures, tables, notes, the handover),
// and renderShiftDoc draws a document. The Reports page shows the document as
// a page the operator can edit, and sends the edited one back to be drawn, so
// the PDF is exactly what they saw.
//
// Pure: takes what end-of-shift builds and returns the document, or the file.

import PDFDocument from 'pdfkit'
import { MM, SIDE, BODY_W, C, F, DASH, num, drawLetterhead, ReportWriter, type Cell, type Col } from '../../lib/pdf/letterhead.js'
import type { EndOfShift, Tone } from './end-of-shift.js'

const TZ = 'Africa/Nairobi'
const H = 3_600_000
const fmtHM = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
const fmtDate = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' })
const fmtStamp = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

/** "3 h 05 min", "42 min". */
export function dur(msv: number | null | undefined): string {
  if (msv == null || !Number.isFinite(msv)) return DASH
  const m = Math.max(0, Math.round(msv / 60_000))
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}
const plural = (n: number, word: string) => `${num(n)} ${word}${n === 1 ? '' : 's'}`

/** "ES-WESTSU-20261031-1800": the organisation, the date and the minute it was made, in EAT. */
export function reportNumber(short: string, at: number): string {
  const s = new Date(at + 3 * H).toISOString()
  return `ES-${short}-${s.slice(0, 10).replace(/-/g, '')}-${s.slice(11, 16).replace(':', '')}`
}

export function endOfShiftFileName(orgName: string, at: number): string {
  const s = new Date(at + 3 * H).toISOString()
  return `End of shift report ${orgName.replace(/[^\w .-]/g, '')} ${s.slice(0, 10)} ${s.slice(11, 16).replace(':', '')}.pdf`
}

// ── the document ──────────────────────────────────────────────────────────────

/** flag = red, mut = grey; otherwise ink. */
export type DocTone = 'flag' | 'mut'
export interface DocCell { text: string; bold?: boolean; tone?: DocTone }
/** A column: width in mm, 0 shares what is left. */
export interface DocCol { w: number; align?: 'left' | 'right' | 'center' }
export interface DocTable { kind: 'table'; cols: DocCol[]; head: string[]; rows: DocCell[][]; size?: number }
export interface DocNone { kind: 'none'; text: string }
export type DocBlock =
  | { kind: 'h2'; title: string; aside?: string }
  | { kind: 'h3'; title: string; aside?: string }
  | { kind: 'figures'; items: Array<{ label: string; value: string; flag?: boolean }> }
  | DocTable
  | DocNone
  | { kind: 'note'; text: string }
  /** Two sub-sections side by side, kept on one page. */
  | { kind: 'pair'; halves: Array<{ title: string; aside?: string; body: DocTable | DocNone }> }
  /** Ruled lines for the handover (what is written prints on them), then the two signatures. */
  | { kind: 'handover'; lines: string[]; signatures: string[] }

export interface ShiftDoc {
  title: string
  reportNo: string
  date: string
  meta: Array<{ label: string; value: string }>
  blocks: DocBlock[]
  footer: string
}

const toneOf = (t: Tone): DocTone | undefined => (t === 'c' ? 'flag' : t === 'm' ? 'mut' : undefined)

/** The report laid out as a document. */
export function endOfShiftDoc(r: EndOfShift, o: { orgName: string; reportNo: string; generatedAt?: number }): ShiftDoc {
  const generatedAt = o.generatedAt ?? Date.now()
  // One day reads "2 Nov 2026, 00:00 to 14:05"; a period over days names both.
  const date = fmtDate.format(r.from)
  const oneDay = date === fmtDate.format(r.to)
  const since = oneDay ? fmtHM.format(r.from) : `${date}, ${fmtHM.format(r.from)}`
  const span = oneDay ? `${fmtHM.format(r.from)} to ${fmtHM.format(r.to)}` : `${fmtHM.format(r.from)} to ${fmtDate.format(r.to)}, ${fmtHM.format(r.to)}`
  const b: DocBlock[] = []

  // ── 1. overview ──
  const theftN = r.theft.length
  b.push({ kind: 'h2', title: '1. Overview', aside: `${date}, ${span}` })
  b.push({ kind: 'figures', items: [
    { label: 'Fuel refills', value: `${num(r.fuel.refills)} · ${num(r.fuel.refillL)} L` },
    { label: 'Fuel drains', value: `${num(r.fuel.drains.length)} · ${num(r.fuel.drainL, 1)} L` },
    { label: 'Escalated thefts', value: num(theftN), flag: theftN > 0 },
    { label: 'Policy breaches', value: num(r.breachTotal) },
    { label: `Reporting since ${since}`, value: `${num(r.fleet.reporting)} of ${num(r.fleet.units)}` },
  ] })

  // ── 2. escalated thefts ──
  b.push({ kind: 'h2', title: '2. Critical: escalated thefts', aside: `${theftN} of ${plural(r.fuel.drains.length, 'drain')} in the shift` })
  if (!theftN) b.push({ kind: 'none', text: 'No theft escalated in the shift.' })
  else b.push({ kind: 'table', cols: [{ w: 12 }, { w: 20 }, { w: 32 }, { w: 16, align: 'right' }, { w: 0 }, { w: 18 }, { w: 32 }],
    head: ['Time', 'Unit', 'Driver', 'Lost', 'Where', 'Unit was', 'Status'],
    rows: r.theft.map((d): DocCell[] => [
      { text: fmtHM.format(d.t) }, { text: d.plate, bold: true }, { text: d.driver ?? 'Not recorded' },
      { text: `${num(d.litres, 1)} L`, tone: 'flag', bold: true }, { text: d.place ?? DASH },
      { text: d.stationary ? 'Standing' : 'Moving' }, { text: d.status, tone: toneOf(d.tone), bold: d.tone === 'c' },
    ]) })

  // ── 3. policy breaches ──
  b.push({ kind: 'h2', title: '3. Policy breaches', aside: `${num(r.breachTotal)} in the shift · top 5 units for each` })
  const noCam = (x: EndOfShift['breaches'][number]) => x.fromDashcam && !r.dashcam
  b.push({ kind: 'table', cols: r.breaches.map(() => ({ w: 0, align: 'center' as const })), head: r.breaches.map((x) => x.label), rows: [
    r.breaches.map((x) => ({ text: noCam(x) ? DASH : num(x.total), bold: true })),
    r.breaches.map((x) => ({ text: noCam(x) ? 'no dashcams' : plural(x.units, 'unit'), tone: 'mut' as const })),
  ] })
  const half = (x: EndOfShift['breaches'][number]) => {
    const aside = x.units ? (x.units > x.top.length ? `top ${x.top.length} of ${x.units} units` : `all ${plural(x.units, 'unit')}`) : ''
    const body: DocTable | DocNone = !x.top.length
      ? { kind: 'none', text: noCam(x) ? 'No dashcams in this fleet.' : 'None in the shift.' }
      : x.key === 'speed'
        ? { kind: 'table', size: 7.4, cols: [{ w: 16 }, { w: 0 }, { w: 17, align: 'right' }, { w: 15, align: 'right' }, { w: 16, align: 'right' }],
            head: ['Unit', 'Driver', 'Time over', 'Avg over', 'Top / limit'],
            rows: x.top.map((t): DocCell[] => [
              { text: t.plate, bold: true }, { text: t.driver ?? 'Not recorded' }, { text: dur((t.overSec ?? 0) * 1000), bold: true },
              { text: t.avgOver != null ? `+${num(t.avgOver)} km/h` : DASH },
              t.peak ? { text: `${num(t.peak)} / ${num(t.limit)}`, tone: t.limit && t.peak - t.limit >= 30 ? 'flag' : undefined } : { text: DASH },
            ]) }
        : { kind: 'table', size: 7.4, cols: [{ w: 18 }, { w: 0 }, { w: 13, align: 'right' }], head: ['Unit', 'Driver', 'Times'],
            rows: x.top.map((t): DocCell[] => [{ text: t.plate, bold: true }, { text: t.driver ?? 'Not recorded' }, { text: num(t.times), bold: true }]) }
    return { title: x.label, aside, body }
  }
  for (let i = 0; i < r.breaches.length; i += 2) b.push({ kind: 'pair', halves: r.breaches.slice(i, i + 2).map(half) })
  if (r.dashcam) b.push({ kind: 'note', text: 'On phone, no seatbelt and camera covered come from the dashcams, so only units with a camera are counted.' })

  // ── 4. out of geofence ──
  b.push({ kind: 'h2', title: '4. Out of geofence', aside: `Left a geofence since ${since}` })
  if (!r.zonesKnown) b.push({ kind: 'none', text: 'No geofences are set up for this fleet.' })
  else {
    const ob = r.outAndBack
    b.push({ kind: 'figures', items: [
      { label: 'Left and still out', value: num(r.outside.length), flag: r.outside.length > 0 },
      { label: 'Units out and back', value: num(ob.units) },
      { label: ob.longest ? `Longest out: ${ob.longest.plate}, from ${ob.longest.zone}` : 'Longest time out', value: ob.longest ? dur(ob.longest.ms) : DASH },
    ] })
    b.push({ kind: 'h3', title: 'Left and still out', aside: r.outside.length ? 'no dispatch first, then longest out' : '' })
    if (!r.outside.length) b.push({ kind: 'none', text: 'No unit that left a geofence in the shift is still out.' })
    else {
      b.push({ kind: 'table', size: 7.6, cols: [{ w: 18 }, { w: 27 }, { w: 28 }, { w: 10 }, { w: 20, align: 'right' }, { w: 0 }, { w: 22 }],
        head: ['Unit', 'Driver', 'Left', 'At', 'Out for', 'Now near', 'Dispatch'],
        rows: r.outside.map((u): DocCell[] => [
          { text: u.plate, bold: true }, { text: u.driver ?? 'Unassigned' }, { text: u.left }, { text: fmtHM.format(u.since) },
          { text: dur(u.forMs), tone: u.long ? 'flag' : undefined, bold: u.long },
          { text: u.silentSince ? `No signal since ${fmtHM.format(u.silentSince)}` : (u.near ?? (u.lat != null && u.lng != null ? `${u.lat.toFixed(4)}, ${u.lng.toFixed(4)}` : DASH)) },
          u.dispatch ? { text: `Tag ${u.dispatch}`, tone: 'mut' } : { text: 'No dispatch', tone: 'flag', bold: true },
        ]) })
      b.push({ kind: 'note', text: 'Red: no dispatch, or out longer than 12 hours. A unit already outside at the start of the shift is not counted.' })
    }
  }

  // ── 5. weighbridge ──
  const wb = r.weighbridge
  let n = 5
  if (wb) {
    b.push({ kind: 'h2', title: `${n++}. Weighbridge`, aside: span })
    b.push({ kind: 'figures', items: [
      { label: 'Tickets weighed', value: num(wb.tickets) }, { label: 'Net weighed', value: `${num(wb.tonnes, 1)} t` },
      { label: 'Units weighed', value: num(wb.units) }, { label: 'Units with 2+ trips', value: num(wb.multiUnits) },
      { label: 'Bridges in use', value: num(wb.bridges.length) },
    ] })
    b.push({ kind: 'h3', title: 'By bridge', aside: 'net weight' })
    if (!wb.bridges.length) b.push({ kind: 'none', text: 'Nothing weighed in the shift.' })
    else b.push({ kind: 'table', cols: [{ w: 0 }, { w: 22, align: 'right' }, { w: 25, align: 'right' }, { w: 32, align: 'right' }],
      head: ['Bridge', 'Tickets', 'Net (t)', 'Busiest hour'],
      rows: wb.bridges.map((x): DocCell[] => [{ text: x.name, bold: true }, { text: num(x.tickets) }, { text: num(x.tonnes, 1) }, { text: x.busiest ?? DASH }]) })
    b.push({ kind: 'h3', title: 'Units with more than one trip', aside: wb.multi.length ? `${num(wb.multi.length)} units, most trips first` : '' })
    if (!wb.multi.length) b.push({ kind: 'none', text: 'No unit was weighed more than once.' })
    else b.push({ kind: 'table', cols: [{ w: 20 }, { w: 42 }, { w: 14, align: 'right' }, { w: 18, align: 'right' }, { w: 0 }],
      head: ['Unit', 'Driver', 'Trips', 'Net (t)', 'Weighed at'],
      rows: wb.multi.map((u): DocCell[] => [{ text: u.plate, bold: true }, { text: u.driver ?? 'Not recorded' }, { text: num(u.trips), bold: true },
        { text: num(u.tonnes, 1) }, { text: u.bridges.join(', ') || DASH }]) })
    b.push({ kind: 'note', text: 'A trip here is one load weighed: the mill net when the load reached the mill, otherwise the outstation net.' })
  }

  // ── products ferried ──
  b.push({ kind: 'h2', title: `${n++}. Products ferried`, aside: span })
  if (!r.products.length) b.push({ kind: 'none', text: 'No load recorded in the shift.' })
  else {
    const total = (f: (p: EndOfShift['products'][number]) => number) => r.products.reduce((s, p) => s + f(p), 0)
    b.push({ kind: 'table', cols: [{ w: 32 }, { w: 13, align: 'right' }, { w: 12, align: 'right' }, { w: 19, align: 'right' }, { w: 14, align: 'right' }, { w: 0 }, { w: 30 }],
      head: ['Product', 'Loads', 'Units', 'Weight (t)', 'Bags', 'Where it went', 'Read from'],
      rows: [...r.products.map((p): DocCell[] => [{ text: p.product, bold: true }, { text: num(p.loads) }, { text: num(p.units) },
        { text: num(p.tonnes, 1), bold: true }, { text: p.bags ? num(p.bags) : DASH }, { text: p.where || DASH }, { text: p.source, tone: 'mut' }]),
      [{ text: 'Total', bold: true }, { text: num(total((p) => p.loads)), bold: true }, { text: '' },
        { text: num(total((p) => p.tonnes), 1), bold: true }, { text: '' }, { text: '' }, { text: '' }]] })
  }
  b.push({ kind: 'note', text: 'Cane weights come from the weighbridge; sugar and other sales loads from the tonnage typed on each sales dispatch.' })

  // ── handover ──
  b.push({ kind: 'h2', title: `${n}. Handover to the next shift` })
  b.push({ kind: 'handover', lines: ['', '', '', ''], signatures: ['Prepared by (outgoing operator)', 'Received by (incoming operator)'] })

  return {
    title: 'END OF SHIFT REPORT', reportNo: o.reportNo, date,
    meta: [{ label: 'Fleet', value: o.orgName }, { label: 'Shift', value: `${date}, ${span}` }],
    blocks: b,
    footer: endOfShiftDoc.made(o.orgName, date, generatedAt),
  }
}
/** The footer: the fleet, the report, its date and when it was made. */
endOfShiftDoc.made = (orgName: string, date: string, at: number) => `${orgName} · End of shift report · ${date} · made ${fmtStamp.format(at)}`

// ── drawing ───────────────────────────────────────────────────────────────────

const colorOf = (t?: DocTone) => (t === 'flag' ? C.flag : t === 'mut' ? C.mut : undefined)
const cellOf = (c: DocCell): Cell => ({ text: c.text, bold: c.bold, color: colorOf(c.tone) })
const colsOf = (cols: DocCol[]): Col[] => cols.map((c) => ({ w: c.w * MM, align: c.align }))

/** Draws a document: the one endOfShiftDoc made, or the operator's edit of it. */
export async function renderShiftDoc(d: ShiftDoc): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true,
    info: { Title: `End of shift report ${d.meta[0]?.value ?? ''} ${d.date}`.trim(), Author: 'Off-Grid Consulting Ltd.' } })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))))
  const w = new ReportWriter(doc)

  /** A muted note, a little clear of the table above it. */
  const note = (text: string) => { w.y += 1.2 * MM; w.note(text) }
  /** A sub-heading inside a section, with an aside on the right. */
  const h3 = (text: string, aside = '', x = SIDE, width = BODY_W) => {
    w.line(text, x, w.y + 2, width * 0.55, { font: F.bold, size: 8 })
    if (aside) w.line(aside, x + width * 0.45, w.y + 2.6, width * 0.55, { size: 7, color: C.mut, align: 'right' })
    w.y += 13
  }
  const table = (t: DocTable, o: { x?: number; width?: number } = {}) =>
    w.table(colsOf(t.cols), t.head, t.rows.map((row) => row.map(cellOf)), { ...o, ...(t.size ? { size: t.size } : {}) })

  // ── letterhead and title ──
  w.y = drawLetterhead(doc)
  w.line(d.title, SIDE, w.y, BODY_W / 2, { font: F.bold, size: 15 })
  w.line(`Report no. ${d.reportNo}  ·  Date ${d.date}`, SIDE + BODY_W / 2, w.y + 6, BODY_W / 2, { font: F.bold, size: 8, align: 'right' })
  w.y += 19
  w.hr(SIDE, SIDE + BODY_W, w.y, C.ink, 1.2)
  w.y += 2.2 * MM
  for (const m of d.meta) {
    w.line(m.label, SIDE, w.y, 23 * MM, { color: C.mut })
    w.line(m.value, SIDE + 23 * MM, w.y, BODY_W - 23 * MM, { font: F.bold })
    w.y += 12
  }

  let prev: DocBlock['kind'] | null = null
  for (const blk of d.blocks) {
    switch (blk.kind) {
      case 'h2': w.h2(blk.title, blk.aside ?? ''); break
      case 'h3': if (prev && prev !== 'h2') w.y += 1.5 * MM; h3(blk.title, blk.aside); break
      case 'figures': w.cells(blk.items.map((i) => [i.label, i.value, i.flag ? C.flag : undefined] as [string, string, string | undefined])); break
      case 'table': table(blk); break
      case 'none': w.none(blk.text); break
      case 'note': note(blk.text); break
      case 'pair': {
        if (prev !== 'pair') w.y += 2 * MM
        const half = (BODY_W - 6 * MM) / 2
        const rows = Math.max(1, ...blk.halves.map((h) => (h.body.kind === 'table' ? h.body.rows.length : 1)))
        w.room(13 + 11.2 + rows * 11.2 + 4 * MM)
        const y0 = w.y
        let yMax = y0
        blk.halves.slice(0, 2).forEach((h, k) => {
          const x = SIDE + k * (half + 6 * MM)
          w.y = y0
          h3(h.title, h.aside, x, half)
          if (h.body.kind === 'none') w.none(h.body.text, x, half)
          else table(h.body, { x, width: half })
          yMax = Math.max(yMax, w.y)
        })
        w.y = yMax + 2 * MM
        break
      }
      case 'handover': {
        w.room(blk.lines.length * 9 * MM + 30 * MM)
        for (const text of blk.lines) {
          w.y += 8 * MM
          if (text) w.line(text, SIDE + 1 * MM, w.y - 4.2 * MM, BODY_W - 2 * MM, { size: 9 })
          w.hr(SIDE, SIDE + BODY_W, w.y, C.rule, 0.6)
        }
        w.y += 16 * MM
        const sigs = blk.signatures.slice(0, 2)
        const sigW = (BODY_W - 12 * MM) / 2
        sigs.forEach((label, k) => {
          const x = SIDE + k * (sigW + 12 * MM)
          w.hr(x, x + sigW, w.y, C.ink, 0.8)
          w.line(label, x, w.y + 2, sigW, { size: 7.4, color: C.mut })
        })
        w.y += 12
        break
      }
    }
    prev = blk.kind
  }

  w.footers(d.footer)
  doc.end()
  return done
}

export async function renderEndOfShiftPdf(r: EndOfShift, o: { orgName: string; reportNo: string; generatedAt?: number }): Promise<Buffer> {
  return renderShiftDoc(endOfShiftDoc(r, o))
}
