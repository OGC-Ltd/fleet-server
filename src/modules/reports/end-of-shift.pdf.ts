// The end-of-shift report as a PDF on the RAI Group / OGC letterhead, in the
// plain ruled style the trip report and the driver scorecard share.
//
// Pure drawing: takes what end-of-shift builds and returns the file.

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
const toneColor = (t: Tone) => (t === 'c' ? C.flag : t === 'o' ? C.ink : C.mut)

/** "ES-WESTSU-20261031-1800": the organisation, the date and the minute it was made, in EAT. */
export function reportNumber(short: string, at: number): string {
  const s = new Date(at + 3 * H).toISOString()
  return `ES-${short}-${s.slice(0, 10).replace(/-/g, '')}-${s.slice(11, 16).replace(':', '')}`
}

export function endOfShiftFileName(orgName: string, at: number): string {
  const s = new Date(at + 3 * H).toISOString()
  return `End of shift report ${orgName.replace(/[^\w .-]/g, '')} ${s.slice(0, 10)} ${s.slice(11, 16).replace(':', '')}.pdf`
}

export async function renderEndOfShiftPdf(r: EndOfShift, o: { orgName: string; reportNo: string; generatedAt?: number }): Promise<Buffer> {
  const generatedAt = o.generatedAt ?? Date.now()
  const date = fmtDate.format(r.from)
  const span = `${fmtHM.format(r.from)} to ${fmtHM.format(r.to)}`
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true,
    info: { Title: `End of shift report ${o.orgName} ${date}`, Author: 'Off-Grid Consulting Ltd.' } })
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

  // ── letterhead and title ──
  w.y = drawLetterhead(doc)
  w.line('END OF SHIFT REPORT', SIDE, w.y, BODY_W / 2, { font: F.bold, size: 15 })
  w.line(`Report no. ${o.reportNo}  ·  Date ${date}`, SIDE + BODY_W / 2, w.y + 6, BODY_W / 2, { font: F.bold, size: 8, align: 'right' })
  w.y += 19
  w.hr(SIDE, SIDE + BODY_W, w.y, C.ink, 1.2)
  w.y += 2.2 * MM
  for (const [k, v] of [['Fleet', o.orgName], ['Shift', `${date}, ${span}`]] as const) {
    w.line(k, SIDE, w.y, 23 * MM, { color: C.mut })
    w.line(v, SIDE + 23 * MM, w.y, BODY_W - 23 * MM, { font: F.bold })
    w.y += 12
  }

  // ── 1. overview ──
  const theftN = r.theft.length
  w.h2('1. Overview', `${date}, ${span}`)
  w.cells([
    ['Fuel refills', `${num(r.fuel.refills)} · ${num(r.fuel.refillL)} L`],
    ['Fuel drains', `${num(r.fuel.drains.length)} · ${num(r.fuel.drainL, 1)} L`],
    ['Escalated thefts', num(theftN), theftN ? C.flag : undefined],
    ['Policy breaches', num(r.breachTotal)],
    [`Reporting since ${fmtHM.format(r.from)}`, `${num(r.fleet.reporting)} of ${num(r.fleet.units)}`],
  ])

  // ── 2. escalated thefts ──
  w.h2('2. Critical: escalated thefts', `${theftN} of ${plural(r.fuel.drains.length, 'drain')} in the shift`)
  if (!theftN) w.none('No theft escalated in the shift.')
  else {
    const cols: Col[] = [{ w: 12 * MM }, { w: 20 * MM }, { w: 32 * MM }, { w: 16 * MM, align: 'right' }, { w: 0 }, { w: 18 * MM }, { w: 32 * MM }]
    w.table(cols, ['Time', 'Unit', 'Driver', 'Lost', 'Where', 'Unit was', 'Status'], r.theft.map((d): Cell[] => [
      { text: fmtHM.format(d.t) }, { text: d.plate, bold: true }, { text: d.driver ?? 'Not recorded' },
      { text: `${num(d.litres, 1)} L`, color: C.flag, bold: true }, { text: d.place ?? DASH },
      { text: d.stationary ? 'Standing' : 'Moving' }, { text: d.status, color: toneColor(d.tone), bold: d.tone === 'c' },
    ]))
  }

  // ── 3. policy breaches ──
  w.h2('3. Policy breaches', `${num(r.breachTotal)} in the shift · top 5 units for each`)
  const noCam = (b: EndOfShift['breaches'][number]) => b.fromDashcam && !r.dashcam
  w.table(r.breaches.map(() => ({ w: 0, align: 'center' as const })), r.breaches.map((b) => b.label), [
    r.breaches.map((b) => ({ text: noCam(b) ? DASH : num(b.total), bold: true })),
    r.breaches.map((b) => ({ text: noCam(b) ? 'no dashcams' : plural(b.units, 'unit'), color: C.mut })),
  ])
  w.y += 2 * MM
  const half = (BODY_W - 6 * MM) / 2
  const top5 = (b: EndOfShift['breaches'][number], x: number) => {
    const aside = b.units ? (b.units > b.top.length ? `top ${b.top.length} of ${b.units} units` : `all ${plural(b.units, 'unit')}`) : ''
    h3(b.label, aside, x, half)
    if (!b.top.length) return w.none(noCam(b) ? 'No dashcams in this fleet.' : 'None in the shift.', x, half)
    if (b.key === 'speed') {
      w.table([{ w: 16 * MM }, { w: 0 }, { w: 17 * MM, align: 'right' }, { w: 15 * MM, align: 'right' }, { w: 16 * MM, align: 'right' }],
        ['Unit', 'Driver', 'Time over', 'Avg over', 'Top / limit'],
        b.top.map((t): Cell[] => [
          { text: t.plate, bold: true }, { text: t.driver ?? 'Not recorded' }, { text: dur((t.overSec ?? 0) * 1000), bold: true },
          { text: t.avgOver != null ? `+${num(t.avgOver)} km/h` : DASH },
          t.peak ? { text: `${num(t.peak)} / ${num(t.limit)}`, color: t.limit && t.peak - t.limit >= 30 ? C.flag : undefined } : { text: DASH },
        ]), { x, width: half, size: 7.4 })
    } else {
      w.table([{ w: 18 * MM }, { w: 0 }, { w: 13 * MM, align: 'right' }], ['Unit', 'Driver', 'Times'],
        b.top.map((t): Cell[] => [{ text: t.plate, bold: true }, { text: t.driver ?? 'Not recorded' }, { text: num(t.times), bold: true }]),
        { x, width: half, size: 7.4 })
    }
  }
  // Two kinds side by side, kept together on one page.
  for (let i = 0; i < r.breaches.length; i += 2) {
    const pair = r.breaches.slice(i, i + 2)
    const rows = Math.max(...pair.map((b) => Math.max(1, b.top.length)))
    w.room(13 + 11.2 + rows * 11.2 + 4 * MM)
    const y0 = w.y
    let yMax = y0
    pair.forEach((b, k) => {
      w.y = y0
      top5(b, SIDE + k * (half + 6 * MM))
      yMax = Math.max(yMax, w.y)
    })
    w.y = yMax + 2 * MM
  }
  if (r.dashcam) note('On phone, no seatbelt and camera covered come from the dashcams, so only units with a camera are counted.')

  // ── 4. out of geofence ──
  w.h2('4. Out of geofence', `Left a geofence since ${fmtHM.format(r.from)}`)
  if (!r.zonesKnown) w.none('No geofences are set up for this fleet.')
  else {
    const ob = r.outAndBack
    w.cells([
      ['Left and still out', num(r.outside.length), r.outside.length ? C.flag : undefined],
      ['Units out and back', num(ob.units)],
      [ob.longest ? `Longest out: ${ob.longest.plate}, from ${ob.longest.zone}` : 'Longest time out', ob.longest ? dur(ob.longest.ms) : DASH],
    ])
    w.y += 1.5 * MM
    h3('Left and still out', r.outside.length ? 'no dispatch first, then longest out' : '')
    if (!r.outside.length) w.none('No unit that left a geofence in the shift is still out.')
    else {
      w.table([{ w: 18 * MM }, { w: 27 * MM }, { w: 28 * MM }, { w: 10 * MM }, { w: 20 * MM, align: 'right' }, { w: 0 }, { w: 22 * MM }],
        ['Unit', 'Driver', 'Left', 'At', 'Out for', 'Now near', 'Dispatch'],
        r.outside.map((u): Cell[] => [
          { text: u.plate, bold: true }, { text: u.driver ?? 'Unassigned' }, { text: u.left }, { text: fmtHM.format(u.since) },
          { text: dur(u.forMs), color: u.long ? C.flag : undefined, bold: u.long },
          { text: u.silentSince ? `No signal since ${fmtHM.format(u.silentSince)}` : (u.near ?? (u.lat != null && u.lng != null ? `${u.lat.toFixed(4)}, ${u.lng.toFixed(4)}` : DASH)) },
          u.dispatch ? { text: `Tag ${u.dispatch}`, color: C.mut } : { text: 'No dispatch', color: C.flag, bold: true },
        ]), { size: 7.6 })
      note('Red: no dispatch, or out longer than 12 hours. A unit already outside at the start of the shift is not counted.')
    }
  }

  // ── 5. weighbridge ──
  const wb = r.weighbridge
  let n = 5
  if (wb) {
    w.h2(`${n++}. Weighbridge`, span)
    w.cells([['Tickets weighed', num(wb.tickets)], ['Net weighed', `${num(wb.tonnes, 1)} t`], ['Units weighed', num(wb.units)],
      ['Units with 2+ trips', num(wb.multiUnits)], ['Bridges in use', num(wb.bridges.length)]])
    w.y += 1.5 * MM
    h3('By bridge', 'net weight')
    if (!wb.bridges.length) w.none('Nothing weighed in the shift.')
    else w.table([{ w: 0 }, { w: 22 * MM, align: 'right' }, { w: 25 * MM, align: 'right' }, { w: 32 * MM, align: 'right' }],
      ['Bridge', 'Tickets', 'Net (t)', 'Busiest hour'],
      wb.bridges.map((b): Cell[] => [{ text: b.name, bold: true }, { text: num(b.tickets) }, { text: num(b.tonnes, 1) }, { text: b.busiest ?? DASH }]))
    w.y += 1.5 * MM
    h3('Units with more than one trip', wb.multi.length ? `${num(wb.multi.length)} units, most trips first` : '')
    if (!wb.multi.length) w.none('No unit was weighed more than once.')
    else w.table([{ w: 20 * MM }, { w: 42 * MM }, { w: 14 * MM, align: 'right' }, { w: 18 * MM, align: 'right' }, { w: 0 }],
      ['Unit', 'Driver', 'Trips', 'Net (t)', 'Weighed at'],
      wb.multi.map((u): Cell[] => [{ text: u.plate, bold: true }, { text: u.driver ?? 'Not recorded' }, { text: num(u.trips), bold: true },
        { text: num(u.tonnes, 1) }, { text: u.bridges.join(', ') || DASH }]))
    note('A trip here is one load weighed: the mill net when the load reached the mill, otherwise the outstation net.')
  }

  // ── products ferried ──
  w.h2(`${n++}. Products ferried`, span)
  if (!r.products.length) w.none('No load recorded in the shift.')
  else {
    const total = (f: (p: EndOfShift['products'][number]) => number) => r.products.reduce((s, p) => s + f(p), 0)
    w.table([{ w: 32 * MM }, { w: 13 * MM, align: 'right' }, { w: 12 * MM, align: 'right' }, { w: 19 * MM, align: 'right' },
      { w: 14 * MM, align: 'right' }, { w: 0 }, { w: 30 * MM }],
    ['Product', 'Loads', 'Units', 'Weight (t)', 'Bags', 'Where it went', 'Read from'],
    [...r.products.map((p): Cell[] => [{ text: p.product, bold: true }, { text: num(p.loads) }, { text: num(p.units) },
      { text: num(p.tonnes, 1), bold: true }, { text: p.bags ? num(p.bags) : DASH }, { text: p.where || DASH }, { text: p.source, color: C.mut }]),
    [{ text: 'Total', bold: true }, { text: num(total((p) => p.loads)), bold: true }, { text: '' },
      { text: num(total((p) => p.tonnes), 1), bold: true }, { text: '' }, { text: '' }, { text: '' }]])
  }
  note('Cane weights come from the weighbridge; sugar and other sales loads from the tonnage typed on each sales dispatch.')

  // ── handover ──
  w.room(4 * 9 * MM + 30 * MM)
  w.h2(`${n}. Handover to the next shift`)
  for (let i = 0; i < 4; i++) { w.y += 8 * MM; w.hr(SIDE, SIDE + BODY_W, w.y, C.rule, 0.6) }
  w.y += 16 * MM
  const sigW = (BODY_W - 12 * MM) / 2
  ;['Prepared by (outgoing operator)', 'Received by (incoming operator)'].forEach((label, k) => {
    const x = SIDE + k * (sigW + 12 * MM)
    w.hr(x, x + sigW, w.y, C.ink, 0.8)
    w.line(label, x, w.y + 2, sigW, { size: 7.4, color: C.mut })
  })
  w.y += 12

  w.footers(`${o.orgName} · End of shift report · ${date} · made ${fmtStamp.format(generatedAt)}`)
  doc.end()
  return done
}
