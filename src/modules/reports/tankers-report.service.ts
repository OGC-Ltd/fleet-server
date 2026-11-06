/**
 * The Tankers Report (operator, 2–3 Nov 2026): Menengai's tankers on the road
 * from the Mombasa depot to MORL, and how far each went in the 4 hours up to
 * the report time. Made here since 4 Nov 2026 (operator: "move this logic to
 * the server"); the Reports page sends the tankers off its fleet list and
 * draws the table, PDF and CSV from the rows.
 *
 *   Time left storage facility   when it drove out of the Mombasa depot
 *   Location                     where it was at the report time (the
 *                                Movements report's place name)
 *   Distance covered within 4 h  km driven in that window
 *   Distance (km)                km driven since it left the depot
 *
 * Which tankers: those whose last visit to the depot is followed by the road,
 * not by the depot again: still on the road to MORL, or arrived at MORL in the
 * last COMPLETED_SHOWN_MS. One still at the depot is loading; one that reached
 * MORL before that, or that left MORL since, is not on a trip from Mombasa.
 *
 * Status: 'completed' reached the MORL geofence; 'still' covered under half
 * of what the middle tanker on the road covered in the same 4 hours, or did
 * not move at all; 'transit' the rest.
 */
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { haversineM, isInsideFence } from '../../lib/geofence.js'
import { findMorlDestination, getMovementReport, type MorlFence } from './movement-report.service.js'

export const WINDOW_MS = 4 * 3_600_000
const DAY_MS = 86_400_000
/** Read first: the last two days, which hold most trips under way. */
const FIRST_READ_MS = 2 * DAY_MS
/** How far back a tanker's readings are followed to its departure from the depot. */
export const LOOKBACK_DAYS = 10
/** A trip that reached MORL longer ago than this is done with: off the report. */
export const COMPLETED_SHOWN_MS = 24 * 3_600_000
/** Under this in the window is "no movement": a parked tanker's GPS still wanders a few hundred metres. */
export const MIN_MOVE_KM = 0.5
/** Out of a fence and back within this is the fix wandering at the gate, not a trip. */
export const BLIP_MS = 15 * 60_000
/** Red: under this share of the middle (median) tanker's distance in the 4 hours. */
export const SLOW_SHARE = 0.5
/** Tankers read side by side. */
const READ_AT_ONCE = 4

/** The storage facility: the Mombasa loading point (as the Movements report has it) and its radius. */
export const DEPOT = { name: 'Mombasa depot', lat: -4.04579, lng: 39.65165, radiusM: 1000 }

// Distance along the track, as the page's day summary reads it (new-ui lib/vehicleDay)
const TRACK_MOVING_KMH = 3
const TRACK_MAX_GAP_MS = 10 * 60_000   // no evidence across a longer silence
const TRACK_MAX_KMH = 200              // a hop implying more than this is a GPS jump

export interface Ping { t: number; lat: number | null; lng: number | null; speedKmh: number | null }
export type TankerStatus = 'transit' | 'completed' | 'still'
export interface Trip { leftAt: number; arrivedAt: number | null; windowKm: number; tripKm: number; status: TankerStatus }
export interface TankerUnit { key: string; plate: string; vehicleIds: string[] }
export interface TankerRow extends Trip { unit: { key: string; plate: string }; location: string }
export interface TankersReport {
  from: number; to: number
  morl: string | null
  tankers: number
  failed: number
  slow: { median: number; line: number }
  rows: TankerRow[]
}

const inDepot = (p: { lat: number; lng: number }) => haversineM(p.lat, p.lng, DEPOT.lat, DEPOT.lng) <= DEPOT.radiusM

/** Km driven between a and b (b excluded): hops while moving, never across a long silence or a GPS jump. Pure. */
export function trackKm(pings: Ping[], a: number, b: number): number {
  const sub = pings.filter(p => p.t >= a && p.t < b)
  let metres = 0
  for (let i = 1; i < sub.length; i++) {
    const prev = sub[i - 1]!
    const p = sub[i]!
    const gap = p.t - prev.t
    if (gap <= 0 || gap > TRACK_MAX_GAP_MS) continue
    const moving = (prev.speedKmh ?? 0) >= TRACK_MOVING_KMH || (p.speedKmh ?? 0) >= TRACK_MOVING_KMH
    if (!moving || prev.lat == null || prev.lng == null || p.lat == null || p.lng == null) continue
    const m = haversineM(prev.lat, prev.lng, p.lat, p.lng)
    if (m / (gap / 3_600_000) / 1000 <= TRACK_MAX_KMH) metres += m
  }
  return metres / 1000
}

/**
 * One tanker's trip from the depot, from its readings (sorted by time) up to
 * `to`. `need`: true when the readings do not reach back far enough to say,
 * so more days should be read. Otherwise `trip` is null (not on a trip from
 * Mombasa) or the trip. Pure.
 */
export function depotTrip(pings: Ping[], morl: MorlFence | null, { from, to }: { from: number; to: number }): { need: boolean; trip: Trip | null } {
  const marks: Array<{ t: number; depot: boolean; morl: boolean }> = []
  for (const p of pings) {
    if (p.t > to) break
    if (p.lat == null || p.lng == null) continue
    const at = { lat: p.lat, lng: p.lng }
    marks.push({ t: p.t, depot: inDepot(at), morl: morl ? isInsideFence(at.lat, at.lng, morl.geometry) : false })
  }
  if (!marks.length) return { need: true, trip: null }
  // The last reading inside the depot, and the departure after it. A reading
  // out and back in within BLIP_MS is the fix wandering, so it is skipped.
  let lastIn = -1
  for (let i = marks.length - 1; i >= 0; i--) {
    if (!marks[i]!.depot) continue
    const nextAt = marks.findIndex((m, j) => j > i && !m.depot)
    if (nextAt < 0) { lastIn = i; break }
    const backIn = marks.find((m, j) => j > nextAt && m.depot)
    if (backIn && backIn.t - marks[nextAt]!.t < BLIP_MS) continue
    lastIn = i
    break
  }
  if (lastIn < 0) {
    // Not at the depot in what was read. At MORL before COMPLETED_SHOWN_MS ago:
    // any trip from Mombasa ended before that, so no more need be read.
    const oldMorl = marks.some(m => m.morl && m.t < to - COMPLETED_SHOWN_MS)
    return { need: !oldMorl, trip: null }
  }
  const out = marks.find((m, j) => j > lastIn && !m.depot)
  if (!out) return { need: false, trip: null }                     // still at the depot: loading
  const leftAt = out.t
  const arrivedAt = marks.find(m => m.t > leftAt && m.morl)?.t ?? null
  if (arrivedAt != null && arrivedAt < to - COMPLETED_SHOWN_MS) return { need: false, trip: null }
  const tripEnd = arrivedAt ?? to
  const a = Math.max(from, leftAt)
  const b = Math.min(to, tripEnd)
  return {
    need: false,
    trip: {
      leftAt, arrivedAt,
      windowKm: b > a ? trackKm(pings, a, b) : 0,
      tripKm: trackKm(pings, leftAt, tripEnd),
      // Red or not is read against the other tankers once all are known (markSlow)
      status: arrivedAt != null ? 'completed' : 'transit',
    },
  }
}

/**
 * Red: the tankers on the road that covered under half of what the middle one
 * covered in the 4 hours, and any that did not move at all. Returns the line
 * in km, for the page and the PDF to state. Pure; sets each row's status.
 */
export function markSlow(rows: Array<Pick<Trip, 'status' | 'windowKm'>>): { median: number; line: number } {
  const road = rows.filter(r => r.status !== 'completed')
  const km = road.map(r => r.windowKm ?? 0).sort((a, b) => a - b)
  const median = km.length ? (km.length % 2 ? km[(km.length - 1) / 2]! : (km[km.length / 2 - 1]! + km[km.length / 2]!) / 2) : 0
  const line = Math.max(SLOW_SHARE * median, MIN_MOVE_KM)
  for (const r of road) r.status = (r.windowKm ?? 0) < line ? 'still' : 'transit'
  return { median, line }
}

/** On the road first, by the time they left the depot; then those that reached MORL. Pure. */
export function sortRows<T extends Pick<TankerRow, 'status' | 'leftAt' | 'unit'>>(rows: T[]): T[] {
  return rows.sort((x, y) => Number(x.status === 'completed') - Number(y.status === 'completed') || x.leftAt - y.leftAt
    || String(x.unit.plate).localeCompare(String(y.unit.plate)))
}

/** A tracker's readings between a and b, oldest first. */
async function readPings(vehicleId: string, a: number, b: number): Promise<Ping[]> {
  const rows = await prisma.$queryRaw<Array<{ captured_at: Date; lat: number | null; lng: number | null; speed_kmh: number | null }>>`
      SELECT captured_at, lat, lng, speed_kmh
        FROM vehicle_telemetries
       WHERE vehicle_id = ${vehicleId} AND captured_at >= ${new Date(a)} AND captured_at <= ${new Date(b)}
       ORDER BY captured_at ASC`
  return rows.map(r => ({ t: r.captured_at.getTime(), lat: r.lat, lng: r.lng, speedKmh: r.speed_kmh }))
}

/**
 * One tracker's trip: the last two days first, then a day further back at a
 * time while its readings do not yet reach its last visit to the depot, up to
 * LOOKBACK_DAYS.
 */
async function trackerTrip(vehicleId: string, morl: MorlFence | null, window: { from: number; to: number }): Promise<{ trip: Trip | null; n: number }> {
  let start = window.to - FIRST_READ_MS
  let pings = await readPings(vehicleId, start, window.to)
  let r = depotTrip(pings, morl, window)
  for (let back = 3; back <= LOOKBACK_DAYS && r.need; back++) {
    pings = [...await readPings(vehicleId, start - DAY_MS, start - 1), ...pings]
    start -= DAY_MS
    r = depotTrip(pings, morl, window)
  }
  return { trip: r.trip, n: pings.length }
}

/** Runs `fn` over `items`, `limit` at a time; a failure is kept, not thrown. */
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

/**
 * The report at `to` (default now) for the tankers the page sends. A
 * permission-scoped caller's trackers are cut to the ones they may see.
 */
export async function getTankersReport(orgId: string, units: TankerUnit[], to: number, allowed: Set<string> | null = null): Promise<TankersReport> {
  const from = to - WINDOW_MS
  const scoped = units
    .map(u => ({ ...u, vehicleIds: u.vehicleIds.filter(id => !allowed || allowed.has(id)) }))
    .filter(u => u.vehicleIds.length)
  const ids = scoped.flatMap(u => u.vehicleIds)
  // Only a dedicated MORL fence completes this trip; the Movements report's
  // HQ-yard fallback must not mark a tanker at Menengai Yard as arrived.
  const [morl, moves] = await Promise.all([
    findMorlDestination(orgId),
    ids.length ? getMovementReport(orgId, { from, to }, new Set(ids)) : null,
  ])
  // Where each tracker was at the report time, as Movements names it
  const place = new Map((moves?.groups ?? []).flatMap(g => g.rows).map(row => [row.vehicleId, row]))

  const results = await settleLimited(ids, READ_AT_ONCE, id => trackerTrip(id, morl, { from, to }))
  const byId = new Map(ids.map((id, i) => [id, results[i]!]))

  const rows: TankerRow[] = []
  let failed = 0
  for (const u of scoped) {
    let best: { trip: Trip; n: number } | null = null
    let read = 0
    for (const id of u.vehicleIds) {
      const r = byId.get(id)!
      if (r.status === 'rejected') { logger.warn({ err: r.reason, orgId, vehicleId: id }, 'tankers report: readings could not be read'); continue }
      read++
      if (r.value.trip && (!best || r.value.n > best.n)) best = { trip: r.value.trip, n: r.value.n }
    }
    if (!read) { failed++; continue }
    if (!best) continue
    const location = best.trip.status === 'completed' ? 'MORL'
      : u.vehicleIds.map(id => place.get(id)).filter(Boolean)
        .sort((a, b) => (b!.lastAt ?? 0) - (a!.lastAt ?? 0))[0]?.location ?? ''
    rows.push({ unit: { key: u.key, plate: u.plate }, ...best.trip, location })
  }
  sortRows(rows)
  const slow = markSlow(rows)
  return { from, to, morl: morl?.name ?? null, tankers: scoped.length, failed, slow, rows }
}
