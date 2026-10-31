// The driver scorecard as a PDF on the RAI Group / OGC letterhead, in the
// same plain document style as the trip report (numbered sections, ruled
// tables): the fleet's pay for the period, then one section per driver with
// the pay, the violations and the day-by-day working. One driver, a chosen
// few or all of them — whichever the scorecard answer holds.
//
// Pure drawing: takes what driver-score.service answers and returns the file.

import PDFDocument from 'pdfkit'
import { MM, SIDE, BODY_W, C, F, DASH, num, drawLetterhead, ReportWriter, type Cell, type Col } from '../../lib/pdf/letterhead.js'
import { PAY_RULES, type ViolationKind } from './driver-score.rules.js'
import type { DriverScore, ScorecardAnswer } from './driver-score.service.js'

const TZ = 'Africa/Nairobi'
const fmtLong = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })
const fmtDayShort = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
const fmtHM = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
const fmtStamp = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
const dayText = (d: string) => fmtLong.format(new Date(`${d}T00:00:00Z`))

/** "KES 1,250", "−KES 150": the sign leads, as the page reads it. A hyphen: Helvetica has no Unicode minus. */
const kes = (v: number) => `${v < 0 ? '-' : ''}KES ${num(Math.abs(Math.round(v)))}`
// Helvetica has no Unicode minus, so String() keeps the plain hyphen-minus it prints.
const pts = (v: number) => (v > 0 ? `+${v}` : String(v))
const tone = (v: number) => (v < 0 ? C.flag : v > 0 ? C.good : undefined)

const VIOLATION_ORDER: ViolationKind[] = ['speeding', 'harshBrake', 'seatbelt', 'phone', 'freewheel', 'redLight', 'headlights']
const SHORT: Record<ViolationKind, string> = {
  speeding: 'Speeding >15', harshBrake: 'Harsh braking', seatbelt: 'No seat belt', phone: 'Phone use',
  freewheel: 'Free-wheeling', redLight: 'Red light', headlights: 'No headlights',
}
const FUEL_WHY: Record<string, string> = {
  'no-data': 'no probe reading', 'short-day': 'too short to rate', implausible: 'implausible reading', 'too-slow': 'below speed qualifier',
}

/** The worst standing of the period, in words, and whether it is a flag. */
export function standingText(d: DriverScore): { text: string; flag: boolean } {
  const worst = d.months.some(m => m.standing === 'termination') ? 'termination'
    : d.months.some(m => m.standing === 'suspension') ? 'suspension' : 'ok'
  if (worst === 'termination') return { text: 'Termination', flag: true }
  if (worst === 'suspension') return { text: 'Suspension', flag: true }
  if (d.tripPayDaysLost) return { text: `Trip pay lost ×${d.tripPayDaysLost}`, flag: true }
  return { text: 'Clear', flag: false }
}

/** The file name the browser saves it under. */
export function scorecardFileName(a: ScorecardAnswer): string {
  const span = a.from === a.to ? a.from : `${a.from} to ${a.to}`
  const who = a.drivers.length === 1 ? a.drivers[0]!.name : `${a.organisation || 'Drivers'}`
  return `Driver scorecard ${who} ${span}.pdf`
}

export async function renderScorecardPdf(a: ScorecardAnswer, opts: { allDrivers: boolean; generatedAt?: number }): Promise<Buffer> {
  const period = a.from === a.to ? dayText(a.from) : `${dayText(a.from)} to ${dayText(a.to)}`
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true,
    info: { Title: `Driver scorecard ${period}`, Author: 'Off-Grid Consulting Ltd.' } })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>(res => doc.on('end', () => res(Buffer.concat(chunks))))
  const w = new ReportWriter(doc)
  const drivers = a.drivers

  // ── letterhead and title ──
  w.y = drawLetterhead(doc)
  w.line('DRIVER SCORECARD', SIDE, w.y, BODY_W / 2, { font: F.bold, size: 15 })
  w.line(`Period ${period}`, SIDE + BODY_W / 2, w.y + 6, BODY_W / 2, { font: F.bold, size: 8, align: 'right' })
  w.y += 19
  w.hr(SIDE, SIDE + BODY_W, w.y, C.ink, 1.2)
  w.y += 2.2 * MM
  const info: [string, string][] = [
    ['Fleet', a.organisation || DASH],
    ['Drivers', opts.allDrivers ? `All ${drivers.length} drivers who drove in the period` : drivers.length === 1 ? drivers[0]!.name : `${drivers.length} selected drivers`],
    ['Pay basis', "Molasses truck drivers' pay structure, revised proposal v2.0"],
  ]
  for (const [k, v] of info) {
    w.line(k, SIDE, w.y, 23 * MM, { color: C.mut })
    w.line(v, SIDE + 23 * MM, w.y, BODY_W - 23 * MM, { font: F.bold })
    w.y += 12
  }

  // ── 1. summary ──
  const total = (f: (d: DriverScore) => number) => drivers.reduce((n, d) => n + f(d), 0)
  const violations = total(d => Object.values(d.violations).reduce((n, v) => n + v, 0))
  w.h2('1. Summary', period)
  w.cells([
    ['Drivers', num(drivers.length)],
    ['Driver-days', num(total(d => d.days))],
    ['Completed trips', num(total(d => d.trips))],
    ['Gross pay', kes(total(d => d.pay.gross))],
    ['Est. net (85%)', kes(total(d => d.pay.net))],
    ['Safety violations', num(violations), violations ? C.flag : undefined],
  ])
  w.cells([
    ['Retainer', kes(total(d => d.pay.retainer))],
    ['Trip-wise pay', kes(total(d => d.pay.tripPay))],
    ['Lunch', kes(total(d => d.pay.lunch))],
    ['Fuel incentive', kes(total(d => d.pay.fuelKes)), tone(total(d => d.pay.fuelKes))],
    ['Speed incentive', kes(total(d => d.pay.speedKes)), tone(total(d => d.pay.speedKes))],
    ['Safety penalties', kes(total(d => d.pay.safetyKes)), tone(total(d => d.pay.safetyKes))],
  ])

  // ── 2. pay by driver ──
  w.h2('2. Pay by driver', 'KES, for the period')
  if (!drivers.length) w.none('No assigned driver drove in this period.')
  else {
    const cols: Col[] = [{ w: 0 }, { w: 10 * MM, align: 'right' }, { w: 10 * MM, align: 'right' }, { w: 16 * MM, align: 'right' },
      { w: 12 * MM, align: 'right' }, { w: 13 * MM, align: 'right' }, { w: 13 * MM, align: 'right' }, { w: 14 * MM, align: 'right' },
      { w: 18 * MM, align: 'right' }, { w: 18 * MM, align: 'right' }, { w: 24 * MM }]
    const row = (d: DriverScore): Cell[] => {
      const st = standingText(d)
      return [{ text: d.name, bold: true }, { text: num(d.days) }, { text: num(d.trips) }, { text: num(d.pay.tripPay) },
        { text: num(d.pay.lunch) }, { text: num(d.pay.fuelKes), color: tone(d.pay.fuelKes) }, { text: num(d.pay.speedKes), color: tone(d.pay.speedKes) },
        { text: num(d.pay.safetyKes), color: tone(d.pay.safetyKes) }, { text: num(d.pay.gross), bold: true }, { text: num(d.pay.net) },
        { text: st.text, color: st.flag ? C.flag : C.good, bold: st.flag }]
    }
    w.table(cols, ['Driver', 'Days', 'Trips', 'Trip pay', 'Lunch', 'Fuel', 'Speed', 'Safety', 'Gross', 'Est. net', 'Standing'],
      [...drivers.map(row), [{ text: 'Total', bold: true }, { text: num(total(d => d.days)) }, { text: num(total(d => d.trips)) },
        { text: num(total(d => d.pay.tripPay)) }, { text: num(total(d => d.pay.lunch)) }, { text: num(total(d => d.pay.fuelKes)) },
        { text: num(total(d => d.pay.speedKes)) }, { text: num(total(d => d.pay.safetyKes)) }, { text: num(total(d => d.pay.gross)), bold: true },
        { text: num(total(d => d.pay.net)), bold: true }, { text: '' }]], { size: 7.4 })
    w.more('Gross includes the retainer for the period and any 1-day suspension; the retainer is the same for every driver and is shown on each driver\'s page.')
  }

  // ── 3. how it is worked out ──
  const R = PAY_RULES
  w.h2('3. How the pay is worked out')
  w.note([
    `Retainer KES ${num(R.retainerMonthly)} a month, pro-rated by calendar day. Trip-wise pay per completed trip by route `
      + `(${R.trip.routes.map(r => `${r.name.replace(' to Distillery', '')} ${num(Math.round(R.trip.dailyTarget / (R.trip.shiftHours / r.tatHours)))}`).join(', ')}), `
      + `and KES ${R.lunchPerDay} lunch on a day with at least one completed trip.`,
    `Fuel: over 2.0 km/L +5, 1.80–1.99 +3, below 1.80 -3 points at KES ${R.fuel.kesPerPoint}; the bonus needs an average speed of ${R.fuel.minAvgKmh.other} km/h (${R.fuel.minAvgKmh.kabras} on the Kabras route).`,
    `Speed: +${R.speed.compliantPoints} a day within the limit plus a ${R.speed.bufferKmh} km/h buffer; 4–10 km/h over -3, -5, -10 by offence of the day; over 10 km/h -15; at KES ${R.speed.kesPerPoint} a point.`,
    `Safety: each violation's points at KES ${R.safety.kesPerPoint} (speeding over 15 km/h -10, phone -5, free-wheeling -5, seat belt -3, harsh braking -3). A day's positive points stop at +${R.dailyPositiveCap} and its safety points at ${R.safety.dailyFloor}.`,
    `Zero tolerance: ${R.zeroTolerance.tripPayDay} violations in a day, or a 3rd 4–10 km/h offence, lose that day's trip-wise pay; ${R.zeroTolerance.suspendMonth} in a month is a 1-day suspension without pay (KES ${num(R.retainerMonthly / R.workingDaysPerMonth)}); ${R.zeroTolerance.terminateMonth} is termination. Violations are counted from the first of the month.`,
    `Estimated net is ${Math.round((1 - R.netDeduction) * 100)}% of gross.`,
  ].join('\n'))
  w.note(`Not scored here: ${a.manual.join('; ')}.`)
  const cov = a.coverage
  const gaps = [
    cov.unattributed.trips ? `${num(cov.unattributed.trips)} completed trips` : null,
    cov.unattributed.overspeed ? `${num(cov.unattributed.overspeed)} speeding incidents` : null,
    cov.unattributed.harshBrake ? `${num(cov.unattributed.harshBrake)} harsh-braking events` : null,
    cov.unattributed.dashcam ? `${num(cov.unattributed.dashcam)} dashcam alarms` : null,
  ].filter(Boolean)
  if (gaps.length) w.note(`On vehicles with no assigned driver at the time, so not paid or charged to anyone: ${gaps.join(', ')}.`)
  if (cov.dashcam.note) w.note(cov.dashcam.note)

  // ── 4. one section per driver ──
  drivers.forEach((d, i) => {
    doc.addPage({ size: 'A4', margin: 0 })
    w.y = 12 * MM
    const st = standingText(d)
    const plates = [...new Set(d.byDay.flatMap(x => x.plates))].filter(p => p !== '?')
    w.h2(`4.${i + 1}  ${d.name}`, `${plates.join(', ') || 'No vehicle recorded'} · ${st.text}`)
    w.cells([
      ['Retainer', kes(d.pay.retainer)],
      ['Trip-wise pay', kes(d.pay.tripPay)],
      ['Lunch', kes(d.pay.lunch)],
      ['Fuel', kes(d.pay.fuelKes), tone(d.pay.fuelKes)],
      ['Speed', kes(d.pay.speedKes), tone(d.pay.speedKes)],
      ['Safety', kes(d.pay.safetyKes), tone(d.pay.safetyKes)],
    ])
    w.cells([
      ['Days · trips', `${num(d.days)} · ${num(d.trips)}`],
      ['Average km/L', d.kmpl != null ? `${num(d.kmpl, 2)} (${d.fuelDays} d)` : DASH],
      ['Trip pay lost', d.pay.tripPayLost ? kes(-d.pay.tripPayLost) : DASH, d.pay.tripPayLost ? C.flag : undefined],
      ['Suspension', d.pay.suspension ? kes(d.pay.suspension) : DASH, d.pay.suspension ? C.flag : undefined],
      ['Gross pay', kes(d.pay.gross)],
      ['Est. net (85%)', kes(d.pay.net)],
    ])
    if (d.unpricedTrips) w.more(`${d.unpricedTrips} of the trips ran a route the pay table does not name, so carry no trip-wise pay.`, SIDE, BODY_W, C.flag)

    w.h2('Violations', d.months.map(m => `${m.month}: ${m.violations} this month, ${m.standing === 'ok' ? 'clear' : m.standing}`).join(' · '))
    w.cells(VIOLATION_ORDER.filter(k => PAY_RULES.safety.violations[k].detectable)
      .map(k => [SHORT[k], num(d.violations[k]), d.violations[k] ? C.flag : undefined] as [string, string, string | undefined]))

    w.h2('Day by day')
    w.table(
      [{ w: 21 * MM }, { w: 0 }, { w: 11 * MM, align: 'right' }, { w: 15 * MM, align: 'right' }, { w: 13 * MM, align: 'right' },
       { w: 10 * MM, align: 'right' }, { w: 11 * MM, align: 'right' }, { w: 11 * MM, align: 'right' }, { w: 10 * MM, align: 'right' }, { w: 34 * MM }],
      ['Day', 'Vehicles', 'Trips', 'Trip pay', 'km/L', 'Fuel', 'Speed', 'Safety', 'Viol.', 'Note'],
      d.byDay.map(x => [
        { text: fmtDayShort.format(new Date(`${x.day}T00:00:00Z`)) }, { text: x.plates.filter(p => p !== '?').join(', ') || DASH },
        { text: num(x.trips) }, { text: x.losesTripPay ? `0 (${num(x.tripPayEarned)})` : num(x.tripPay), color: x.losesTripPay ? C.flag : undefined },
        { text: x.fuel.kmpl != null ? num(x.fuel.kmpl, 2) : DASH }, { text: pts(x.fuel.points), color: tone(x.fuel.points) },
        { text: pts(x.speedPoints), color: tone(x.speedPoints) }, { text: pts(x.safetyPoints), color: tone(x.safetyPoints) },
        { text: num(x.violations), color: x.violations ? C.flag : undefined },
        { text: x.losesTripPay ? (x.tripPayLostFor === 'violations' ? 'Trip pay lost: 3+ violations' : 'Trip pay lost: 3rd speed offence')
            : x.fuel.why ? `Fuel: ${FUEL_WHY[x.fuel.why]}` : '', color: x.losesTripPay ? C.flag : C.mut },
      ]), { size: 7.4 })

    const events = d.byDay.flatMap(x => x.events)
    if (events.length) {
      w.h2('Speeding and safety events')
      w.table([{ w: 30 * MM }, { w: 22 * MM }, { w: 0 }, { w: 22 * MM, align: 'right' }, { w: 16 * MM, align: 'right' }],
        ['When', 'Vehicle', 'Event', 'Measured', 'Points'],
        events.map(e => [
          { text: `${fmtDayShort.format(new Date(e.at))} ${fmtHM.format(new Date(e.at))}` }, { text: e.plate ?? DASH },
          { text: e.kind === 'overspeed' ? 'Over the speed limit' : PAY_RULES.safety.violations[e.kind].label },
          { text: e.value == null ? '' : e.kind === 'harshBrake' ? `${num(e.value, 1)} m/s²` : `+${num(e.value)} km/h` },
          { text: pts(e.points), color: tone(e.points) },
        ]), { size: 7.4 })
    }
  })

  w.footers(`Generated ${fmtStamp.format(opts.generatedAt ?? Date.now())}`)
  doc.end()
  return done
}
