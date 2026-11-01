// The movement report as a PDF, in the Driver Behaviour Report's style: the
// RAI Group / OGC letterhead, a report number and date, the fleet and window
// at the top, numbered sections and ruled tables, a running head from the
// second page and the page count at the foot.
//
// One section per grouping (CPO first), in the operator's sheet's columns —
// grouping, last coordinates, location, speed, direction — with the sheet's
// colours as light tints: green heading to MORL, orange leaving it, yellow at
// MORL. A unit that has not reported in the window has its name in red.
//
// Pure drawing: takes what movement-report.service answers and returns the file.

import PDFDocument from 'pdfkit'
import { MM, SIDE, BODY_W, C, F, DASH, num, drawLetterhead, ReportWriter, type Cell, type Col } from '../../lib/pdf/letterhead.js'
import type { MovementReport, MovementRow, MovementState } from './movement-report.service.js'

const TZ = 'Africa/Nairobi'
const parts = (ms: number) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).formatToParts(ms).map(p => [p.type, p.value])) as Record<string, string>
/** "18.06.2025 07:56:26", as the operator's sheet writes it. */
const stamp = (ms: number) => { const p = parts(ms); return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}:${p.second}` }
const hm = (ms: number) => { const p = parts(ms); return `${p.hour}:${p.minute}hrs` }
const dateOf = (ms: number) => { const p = parts(ms); return `${p.day}/${p.month}/${p.year}` }
const longDay = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(ms)

/** The sheet's colours, as tints light enough to print on. */
const TINT: Partial<Record<MovementState, string>> = { to: '#e3f1dc', from: '#fbe4d3', at: '#fdf3c9' }

const DIRECTION: Record<MovementState, string> = {
  to: 'To MORL', from: 'From MORL', at: '', moving: 'Moving', stopped: '', 'no-fix': '',
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
  if (!r.morl) w.more('No geofence named MORL was found for this fleet, so no direction is given. Draw one on the map named "MORL" and the next report will use it.', SIDE, BODY_W, C.flag)

  // ── one section per grouping ──
  const cols: Col[] = [{ w: 54 * MM }, { w: 30 * MM }, { w: 0 }, { w: 15 * MM, align: 'right' }, { w: 20 * MM }]
  const cell = (row: MovementRow): Cell[] => [
    { text: row.grouping, bold: true, color: row.stale || row.state === 'no-fix' ? C.flag : undefined },
    { text: row.lastAt != null ? stamp(row.lastAt) : 'No fix', color: row.stale ? C.flag : undefined },
    { text: row.state === 'at' ? (r.morl ?? 'MORL') : row.location ?? DASH },
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

  // ── how to read it ──
  w.y += 2 * MM
  w.note([
    `Direction compares each unit's distance to the ${r.morl ?? 'MORL'} geofence at the start of the window with its distance now: a kilometre or more closer is "To MORL", further is "From MORL", inside the fence is "At MORL". Less change than that gives no direction; a unit doing ${5} km/h or more is then shown as moving.`,
    'Rows: green heading to MORL, orange leaving it, yellow at MORL. A name in red has not reported in this window; its last coordinates are older.',
    'Location is the nearest named place to the last fix; where none has been looked up yet, the coordinates are given instead.',
  ].join('\n'))

  w.footers(`${r.organisation} · Movement Report · ${windowText}`)
  doc.end()
  return done
}
