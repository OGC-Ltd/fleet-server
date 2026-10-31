// One trip (a dispatch, a trip cut from a day, or a whole day) as a report:
// the measured ingredients from trip-report.service shaped into what
// trip-report.pdf lays out on the letterhead. Pure, so it is tested on its own.
// Moved here from the dashboard (new-ui lib/tripReport) so the report is made
// on the server; the figures are computed exactly as they were there.
//
// Everything is worked out from the unit's own fixes. Distance only counts
// segments the unit was actually moving on, so GPS jitter in a parked truck is
// not mileage; a stop is a run of standing segments of 5 minutes or more; and
// where a figure cannot be measured (no probe, no destination point, no
// camera) it is null and the page prints a dash or says why.

import { haversineM, type Point } from '../../lib/dispatch-trip.js'
import type { getTripReportData } from './trip-report.service.js'

export type ReportInput = Awaited<ReturnType<typeof getTripReportData>>

/**
 * The driver's conduct during the trip, in print order (operator, 2026-10-29;
 * the trip, not the whole day, since 2026-10-30). Escalated fuel theft is a
 * theft case confirmed on review.
 */
export const BREACH_KINDS = [
  { key: 'theft', label: 'Escalated fuel theft' },
  { key: 'brake', label: 'Harsh braking' },
  { key: 'speed', label: 'Overspeeding' },
  { key: 'accel', label: 'Harsh acceleration' },
] as const

/** Driver-camera alarms, added to the conduct table only for a unit with a dashcam. */
export const DASHCAM_KINDS = [
  { key: 'seatbelt', label: 'No seat belt' },
  { key: 'phone', label: 'Phone use while driving' },
  { key: 'hands', label: 'Hands off the wheel' },
] as const

const YARD_RADIUS_M = 800
const arrivalRadiusM = (spreadM: number | null | undefined) => Math.min(Math.max((spreadM ?? 0) * 2, 800), 3000)
/** Below this a segment is standing: walking pace, or drift under 40 m. */
const MOVING_KMH = 3
const MOVING_MIN_M = 40
/** A stop that wanders further than this from where it began has become driving. */
const STOP_DRIFT_M = 200
const STOP_MIN_MS = 5 * 60_000
/** An unexplained stop this long is flagged on the page. */
const LONG_STOP_MS = 30 * 60_000
/** A reported speed above this is a bad fix, not a truck. */
const MAX_PLAUSIBLE_KMH = 160

const ROWS = { stops: 8, fuel: 6, breaches: 6, geo: 8, weighings: 8 }
/** Leaving a place is measured at this multiple of its arrival radius, so GPS
 *  jitter on the boundary cannot read as a string of departures and arrivals. */
const EXIT_FACTOR = 1.25
const ROUTE_POINTS = 600

/** [t, lat, lng, speedKmh, ignition 1/0/null] */
type Fix = [number, number, number, number | null, number | null]
type Pos = { lat: number | null; lng: number | null }

const pt = (lat: number, lng: number): Point => ({ lat, lng })

function thin<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows
  const step = rows.length / max
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(rows[Math.floor(i * step)]!)
  out[out.length - 1] = rows[rows.length - 1]!
  return out
}

interface Segment { i: number; t0: number; t1: number; dt: number; m: number; moving: boolean; idle: boolean }

/** Segment by segment: moving or standing, how far, how long, engine on throughout. */
function segments(track: Fix[]): Segment[] {
  const segs: Segment[] = []
  for (let i = 1; i < track.length; i++) {
    const [t0, lat0, lng0, , ign0] = track[i - 1]!
    const [t1, lat1, lng1, , ign1] = track[i]!
    const dt = t1 - t0
    if (dt <= 0) continue
    const m = haversineM(pt(lat0, lng0), pt(lat1, lng1))
    const kmh = (m / 1000) / (dt / 3_600_000)
    segs.push({ i, t0, t1, dt, m, moving: m >= MOVING_MIN_M && kmh >= MOVING_KMH, idle: ign0 === 1 && ign1 === 1 })
  }
  return segs
}

interface RawStop { t: number; endT: number; ms: number; idleMs: number; lat: number; lng: number }

function findStops(track: Fix[], segs: Segment[]): RawStop[] {
  const stops: RawStop[] = []
  let cur: RawStop | null = null
  const close = () => {
    if (cur && cur.ms >= STOP_MIN_MS) stops.push(cur)
    cur = null
  }
  for (const s of segs) {
    if (s.moving) { close(); continue }
    const [, lat, lng] = track[s.i - 1]!
    if (cur && haversineM(cur, pt(track[s.i]![1], track[s.i]![2])) > STOP_DRIFT_M) close()
    if (!cur) cur = { t: s.t0, endT: s.t1, ms: 0, idleMs: 0, lat, lng }
    const c: RawStop = cur
    c.endT = s.t1
    c.ms += s.dt
    if (s.idle) c.idleMs += s.dt
  }
  close()
  return stops
}

type At = 'yard' | 'dest' | 'zone' | null

/** What to call a point at a moment: the yard, the destination, the zone it was in, or nothing. */
function placer(d: ReportInput) {
  const visits = d.zones?.visits ?? []
  const dest = d.dest
  return (t: number | null, lat: number | null, lng: number | null): { place: string | null; at: At } => {
    if (lat != null && lng != null) {
      if (d.yard && haversineM(d.yard, pt(lat, lng)) <= YARD_RADIUS_M) return { place: d.yard.name ?? 'Yard', at: 'yard' }
      if (dest && haversineM(dest, pt(lat, lng)) <= arrivalRadiusM(dest.spreadM)) return { place: dest.name, at: 'dest' }
    }
    if (t != null) {
      const v = visits.find(z => t >= z.enteredAt && t <= z.leftAt)
      if (v) return { place: v.name, at: 'zone' }
    }
    return { place: null, at: null }
  }
}

/** The track position nearest a moment, for events that carry no coordinates. */
function positionAt(track: Fix[], t: number | null): Pos {
  if (!track.length || t == null) return { lat: null, lng: null }
  let lo = 0, hi = track.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (track[mid]![0] < t) lo = mid + 1; else hi = mid
  }
  const best = lo > 0 && Math.abs(track[lo - 1]![0] - t) < Math.abs(track[lo]![0] - t) ? lo - 1 : lo
  return Math.abs(track[best]![0] - t) <= 10 * 60_000 ? { lat: track[best]![1], lng: track[best]![2] } : { lat: null, lng: null }
}

/** Every crossing of a place's edge along a track, debounced by EXIT_FACTOR. */
function crossings(track: [number, number, number, ...unknown[]][], c: Point, r: number) {
  const out: { t: number; arrive: boolean }[] = []
  let inside: boolean | null = null
  for (const [t, lat, lng] of track) {
    const m = haversineM(c, pt(lat, lng))
    const now: boolean = inside ? m <= r * EXIT_FACTOR : m <= r
    if (inside != null && now !== inside) out.push({ t, arrive: now })
    inside = now
  }
  return out
}

export interface Mark { t: number; label: string; zone: string | null; flag: boolean }

/**
 * The round trip as four moments (operator, 2026-10-29): left the yard,
 * arrived at the destination, left the destination, got back to the yard. A
 * departure is the first fix outside the place, an arrival the first fix
 * inside it. Read from the leg track, which reaches 12 h before the dispatch
 * and 24 h after it, because a dispatch is often raised once the truck is
 * already out and closed before it is home.
 */
function milestones(d: ReportInput, track: Fix[], w: { from: number; to: number }): Mark[] {
  const leg = (d.legTrack?.length ? d.legTrack : track) as [number, number, number][]
  const Y = d.yard ? crossings(leg, d.yard, YARD_RADIUS_M) : []
  const D = d.dest ? crossings(leg, d.dest, arrivalRadiusM(d.dest.spreadM)) : []
  const yardName = d.yard?.name ?? 'Yard', destName = d.dest?.name ?? 'Destination'
  const rows: Omit<Mark, 'flag'>[] = []
  // Arrival at the destination: the first one inside the trip window.
  const destIn = D.find(x => x.arrive && x.t >= w.from && x.t <= w.to)
  // Left the yard: the last departure before that arrival (or before the trip ends).
  const limit = destIn?.t ?? w.to
  const yardOut = [...Y].reverse().find(x => !x.arrive && x.t <= limit && x.t >= w.from - 12 * 3_600_000)
  if (yardOut) rows.push({ t: yardOut.t, label: 'Departure', zone: yardName })
  if (destIn) rows.push({ t: destIn.t, label: 'Arrival', zone: destName })
  const destOut = destIn && D.find(x => !x.arrive && x.t > destIn.t)
  if (destOut) rows.push({ t: destOut.t, label: 'Departure', zone: destName })
  const after = destOut ? destOut.t : (destIn ? null : yardOut?.t ?? null)
  const yardIn = after != null && Y.find(x => x.arrive && x.t > after)
  if (yardIn) rows.push({ t: yardIn.t, label: 'Arrival', zone: yardName })
  return rows.map(x => ({ ...x, flag: false }))
}

const capped = <T>(rows: T[], n: number) => ({ rows: rows.slice(0, n), more: Math.max(0, rows.length - n) })
const byTime = (a: { t: number }, b: { t: number }) => a.t - b.t
const round1 = (v: number) => Math.round(v * 10) / 10

const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' })
const HM_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', hour12: false })

function reportNumber(d: ReportInput) {
  const prefix = d.mode === 'day' ? 'DR' : 'TR'
  const day = DAY_FMT.format(d.dispatch.dispatchedAt).replace(/-/g, '')
  const hm = HM_FMT.format(d.dispatch.dispatchedAt).replace(':', '')
  return `${prefix}-${String(d.vehicle.plate).replace(/\s+/g, '')}-${day}-${hm}`
}

/** How far before the gate sign-out the yard exit may be and still be the departure. */
const DEPARTURE_LEAD_MS = 30 * 60_000
/** How long before departure the loading ticket may have been weighed. */
const LOADING_BEFORE_MS = 6 * 3_600_000

export interface TripWindow { from: number; to: number; arrived: boolean; clipped: boolean }

/**
 * The trip, start to end. It starts at the departure: the gate sign-out, or
 * the yard exit when the truck crossed the yard edge shortly before the
 * sign-out was recorded, so the geofence departure and the header can never
 * disagree. It ends on arrival at the destination (first fix inside it), or
 * at the end of the window when the truck has not arrived.
 */
export function tripWindow(d: ReportInput, marks: Mark[]): TripWindow {
  const signedOut = d.dispatch?.dispatchedAt ?? d.window.from
  const yardOut = marks.find(m => m.label === 'Departure' && m.zone === (d.yard?.name ?? 'Yard'))
  const from = yardOut && yardOut.t < signedOut && signedOut - yardOut.t <= DEPARTURE_LEAD_MS ? yardOut.t : signedOut
  const destIn = marks.find(m => m.label === 'Arrival' && m.zone === (d.dest?.name ?? 'Destination') && m.t > from)
  // The server's own arrival time is the fallback when the track shows no crossing.
  const arrivedAt = destIn?.t ?? (d.arrivedAt != null && d.arrivedAt > from ? d.arrivedAt : null)
  const to = arrivedAt != null ? Math.min(arrivedAt, d.window.to) : d.window.to
  return { from, to, arrived: arrivedAt != null, clipped: !!d.window.clipped }
}

type Ticket = ReportInput['weighments'][number]

/**
 * The tickets that belong to the trip: every ticket weighed during it, and the
 * loading ticket, the last one weighed before departure (up to 6 h before),
 * which is the load the truck is carrying. Earlier trips' tickets are left out.
 */
export function tripTickets(weighments: Ticket[], w: { from: number; to: number }): Ticket[] {
  const lastAt = (tk: Ticket) => Math.max(tk.tokenAt ?? 0, ...(tk.weighings ?? []).filter(x => !x.doubtful).map(x => x.at))
  const during = weighments.filter(tk => (tk.weighings ?? []).some(x => !x.doubtful && x.at >= w.from && x.at <= w.to))
  const loading = weighments
    .filter(tk => !during.includes(tk) && lastAt(tk) <= w.from && lastAt(tk) >= w.from - LOADING_BEFORE_MS)
    .sort((a, b) => lastAt(b) - lastAt(a))[0]
  return [...(loading ? [loading] : []), ...during].sort((a, b) => a.tokenAt - b.tokenAt)
}

export function buildTripReport(d: ReportInput) {
  const fullTrack = ((d.track ?? []) as Fix[]).filter(p => Number.isFinite(p[1]) && Number.isFinite(p[2]))
  // The yard / destination crossings, read on everything the server sent.
  const marks = milestones(d, fullTrack, d.window)
  // ONE window for the whole report: departure to arrival (operator,
  // 2026-10-30: "everything in the trip report should be within the trip
  // timeline"). Every section below reads only what falls inside it.
  const w = tripWindow(d, marks)
  const inTrip = (t: number | null | undefined): t is number => t != null && t >= w.from && t <= w.to
  const track = fullTrack.filter(p => inTrip(p[0]))
  const segs = segments(track)
  const where = placer(d)

  // ── summary ──
  const moving = segs.filter(s => s.moving)
  const distanceM = moving.reduce((a, s) => a + s.m, 0)
  const movingMs = moving.reduce((a, s) => a + s.dt, 0)
  const durationMs = w.to - w.from
  const idleMs = segs.filter(s => !s.moving && s.idle).reduce((a, s) => a + s.dt, 0)
  const speeds = track.map(p => p[3]).filter((v): v is number => v != null && Number.isFinite(v) && v <= MAX_PLAUSIBLE_KMH)
  const hasIgnition = track.some(p => p[4] != null)

  // ── fuel ──
  const F0 = d.fuel
  const fillings = (F0.fillings ?? []).filter(x => inTrip(x.t))
  const drains = (F0.drains ?? []).filter(x => inTrip(x.t))
  // A counter reading covers the server's whole window, not the trip.
  const usedByCounterL = w.to === d.window?.to && w.from === d.window?.from ? F0.usedByCounterL ?? null : null
  const series = ((F0.series ?? []) as [number, number][]).filter(p => inTrip(p[0]))
  const startL = F0.hasProbe && series.length ? series[0]![1] : null
  const endL = F0.hasProbe && series.length ? series[series.length - 1]![1] : null
  const counted = (x: { review?: string | null }) => x.review !== 'NOT_THEFT' && x.review !== 'PROBE_FAULT' && x.review !== 'DISMISSED'
  const filledL = fillings.reduce((a, x) => a + (x.litres ?? 0), 0)
  const drainL = drains.filter(counted).reduce((a, x) => a + (x.litres ?? 0), 0)
  let fuelUsedL = usedByCounterL ?? null
  if (fuelUsedL == null && startL != null && endL != null) {
    const v = startL - endL + filledL - drainL
    fuelUsedL = v >= 0 ? round1(v) : null
  }
  const located = (x: { t: number; place?: string | null; lat?: number | null; lng?: number | null }) => {
    const p: Pos = x.lat != null ? { lat: x.lat, lng: x.lng ?? null } : positionAt(track, x.t)
    return { ...p, place: x.place || where(x.t, p.lat, p.lng).place }
  }
  const drainLabel = (r: string | null | undefined) => (r === 'CONFIRMED_THEFT' ? 'Confirmed theft' : r === 'NOT_THEFT' ? 'Drop, cleared' : r === 'PROBE_FAULT' ? 'Probe fault' : 'Suspected theft')
  const fuelRows = [
    ...fillings.map(x => ({ t: x.t, kind: 'refill' as const, label: 'Refill', litres: x.litres, after: x.after, flag: false, ...located(x) })),
    ...drains.map(x => ({ t: x.t, kind: 'drain' as const, label: drainLabel(x.review), litres: x.litres, after: x.after, flag: counted(x), ...located(x) })),
  ].sort(byTime)
  const fuelCap = capped(fuelRows, ROWS.fuel)

  // ── stops ──
  const allStops = findStops(track, segs).map(s => {
    const { place, at } = where(s.t, s.lat, s.lng)
    // The bare fact, no extra words (operator, 2026-10-29).
    const remark = at === 'yard' ? 'Yard' : at === 'dest' ? 'Destination' : at === 'zone' ? 'In zone' : 'Unscheduled'
    return { ...s, place, remark, flag: at == null && s.ms >= LONG_STOP_MS }
  })
  const stops = [...allStops].sort((a, b) => b.ms - a.ms).slice(0, ROWS.stops).sort(byTime).map((s, i) => ({ ...s, n: i + 1 }))

  // ── driver conduct, during the trip ──
  // Dashcam columns are there only when the unit has a camera.
  // The gatherer always answers for the camera; the fallback is for a caller that does not.
  const cam = d.dashcam ?? { fitted: false, complete: true, alarms: [] as ReportInput['dashcam']['alarms'] }
  const kinds: { key: string; label: string }[] = [...BREACH_KINDS, ...(cam.fitted ? DASHCAM_KINDS : [])]
  const mins = (sec: number) => `${Math.max(1, Math.round(sec / 60))} min`
  const speeding = (d.speeding ?? []).filter(s => inTrip(s.t))
  const breaches = [
    ...(d.escalatedThefts ?? []).filter(x => inTrip(x.t)).map(x => ({ t: x.t, key: 'theft', place: x.place ?? null, lat: null, lng: null,
      detail: `${Math.round(x.litres)} L, confirmed on review` as string | null })),
    ...speeding.map(s => ({ t: s.t, key: 'speed', place: null, lat: s.lat, lng: s.lng,
      detail: `${Math.round(s.peakKmh)} in ${Math.round(s.limitKmh)}, ${mins(s.durationSec)}${s.distanceM != null ? `, ${round1(s.distanceM / 1000)} km` : ''}` })),
    ...(d.harsh ?? []).filter(h => inTrip(h.t)).map(h => ({ t: h.t, key: h.type === 'brake' ? 'brake' : 'accel', place: null, lat: h.lat, lng: h.lng,
      detail: h.speedKmh != null ? `at ${Math.round(h.speedKmh)} km/h` : null })),
    ...(cam.fitted ? cam.alarms ?? [] : []).filter(a => inTrip(a.t)).map(a => ({ t: a.t, key: a.kind, place: null, lat: a.lat, lng: a.lng,
      detail: [a.label, a.speed != null ? `at ${a.speed} km/h` : null].filter(Boolean).join(', ') })),
  ].map(b => {
    const p: Pos = b.lat != null ? { lat: b.lat, lng: b.lng ?? null } : positionAt(track, b.t)
    return { ...b, ...p, label: kinds.find(k => k.key === b.key)?.label ?? b.key, place: b.place || where(b.t, p.lat, p.lng).place }
  }).sort(byTime)
  const counts = Object.fromEntries(kinds.map(k => [k.key, breaches.filter(b => b.key === k.key).length])) as Record<string, number>
  const breachCap = capped(breaches, ROWS.breaches)
  const overspeedMs = speeding.reduce((a, s) => a + (s.durationSec ?? 0) * 1000, 0)
  const measuredKm = speeding.filter(s => s.distanceM != null)
  const overspeedKm = measuredKm.length ? round1(measuredKm.reduce((a, s) => a + s.distanceM!, 0) / 1000) : (speeding.length ? null : 0)

  // ── geofence ──
  // Departure / arrival at the yard and destination first; then any other
  // zone crossed on the way. A zone crossing at the yard or the destination is
  // the same event as its milestone, so it is not listed twice.
  const edge = 60_000
  const atEnds = (t: number) => { const p = positionAt(track, t); return where(null, p.lat, p.lng).at != null }
  const geoRows = [...marks, ...(d.zones?.visits ?? []).filter(v => !atEnds(v.enteredAt) && !atEnds(v.leftAt)).flatMap(v => [
    v.enteredAt > w.from + edge ? { t: v.enteredAt, label: v.enforced ? 'Entered restricted zone' : 'Entered', zone: v.name, flag: !!v.enforced } : null,
    v.leftAt < w.to - edge ? { t: v.leftAt, label: 'Left', zone: v.name, flag: false } : null,
  ])].filter((g): g is Mark => !!g && inTrip(g.t)).sort(byTime)
  const geoCap = capped(geoRows, ROWS.geo)

  // ── load ──
  const D = d.dispatch
  const declared = D.tonnageT != null
    ? { cargo: D.cargoName, bags: D.bags, netKg: D.tonnageT * 1000, ref: D.serialNumber ?? D.externalId }
    : null
  const tickets = tripTickets(d.weighments ?? [], w)
  // Every weighing on every ticket of the trip, in time order, each with the
  // time since the one before. A weighing whose date is doubtful at source
  // (stamped before its own ticket) is printed but never measured against.
  const weighings = tickets.flatMap(tk => {
    const list = (tk.weighings ?? []).filter(x => !x.doubtful).sort((a, b) => a.at - b.at)
    const odd = (tk.weighings ?? []).filter(x => x.doubtful)
    return [...list, ...odd].map((x, i, all) => ({
      ...x, ticket: tk.ticket, cargo: tk.cargo,
      // The ticket's net goes on its last weighing, where the load is settled.
      netKg: i === all.length - 1 ? tk.netKg : null,
      sinceMs: null as number | null, sameTicketAsPrev: false,
    }))
  })
  let prev: number | null = null
  for (const x of weighings) {
    x.sinceMs = !x.doubtful && prev != null ? x.at - prev : null
    if (!x.doubtful) prev = x.at
  }
  for (let i = 1; i < weighings.length; i++) weighings[i]!.sameTicketAsPrev = weighings[i]!.ticket === weighings[i - 1]!.ticket
  const weighCap = capped(weighings, ROWS.weighings)
  const bridges = [...new Set(weighings.map(x => x.bridge).filter(Boolean))] as string[]
  const kind = D.kind ? D.kind.charAt(0) + D.kind.slice(1).toLowerCase() : null
  const load = {
    cargo: D.cargoName ?? tickets.find(x => x.cargo)?.cargo ?? kind,
    kind,
    // A cane dispatch has no serial, only an internal UUID nobody can quote.
    ref: D.serialNumber ?? (/^[0-9a-f]{8}-/i.test(D.externalId ?? '') ? null : D.externalId ?? null),
    bags: D.bags ?? null,
    declaredKg: D.tonnageT != null ? D.tonnageT * 1000 : null,
    weighedKg: tickets.some(x => x.netKg != null) ? tickets.reduce((a, x) => a + (x.netKg ?? 0), 0) : null,
  }

  return {
    reportNo: reportNumber(d),
    generatedAt: d.generatedAt ?? Date.now(),
    companyName: d.companyName ?? null,
    vehicle: { plate: d.vehicle.plate, type: d.vehicle.type ?? null, driver: D.driverName ?? null },
    window: w,
    // A dispatch's report, a trip within a day, or the whole day.
    mode: d.mode === 'day' ? 'day' as const : 'trip' as const,
    from: { name: d.yard?.name ?? d.fromName ?? null, at: w.from },
    to: { name: d.dest?.name ?? d.toName ?? D.destination ?? null, arrivedAt: w.arrived ? w.to : null },
    toDestinationMs: w.arrived ? w.to - w.from : null,
    yard: d.yard ? { lat: d.yard.lat, lng: d.yard.lng } : null,
    dest: d.dest ? { lat: d.dest.lat, lng: d.dest.lng } : null,
    /** [lat, lng] */
    track: thin(track, ROUTE_POINTS).map(p => [p[1], p[2]] as [number, number]),
    map: d.map ?? null,
    summary: {
      distanceKm: track.length > 1 ? round1(distanceM / 1000) : null,
      movingMs: track.length > 1 ? movingMs : null,
      stoppedMs: track.length > 1 ? Math.max(0, durationMs - movingMs) : null,
      idleMs: hasIgnition ? idleMs : null,
      durationMs,
      avgKmh: movingMs > 0 ? round1(distanceM / 1000 / (movingMs / 3_600_000)) : null,
      maxKmh: speeds.length ? Math.max(...speeds) : null,
      fuelUsedL,
    },
    declared,
    load,
    weighbridge: { rows: weighCap.rows, more: weighCap.more, tickets: tickets.length, weighings: weighings.length,
      bridges, doubtful: weighings.some(x => x.doubtful),
      netKg: tickets.reduce((a, x) => a + (x.netKg ?? 0), 0) },
    stops,
    stopsTotal: allStops.length,
    fuel: { series, hasProbe: !!F0.hasProbe, startL, endL, rows: fuelCap.rows, more: fuelCap.more, drainL: round1(drainL) },
    // Metres above sea level along the trip (may be empty).
    altitude: thin(((d.altitude ?? []) as [number, number][]).filter(p => inTrip(p[0]) && Number.isFinite(p[1])), 300),
    breaches: { kinds, dashcam: { fitted: !!cam.fitted, complete: cam.complete !== false }, counts, total: breaches.length,
      rows: breachCap.rows, more: breachCap.more, overspeedMs, overspeedKm },
    geo: { rows: geoCap.rows, more: geoCap.more, timedOut: !!d.zones?.timedOut },
  }
}

export type TripReport = ReturnType<typeof buildTripReport>
