/**
 * Reading a Wialon Logistics itinerary (Planner, operator 2026-11-11): the
 * route a dispatcher planned in Wialon for one truck, exported to .xlsx.
 *
 *   Generated: 08:48
 *   Itinerary "VS - Menengai - KDE 268P"           ← the truck is the last part
 *   11.11.2026 05:34 — 12.11.2026 11:20            ← the planned run
 *   # | Order | Address | Estimated arrival | Fact | Delivery interval | Estimated mileage | Estimated service time | Weight, kg | Volume | Cost | Phone | Client | Comment | …
 *   1 | MORL  | -0.288, 36.044 | 05:34 | | 04:00 — 23:00 | 0 m   | 30 min   ← home, left out of the stops
 *   2 | SHOP  | -0.143, 35.683 | 07:13 | | 04:00 — 22:00 | 49.4 km |       …
 *   …
 *  19 | MORL  | -0.288, 36.044 | 12.11.2026 11:20 | …          ← back home
 *
 * It names no customer ID, invoice or driver: a stop is kept by its name
 * (`WL:` + the name), and each keeps its planned arrival, window, service time
 * and leg so the page can set them against what the truck did. Times are read
 * as Nairobi time (+03:00); an arrival without a date is on the run's first
 * day, as Wialon writes the date only once it changes. Pure: no database, no clock.
 */
import type { DeliverySheet, SheetHeader, SheetProblem, SheetStop } from './sheet.js'

export interface PlannedStop {
  /** Planned arrival, ISO +03:00. */
  at: string | null
  /** The delivery window, HH:MM. */
  windowFrom: string | null
  windowTo: string | null
  /** Planned time at the stop. */
  serviceMin: number | null
  /** Planned km from the stop before. */
  legKm: number | null
}

export interface ItineraryRoute {
  /** The itinerary's name, as Wialon writes it in quotes. */
  name: string
  start: string | null
  end: string | null
  /** Every leg, the return home included. */
  km: number | null
  home: { name: string, lat: number, lng: number } | null
}

const text = (v: unknown) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim()
const key = (v: unknown) => text(v).toUpperCase().replace(/[^A-Z0-9]/g, '')

const COLUMNS: Record<string, string> = {
  ORDER: 'name', ADDRESS: 'address', ESTIMATEDARRIVAL: 'arrival', DELIVERYINTERVAL: 'window',
  ESTIMATEDMILEAGE: 'mileage', ESTIMATEDSERVICETIME: 'service', WEIGHTKG: 'weight', COST: 'cost',
  CLIENT: 'client', COMMENT: 'comment',
}

/** Its heading row: one with Order and Estimated arrival. */
export function itineraryHeadingAt(rows: unknown[][]): number {
  return rows.findIndex((r) => {
    const ks = (r ?? []).map(key)
    return ks.includes('ORDER') && ks.includes('ESTIMATEDARRIVAL')
  })
}

const p2 = (x: string) => x.padStart(2, '0')

/** "11.11.2026 05:34" → ISO +03:00; "07:13" → on `day`. */
export function readWhen(v: unknown, day: string | null): string | null {
  const s = text(v)
  let m = /(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/.exec(s)
  if (m) return `${m[3]}-${p2(m[2])}-${p2(m[1])}T${p2(m[4])}:${m[5]}:00+03:00`
  m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (m && day) return `${day}T${p2(m[1])}:${m[2]}:00+03:00`
  return null
}

/** "49.4 km" / "426 m" → km. */
export function readKm(v: unknown): number | null {
  const m = /(-?\d+(?:[.,]\d+)?)\s*(km|m)\b/i.exec(text(v))
  if (!m) return null
  const n = Number(m[1].replace(',', '.'))
  return m[2].toLowerCase() === 'km' ? n : n / 1000
}

/** "30 min" / "1 h 30 min" → minutes. */
export function readMinutes(v: unknown): number | null {
  const s = text(v)
  const h = /(\d+)\s*h/i.exec(s)
  const mi = /(\d+)\s*min/i.exec(s)
  if (!h && !mi) return null
  return (h ? Number(h[1]) * 60 : 0) + (mi ? Number(mi[1]) : 0)
}

/**
 * An Address cell: "-0.288, 36.044", or "BUSIA (0.465675, 34.1008417)" with
 * the place written before the point in brackets.
 */
export function readAddress(v: unknown): { place: string, p: { lat: number, lng: number } | null } {
  const s = text(v)
  const bracketed = /^(.*?)\(\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*\)\s*$/.exec(s)
  if (bracketed) return { place: bracketed[1].trim(), p: { lat: Number(bracketed[2]), lng: Number(bracketed[3]) } }
  const nums = s.match(/-?\d+(?:\.\d+)?/g)
  if (!nums || nums.length !== 2) return { place: '', p: null }
  return { place: '', p: { lat: Number(nums[0]), lng: Number(nums[1]) } }
}

/**
 * The truck in an itinerary's name: "VS - Menengai - KDE 268P", or
 * "VS - Menengai - KCS 078M - 2026-11-10 13:03" where a date follows it.
 * The last part with letters and digits that is not a date.
 */
export function plateOfRoute(name: string): string {
  const parts = name.split(/\s+-\s+/).map((x) => x.trim())
  for (let i = parts.length - 1; i >= 0; i--) {
    const x = parts[i]
    if (/^\d{4}-\d{1,2}-\d{1,2}/.test(x) || /^\d{1,2}[./]\d{1,2}[./]\d{4}/.test(x)) continue
    if (/[A-Z]/i.test(x) && /\d/.test(x)) return x
  }
  return parts[parts.length - 1] ?? ''
}

const metres = (a: { lat: number, lng: number }, b: { lat: number, lng: number }) => {
  const rad = Math.PI / 180
  const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** The customer key a named stop is kept by. */
export const itineraryCode = (name: string) => `WL:${text(name).toUpperCase()}`.slice(0, 120)

export function readItinerary(rows: unknown[][], headingAt: number): DeliverySheet & { route: ItineraryRoute } {
  const problems: SheetProblem[] = []
  const header: SheetHeader = { plate: '', planDate: null, sheetAt: null, driverName: '', gatePass: '', tillNo: '' }
  const route: ItineraryRoute = { name: '', start: null, end: null, km: null, home: null }

  for (let r = 0; r < headingAt; r++) {
    for (const cell of rows[r] ?? []) {
      const s = text(cell)
      const named = /Itinerary\s*["“”']([^"“”']+)["“”']/i.exec(s)
      if (named) {
        route.name = named[1].trim()
        header.plate = plateOfRoute(route.name)
        continue
      }
      const span = s.match(/\d{1,2}\.\d{1,2}\.\d{4}\s+\d{1,2}:\d{2}/g)
      if (span && span.length >= 1 && !route.start) {
        route.start = readWhen(span[0], null)
        // The end with its own date, else a bare time on the start's day ("10.11.2026 06:00 — 06:06")
        const endTime = /[—–-]\s*(\d{1,2}:\d{2})\s*$/.exec(s)
        route.end = span[1] ? readWhen(span[1], null)
          : endTime && route.start ? readWhen(endTime[1], route.start.slice(0, 10)) : null
      }
    }
  }
  if (route.start) {
    header.planDate = route.start.slice(0, 10)
    header.sheetAt = route.start
  }

  const cols: Record<string, number> = {}
  ;(rows[headingAt] ?? []).forEach((cell, c) => {
    const f = COLUMNS[key(cell)]
    if (f && cols[f] == null) cols[f] = c
  })
  const at = (row: unknown[], f: string) => (cols[f] == null ? null : row[cols[f]])

  interface Line { row: number, name: string, client: string, place: string, p: { lat: number, lng: number } | null, planned: PlannedStop, weight: number | null, cost: number | null, comment: string }
  const lines: Line[] = []
  for (let r = headingAt + 1; r < rows.length; r++) {
    const row = rows[r] ?? []
    const name = text(at(row, 'name')) || text(at(row, 'client'))
    if (!name) continue
    const win = text(at(row, 'window')).match(/\d{1,2}:\d{2}/g) ?? []
    const weight = Number(text(at(row, 'weight')).replace(/[^0-9.]/g, ''))
    const cost = Number(text(at(row, 'cost')).replace(/[^0-9.]/g, ''))
    lines.push({
      row: r + 1, name, client: text(at(row, 'client')), ...readAddress(at(row, 'address')),
      planned: {
        at: readWhen(at(row, 'arrival'), header.planDate),
        windowFrom: win[0] ? win[0].padStart(5, '0') : null,
        windowTo: win[1] ? win[1].padStart(5, '0') : null,
        serviceMin: readMinutes(at(row, 'service')),
        legKm: readKm(at(row, 'mileage')),
      },
      weight: weight > 0 ? weight : null,
      cost: cost > 0 ? cost : null,
      comment: text(at(row, 'comment')),
    })
  }

  // Home: the first line, and the last too when it comes back to it
  let body = lines
  if (lines.length >= 2) {
    const first = lines[0]
    const last = lines[lines.length - 1]
    if (first.p) route.home = { name: first.name, ...first.p }
    const back = last.name === first.name || (first.p && last.p && metres(first.p, last.p) < 300)
    body = lines.slice(1, back ? -1 : undefined)
  }
  const kms = lines.map((l) => l.planned.legKm).filter((x): x is number => x != null)
  route.km = kms.length ? Math.round(kms.reduce((a, b) => a + b, 0) * 10) / 10 : null

  const stops: SheetStop[] = body.map((l, i) => {
    let p = l.p
    if (!p || (p.lat === 0 && p.lng === 0)) {
      problems.push({ row: l.row, message: `${l.name}: no coordinates.` })
      p = null
    }
    return {
      sequence: i + 1, rep: '', customerCode: itineraryCode(l.name), customerName: l.name,
      location: l.place, lat: p?.lat ?? null, lng: p?.lng ?? null, invoiceNo: '',
      amount: l.cost, tonnage: l.weight != null ? Math.round(l.weight) / 1000 : null,
      outcome: null, remarks: l.comment, row: l.row, planned: l.planned,
    }
  })
  if (!stops.length) problems.push({ row: null, message: 'The itinerary lists no stops.' })
  if (!header.plate) problems.push({ row: null, message: 'No itinerary name with a truck on the sheet.' })
  if (!header.planDate) problems.push({ row: null, message: 'No planned run dates on the sheet.' })
  return { header, stops, problems, route }
}
