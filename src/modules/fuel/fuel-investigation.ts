/**
 * A fuel alert's investigation map (operator, 2026-10-15): where it happened,
 * and how the unit moved around it. Layers that must never be mistaken for
 * one another:
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
 *
 * The 5/10/15-minute drive zones (Google Isochrones) were removed on request,
 * 2026-10-19.
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
import { WEIGHBRIDGES } from '../weighments/weighbridge.geography.js'
import { NotFoundError } from '../../core/errors/errors.js'
import { findPlaybackFixes, type PlaybackPoint } from '../telemetry/telemetry.repository.js'
import { findTheftById } from './fuel.repository.js'
import { prisma } from '../../lib/prisma.js'
import {
  googleRoutingAvailable, snapToRoads, computeRoute, GoogleRoutingError, type LatLng,
} from '../../providers/google-routing/index.js'

const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)

/** Raised when the saved shape or the way it is built changes. */
export const INVESTIGATION_FORMAT = 1
export const AROUND_MS = 60 * 60_000
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
  !(err instanceof GoogleRoutingError) ? 'Google could not be reached' : `Google: ${err.message}`

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
  const snapped: Investigation['snapped'] = { segments: [], reason: null }
  if (!on) {
    snapped.reason = 'Road matching is switched off on this server'
  } else {
    try {
      const segs = await Promise.all(stretches(track).map((seg) => moving(seg)).filter((seg) => seg.length >= 2).map((seg) => snapToRoads(seg)))
      snapped.segments = segs.filter((seg) => seg.length >= 2)
    } catch (err) {
      snapped.reason = why(err)
      logger.warn({ err, theftId }, 'Investigation: snap to roads failed')
    }
    if (!snapped.reason && !snapped.segments.length) snapped.reason = STILL
  }

  // Final only when the whole window is past AND the road match came back: a
  // failed call would otherwise be frozen into the evidence.
  const complete = now >= toMs + SETTLE_MS
  const snapOk = !on || !snapped.reason || snapped.reason === STILL
  const final = complete && snapOk
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

const haltCache = new Map<string, { at: number; inv: Investigation }>()
const remember = <V>(m: Map<string, V>, k: string, v: V) => {
  m.delete(k); m.set(k, v)
  if (m.size > 2_000) m.delete(m.keys().next().value as string)
}

/**
 * The same investigation for a unit halted mid-journey (the map's Halted
 * list, operator 2026-10-15): where it stopped, its route from an hour before
 * the halt to now and the stops on it. Never saved: the halt is still going
 * on. Built at most every five minutes per halt.
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
/** A unit out of its yard longer than the lookback is followed back this far
 *  (Menengai's tankers are out for days); its last visit is looked for over
 *  TRIP_SEEN_MS. */
const TRIP_LONG_MS = 48 * 60 * 60_000
const TRIP_SEEN_MS = 7 * 24 * 60 * 60_000
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
  /** Last fix inside the origin, when that is older than the track shown. */
  lastAtOriginAt: string | null
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

/** Geofences that name a place a run starts from. */
const HOME_FENCE = '(yard|factory|mill|depot|(^| )hq( |$))'
const SITES_TTL_MS = 60 * 60_000
const sitesCache = new Map<string, { at: number; sites: TripPlace[] }>()

/**
 * The yards and factories an organisation's runs start from, for a fleet
 * with no single yard on record (operator, 2026-10-15: West Kenya, Kabras
 * and Menengai, "the same" as Sukari): its own geofences named as a yard,
 * factory, mill, depot or HQ — Kabras Sugar Factory, Naitiri Factory,
 * Menengai Yard (Nakuru HQ). Each at its fence's centre. Fences within a
 * kilometre of one another are one place (Menengai draws its yard three
 * times); the operator's mixed-case name is kept over a shouted code.
 *
 * A fleet with no such fence (Nzoia, operator 2026-10-15: "turn it on for
 * Nzoia too") starts from its factory yard's weighbridges instead — Nzoia's
 * CW and HD bridges are operator-given, and are one place.
 */
export async function homeSites(orgId: string, now: number): Promise<TripPlace[]> {
  const hit = sitesCache.get(orgId)
  if (hit && now - hit.at < SITES_TTL_MS) return hit.sites
  const rows = await prisma.$queryRawUnsafe<{ name: string; lat: number; lng: number }[]>(
    `SELECT name, ST_Y(ST_Centroid(geom::geometry)) AS lat, ST_X(ST_Centroid(geom::geometry)) AS lng
       FROM geofences WHERE organisation_id = $1 AND geom IS NOT NULL AND name ~* '${HOME_FENCE}'`,
    orgId,
  ).catch((err) => { logger.warn({ err, orgId }, 'Trip investigation: home sites'); return [] })
  const shout = (n: string) => n === n.toUpperCase()
  const ranked = rows
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng))
    .sort((a, b) => Number(shout(a.name)) - Number(shout(b.name)) || b.name.length - a.name.length)
  if (ranked.length === 0) {
    const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { code: true } })
    const title = (n: string) => n.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_m, pre: string, c: string) => pre + c.toUpperCase())
    for (const w of WEIGHBRIDGES) {
      if (org?.code && w.orgCode === org.code) ranked.push({ name: `${title(w.centerName)} Factory Yard`, lat: w.lat, lng: w.lng })
    }
  }
  const sites: TripPlace[] = []
  for (const r of ranked) {
    if (sites.some((s) => haversineM(s, r) < 1_000)) continue
    sites.push({ lat: Number(r.lat), lng: Number(r.lng), name: r.name.trim() })
  }
  remember(sitesCache, orgId, { at: now, sites })
  return sites
}

/** When the unit was last inside any of `sites` (7 days), and which. */
async function lastInside(vehicleId: string, sites: TripPlace[], now: number): Promise<{ site: TripPlace; at: number } | null> {
  if (!/^[a-z0-9]{20,32}$/i.test(vehicleId)) return null
  const since = new Date(now - TRIP_SEEN_MS)
  const deg = (YARD_RADIUS_M * 1.5) / 111_320
  const found = await Promise.all(sites.map(async (site) => {
    const rows = await prisma.$queryRawUnsafe<{ at: Date | null }[]>(
      `SELECT max(captured_at) AS at FROM vehicle_telemetries
        WHERE vehicle_id = $1 AND captured_at >= $2
          AND lat BETWEEN $3::float8 - $5::float8 AND $3::float8 + $5::float8
          AND lng BETWEEN $4::float8 - $5::float8 AND $4::float8 + $5::float8
          AND 2 * 6371000 * asin(sqrt(power(sin(radians(lat - $3::float8) / 2), 2)
              + cos(radians($3::float8)) * cos(radians(lat)) * power(sin(radians(lng - $4::float8) / 2), 2))) <= $6::float8`,
      vehicleId, since, site.lat, site.lng, deg, YARD_RADIUS_M,
    ).catch((err) => { logger.warn({ err, vehicleId }, 'Trip investigation: last visit'); return [] })
    const at = rows[0]?.at
    return at ? { site, at: at.getTime() } : null
  }))
  return found.filter((x) => x != null).sort((a, b) => b!.at - a!.at)[0] ?? null
}

/**
 * Of several yards, the one this outing started from: the one the unit most
 * recently drove out of, else the one it stands in now. Null when the track
 * never touches any of them.
 */
export function startingSite<S extends LatLng>(track: { t: number; lat: number; lng: number }[], sites: S[], radiusM: number): S | null {
  let best: S | null = null
  let bestT = -Infinity
  let standing: S | null = null
  for (const site of sites) {
    const leg = tripLeg(track, site, radiusM, null)
    if (leg.departed != null && track[leg.departed]!.t > bestT) { best = site; bestT = track[leg.departed]!.t }
    if (leg.atOrigin) standing = site
  }
  return best ?? standing
}

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
 * route it actually drove since it left, with its stops.
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
  // No gate on the dispatch and no yard on record: the fleet's own yards and
  // factories, chosen once the track is read.
  const sites = origin ? [] : await homeSites(orgId, now)

  const dispatchedMs = run ? Date.parse(run.dispatchedAt) : null
  const notBefore = dispatchedMs != null ? dispatchedMs - TRIP_LEAD_MS : null
  const fromMs = Math.max(now - TRIP_MAX_MS, notBefore ?? now - TRIP_LOOKBACK_MS)
  const fixes = await findPlaybackFixes(vehicleId, orgId, new Date(fromMs), new Date(now + 60_000))
  const toTrack = (f: typeof fixes): TrackPoint[] => (f?.points ?? []).map((pt: PlaybackPoint) => ({
    t: pt.t, lat: pt.lat, lng: pt.lng, spd: pt.spd ?? null, eng: pt.eng ?? null,
    ...(pt.gapBefore ? { gapBefore: true as const } : {}),
  }))
  let track = toTrack(fixes)
  let truncated = fixes?.truncated ?? false

  // Out of its yard for longer than the lookback (no dispatch to say when
  // it left): find its last visit, and read the track from there when that
  // is within two days.
  let lastAtOriginAt: string | null = null
  const homes = origin ? [origin] : sites
  if (!run && homes.length && !homes.some((h) => track.some((pt) => haversineM(h, pt) <= YARD_RADIUS_M))) {
    const seen = await lastInside(vehicleId, homes, now)
    if (seen) {
      if (!origin) origin = seen.site
      if (now - seen.at <= TRIP_LONG_MS) {
        const more = await findPlaybackFixes(vehicleId, orgId, new Date(seen.at - TRIP_PAD_MS), new Date(now + 60_000))
        track = toTrack(more)
        truncated = more?.truncated ?? false
      } else {
        lastAtOriginAt = new Date(seen.at).toISOString()
      }
    }
  }

  let departedAt: string | null = null
  let returnedAt: string | null = null
  let atOrigin = false
  if (!origin && sites.length) origin = startingSite(track, sites, YARD_RADIUS_M) ?? (sites.length === 1 ? sites[0]! : null)
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

  // Where it is now (or where it came back to).
  const last = track[track.length - 1] ?? null
  const point: IncidentPoint | null = last
    ? { lat: last.lat, lng: last.lng, fixAt: new Date(last.t).toISOString(), offsetS: 0, movedM: 0,
        basis: returnedAt ? 'Back at the yard' : 'Latest recorded position' }
    : null

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
    truncated,
    snapped: { segments: [], reason: 'Asked for separately' },
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
      lastAtOriginAt,
      arrivedAt: run?.arrivedAt ?? null,
      atOrigin,
      planned,
      plannedReason,
    },
  }
}
