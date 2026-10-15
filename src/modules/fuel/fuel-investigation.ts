/**
 * A fuel alert's investigation map (operator, 2026-10-15): where it happened,
 * how the unit moved around it, and how far a vehicle could have got from
 * there. Three layers that must never be mistaken for one another:
 *
 *   point   WHERE the unit stood when the fuel began to fall — a recorded
 *           fix, with how far its time is from the fall and how much the unit
 *           moved during the fall, so the reader can judge how exact it is.
 *   track   the RECORDED fixes from an hour before the fall to an hour after
 *           it, from our own telemetry (the Wialon messages already ingested,
 *           so an investigation needs no live Wialon session). Silences of
 *           over six minutes are marked and never bridged.
 *   snapped the same track matched to roads (Google Roads API). Computed, so
 *           it is labelled as such and kept beside the record, never instead
 *           of it. Snapped one recorded stretch at a time: a silence is an
 *           unknown, not a road.
 *   zones   where a vehicle could DRIVE from the point in 5, 10 and 15
 *           minutes (Google Isochrones, no traffic: today's traffic says
 *           nothing about that hour). Search areas, not evidence.
 *
 * ## Kept once complete
 *
 * Evidence must not change under a reader's feet. Once the hour after the
 * fall is over, the investigation is written to disk and every later ask is
 * answered from that file — the same answer, whatever the database or Google
 * says later. Before then it is built on each ask and says it is provisional.
 * Disk, not a table: one gzip per alert under <REPORT_STORE_DIR>/../
 * investigations (or INVESTIGATION_STORE_DIR), beside the saved reports.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { haversineM, YARD_RADIUS_M } from '../../lib/dispatch-trip.js'
import { getOpenTripsCached } from '../dispatches/open-trips.cache.js'
import { NotFoundError } from '../../core/errors/errors.js'
import { findPlaybackFixes, type PlaybackPoint } from '../telemetry/telemetry.repository.js'
import { findTheftById } from './fuel.repository.js'
import { prisma } from '../../lib/prisma.js'
import {
  googleRoutingAvailable, isochrone, snapToRoads, nearestRoad, computeRoute, GoogleRoutingError, type LatLng,
} from '../../providers/google-routing/index.js'

const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)

/** Raised when the saved shape or the way it is built changes. */
export const INVESTIGATION_FORMAT = 1
export const AROUND_MS = 60 * 60_000
export const ZONE_MINUTES = [5, 10, 15] as const
/** How long after the window closes before it is saved: late fixes arrive. */
const SETTLE_MS = 10 * 60_000

export interface TrackPoint {
  t: number
  lat: number
  lng: number
  spd: number | null
  eng: boolean | null
  gapBefore?: true
}

export interface IncidentPoint {
  lat: number
  lng: number
  /** The fix the point was taken from. */
  fixAt: string
  /** Seconds from the start of the fall to that fix; negative = before it. */
  offsetS: number
  /** Furthest any fix during the fall was from the point, in metres. */
  movedM: number
  /** How the point was chosen, in words the map can show. */
  basis: string
}

export interface Zone { minutes: number; geometry: unknown }

/** Where the zones were measured from, when that is not the point itself. */
export interface ZoneOrigin extends LatLng {
  /** Metres from the incident point to this start. */
  offsetM: number
  basis: string
  /** When the unit was there, for a start taken from the track. */
  fixAt: string | null
}

export interface Investigation {
  format: number
  /** What it investigates: a fuel alert, or a unit halted mid-journey. */
  kind?: 'fuel' | 'halt' | 'trip'
  theftId: string
  vehicleId: string
  plate: string | null
  beganAt: string
  detectedAt: string
  litres: number
  window: { from: string; to: string }
  point: IncidentPoint | null
  track: TrackPoint[]
  truncated: boolean
  snapped: { segments: [number, number][][]; reason: string | null }
  zones: { minutes: number[]; items: Zone[]; reason: string | null; from: ZoneOrigin | null }
  builtAt: string
  /** True once saved: the answer will not change. */
  final: boolean
}

// ── the point ───────────────────────────────────────────────────────────────

/**
 * Where the unit stood when the fuel began to fall.
 *
 * The last fix at or before the start of the fall, when it is recent (within
 * 15 min) — the tank is read with the position, so that is where the unit was
 * as the level started down. Otherwise the first fix inside the fall. Failing
 * both, the fix nearest in time, said so.
 */
export function pickIncidentPoint(track: TrackPoint[], beganMs: number, detectedMs: number): IncidentPoint | null {
  if (!track.length) return null
  const RECENT_MS = 15 * 60_000
  let before: TrackPoint | null = null
  let inside: TrackPoint | null = null
  let nearest: TrackPoint = track[0]!
  for (const p of track) {
    if (p.t <= beganMs) before = p
    else if (!inside && p.t <= detectedMs) inside = p
    if (Math.abs(p.t - beganMs) < Math.abs(nearest.t - beganMs)) nearest = p
  }
  let chosen: TrackPoint
  let basis: string
  if (before && beganMs - before.t <= RECENT_MS) {
    chosen = before
    basis = 'Last recorded position as the fuel began to fall'
  } else if (inside) {
    chosen = inside
    basis = 'First recorded position during the fall'
  } else {
    chosen = nearest
    basis = 'Nearest recorded position in time; no fix close to the fall'
  }
  let movedM = 0
  for (const p of track) {
    if (p.t < beganMs || p.t > detectedMs) continue
    movedM = Math.max(movedM, haversineM(chosen, p))
  }
  return {
    lat: chosen.lat, lng: chosen.lng,
    fixAt: new Date(chosen.t).toISOString(),
    offsetS: Math.round((chosen.t - beganMs) / 1000),
    movedM: Math.round(movedM),
    basis,
  }
}

/** Recorded stretches: split wherever the unit went quiet. */
export function stretches(track: TrackPoint[]): TrackPoint[][] {
  const out: TrackPoint[][] = []
  for (const p of track) {
    if (p.gapBefore || !out.length) out.push([p])
    else out[out.length - 1]!.push(p)
  }
  return out
}

/** Consecutive fixes at the same spot add nothing to a road match. */
function moving(seg: TrackPoint[]): TrackPoint[] {
  const out: TrackPoint[] = []
  for (const p of seg) {
    const last = out[out.length - 1]
    if (!last || haversineM(last, p) >= 15) out.push(p)
  }
  return out
}

// ── storage ─────────────────────────────────────────────────────────────────

const base = () => process.env['INVESTIGATION_STORE_DIR']
  || (env.REPORT_STORE_DIR ? path.join(path.dirname(env.REPORT_STORE_DIR), 'investigations') : '')
  || path.resolve(process.cwd(), '.cache', 'investigations')
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')
const fileOf = (orgId: string, theftId: string) =>
  path.join(base(), `v${INVESTIGATION_FORMAT}`, safe(orgId), `${safe(theftId)}.json.gz`)

async function readSaved(orgId: string, theftId: string): Promise<Investigation | null> {
  try {
    return JSON.parse((await gunzip(await fs.readFile(fileOf(orgId, theftId)))).toString('utf8')) as Investigation
  } catch { return null }
}

async function save(orgId: string, inv: Investigation): Promise<void> {
  const file = fileOf(orgId, inv.theftId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmp, await gzip(JSON.stringify(inv)))
  await fs.rename(tmp, file)
}

// ── build ───────────────────────────────────────────────────────────────────

const inflight = new Map<string, Promise<Investigation>>()
const STILL = 'The unit did not move in this window'

const why = (err: unknown) =>
  !(err instanceof GoogleRoutingError) ? 'Google could not be reached'
    : err.message.startsWith('The point') ? err.message
    : OFF_ROAD.test(err.message) ? 'The point is too far from a road for Google to measure from'
    : `Google: ${err.message}`

/** Google's answer when the start is too far from any road. */
const OFF_ROAD = /road segment|snapping tolerance|NotFound/i

/** Fast enough that the unit must have been on a road. */
const ON_ROAD_KMH = 20

/**
 * The 5/10/15-minute zones from the point.
 *
 * A point standing off-road (a machine in a field) is refused by the
 * Isochrones API. The zones are then measured from, in order: the nearest
 * road Google knows (nearestRoads, which only searches a few tens of metres),
 * else the recorded fix nearest in time to the fall at which the unit was
 * driving at road speed. `zones.from` says which, where, and how far from the
 * point, so the map never passes a road start off as the incident.
 */
async function zonesFrom(point: LatLng, track: TrackPoint[], beganMs: number, zones: Investigation['zones']): Promise<Zone[]> {
  const run = (o: LatLng) => Promise.all(ZONE_MINUTES.map(async (m) =>
    ({ minutes: m, geometry: await isochrone(o, m * 60, { traffic: false }) })))
  try {
    return await run(point)
  } catch (err) {
    if (!(err instanceof GoogleRoutingError) || !OFF_ROAD.test(err.message)) throw err
  }
  const road = await nearestRoad(point).catch(() => null)
  const tried: { at: LatLng; basis: string; fixAt: string | null }[] = []
  if (road) tried.push({ at: road, basis: 'The nearest road to the point', fixAt: null })
  const driving = track
    .filter((p) => (p.spd ?? 0) >= ON_ROAD_KMH)
    .sort((a, b) => Math.abs(a.t - beganMs) - Math.abs(b.t - beganMs))
  if (driving[0]) {
    const p = driving[0]
    tried.push({ at: p, basis: 'Where the unit was driving on a road nearest in time to the fall', fixAt: new Date(p.t).toISOString() })
  }
  for (const c of tried) {
    try {
      const out = await run(c.at)
      zones.from = { lat: c.at.lat, lng: c.at.lng, offsetM: Math.round(haversineM(point, c.at)), basis: c.basis, fixAt: c.fixAt }
      return out
    } catch (err) {
      if (!(err instanceof GoogleRoutingError) || !OFF_ROAD.test(err.message)) throw err
    }
  }
  throw new GoogleRoutingError('The point is off-road, and no road start near it could be found', 404)
}

async function build(orgId: string, theftId: string, now: number): Promise<Investigation> {
  const theft = await findTheftById(orgId, theftId)
  if (!theft) throw new NotFoundError('Fuel theft')
  const beganMs = theft.beganAt.getTime()
  const detectedMs = Math.max(beganMs, theft.detectedAt.getTime())
  const from = new Date(beganMs - AROUND_MS)
  const toMs = detectedMs + AROUND_MS
  const to = new Date(Math.min(toMs, now))

  const fixes = await findPlaybackFixes(theft.vehicleId, orgId, from, to)
  const track: TrackPoint[] = (fixes?.points ?? []).map((p: PlaybackPoint) => ({
    t: p.t, lat: p.lat, lng: p.lng, spd: p.spd ?? null, eng: p.eng ?? null,
    ...(p.gapBefore ? { gapBefore: true as const } : {}),
  }))
  const point = pickIncidentPoint(track, beganMs, detectedMs)

  const on = googleRoutingAvailable()
  const zones: Investigation['zones'] = { minutes: [...ZONE_MINUTES], items: [], reason: null, from: null }
  const snapped: Investigation['snapped'] = { segments: [], reason: null }
  if (!on) {
    zones.reason = 'Drive zones are switched off on this server'
    snapped.reason = 'Road matching is switched off on this server'
  } else {
    const [z, s] = await Promise.allSettled([
      point ? zonesFrom(point, track, beganMs, zones) : Promise.resolve([]),
      Promise.all(stretches(track).map((seg) => moving(seg)).filter((seg) => seg.length >= 2).map((seg) => snapToRoads(seg))),
    ])
    if (!point) zones.reason = 'No recorded position near the fall'
    else if (z.status === 'fulfilled') zones.items = z.value.filter((x) => x.geometry != null)
    else { zones.reason = why(z.reason); logger.warn({ err: z.reason, theftId }, 'Investigation: isochrones failed') }
    if (s.status === 'fulfilled') snapped.segments = s.value.filter((seg) => seg.length >= 2)
    else { snapped.reason = why(s.reason); logger.warn({ err: s.reason, theftId }, 'Investigation: snap to roads failed') }
    if (!snapped.reason && !snapped.segments.length) snapped.reason = STILL
  }

  // Final only when the whole window is past AND every Google layer came
  // back: a failed call would otherwise be frozen into the evidence.
  const complete = now >= toMs + SETTLE_MS
  const zonesOk = !on || !point || zones.items.length > 0
  const snapOk = !on || !snapped.reason || snapped.reason === STILL
  const final = complete && zonesOk && snapOk
  return {
    format: INVESTIGATION_FORMAT,
    theftId: theft.id,
    vehicleId: theft.vehicleId,
    plate: theft.vehicle?.name ?? null,
    beganAt: theft.beganAt.toISOString(),
    detectedAt: theft.detectedAt.toISOString(),
    litres: Math.round(theft.stolenMl / 100) / 10,
    window: { from: from.toISOString(), to: to.toISOString() },
    point,
    track,
    truncated: fixes?.truncated ?? false,
    snapped,
    zones,
    builtAt: new Date(now).toISOString(),
    final,
  }
}

export async function getInvestigation(orgId: string, theftId: string): Promise<Investigation> {
  const saved = await readSaved(orgId, theftId)
  if (saved) return saved
  const key = `${orgId}/${theftId}`
  const running = inflight.get(key)
  if (running) return running
  const p = (async () => {
    const inv = await build(orgId, theftId, Date.now())
    if (inv.final) await save(orgId, inv).catch((err) => logger.warn({ err, theftId }, 'Investigation: could not save'))
    return inv
  })().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

// ── a halted unit ───────────────────────────────────────────────────────────

/** How far back from the halt the route is drawn. */
export const HALT_BEFORE_MS = 60 * 60_000
/** A long halt is drawn up to this long after it began. */
const HALT_AFTER_CAP_MS = 6 * 60 * 60_000
/** A halt's answer is rebuilt at most this often: the halt is still going on. */
const HALT_TTL_MS = 5 * 60_000
/** Drive zones from the same spot are reused this long. */
const ZONE_TTL_MS = 60 * 60_000

const haltCache = new Map<string, { at: number; inv: Investigation }>()
const zoneCache = new Map<string, { at: number; zones: Investigation['zones'] }>()
const remember = <V>(m: Map<string, V>, k: string, v: V) => {
  m.delete(k); m.set(k, v)
  if (m.size > 2_000) m.delete(m.keys().next().value as string)
}

/**
 * The same investigation for a unit halted mid-journey (the map's Halted
 * list, operator 2026-10-15): where it stopped, its route from an hour before
 * the halt to now, the stops on it, and the 5/10/15-minute drive zones from
 * where it stands. Never saved: the halt is still going on. Built at most
 * every five minutes per halt, zones reused per spot for an hour.
 */
export async function getHaltInvestigation(orgId: string, vehicleId: string, sinceMs: number): Promise<Investigation> {
  const key = `${orgId}/${vehicleId}/${Math.floor(sinceMs / 60_000)}`
  const hit = haltCache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < HALT_TTL_MS) return hit.inv
  const running = inflight.get(`halt:${key}`)
  if (running) return running
  const p = (async () => {
    const vehicle = await prisma.vehicle.findFirst({ where: { id: vehicleId, organisationId: orgId }, select: { id: true, name: true } })
    if (!vehicle) throw new NotFoundError('Vehicle')
    const from = new Date(sinceMs - HALT_BEFORE_MS)
    const to = new Date(Math.min(now, sinceMs + HALT_AFTER_CAP_MS))
    const fixes = await findPlaybackFixes(vehicleId, orgId, from, to)
    const track: TrackPoint[] = (fixes?.points ?? []).map((pt: PlaybackPoint) => ({
      t: pt.t, lat: pt.lat, lng: pt.lng, spd: pt.spd ?? null, eng: pt.eng ?? null,
      ...(pt.gapBefore ? { gapBefore: true as const } : {}),
    }))
    const point = pickIncidentPoint(track, sinceMs, sinceMs)
    if (point) point.basis = 'Last recorded position as the unit halted'

    let zones: Investigation['zones'] = { minutes: [...ZONE_MINUTES], items: [], reason: null, from: null }
    if (!googleRoutingAvailable()) zones.reason = 'Drive zones are switched off on this server'
    else if (!point) zones.reason = 'No recorded position near the halt'
    else {
      const zk = `${point.lat.toFixed(4)},${point.lng.toFixed(4)}`
      const z = zoneCache.get(zk)
      if (z && now - z.at < ZONE_TTL_MS) zones = z.zones
      else {
        try {
          zones.items = (await zonesFrom(point, track, sinceMs, zones)).filter((x) => x.geometry != null)
          remember(zoneCache, zk, { at: now, zones })
        } catch (err) {
          zones.reason = why(err)
          logger.warn({ err, vehicleId }, 'Halt investigation: isochrones failed')
        }
      }
    }

    const inv: Investigation = {
      format: INVESTIGATION_FORMAT,
      kind: 'halt',
      theftId: `halt:${vehicleId}:${sinceMs}`,
      vehicleId,
      plate: vehicle.name ?? null,
      beganAt: new Date(sinceMs).toISOString(),
      detectedAt: new Date(sinceMs).toISOString(),
      litres: 0,
      window: { from: from.toISOString(), to: to.toISOString() },
      point,
      track,
      truncated: fixes?.truncated ?? false,
      snapped: { segments: [], reason: 'Not drawn for a halt' },
      zones,
      builtAt: new Date(now).toISOString(),
      final: false,
    }
    remember(haltCache, key, { at: now, inv })
    return inv
  })().finally(() => inflight.delete(`halt:${key}`))
  inflight.set(`halt:${key}`, p)
  return p
}

// ── a unit's trip from its factory ──────────────────────────────────────────

/** How far back the trip is looked for without a dispatch. */
export const TRIP_LOOKBACK_MS = 12 * 60 * 60_000
/** A dispatch's track starts this long before it was raised: a cane run's
 *  clock is the clerk's, and the truck may already be rolling. */
const TRIP_LEAD_MS = 2 * 60 * 60_000
/** Never more than this much track. */
const TRIP_MAX_MS = 36 * 60 * 60_000
/** Shown either side of leaving and coming back. */
const TRIP_PAD_MS = 10 * 60_000
/** A trip is rebuilt at most this often: the unit is still on it. */
const TRIP_TTL_MS = 2 * 60_000
/** A planned road between two fixed places changes rarely. */
const PLAN_TTL_MS = 24 * 60 * 60_000
/** Road matching is asked for on demand and reused this long. */
const SNAP_TTL_MS = 10 * 60_000
/** Fixes fed to the road match are at least this far apart: Google fills
 *  the road between them (interpolate), and it needs them under 300 m. */
const SNAP_SPACING_M = 120

export interface TripPlace extends LatLng { name: string | null }

export interface TripInfo {
  /** Where the run starts: the dispatch's gate, else the organisation's yard. */
  origin: TripPlace | null
  /** The dispatch's destination, when it names a place we can put on a map. */
  destination: (TripPlace & { source: 'stated' | 'measured' }) | null
  /** Named on the dispatch, placed or not. */
  destinationName: string | null
  dispatch: {
    externalId: string
    dispatchedAt: string
    driverName: string | null
    serialNumber: string | null
    status: string
    kind: 'SALES' | 'CANE'
  } | null
  /** When the unit left the origin, and came back, read from the track. */
  departedAt: string | null
  returnedAt: string | null
  /** First fix at the destination after the dispatch (dispatch-trip). */
  arrivedAt: string | null
  /** True while the unit stands inside the origin's yard. */
  atOrigin: boolean
  /** Google's road from origin to destination: the run as planned. */
  planned: { path: [number, number][]; distanceM: number; durationS: number } | null
  plannedReason: string | null
}

export type TripInvestigation = Investigation & { trip: TripInfo }

const tripCache = new Map<string, { at: number; inv: TripInvestigation }>()
const planCache = new Map<string, { at: number; plan: TripInfo['planned']; reason: string | null }>()
const snapCache = new Map<string, { at: number; snapped: Investigation['snapped'] }>()
const tripInflight = new Map<string, Promise<TripInvestigation>>()

/**
 * The outing the trip is about, as indices into `track`.
 *
 * `departed` is the first fix outside `radiusM` of the origin after a fix
 * inside it — with a dispatch, the first such exit at or after `notBeforeMs`
 * (the dispatch less a lead, the clerk's clock being loose); without one, the
 * latest exit. A dispatched unit already out when the track opens departed
 * before it, so the outing starts at the first fix. `returned` is the first
 * fix back inside after that, or null while it is still out.
 */
export function tripLeg(
  track: { t: number; lat: number; lng: number }[], origin: LatLng, radiusM: number, notBeforeMs: number | null,
): { departed: number | null; returned: number | null; atOrigin: boolean } {
  const inside = track.map((p) => haversineM(origin, p) <= radiusM)
  const exits: number[] = []
  for (let i = 1; i < track.length; i++) if (inside[i - 1] && !inside[i]) exits.push(i)
  const atOrigin = inside.length > 0 && inside[inside.length - 1] === true
  let departed: number | null
  if (notBeforeMs != null) {
    departed = exits.find((i) => track[i]!.t >= notBeforeMs) ?? null
    if (departed == null && track.length > 0 && !inside[0]) departed = 0
  } else {
    departed = exits.length ? exits[exits.length - 1]! : null
  }
  let returned: number | null = null
  if (departed != null) {
    for (let i = departed + 1; i < track.length; i++) if (inside[i]) { returned = i; break }
  }
  return { departed, returned, atOrigin }
}

const tidyName = (s: string | null) => s?.replace(/\s+(Limited|Ltd\.?)$/i, '').trim() || null

async function plannedRoad(origin: LatLng, dest: LatLng, now: number): Promise<{ plan: TripInfo['planned']; reason: string | null }> {
  const key = `${origin.lat.toFixed(4)},${origin.lng.toFixed(4)}>${dest.lat.toFixed(4)},${dest.lng.toFixed(4)}`
  const hit = planCache.get(key)
  if (hit && now - hit.at < PLAN_TTL_MS) return hit
  try {
    const r = await computeRoute(origin, dest)
    const out = r
      ? { plan: { path: r.path, distanceM: r.distanceM, durationS: Math.round(r.staticDurationS || r.durationS) }, reason: null }
      : { plan: null, reason: 'Google found no road between the two' }
    remember(planCache, key, { at: now, ...out })
    return out
  } catch (err) {
    logger.warn({ err }, 'Trip investigation: planned road failed')
    return { plan: null, reason: why(err) }
  }
}

/**
 * A unit's run from its factory (operator, 2026-10-15, for Sukari: "the start
 * is at the Sukari Industries; some units we can capture their destination,
 * which is a webhook from FactorySuite"): where it left from, where the
 * dispatch says it is going, the road Google would take between the two, the
 * route it actually drove since it left (with its stops), and the 5/10/15-
 * minute drive zones from where it is now.
 *
 * Origin: the dispatch's gate (factory_code), else the organisation's yard.
 * A unit with no dispatch still gets its latest outing from the yard. Built
 * at most every two minutes; the road match (`snap`) only when asked for,
 * since it is billed per hundred fixes and a day's run is thousands.
 */
export async function getTripInvestigation(
  orgId: string, vehicleId: string, opts: { snap?: boolean } = {},
): Promise<TripInvestigation> {
  const now = Date.now()
  const key = `${orgId}/${vehicleId}`
  let base = tripCache.get(key)
  if (!base || now - base.at >= TRIP_TTL_MS) {
    let running = tripInflight.get(key)
    if (!running) {
      running = buildTrip(orgId, vehicleId, now).finally(() => tripInflight.delete(key))
      tripInflight.set(key, running)
    }
    base = { at: now, inv: await running }
    remember(tripCache, key, base)
  }
  const inv = base.inv
  if (!opts.snap) return inv
  return { ...inv, snapped: await snapTrip(key, inv, now) }
}

async function snapTrip(key: string, inv: Investigation, now: number): Promise<Investigation['snapped']> {
  if (!googleRoutingAvailable()) return { segments: [], reason: 'Road matching is switched off on this server' }
  const sk = `${key}/${inv.track[0]?.t ?? 0}/${inv.track[inv.track.length - 1]?.t ?? 0}`
  const hit = snapCache.get(sk)
  if (hit && now - hit.at < SNAP_TTL_MS) return hit.snapped
  const thin = (seg: TrackPoint[]) => {
    const out: TrackPoint[] = []
    for (const p of seg) {
      const prev = out[out.length - 1]
      if (!prev || haversineM(prev, p) >= SNAP_SPACING_M) out.push(p)
    }
    const end = seg[seg.length - 1]
    const tail = out[out.length - 1]
    if (end && tail && tail !== end && haversineM(tail, end) >= 15) out.push(end)
    return out
  }
  let snapped: Investigation['snapped']
  try {
    const segments = (await Promise.all(stretches(inv.track).map(thin).filter((s) => s.length >= 2).map((s) => snapToRoads(s))))
      .filter((s) => s.length >= 2)
    snapped = { segments, reason: segments.length ? null : STILL }
  } catch (err) {
    logger.warn({ err, vehicleId: inv.vehicleId }, 'Trip investigation: snap to roads failed')
    snapped = { segments: [], reason: why(err) }
  }
  remember(snapCache, sk, { at: now, snapped })
  return snapped
}

async function buildTrip(orgId: string, vehicleId: string, now: number): Promise<TripInvestigation> {
  const [vehicle, open] = await Promise.all([
    prisma.vehicle.findFirst({ where: { id: vehicleId, organisationId: orgId }, select: { id: true, name: true } }),
    getOpenTripsCached(orgId),
  ])
  if (!vehicle) throw new NotFoundError('Vehicle')
  const run = open.byVehicle.get(vehicleId) ?? null

  // The gate the run left from, named as the operator knows it: Sukari's own
  // gate is "Sukari Industries", not the provider's site label "Ndhiwa".
  let origin: TripPlace | null = null
  if (run?.originLat != null && run.originLng != null) {
    const gate = { lat: run.originLat, lng: run.originLng }
    const ownYard = open.yard != null && haversineM(open.yard, gate) < 3_000
    origin = { ...gate, name: ownYard ? tidyName(open.yardName) : run.originName }
  } else if (open.yard) {
    origin = { ...open.yard, name: tidyName(open.yardName) }
  }

  const dispatchedMs = run ? Date.parse(run.dispatchedAt) : null
  const notBefore = dispatchedMs != null ? dispatchedMs - TRIP_LEAD_MS : null
  const fromMs = Math.max(now - TRIP_MAX_MS, notBefore ?? now - TRIP_LOOKBACK_MS)
  const fixes = await findPlaybackFixes(vehicleId, orgId, new Date(fromMs), new Date(now + 60_000))
  let track: TrackPoint[] = (fixes?.points ?? []).map((pt: PlaybackPoint) => ({
    t: pt.t, lat: pt.lat, lng: pt.lng, spd: pt.spd ?? null, eng: pt.eng ?? null,
    ...(pt.gapBefore ? { gapBefore: true as const } : {}),
  }))

  let departedAt: string | null = null
  let returnedAt: string | null = null
  let atOrigin = false
  if (origin && track.length) {
    const leg = tripLeg(track, origin, YARD_RADIUS_M, notBefore)
    atOrigin = leg.atOrigin
    if (leg.departed != null) {
      const d = track[leg.departed]!.t
      const r = leg.returned != null ? track[leg.returned]!.t : null
      departedAt = new Date(d).toISOString()
      returnedAt = r != null ? new Date(r).toISOString() : null
      const lo = d - TRIP_PAD_MS
      const hi = r != null ? r + TRIP_PAD_MS : Infinity
      track = track.filter((p) => p.t >= lo && p.t <= hi)
      const first = track[0]
      if (first?.gapBefore) track[0] = { t: first.t, lat: first.lat, lng: first.lng, spd: first.spd, eng: first.eng }
    }
  }

  // Where it is now (or where it came back to): the zones' start.
  const last = track[track.length - 1] ?? null
  const point: IncidentPoint | null = last
    ? { lat: last.lat, lng: last.lng, fixAt: new Date(last.t).toISOString(), offsetS: 0, movedM: 0,
        basis: returnedAt ? 'Back at the yard' : 'Latest recorded position' }
    : null

  let zones: Investigation['zones'] = { minutes: [...ZONE_MINUTES], items: [], reason: null, from: null }
  if (!googleRoutingAvailable()) zones.reason = 'Drive zones are switched off on this server'
  else if (!point || !last) zones.reason = 'No recorded position for this unit'
  else {
    const zk = `${point.lat.toFixed(4)},${point.lng.toFixed(4)}`
    const z = zoneCache.get(zk)
    if (z && now - z.at < ZONE_TTL_MS) zones = z.zones
    else {
      try {
        zones.items = (await zonesFrom(point, track, last.t, zones)).filter((x) => x.geometry != null)
        remember(zoneCache, zk, { at: now, zones })
      } catch (err) {
        zones.reason = why(err)
        logger.warn({ err, vehicleId }, 'Trip investigation: isochrones failed')
      }
    }
  }

  const destination: TripInfo['destination'] = run?.destinationLat != null && run.destinationLng != null
    ? { lat: run.destinationLat, lng: run.destinationLng, name: run.destination,
        source: run.destinationSource === 'stated' ? 'stated' : 'measured' }
    : null
  let planned: TripInfo['planned'] = null
  let plannedReason: string | null = null
  if (!run) plannedReason = 'No open dispatch for this unit'
  else if (!destination) plannedReason = run.destination ? `${run.destination} has not been placed on the map yet` : 'The dispatch names no destination'
  else if (!origin) plannedReason = 'The yard this run left from is not known'
  else if (!googleRoutingAvailable()) plannedReason = 'Routing is switched off on this server'
  else ({ plan: planned, reason: plannedReason } = await plannedRoad(origin, destination, now))

  const beganMs = departedAt ? Date.parse(departedAt) : dispatchedMs ?? track[0]?.t ?? now
  return {
    format: INVESTIGATION_FORMAT,
    kind: 'trip',
    theftId: `trip:${vehicleId}`,
    vehicleId,
    plate: vehicle.name ?? null,
    beganAt: new Date(beganMs).toISOString(),
    detectedAt: new Date(beganMs).toISOString(),
    litres: 0,
    window: { from: new Date(track[0]?.t ?? fromMs).toISOString(), to: new Date(last?.t ?? now).toISOString() },
    point,
    track,
    truncated: fixes?.truncated ?? false,
    snapped: { segments: [], reason: 'Asked for separately' },
    zones,
    builtAt: new Date(now).toISOString(),
    final: false,
    trip: {
      origin,
      destination,
      destinationName: run?.destination ?? null,
      dispatch: run ? {
        externalId: run.externalId,
        dispatchedAt: run.dispatchedAt,
        driverName: run.driverName || null,
        serialNumber: run.serialNumber,
        status: run.status,
        kind: run.departureIsSignOut ? 'SALES' : 'CANE',
      } : null,
      departedAt,
      returnedAt,
      arrivedAt: run?.arrivedAt ?? null,
      atOrigin,
      planned,
      plannedReason,
    },
  }
}
