// The movement report as a PDF, in the Driver Behaviour Report's style: the
// RAI Group / OGC letterhead, a report number and date, the fleet and window
// at the top, numbered sections and ruled tables, a running head from the
// second page and the page count at the foot.
//
// One section per grouping (CPO first), in the operator's sheet's columns —
// grouping, last coordinates, location, speed, direction — with the sheet's
// colours as light tints: green heading to MORL, orange leaving it, yellow at
// MORL. A unit that has not reported in the window has its name in red. The
// Direction column always says where the unit stands: To MORL, From MORL,
// At MORL, Moving or Stopped.
//
// Pure drawing: takes what movement-report.service answers and returns the file.

import PDFDocument from 'pdfkit'
import { MM, SIDE, BODY_W, C, F, DASH, num, drawLetterhead, ReportWriter, type Cell, type Col } from '../../lib/pdf/letterhead.js'
import { MOVING_KMH, type MovementReport, type MovementRow, type MovementState } from './movement-report.service.js'

const TZ = 'Africa/Nairobi'
const parts = (ms: number) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).formatToParts(ms).map(p => [p.type, p.value])) as Record<string, string>
/** "18.06.2025 07:56:26", as the operator's sheet writes it. */
const stamp = (ms: number) => { const p = parts(ms); return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}:${p.second}` }
const hm = (ms: number) => { const p = parts(ms); return `${p.hour}:${p.minute}hrs` }
const dateOf = (ms: number) => { const p = parts(ms); return `${p.day}/${p.month}/${p.year}` }
const longDay = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(ms)

/**
 * A unit moving now, on a fix inside the window: its Location cell filled green
 * (operator, 2026-11-02). A row the operator set to Stopped or No fix is not
 * moving, whatever the last speed said.
 */
export const isMoving = (row: MovementRow) => row.lastAt != null && !row.stale
  && row.state !== 'stopped' && row.state !== 'no-fix' && (row.speedKmh ?? 0) >= MOVING_KMH

/** A moving unit's Location cell: a green fill, stronger than the To MORL row tint so it shows on any row. */
export const MOVING_FILL = '#b5dfa6'

/** The sheet's colours, as tints light enough to print on. */
const TINT: Partial<Record<MovementState, string>> = { to: '#e3f1dc', from: '#fbe4d3', at: '#fdf3c9' }

/** Every row carries a status in the Direction column (operator, 2026-11-01). */
export const DIRECTION: Record<MovementState, string> = {
  to: 'To MORL', from: 'From MORL', at: 'At MORL', moving: 'Moving', stopped: 'Stopped', 'no-fix': 'No fix',
}

/** "MV-MENENGAI-20261101-1943": what the report is, whose, and when. */
export function movementReportNo(r: MovementReport): string {
  const p = parts(r.to)
  return `MV-${(r.orgCode || 'ORG').toUpperCase()}-${p.year}${p.month}${p.day}-${p.hour}${p.minute}`
}

export function movementFileName(r: MovementReport): string {
  return `Movement Report ${r.organisation || r.orgCode} ${movementReportNo(r).slice(-13)} last ${r.hours} hours.pdf`
}

export async function renderMovementReportPdf(r: MovementReport): Promise<Buffer> {
  const reportNo = movementReportNo(r)
  const windowText = `Last ${r.hours} hours, ${longDay(r.from)}, ${hm(r.from)} – ${hm(r.to)}`
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: `Movement Report ${reportNo}`, Author: 'Off-Grid Consulting Ltd.' } })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>(res => doc.on('end', () => res(Buffer.concat(chunks))))
  const w = new ReportWriter(doc)

  // ── letterhead, title, who and when ──
  w.y = drawLetterhead(doc)
  w.line('MOVEMENT REPORT', SIDE, w.y, BODY_W / 2, { font: F.bold, size: 15 })
  {
    const right = `Report no. ${reportNo}   ·   Date ${dateOf(r.to)}`
    w.line(right, SIDE + BODY_W / 2, w.y + 6, BODY_W / 2, { size: 8, color: C.mut, align: 'right' })
  }
  w.y += 19
  w.hr(SIDE, SIDE + BODY_W, w.y, C.ink, 1.2)
  w.y += 2.2 * MM
  const half = BODY_W / 2
  const info: [string, string, string, string][] = [
    ['Fleet', r.organisation || DASH, 'Window', windowText],
    ['Groups', `${r.groups.length} (${r.groups.slice(0, 3).map(g => g.name).join(', ')}${r.groups.length > 3 ? ', …' : ''})`, 'Vehicles', `${num(r.counts.total)} listed`],
    ['Generated', `${longDay(r.to)}, ${hm(r.to)}`, 'Reference', r.morl ? `${r.morl} geofence` : 'No MORL geofence'],
  ]
  for (const [a, av, b, bv] of info) {
    w.line(a, SIDE, w.y, 23 * MM, { color: C.mut })
    w.line(av, SIDE + 23 * MM, w.y, half - 26 * MM, { font: F.bold })
    w.line(b, SIDE + half, w.y, 23 * MM, { color: C.mut })
    w.line(bv, SIDE + half + 23 * MM, w.y, half - 23 * MM, { font: F.bold })
    w.y += 12
  }
  w.runningHead = { title: 'Movement Report', right: `${r.organisation} · ${reportNo}` }

  // ── 1. overview ──
  const n = r.counts
  w.h2('1. Overview', windowText)
  w.cells([
    ['Vehicles', num(n.total)],
    ['Heading to MORL', num(n.to), n.to ? C.good : undefined],
    ['Leaving MORL', num(n.from), n.from ? '#b45309' : undefined],
    ['At MORL', num(n.at)],
    ['Moving, no direction', num(n.moving)],
    ['Stopped elsewhere', num(n.stopped)],
    ['Not reporting', num(n.stale + n['no-fix']), n.stale + n['no-fix'] ? C.flag : undefined],
  ])

  // ── one section per grouping ──
  const cols: Col[] = [{ w: 54 * MM }, { w: 30 * MM }, { w: 0 }, { w: 15 * MM, align: 'right' }, { w: 20 * MM }]
  const cell = (row: MovementRow): Cell[] => [
    { text: row.grouping, bold: true, color: row.stale || row.state === 'no-fix' ? C.flag : undefined },
    { text: row.lastAt != null ? stamp(row.lastAt) : 'No fix', color: row.stale ? C.flag : undefined },
    { text: row.location ?? (row.state === 'at' ? r.morl ?? 'MORL' : DASH), fill: isMoving(row) ? MOVING_FILL : undefined },
    { text: row.speedKmh != null ? `${row.speedKmh} km/h` : DASH },
    { text: DIRECTION[row.state], bold: row.state === 'to' || row.state === 'from' },
  ]
  r.groups.forEach((g, i) => {
    const tally = (s: MovementState) => g.rows.filter(x => x.state === s).length
    const aside = [`${g.rows.length} vehicle${g.rows.length === 1 ? '' : 's'}`,
      tally('to') ? `${tally('to')} to MORL` : null, tally('from') ? `${tally('from')} from MORL` : null,
      tally('at') ? `${tally('at')} at MORL` : null].filter(Boolean).join(' · ')
    w.room(60)
    w.h2(`${i + 2}. ${g.name}`, aside)
    w.table(cols, ['Grouping', 'Last coordinates', 'Location', 'Speed', 'Direction'], g.rows.map(cell),
      { size: 7.6, fills: g.rows.map(x => TINT[x.state] ?? null) })
  })

  w.footers(`${r.organisation} · Movement Report · ${windowText}`)
  doc.end()
  return done
}
