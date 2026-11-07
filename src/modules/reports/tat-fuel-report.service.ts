/**
 * The TAT and Fuel Report (operator, 4 Nov 2026; West Kenya's daily sheet):
 * one row per trip finished on the fleet day, and one row for each other unit
 * saying why it has none.
 *
 * Where a trip comes from, in order (operator: FactorySuite for Naitiri, Sukari
 * and Olepito; failing that, the factory fence, routes and geofences):
 *
 *   FactorySuite   raised at dispatch, ended at sign-in. Its duration starts when
 *                  the unit leaves the premises after dispatch; the station is
 *                  the dispatch's destination.
 *   The fence      as West Kenya's sheet has it: from one entry to a factory
 *                  fence to the next, so the fuelling at the yard falls inside
 *                  the trip. The station is the cane-transfer ticket's centre,
 *                  then the route most driven, then the geofence most stood in.
 *
 *   The fuel       every figure as Vehicle analytics gives it for the times the
 *                  row shows, to the minute (fuel/fuel-balance; operator, 4 Nov
 *                  2026): type those times in there and the two read the same.
 */
import { prisma } from '../../lib/prisma.js'
import { reportDb } from '../../lib/report-db.js'
import { logger } from '../../lib/logger.js'
import { fleetDayBounds } from '../../lib/provider-time.js'
import { isInsideFence } from '../../lib/geofence.js'
import { fenceOf, siteNameOf, typeHeading, type MorlFence } from './movement-report.service.js'
import { trackKm, type Ping } from './tankers-report.service.js'
import { asDaySeries, fuelBalance, type BalanceReading } from '../fuel/fuel-balance.js'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** A dispatch signed in long after is read back this far at most. */
const MAX_TRIP_MS = 7 * DAY_MS
/** The units on the report: anything dispatched or ticketed in this long before the day. */
const ROSTER_MS = 30 * DAY_MS
/** Older and not signed in is a forgotten sign-in, not a trip under way. */
const OPEN_TRIP_MS = 72 * HOUR_MS
/** A fence trip's first read: most start within this before the day. */
const FIRST_READ_MS = 2 * DAY_MS
/** As far back as a fence trip's start is followed. */
const LONGEST_READ_MS = 5 * DAY_MS
/** Out of a fence and back within this is the fix wandering at the gate. */
export const GATE_BLIP_MS = 15 * 60_000
/** Between two entries a unit must have driven this far for it to be a trip, not a shuffle around the yard. */
export const MIN_FENCE_TRIP_KM = 5
/** Parked at the mill longer than this: the trip starts at PARKED_LEAD_MS before it drove out, not days back. */
export const PARKED_MS = 24 * HOUR_MS
const PARKED_LEAD_MS = 2 * HOUR_MS
/** A reading under this is a dead probe, not a level. */
const MIN_LEVEL_L = 1
const MIN_TRIP_KM = 1
const MIN_GPS_TRIP_MS = 30 * 60_000
/** More km to the litre than this and the probe is not following the tank: a heavy unit does 2 to 5. */
const MAX_KM_PER_L = 15
const READ_AT_ONCE = 4
const CACHE_MS = 10 * 60_000
/** A haulage unit with no stated type carries a tank at least this big. */
const HAULAGE_TANK_L = 300
export { ROAD_PLATE, vehicleHeading, isPrimeMover, PRIME_MOVERS } from './vehicle-kind.js'
import { ROAD_PLATE, vehicleHeading, isPrimeMover, PRIME_MOVERS } from './vehicle-kind.js'
/** Whose fences read together: West Kenya's trucks deliver to each other's mills. */
const FENCE_FAMILIES: readonly (readonly string[])[] = [['WESTSUGAR', 'KABRAS', 'NZOIA']]
/** A mill's fence is named for a factory; this one is drawn over KABRAS FACTORY -WKS and wider, where the road passes. */
const MILL_NAME = /factory/i
const NOT_THE_GATE = /\(West Kenya\)/i
/** A route has "Route" in its name; other lines are roads and hazards, not ways to a station. */
const ROUTE_NAME = /\broute\b/i
/** Fences that are the site itself or its surroundings, never where a trip went. */
const NOT_A_STATION = /industries|stop\s*over|no[\s-]*go/i
/** The ticket's name for a centre, as the sheet names it. */
const STATION_WORDS: Readonly<Record<string, string>> = { SELIENT: 'Selia', WEYETA: 'Wayeta', 'KITALE (AMUKA)': 'Amuka' }
/** The site in a unit's name, as it is misspelt there. */
const BASE_WORDS: Readonly<Record<string, string>> = {
  kabaras: 'Kabras', naititi: 'Naitiri', naitiric: 'Naitiri', oleptio: 'Olepito', lake: 'Lake Agro', lakeagro: 'Lake Agro',
}

export type TatComment = 'PROBE OK' | 'PROBE ISSUE' | 'PROBE FAILURE' | 'NO FLS' | 'GPS MILEAGE FAILURE'
  | 'NOT UPDATING' | 'NO TRIP' | 'INCOMPLETE TRIP'

export interface Reading extends Ping { fuelL: number | null }
export interface Fill { at: number; ml: number }

export interface FuelFigures {
  /** Null where no reading read a tank; what was filled and drained is on the ledger regardless. */
  initial: number | null; topUps: number; total: number | null; consumption: number | null; theft: number; final: number | null
}

export interface TatRow {
  vehicleId: string
  plate: string
  group: string
  source: 'factorysuite' | 'fence' | null
  dispatchedAt: number | null
  leftAt: number | null
  returnedAt: number | null
  station: string | null
  driver: string | null
  fuel: FuelFigures | null
  km: number | null
  rate: number | null
  tankL: number | null
  comment: TatComment
  base: string
}

export interface TatFuelReport {
  day: string
  from: number
  to: number
  base: string
  mills: string[]
  units: number
  failed: number
  rows: TatRow[]
}

const round2 = (n: number) => Math.round(n * 100) / 100

const insideAny = (p: Ping, fences: MorlFence[]) =>
  p.lat != null && p.lng != null && fences.some(f => isInsideFence(p.lat!, p.lng!, f.geometry))

/** When the unit left the premises: its first reading outside after dispatch; dispatch itself if it was already out or nothing says. Pure. */
export function leftPremises(pings: Ping[], fences: MorlFence[], dispatchedAt: number, returnedAt: number): number {
  if (!fences.length) return dispatchedAt
  let inside: boolean | null = null
  for (const p of pings) {
    if (p.t < dispatchedAt || p.t > returnedAt || p.lat == null || p.lng == null) continue
    const here = insideAny(p, fences)
    if (inside == null && !here) return dispatchedAt
    if (inside && !here) return p.t
    inside = here
  }
  return dispatchedAt
}

export interface Stay { in: number; out: number }

/** The visits to the factory fences, with the fix wandering at the gate and a shuffle around the yard folded in. Pure. */
export function millStays(pings: Ping[], mills: MorlFence[]): Stay[] {
  const raw: Stay[] = []
  for (const p of pings) {
    if (!insideAny(p, mills)) continue
    const last = raw.at(-1)
    if (last && p.t - last.out <= GATE_BLIP_MS) last.out = p.t
    else raw.push({ in: p.t, out: p.t })
  }
  const stays: Stay[] = []
  for (const s of raw) {
    const last = stays.at(-1)
    if (last && trackKm(pings, last.out, s.in) < MIN_FENCE_TRIP_KM) last.out = s.out
    else stays.push({ ...s })
  }
  return stays
}

export interface FenceTrip { startAt: number; endAt: number; leftAt: number }

/** The trips ending inside [from, to): from one entry to a factory fence to the next. Pure. */
export function fenceTrips(stays: Stay[], from: number, to: number): FenceTrip[] {
  const out: FenceTrip[] = []
  for (let i = 1; i < stays.length; i++) {
    const end = stays[i]!.in
    if (end < from || end >= to) continue
    const last = stays[i - 1]!
    const startAt = last.out - last.in > PARKED_MS ? last.out - PARKED_LEAD_MS : last.in
    out.push({ startAt, endAt: end, leftAt: last.out })
  }
  return out
}

/** "Kabras to Magut Route" → Magut, "Naitiri - Rai Paper Route" → Rai Paper. Pure. */
export function routeStation(name: string): string | null {
  const m = /^.*?(?:\s-\s|\sto\s)(.+?)\s+route\b/i.exec(name.trim())
  return m ? m[1]!.trim() : null
}

/** "Misikhu New" → Misikhu, "Selia Region" → Selia. Pure. */
export const placeStation = (name: string): string =>
  name.replace(/\b(new|region|town)\b/gi, ' ').replace(/\s+/g, ' ').trim() || name.trim()

/** The cane ticket's centre as the sheet names it: "SELIENT YARD" → Selia, "KHALABA YARD" → Khalaba. Pure. */
export function ticketStation(center: string): string {
  const bare = center.replace(/\s+yard\s*$/i, '').trim().toUpperCase()
  const word = STATION_WORDS[bare] ?? bare
  return word.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase())
}

/** Where a fence trip went without a ticket to say: the route most driven, then the place most stood in. Pure. */
export function stationFromFences(readings: Ping[], routes: MorlFence[], places: MorlFence[]): string | null {
  let best: { n: number; name: string } | null = null
  for (const r of routes) {
    const name = routeStation(r.name)
    if (!name) continue
    const n = readings.filter(p => p.lat != null && p.lng != null && (p.speedKmh ?? 0) >= 3 && isInsideFence(p.lat, p.lng, r.geometry)).length
    if (n > 0 && (!best || n > best.n)) best = { n, name }
  }
  if (best) return best.name
  for (const f of places) {
    const n = readings.filter(p => p.lat != null && p.lng != null && isInsideFence(p.lat, p.lng, f.geometry)).length
    if (n > 0 && (!best || n > best.n)) best = { n, name: placeStation(f.name) }
  }
  return best?.name ?? null
}

/** The site a unit is named for: "WKS - Kabras - KDE 321Q" → Kabras. Pure. */
export function baseOf(name: string, fallback: string): string {
  const m = /^(?:WKS|West Sugar)\s*-+\s*([A-Za-z]{4,})/i.exec(name.trim())
  if (!m) return fallback
  const word = m[1]!.toLowerCase()
  return BASE_WORDS[word] ?? word.charAt(0).toUpperCase() + word.slice(1)
}

/** Is this unit on the report? Dispatched, ticketed, or by its size and plate a haulage unit. Pure. */
export function onRoster(v: { type: string; plate: string; tankL: number | null; prime?: boolean }, dispatched: boolean, ticketed: boolean): boolean {
  if (dispatched || v.prime) return true
  if (v.type === 'SALOON' || v.type === 'COMPANY_VEHICLE' || v.type === 'PLANT') return false
  if (ticketed) return true
  return v.type === 'UNSPECIFIED' && (v.tankL ?? 0) >= HAULAGE_TANK_L && ROAD_PLATE.test(v.plate)
}

/** What the sheet's Comment says of a finished trip. Pure. */
export function tripComment(o: { readings: number; fuel: FuelFigures | null; km: number; durationMs: number; tankL: number | null }): TatComment {
  if (!o.readings) return 'NOT UPDATING'
  if (o.km < MIN_TRIP_KM && o.durationMs >= MIN_GPS_TRIP_MS) return 'GPS MILEAGE FAILURE'
  if (o.fuel?.consumption == null) return o.tankL == null ? 'NO FLS' : 'PROBE FAILURE'
  if (o.fuel.consumption <= 0 || o.km / o.fuel.consumption > MAX_KM_PER_L) return 'PROBE ISSUE'
  return 'PROBE OK'
}

/** What it says of a unit with no trip finished that day. Pure. */
export function idleComment(o: { readings: number; fuelReadings: number; open: boolean; tankL: number | null }): TatComment {
  if (o.open) return 'INCOMPLETE TRIP'
  if (!o.readings) return 'NOT UPDATING'
  if (!o.fuelReadings) return o.tankL == null ? 'NO FLS' : 'PROBE FAILURE'
  return 'NO TRIP'
}

/** A unit's rows come together, prime movers first, then trucks before tractors, plate by plate, trips in order. Pure. */
export function sortRows<T extends Pick<TatRow, 'group' | 'plate' | 'leftAt'>>(rows: T[]): T[] {
  const rank = (g: string) => (g === PRIME_MOVERS ? 0 : 1)
  return rows.sort((a, b) => rank(a.group) - rank(b.group) || b.group.localeCompare(a.group) || a.plate.localeCompare(b.plate) || (a.leftAt ?? 0) - (b.leftAt ?? 0))
}

async function readReadings(vehicleId: string, a: number, b: number): Promise<Reading[]> {
  const rows = await reportDb().$queryRaw<Array<{ captured_at: Date; lat: number | null; lng: number | null; speed_kmh: number | null; fuel_level_ml: number | null }>>`
      SELECT captured_at, lat, lng, speed_kmh, fuel_level_ml
        FROM vehicle_telemetries
       WHERE vehicle_id = ${vehicleId} AND captured_at >= ${new Date(a)} AND captured_at < ${new Date(b)}
       ORDER BY captured_at ASC`
  return rows.map(r => ({
    t: r.captured_at.getTime(), lat: r.lat, lng: r.lng, speedKmh: r.speed_kmh,
    fuelL: r.fuel_level_ml == null ? null : r.fuel_level_ml / 1000,
  }))
}

interface Unit { id: string; name: string; plate: string; type: string; tankL: number | null; base: string; prime: boolean }
interface Dispatched { vehicleId: string; dispatchedAt: number; returnedAt: number; destination: string | null; driver: string }
interface Fences { mills: MorlFence[]; routes: MorlFence[]; places: MorlFence[] }
interface TripWindow {
  source: 'factorysuite' | 'fence'
  dispatchedAt: number | null
  /** Where the fuel is read from. */
  startAt: number
  endAt: number
  /** Where the distance is read from. */
  leftAt: number
  /** Shown as the start of the trip. */
  shownAt: number
  station: string | null
  driver: string | null
}

const MINUTE_MS = 60_000
const toMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS

/** The rows for the trips worked out; the fills and drains read once over them all. */
async function tripRows(unit: Unit, windows: TripWindow[], readings: Reading[]): Promise<TatRow[]> {
  const a = toMinute(Math.min(...windows.map(w => w.shownAt)))
  const b = Math.max(...windows.map(w => w.endAt))
  const [fillings, drains] = await Promise.all([
    reportDb().fuelFilling.findMany({
      where: { vehicleId: unit.id, filledAt: { gte: new Date(a), lte: new Date(b) } },
      select: { filledAt: true, verdict: true, observedRiseMl: true, filledMl: true, initialFuelLevelMl: true, finalFuelLevelMl: true },
    }),
    reportDb().fuelTheft.findMany({
      where: { vehicleId: unit.id, beganAt: { gte: new Date(a), lte: new Date(b) } },
      select: { beganAt: true, verdict: true, drainCause: true, cleanDropMl: true, measuredDropMl: true, stolenMl: true, finalFuelLevelMl: true, reviewStatus: true, dismissedAt: true },
    }),
  ])
  const series: BalanceReading[] = readings.map(r => asDaySeries({ ...r, fuelMl: r.fuelL == null ? null : r.fuelL * 1000 }))
  const fills = fillings.map(f => ({ ...f, at: f.filledAt.getTime() }))
  const lost = drains.map(d => ({ ...d, at: d.beganAt.getTime() }))
  return windows.map((w) => {
    const [from, to] = [toMinute(w.shownAt), toMinute(w.endAt)]
    const bal = fuelBalance({ readings: series, fillings: fills, drains: lost, from, to })
    const inTrip = series.filter(r => r.t >= from && r.t < to).length
    const fuel: FuelFigures = {
      initial: bal.startL, topUps: bal.filledL, total: bal.startL == null ? null : Math.round((bal.startL + bal.filledL) * 10) / 10,
      consumption: bal.consumedL, theft: bal.theftL, final: bal.endL,
    }
    const comment = tripComment({ readings: inTrip, fuel, km: bal.distanceKm, durationMs: w.endAt - w.leftAt, tankL: unit.tankL })
    return {
      vehicleId: unit.id, plate: unit.plate, group: groupOf(unit), source: w.source,
      dispatchedAt: w.dispatchedAt, leftAt: w.shownAt, returnedAt: w.endAt,
      station: w.station, driver: w.driver,
      fuel, km: round2(bal.distanceKm),
      rate: bal.kmPerL == null ? null : round2(bal.kmPerL),
      tankL: unit.tankL, comment, base: unit.base,
    }
  })
}

/**
 * Prime movers together, else the kind of vehicle, never the site it is named
 * for (operator, 4 Nov 2026: the site is in Base, and picked with the
 * organisations). An untyped KTC.. plate is a tractor. Pure.
 */
export function groupOf(u: Pick<Unit, 'name' | 'plate' | 'type' | 'prime'>): string {
  if (u.prime) return PRIME_MOVERS
  return u.type === 'UNSPECIFIED' && /^KTC/i.test(u.plate) ? 'Tractors' : vehicleHeading(u)
}

/** A unit's FactorySuite trips: from dispatch to sign-in. */
async function dispatchRows(unit: Unit, trips: Dispatched[], fences: Fences): Promise<TatRow[]> {
  const start = (t: Dispatched) => Math.max(t.dispatchedAt, t.returnedAt - MAX_TRIP_MS)
  const a = Math.min(...trips.map(start))
  const b = Math.max(...trips.map(t => t.returnedAt))
  // A minute early: the fuel is read from the minute the row shows
  const readings = await readReadings(unit.id, a - 60_000, b + 1)
  const windows = trips.map((t): TripWindow => {
    const leftAt = leftPremises(readings.filter(r => r.t >= start(t) && r.t <= t.returnedAt), fences.mills, start(t), t.returnedAt)
    return {
      source: 'factorysuite', dispatchedAt: t.dispatchedAt, startAt: start(t), endAt: t.returnedAt, leftAt, shownAt: leftAt,
      station: t.destination, driver: t.driver,
    }
  })
  return tripRows(unit, windows, readings)
}

/**
 * A unit's trips off the fences, read back until the day's first trip has its
 * start. A unit that drove out and is not yet back is a trip under way.
 */
async function fenceRows(unit: Unit, from: number, to: number, fences: Fences): Promise<{ rows: TatRow[]; under: boolean }> {
  let back = FIRST_READ_MS
  let readings = await readReadings(unit.id, from - back, to)
  let stays = millStays(readings, fences.mills)
  while (back < LONGEST_READ_MS && stays.some(s => s.in >= from && s.in < to) && !stays.some(s => s.in < from)) {
    const more = await readReadings(unit.id, from - back - DAY_MS, from - back)
    back += DAY_MS
    readings = [...more, ...readings]
    stays = millStays(readings, fences.mills)
  }
  const lastOut = stays.at(-1)?.out
  const under = lastOut != null && trackKm(readings, lastOut, to) >= MIN_FENCE_TRIP_KM
  const trips = fenceTrips(stays, from, to)
  if (!trips.length) return { rows: [], under }

  const tickets = await reportDb().weighment.findMany({
    where: {
      vehicleId: unit.id, category: 'CANE_TRANSFER',
      tokenAt: { gte: new Date(trips[0]!.startAt), lte: new Date(trips.at(-1)!.endAt) },
    },
    select: { tokenAt: true, centerName: true },
    orderBy: { tokenAt: 'asc' },
  })
  const windows = trips.map((t): TripWindow => {
    const ticket = tickets.find(x => x.tokenAt.getTime() >= t.startAt && x.tokenAt.getTime() < t.endAt)
    const out = readings.filter(r => r.t >= t.leftAt && r.t <= t.endAt)
    return {
      source: 'fence', dispatchedAt: null, startAt: t.startAt, endAt: t.endAt, leftAt: t.leftAt, shownAt: t.startAt,
      station: ticket ? ticketStation(ticket.centerName) : stationFromFences(out, fences.routes, fences.places),
      driver: null,
    }
  })
  return { rows: await tripRows(unit, windows, readings), under }
}

/** The fences a trip is read against: this organisation's, and its family's. */
async function loadFences(orgCode: string, orgId: string): Promise<Fences> {
  const family = FENCE_FAMILIES.find(f => f.includes(orgCode))
  const rows = await prisma.geofence.findMany({
    where: family ? { organisation: { code: { in: [...family] } } } : { organisationId: orgId },
    select: { name: true, type: true, centerLat: true, centerLng: true, radiusM: true, polygonCoords: true, widthM: true },
    orderBy: { name: 'asc' },
  })
  const out: Fences = { mills: [], routes: [], places: [] }
  for (const r of rows) {
    const f = fenceOf(r)
    if (!f) continue
    if (r.type === 'LINE') { if (ROUTE_NAME.test(r.name)) out.routes.push(f) }
    else if (MILL_NAME.test(r.name)) { if (!NOT_THE_GATE.test(r.name)) out.mills.push(f) }
    else if (!NOT_A_STATION.test(r.name)) out.places.push(f)
  }
  return out
}

async function settleLimited<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      try { out[i] = { status: 'fulfilled', value: await fn(items[i]!) } } catch (reason) { out[i] = { status: 'rejected', reason } }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

async function buildReport(orgId: string, day: string, allowed: Set<string> | null): Promise<TatFuelReport> {
  const bounds = fleetDayBounds(day)
  if (!bounds) throw new Error(`Not a day: ${day}`)
  const from = bounds.from.getTime()
  const to = bounds.to.getTime()
  const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { name: true, code: true } })
  const site = siteNameOf(org?.name)
  const db = reportDb()

  const [fences, dispatches, vehicles, ticketed] = await Promise.all([
    loadFences(org?.code ?? '', orgId),
    db.dispatch.findMany({
      where: {
        organisationId: orgId, vehicleId: { not: null }, status: { not: 'CANCELLED' },
        dispatchedAt: { gte: new Date(from - ROSTER_MS), lt: bounds.to },
      },
      select: { vehicleId: true, dispatchedAt: true, actualReturnAt: true, destination: true, driverName: true },
    }),
    db.vehicle.findMany({
      where: { organisationId: orgId, isActive: true },
      select: { id: true, name: true, registrationPlate: true, vehicleType: true, tankCapacityLitres: true },
    }),
    db.weighment.findMany({
      where: { organisationId: orgId, vehicleId: { not: null }, tokenAt: { gte: new Date(from - ROSTER_MS), lt: bounds.to } },
      select: { vehicleId: true }, distinct: ['vehicleId'],
    }),
  ])

  const trips = new Map<string, Dispatched[]>()
  const open = new Map<string, typeof dispatches[number]>()
  const wasDispatched = new Set<string>()
  for (const d of dispatches) {
    const id = d.vehicleId!
    wasDispatched.add(id)
    const back = d.actualReturnAt?.getTime() ?? null
    if (back != null && back >= from && back < to) {
      const list = trips.get(id) ?? []
      list.push({ vehicleId: id, dispatchedAt: d.dispatchedAt.getTime(), returnedAt: back, destination: d.destination, driver: d.driverName })
      trips.set(id, list)
    } else if ((back == null || back >= to) && d.dispatchedAt.getTime() >= to - OPEN_TRIP_MS) {
      const was = open.get(id)
      if (!was || d.dispatchedAt > was.dispatchedAt) open.set(id, d)
    }
  }
  const hasTicket = new Set(ticketed.map(t => t.vehicleId))
  const units: Unit[] = vehicles
    .map(v => ({
      id: v.id, name: v.name, plate: v.registrationPlate, type: v.vehicleType, base: baseOf(v.name, site), prime: isPrimeMover(v.name),
      tankL: v.tankCapacityLitres == null ? null : Number(v.tankCapacityLitres),
    }))
    .filter(u => onRoster(u, wasDispatched.has(u.id) || trips.has(u.id), hasTicket.has(u.id)))
    .filter(u => !allowed || allowed.has(u.id))

  const counts = units.length ? await db.$queryRaw<Array<{ vehicle_id: string; readings: number; fuel: number }>>`
      SELECT vehicle_id, count(*)::int AS readings, count(*) FILTER (WHERE fuel_level_ml >= ${MIN_LEVEL_L * 1000})::int AS fuel
        FROM vehicle_telemetries
       WHERE vehicle_id = ANY(${units.map(u => u.id)}) AND captured_at >= ${bounds.from} AND captured_at < ${bounds.to}
       GROUP BY vehicle_id` : []
  const countOf = new Map(counts.map(c => [c.vehicle_id, c]))

  const results = await settleLimited(units, READ_AT_ONCE, async (u): Promise<TatRow[]> => {
    const own = trips.get(u.id)
    if (own?.length) return dispatchRows(u, own, fences)
    const c = countOf.get(u.id)
    const o = open.get(u.id)
    const off = c?.readings && fences.mills.length ? await fenceRows(u, from, to, fences) : null
    if (off?.rows.length) return off.rows
    return [{
      vehicleId: u.id, plate: u.plate, group: groupOf(u), source: null,
      dispatchedAt: o?.dispatchedAt.getTime() ?? null, leftAt: null, returnedAt: null,
      station: o?.destination ?? null, driver: o?.driverName ?? null,
      fuel: null, km: null, rate: null, tankL: u.tankL, base: u.base,
      comment: idleComment({ readings: c?.readings ?? 0, fuelReadings: c?.fuel ?? 0, open: Boolean(o) || Boolean(off?.under), tankL: u.tankL }),
    }]
  })

  const rows: TatRow[] = []
  let failed = 0
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') rows.push(...r.value)
    else { failed++; logger.warn({ err: r.reason, orgId, vehicleId: units[i]!.id }, 'TAT report: readings could not be read') }
  })
  sortRows(rows)
  return { day, from, to, base: site, mills: fences.mills.map(f => f.name), units: units.length, failed, rows }
}

const made = new Map<string, { at: number; report: Promise<TatFuelReport> }>()

/** The report for a fleet day. A closed day is kept a while for everyone who can see every unit. */
export async function getTatFuelReport(orgId: string, day: string, allowed: Set<string> | null = null, now = Date.now()): Promise<TatFuelReport> {
  const closed = (fleetDayBounds(day)?.to.getTime() ?? now) <= now
  if (!closed || allowed) return buildReport(orgId, day, allowed)
  const key = `${orgId}|${day}`
  const held = made.get(key)
  if (held && now - held.at < CACHE_MS) return held.report
  for (const [k, v] of made) if (now - v.at >= CACHE_MS) made.delete(k)
  const report = buildReport(orgId, day, null)
  made.set(key, { at: now, report })
  report.catch(() => made.delete(key))
  return report
}
