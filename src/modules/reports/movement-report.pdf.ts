// The movement report as a PDF, in the Driver Conduct Report's style: the
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
import { haversineM } from '../../lib/geofence.js'
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

/** The Mombasa loading point and its radius (operator, 2026-11-02). */
export const MOMBASA_LOADING = { lat: -4.04579, lng: 39.65165, radiusM: 1000 }

/**
 * A unit loading in Mombasa: its last fix, inside the window, within 1 km of
 * the loading point. Its Location cell is filled orange, ahead of green.
 */
export const isLoading = (row: MovementRow) => row.lastAt != null && !row.stale && row.lat != null && row.lng != null
  && haversineM(row.lat, row.lng, MOMBASA_LOADING.lat, MOMBASA_LOADING.lng) <= MOMBASA_LOADING.radiusM

/** A loading unit's Location cell: an orange fill, stronger than the From MORL row tint. */
export const LOADING_FILL = '#f8c08a'

/** A unit at MORL: its Location cell filled yellow, as the operator's sheet has it (2026-11-02), stale or not. */
export const AT_MORL_FILL = '#fbe36b'

export const locationFill = (row: MovementRow) =>
  isLoading(row) ? LOADING_FILL : row.state === 'at' ? AT_MORL_FILL : isMoving(row) ? MOVING_FILL : undefined

/** The sheet's colours, as tints light enough to print on. */
const TINT: Partial<Record<MovementState, string>> = { to: '#e3f1dc', from: '#fbe4d3', at: '#fdf3c9' }

/**
 * Every row carries a status in the Direction column (operator, 2026-11-01),
 * read against the report's site: MORL for Menengai, the organisation's own
 * elsewhere ("To Sukari").
 */
export const directionWords = (site = 'MORL'): Record<MovementState, string> => ({
  to: `To ${site}`, from: `From ${site}`, at: `At ${site}`, moving: 'Moving', stopped: 'Stopped', 'no-fix': 'No fix',
})
export const DIRECTION = directionWords('MORL')

/** "MV-MENENGAI-20261101-1943": what the report is, whose, and when. */
export function movementReportNo(r: MovementReport): string {
  const p = parts(r.to)
  return `MV-${(r.orgCode || 'ORG').toUpperCase()}-${p.year}${p.month}${p.day}-${p.hour}${p.minute}`
}

/** "2 hours", "1 hour", "1.5 hours". */
const hoursWords = (h: number) => `${Number.isInteger(h) ? h : h.toFixed(1)} hour${h === 1 ? '' : 's'}`

/** "1 hour, 2 Nov 2026, 07:00hrs – 08:00hrs"; a window over midnight names both days. */
export function windowText(r: Pick<MovementReport, 'hours' | 'from' | 'to'>): string {
  const sameDay = longDay(r.from) === longDay(r.to - 1)
  return `${hoursWords(r.hours)}, ${longDay(r.from)}, ${hm(r.from)} – ${sameDay ? '' : `${longDay(r.to)}, `}${hm(r.to)}`
}

export function movementFileName(r: MovementReport): string {
  return `Movement Report ${r.organisation || r.orgCode} ${movementReportNo(r).slice(-13)} ${hoursWords(r.hours)}.pdf`
}

/** A window a day over a range of days: "Movement Report Menengai 20261101 to 20261103 0700-0800.pdf". */
export function movementReportsFileName(rs: MovementReport[]): string {
  const day = (ms: number) => { const p = parts(ms); return `${p.year}${p.month}${p.day}` }
  const at = (ms: number) => { const p = parts(ms); return `${p.hour}${p.minute}` }
  const first = rs[0]!, last = rs[rs.length - 1]!
  return `Movement Report ${first.organisation || first.orgCode} ${day(first.from)} to ${day(last.from)} ${at(first.from)}-${at(first.to)}.pdf`
}

export async function renderMovementReportPdf(r: MovementReport): Promise<Buffer> {
  return renderMovementReportsPdf([r])
}

/** One report, or several (a window a day over a range of days), each from a new page, in one file. */
export async function renderMovementReportsPdf(rs: MovementReport[]): Promise<Buffer> {
  const first = rs[0]!
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: `Movement Report ${movementReportNo(first)}`, Author: 'Off-Grid Consulting Ltd.' } })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>(res => doc.on('end', () => res(Buffer.concat(chunks))))
  const w = new ReportWriter(doc)
  rs.forEach((r, i) => {
    if (i) { w.runningHead = null; doc.addPage({ size: 'A4', margin: 0 }) }
    drawReport(w, doc, r)
  })
  const last = rs[rs.length - 1]!
  w.footers(rs.length === 1
    ? `${first.organisation} · Movement Report · ${windowText(first)}`
    : `${first.organisation} · Movement Report · ${rs.length} days, ${longDay(first.from)} – ${longDay(last.from)}, ${hm(first.from)} – ${hm(first.to)}`)
  doc.end()
  return done
}

function drawReport(w: ReportWriter, doc: InstanceType<typeof PDFDocument>, r: MovementReport) {
  const reportNo = movementReportNo(r)
  const when = windowText(r)
  // The site its directions read against: MORL, or the organisation's own ("Sukari")
  const site = r.site || 'MORL'
  const words = directionWords(site)

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
    ['Fleet', r.organisation || DASH, 'Window', when],
    ['Groups', `${r.groups.length} (${r.groups.slice(0, 3).map(g => g.name).join(', ')}${r.groups.length > 3 ? ', …' : ''})`, 'Vehicles', `${num(r.counts.total)} listed`],
    ['As at', `${longDay(r.to)}, ${hm(r.to)}`, 'Reference', r.morl ? `${r.morl} geofence` : `No ${site} geofence`],
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
  w.h2('1. Overview', when)
  w.cells([
    ['Vehicles', num(n.total)],
    [`Heading to ${site}`, num(n.to), n.to ? C.good : undefined],
    [`Leaving ${site}`, num(n.from), n.from ? '#b45309' : undefined],
    [`At ${site}`, num(n.at)],
    ['Moving, no direction', num(n.moving)],
    ['Stopped elsewhere', num(n.stopped)],
    ['Not reporting', num(n.stale + n['no-fix']), n.stale + n['no-fix'] ? C.flag : undefined],
  ])

  // ── one section per grouping ──
  const cols: Col[] = [{ w: 54 * MM }, { w: 30 * MM }, { w: 0 }, { w: 15 * MM, align: 'right' }, { w: 20 * MM }]
  const cell = (row: MovementRow): Cell[] => [
    { text: row.grouping, bold: true, color: row.stale || row.state === 'no-fix' ? C.flag : undefined },
    { text: row.lastAt != null ? stamp(row.lastAt) : 'No fix', color: row.stale ? C.flag : undefined },
    { text: row.location ?? (row.state === 'at' ? r.morl ?? site : DASH), fill: locationFill(row) },
    { text: row.speedKmh != null ? `${row.speedKmh} km/h` : DASH },
    { text: words[row.state], bold: row.state === 'to' || row.state === 'from' },
  ]
  r.groups.forEach((g, i) => {
    const tally = (s: MovementState) => g.rows.filter(x => x.state === s).length
    const aside = [`${g.rows.length} vehicle${g.rows.length === 1 ? '' : 's'}`,
      tally('to') ? `${tally('to')} to ${site}` : null, tally('from') ? `${tally('from')} from ${site}` : null,
      tally('at') ? `${tally('at')} at ${site}` : null].filter(Boolean).join(' · ')
    w.room(60)
    w.h2(`${i + 2}. ${g.name}`, aside)
    w.table(cols, ['Grouping', 'Last coordinates', 'Location', 'Speed', 'Direction'], g.rows.map(cell),
      { size: 7.6, fills: g.rows.map(x => TINT[x.state] ?? null) })
  })
}
