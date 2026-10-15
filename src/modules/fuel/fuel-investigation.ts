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
import { haversineM } from '../../lib/dispatch-trip.js'
import { NotFoundError } from '../../core/errors/errors.js'
import { findPlaybackFixes, type PlaybackPoint } from '../telemetry/telemetry.repository.js'
import { findTheftById } from './fuel.repository.js'
import {
  googleRoutingAvailable, isochrone, snapToRoads, GoogleRoutingError,
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

export interface Investigation {
  format: number
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
  zones: { minutes: number[]; items: Zone[]; reason: string | null }
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
  err instanceof GoogleRoutingError ? `Google: ${err.message}` : 'Google could not be reached'

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
  const zones: Investigation['zones'] = { minutes: [...ZONE_MINUTES], items: [], reason: null }
  const snapped: Investigation['snapped'] = { segments: [], reason: null }
  if (!on) {
    zones.reason = 'Drive zones are switched off on this server'
    snapped.reason = 'Road matching is switched off on this server'
  } else {
    const [z, s] = await Promise.allSettled([
      point
        ? Promise.all(ZONE_MINUTES.map(async (m) => ({ minutes: m, geometry: await isochrone(point, m * 60, { traffic: false }) })))
        : Promise.resolve([]),
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
