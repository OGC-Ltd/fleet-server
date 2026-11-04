// The Dormant Assets, Geofence, TAT and Fuel and Speed reports as PDFs, drawn on the
// server (operator, 4 Nov 2026), on the letterhead the Movement Report uses.
// The page makes the rows, for one organisation or several together and for the
// sites ticked (new-ui hooks/useReportOrgs), and sends them here to be drawn.
//
// Pure drawing: takes the rows and returns the file.

import PDFDocument from 'pdfkit'
import { MM, SIDE, sheetOf, C, F, DASH, num, drawLetterhead, ReportWriter, type Cell, type Col } from '../../lib/pdf/letterhead.js'
import type { DormantPdfBody, GeofencePdfBody, TatFuelPdfBody, SpeedPdfBody } from './report.schema.js'

const OFFSET = 3 * 3600_000
const DAY = 86_400_000
const iso = (ms: number) => new Date(ms + OFFSET).toISOString()
/** "04/11/2026 05:04", in Nairobi. */
const dmyhm = (ms: number) => { const s = iso(ms); return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)} ${s.slice(11, 16)}` }
const dmy = (ms: number) => dmyhm(ms).slice(0, 10)
/** "2026-10-30 11:42:05", in Nairobi, as the sheets write it. */
export const stampWords = (ms: number) => iso(ms).slice(0, 19).replace('T', ' ')

export const CONTACT_LINE = 'This is a system-generated report. For any queries about its contents, please contact OGC Monitoring at operations@offgridconsultingltd.com.'

/** "TF-SUKARI-20261104-0504": what the report is, whose, and when. */
export function templateReportNo(prefix: string, orgCode: string, now: number) {
  const s = iso(now)
  return `${prefix}-${orgCode}-${s.slice(0, 10).replace(/-/g, '')}-${s.slice(11, 16).replace(':', '')}`
}

type Doc = InstanceType<typeof PDFDocument>

function open(title: string, landscape: boolean) {
  const sheet = sheetOf(landscape)
  const doc = new PDFDocument({ size: 'A4', layout: sheet.layout, margin: 0, bufferPages: true, info: { Title: title, Author: 'Off-Grid Consulting Ltd.' } })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>(res => doc.on('end', () => res(Buffer.concat(chunks))))
  return { doc, done, w: new ReportWriter(doc, sheet) }
}

/** The band, the title and number under a rule, and the facts, two to a row. */
function heading(w: ReportWriter, doc: Doc, o: { title: string; reportNo: string; date: string; fleet: string; info: Array<[string, string]> }) {
  const body = w.sheet.body, half = body / 2
  w.y = drawLetterhead(doc, w.sheet)
  w.line(o.title.toUpperCase(), SIDE, w.y, half, { font: F.bold, size: 15 })
  w.line(`Report no. ${o.reportNo}   ·   Date ${o.date}`, SIDE + half, w.y + 6, half, { size: 8, color: C.mut, align: 'right' })
  w.y += 19
  w.hr(SIDE, SIDE + body, w.y, C.ink, 1.2)
  w.y += 2.2 * MM
  for (let i = 0; i < o.info.length; i += 2) {
    const [a, av] = o.info[i]!
    w.line(a, SIDE, w.y, 23 * MM, { color: C.mut })
    w.line(av, SIDE + 23 * MM, w.y, half - 26 * MM, { font: F.bold })
    const b = o.info[i + 1]
    if (b) {
      w.line(b[0], SIDE + half, w.y, 23 * MM, { color: C.mut })
      w.line(b[1], SIDE + half + 23 * MM, w.y, half - 23 * MM, { font: F.bold })
    }
    w.y += 12
  }
  w.runningHead = { title: o.title, right: `${o.fleet} · ${o.reportNo}` }
}

// ── Dormant Assets ───────────────────────────────────────────────────────────

export const DORMANT_SECTIONS = [
  { key: 'yesterday', title: 'OFFLINE YESTERDAY', words: 'Offline yesterday', days: [1, 1] },
  { key: 'two', title: 'OFFLINE FOR 48 HRS', words: 'Offline for 48 hrs', days: [2, 3] },
  { key: 'over', title: 'OFFLINE FOR OVER 48 HRS', words: 'Offline for over 48 hrs', days: [4, Infinity] },
] as const
/** The sheet's section bars. */
const BAR = '#00b0f0'
const BAR_INK = '#0b1f2a'
const BAR_H = 6 * MM

/** The days a section covers: "30/10/2026", "28/10/2026 – 29/10/2026", "27/10/2026 and earlier". */
export function sectionDays(s: { days: readonly [number, number] }, now: number) {
  const d = (n: number) => dmy(now - n * DAY)
  if (s.days[1] === Infinity) return `${d(s.days[0])} and earlier`
  return s.days[0] === s.days[1] ? d(s.days[0]) : `${d(s.days[1])} – ${d(s.days[0])}`
}

/** A section's bar: its title in the very middle of the bar, its days on the right, neither moving the other. */
export function sectionBar(w: ReportWriter, title: string, aside: string) {
  // A bar never sits alone at a page foot: it keeps a row, or the "None." under it
  w.room(4 * MM + BAR_H + 26)
  w.y += 4 * MM
  const body = w.sheet.body
  w.doc.save().rect(SIDE, w.y, body, BAR_H).fill(BAR).restore()
  w.line(title, SIDE, w.y + (BAR_H - 8.4 * 1.16) / 2, body, { font: F.bold, size: 8.4, color: BAR_INK, align: 'center' })
  w.line(aside, SIDE + body * 0.68, w.y + (BAR_H - 7.4 * 1.16) / 2, body * 0.32 - 2 * MM, { size: 7.4, color: BAR_INK, align: 'right' })
  w.y += BAR_H + 1.4 * MM
}

export const dormantFileName = (b: DormantPdfBody) => `Dormant Assets Report ${b.fleet} ${iso(b.now).slice(0, 10)}.pdf`

export async function renderDormantPdf(b: DormantPdfBody, o: { orgCode: string; landscape?: boolean }): Promise<Buffer> {
  const reportNo = templateReportNo('NU', o.orgCode, b.now)
  const { doc, done, w } = open(`Dormant Assets Report ${reportNo}`, Boolean(o.landscape))
  const n = DORMANT_SECTIONS.reduce((s, x) => s + b.sections[x.key].length, 0)
  const asAt = dmyhm(b.now)
  heading(w, doc, {
    title: 'Dormant Assets Report', reportNo, date: dmy(b.now), fleet: b.fleet,
    info: [['Fleet', b.fleet], ['As at', asAt], ['Vehicles', `${num(b.total)} on the platform`], ['Not updating', num(n)]],
  })
  w.h2('1. Overview', `as at ${asAt}`)
  w.cells([
    ...DORMANT_SECTIONS.map((s): [string, string] => [s.words, num(b.sections[s.key].length)]),
    ['Not updating', `${num(n)} of ${num(b.total)}`],
  ])
  w.h2('2. Dormant Assets')
  const cols: Col[] = [{ w: 52 * MM, wrap: true }, { w: 32 * MM }, { w: 0, wrap: true }]
  for (const s of DORMANT_SECTIONS) {
    const list = b.sections[s.key]
    sectionBar(w, s.title, `${sectionDays(s, b.now)} · ${num(list.length)} vehicle${list.length === 1 ? '' : 's'}`)
    if (!list.length) { w.none('None.'); continue }
    w.table(cols, ['Registration', 'Last message', 'Location'], list.map((r): Cell[] => [
      { text: r.name, bold: true }, { text: stampWords(r.lastAt) }, { text: r.location || DASH },
    ]), { size: 7.8 })
  }
  w.y += 2 * MM
  if (b.never) w.note(`${num(b.never)} vehicle${b.never === 1 ? ' has' : 's have'} never reported to the platform and ${b.never === 1 ? 'is' : 'are'} not listed.`)
  w.note('A tracker that stopped sending on the day of the report is not listed yet: it shows the next day, as offline yesterday.')
  w.footers(`${b.fleet} · Dormant Assets Report · ${asAt}`)
  doc.end()
  return done
}

// ── Geofences ────────────────────────────────────────────────────────────────

/** A period ending this close to now ends "now": who is inside is still inside. */
const NOW_SLACK_MS = 5 * 60_000
export const endsNow = (to: number, now: number) => to >= now - NOW_SLACK_MS
/** "2:02:31": hours, minutes, seconds; the hours run past 24. */
export function visitDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
export const periodWords = (from: number, to: number, now: number) => `${dmyhm(from)} to ${endsNow(to, now) ? `now (${dmyhm(to)})` : dmyhm(to)}`

/** A period ending at midnight is that day's: 00:00 to 00:00 next day is one day. */
export function geofenceFileName(b: Pick<GeofencePdfBody, 'fleet' | 'from' | 'to'>) {
  const first = iso(b.from).slice(0, 10), last = iso(Math.max(b.from, b.to - 1)).slice(0, 10)
  return `Geofence Report ${b.fleet} ${first === last ? first : `${first} to ${last}`}.pdf`
}

export async function renderGeofencePdf(b: GeofencePdfBody, o: { orgCode: string; landscape?: boolean; now?: number }): Promise<Buffer> {
  const now = o.now ?? Date.now()
  const reportNo = templateReportNo('GF', o.orgCode, now)
  const { doc, done, w } = open(`Geofence Report ${reportNo}`, Boolean(o.landscape))
  const period = periodWords(b.from, b.to, now)
  const vehicles = new Set(b.rows.map(r => r.vehicleId ?? r.vehicle)).size
  const places = new Set(b.rows.map(r => r.place)).size
  const live = endsNow(b.to, now)
  heading(w, doc, {
    title: 'Geofence Report', reportNo, date: dmy(Math.max(b.from, b.to - 1)), fleet: b.fleet,
    info: [
      ['Fleet', b.fleet], ['Period', period],
      ['Geofences', b.places == null ? 'All' : `${num(b.places)} picked`], ['Visits', `${num(b.rows.length)} by ${num(vehicles)} vehicle${vehicles === 1 ? '' : 's'}`],
      ['Generated', dmyhm(now)],
    ],
  })
  w.h2('1. Overview', period)
  w.cells([
    ['Visits', num(b.rows.length)], ['Vehicles', num(vehicles)], ['Geofences visited', num(places)],
    ...(live ? [['Still inside', num(b.rows.filter(r => r.open).length)] as [string, string]] : []),
  ])
  w.h2('2. Geofence Visits', `${num(b.rows.length)} visit${b.rows.length === 1 ? '' : 's'}`)
  if (!b.rows.length) w.none('No vehicle was in a geofence in the period.')
  else {
    const cols: Col[] = [{ w: 50 * MM, wrap: true }, { w: 0, wrap: true }, { w: 31 * MM }, { w: 31 * MM }, { w: 29 * MM, align: 'right' }]
    w.table(cols, ['Registration', 'Geofence', 'Time in', 'Time out', 'Duration in geofence'], b.rows.map((r): Cell[] => {
      const still = r.open && live
      return [
        { text: r.vehicle, bold: true }, { text: r.place }, { text: stampWords(r.in) },
        { text: still ? 'Still inside' : stampWords(r.out), bold: still }, { text: visitDuration(r.out - r.in) },
      ]
    }), { size: 7.8 })
  }
  w.y += 2 * MM
  if (b.failed) w.note(`${num(b.failed)} vehicle${b.failed === 1 ? '' : 's'} could not be read and ${b.failed === 1 ? 'is' : 'are'} left out.`)
  w.footers(`${b.fleet} · Geofence Report · ${period}`)
  doc.end()
  return done
}

// ── TAT and Fuel ─────────────────────────────────────────────────────────────

type TatPdfRow = TatFuelPdfBody['rows'][number]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "3 Nov 18:41" in Nairobi. */
const whenWords = (ms: number) => { const s = iso(ms); return `${Number(s.slice(8, 10))} ${MONTHS[Number(s.slice(5, 7)) - 1]} ${s.slice(11, 16)}` }
/** "23 h 50 min". */
const tatWords = (ms: number) => {
  const min = Math.round(ms / 60_000)
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`
}
/** The trip, from leaving the premises to being signed back in, and how long it took. */
export function tripWords(r: Pick<TatPdfRow, 'dispatchedAt' | 'leftAt' | 'returnedAt'>) {
  if (r.returnedAt == null) return r.dispatchedAt == null ? '' : `Dispatched ${whenWords(r.dispatchedAt)}`
  const left = r.leftAt ?? r.returnedAt
  return `${whenWords(left)} to ${whenWords(r.returnedAt)} (${tatWords(r.returnedAt - left)})`
}

/** The figures over the rows; the rate only from trips whose probe could be trusted. */
export function tatSummary(rows: TatPdfRow[]) {
  const trips = rows.filter(r => r.returnedAt != null)
  const ok = trips.filter(r => r.comment === 'PROBE OK')
  const km = ok.reduce((s, r) => s + (r.km ?? 0), 0)
  const litres = ok.reduce((s, r) => s + (r.fuel?.consumption ?? 0), 0)
  return {
    trips: trips.length, units: new Set(trips.map(r => r.vehicleId ?? r.plate)).size, litres, km,
    rate: litres > 0 ? km / litres : null,
    notUpdating: rows.filter(r => r.comment === 'NOT UPDATING').length,
  }
}

export const TAT_HEADS = ['Reg No', 'Trip Duration', 'Initial (L)', 'Top Ups (L)', 'Total (L)', 'Consumption', 'Theft (L)', 'Final (L)', 'Station', 'KM', 'KM/L', 'Tank (L)', 'Comment', 'Base']
const TAT_WIDTHS = [20, 48, 14, 17, 14, 20, 15, 14, 25, 10, 11, 13, 30, 14]
const TAT_WRAP = new Set([0, 1, 8, 12, 13])
const TAT_FIGURES = new Set([2, 3, 4, 5, 6, 7, 9, 10, 11])

// As Vehicle analytics writes them: litres to 0.1, kilometres to 0.01.
const litres = (v: number | null | undefined) => (v == null ? DASH : v.toFixed(1))
const kms = (v: number | null | undefined) => (v == null ? DASH : v.toFixed(2))
const whole = (v: number | null | undefined) => (v == null ? DASH : String(Math.round(v)))

export function tatCells(r: TatPdfRow): string[] {
  const f = r.fuel
  return [
    r.plate, tripWords(r), litres(f?.initial), litres(f?.topUps), litres(f?.total), litres(f?.consumption), litres(f?.theft), litres(f?.final),
    r.station || DASH, kms(r.km), r.rate == null ? DASH : r.rate.toFixed(2), whole(r.tankL), r.comment, r.base,
  ]
}

const several = (b: Pick<TatFuelPdfBody, 'day' | 'to'>) => b.to != null && b.to !== b.day

export const tatFileName = (b: Pick<TatFuelPdfBody, 'fleet' | 'day' | 'to'>) => `TAT and Fuel Report ${b.fleet} ${b.day}${several(b) ? ` to ${b.to}` : ''}.pdf`

/** "3 November 2026"; over several days "1 to 3 November 2026", "28 October to 3 November 2026". Pure. */
export function tatPeriodWords(from: string, to: string = from): string {
  const words = (day: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${day}T00:00:00Z`))
  if (from === to) return words(from)
  const a = words(from)
  const short = from.slice(0, 7) === to.slice(0, 7) ? a.split(' ')[0]! : from.slice(0, 4) === to.slice(0, 4) ? a.split(' ').slice(0, 2).join(' ') : a
  return `${short} to ${words(to)}`
}

/** Landscape always, for the sheet's fourteen columns. */
export async function renderTatFuelPdf(b: TatFuelPdfBody, o: { orgCode: string; now?: number }): Promise<Buffer> {
  const now = o.now ?? Date.now()
  const reportNo = templateReportNo('TF', o.orgCode, now)
  const { doc, done, w } = open(`TAT and Fuel Report ${reportNo}`, true)
  const s = tatSummary(b.rows)
  const date = (b.to ?? b.day).split('-').reverse().join('/')
  const period = tatPeriodWords(b.day, b.to)
  heading(w, doc, {
    title: 'TAT and Fuel Report', reportNo, date, fleet: b.fleet,
    info: [['Fleet', b.fleet], ['Units', b.group === 'all' ? 'All units' : b.group], [several(b) ? 'Days' : 'Day', period], ['Trips', `Finished ${several(b) ? 'on these days' : 'on the day'} (${num(s.trips)})`]],
  })
  w.h2('1. Overview', period)
  w.cells([
    ['Trips', num(s.trips)], ['Units on trips', num(s.units)], ['Fuel used, L', num(Math.round(s.litres))], ['Distance, km', num(Math.round(s.km))],
    ['Rate, km/L', s.rate == null ? DASH : s.rate.toFixed(2)], ['Not updating', num(s.notUpdating)],
  ])
  const used = TAT_WIDTHS.reduce((a, x) => a + x, 0)
  const cols: Col[] = TAT_WIDTHS.map((x, i) => ({
    w: (x * w.sheet.body) / used, ...(TAT_FIGURES.has(i) ? { align: 'right' as const } : {}), ...(TAT_WRAP.has(i) ? { wrap: true } : {}),
  }))
  const groups = new Map<string, TatPdfRow[]>()
  for (const r of b.rows) groups.set(r.group, [...(groups.get(r.group) ?? []), r])
  let k = 2
  for (const [group, rows] of groups) {
    w.room(60)
    w.h2(`${k++}. ${group}`, `${num(rows.length)} row${rows.length === 1 ? '' : 's'}`)
    w.table(cols, TAT_HEADS, rows.map(r => tatCells(r).map((text, i): Cell => ({ text, bold: i === 0 }))), { size: 6.8 })
  }
  w.y += 2 * MM
  w.note(CONTACT_LINE)
  w.footers(`${b.fleet} · TAT and Fuel Report · ${several(b) ? period : date}`)
  doc.end()
  return done
}

// ── Speed Report ─────────────────────────────────────────────────────────────

type SpeedPdfRow = SpeedPdfBody['rows'][number]

export const SPEED_HEADS = ['Registration', 'Group', 'Mileage (km)', 'Max. Speed', 'Limit', 'Exceeded By', 'Over Distance (km)', 'Occurrences']
const SPEED_WIDTHS = [50, 15, 20, 18, 15, 20, 28, 19]
const SPEED_FIGURES = new Set([2, 3, 4, 5, 6, 7])
/** The Max. Speed column, which links to where it happened. */
const PEAK_COLUMN = 3

export function speedCells(r: SpeedPdfRow): string[] {
  return [
    r.name, r.group, r.km.toFixed(2), `${Math.round(r.maxKmh)} km/h`, `${Math.round(r.limitKmh)} km/h`,
    `+${Math.round(r.overByKmh)} km/h`, r.overKm.toFixed(2), String(r.occurrences),
  ]
}

export const peakLink = (r: Pick<SpeedPdfRow, 'peak'>) => (r.peak ? `https://www.google.com/maps?q=${r.peak.lat},${r.peak.lng}` : undefined)

export function speedSummary(rows: SpeedPdfRow[]) {
  return {
    units: rows.length,
    occurrences: rows.reduce((n, r) => n + r.occurrences, 0),
    fastest: rows.reduce((m, r) => Math.max(m, r.maxKmh), 0),
    overKm: rows.reduce((n, r) => n + r.overKm, 0),
    km: rows.reduce((n, r) => n + r.km, 0),
  }
}

export const speedFileName = (b: Pick<SpeedPdfBody, 'fleet' | 'day'>) => `Speed Report ${b.fleet} ${b.day}.pdf`

export async function renderSpeedPdf(b: SpeedPdfBody, o: { orgCode: string; landscape?: boolean; now?: number }): Promise<Buffer> {
  const now = o.now ?? Date.now()
  const reportNo = templateReportNo('SP', o.orgCode, now)
  const { doc, done, w } = open(`Speed Report ${reportNo}`, Boolean(o.landscape))
  const s = speedSummary(b.rows)
  const date = b.day.split('-').reverse().join('/')
  const dayWords = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${b.day}T00:00:00Z`))
  heading(w, doc, {
    title: 'Speed Report', reportNo, date, fleet: b.fleet,
    info: [['Fleet', b.fleet], ['Units', b.group === 'all' ? 'All units' : b.group], ['Day', dayWords], ['Over the limit', `${num(s.units)} unit${s.units === 1 ? '' : 's'}`]],
  })
  w.h2('1. Overview', dayWords)
  w.cells([
    ['Units over the limit', num(s.units)], ['Occurrences', num(s.occurrences)], ['Highest speed', s.fastest ? `${Math.round(s.fastest)} km/h` : DASH],
    ['Distance over, km', num(s.overKm, 1)], ['Mileage, km', num(Math.round(s.km))],
  ])
  const used = SPEED_WIDTHS.reduce((a, x) => a + x, 0)
  const cols: Col[] = SPEED_WIDTHS.map((x, i) => ({
    w: (x * w.sheet.body) / used, ...(SPEED_FIGURES.has(i) ? { align: 'right' as const } : {}), ...(i < 2 ? { wrap: true } : {}),
  }))
  const groups = new Map<string, SpeedPdfRow[]>()
  for (const r of b.rows) groups.set(r.group, [...(groups.get(r.group) ?? []), r])
  let k = 2
  for (const [group, rows] of groups) {
    w.room(60)
    w.h2(`${k++}. ${group}`, `${num(rows.length)} unit${rows.length === 1 ? '' : 's'}`)
    w.table(cols, SPEED_HEADS, rows.map(r => speedCells(r).map((text, i): Cell => {
      const link = i === PEAK_COLUMN ? peakLink(r) : undefined
      return { text, bold: i === 0, ...(link ? { link, color: C.hd } : {}) }
    })), { size: 7.8 })
  }
  w.y += 2 * MM
  w.note(CONTACT_LINE)
  w.footers(`${b.fleet} · Speed Report · ${date}`)
  doc.end()
  return done
}
