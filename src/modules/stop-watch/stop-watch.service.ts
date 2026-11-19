/**
 * The stop watch, on the server (operator, 10 Nov 2026: the unauthorised stop
 * notifications "should be server generated"). Every CHECK_MS it reads
 * Menengai's fleet snapshot and flags units standing in a no-go zone or
 * stopped outside every authorised place (stop-watch.rules). Each new flag is
 * a toast to every connected person who may see that unit, once: the flags
 * already announced are remembered in Redis for a day, so a restart or a
 * second tab does not repeat them. The Alerts page reads what is flagged now
 * from GET /organisations/:orgId/stop-watch.
 */

import type { RequestHandler } from 'express'
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { getCacheRedis } from '../../lib/redis.js'
import { connectedUsersReaching, makeToast, toastUsers } from '../../lib/toasts.js'
import { getFleetSnapshotCached } from '../telemetry/fleet-snapshot.cache.js'
import { findAllAsGeoJSON } from '../geofences/geofence.repository.js'
import { AUTHORISED, NO_GO } from './stop-watch.places.js'
import { movementState } from '../../lib/movement-state.js'
import { cachedPlace, reverseGeocode } from '../../lib/geocode.js'
import {
  ORG_CODE, flagWords, flaggedUnits, nearestPlace, placesOf, storePlaces, withMovement,
  type Nearest, type Place, type RawSnapshotRow, type StopFlag,
} from './stop-watch.rules.js'
import { WK_ALLOWED, WK_ORGS, westKenyaStops, type WkUnit } from './stop-watch.west-kenya.js'

export const CHECK_MS = 60_000
const ZONES_MS = 60 * 60_000
const KEEP_S = 24 * 3600

export interface StopWatchFlag extends StopFlag { place: string | null; nearest: Nearest | null; text: string }

const PLACE_WAIT_MS = 5_000
/** Where a stop stands, by name: cached at once, else the lookup for up to PLACE_WAIT_MS. */
async function placeOf(lat: number, lng: number): Promise<string | null> {
  const hit = cachedPlace(lat, lng)
  if (hit) return hit
  let timer: NodeJS.Timeout | undefined
  const wait = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), PLACE_WAIT_MS); timer.unref?.() })
  try {
    return await Promise.race([reverseGeocode(lat, lng).catch(() => null), wait])
  } finally {
    clearTimeout(timer)
  }
}

interface State {
  orgId: string | null
  status: 'loading' | 'done' | 'error' | 'off'
  flags: StopWatchFlag[]
  checkedAt: number | null
  message: string | null
}

let state: State = { orgId: null, status: 'loading', flags: [], checkedAt: null, message: null }
let zones: { at: number; places: Place[] } = { at: 0, places: [] }
const noGo = placesOf(NO_GO)
const fromFile = placesOf(AUTHORISED)

/** Announced already? Redis across restarts; this process's memory when Redis is down. */
const announced = new Map<string, number>()
let primed = false
async function firstTime(key: string, now: number, isPrimed: boolean): Promise<boolean> {
  for (const [k, at] of announced) if (now - at > KEEP_S * 1000) announced.delete(k)
  if (announced.has(key)) return false
  announced.set(key, now)
  const redis = getCacheRedis()
  if (redis) {
    try {
      return (await redis.set(`stopwatch:announced:${key}`, '1', 'EX', KEEP_S, 'NX')) === 'OK'
    } catch { /* fall through to memory */ }
  }
  // No Redis: after a start, the first check only learns what is already
  // standing, so a deploy does not toast the whole list again.
  return isPrimed
}

async function menengaiId(): Promise<string | null> {
  if (state.orgId) return state.orgId
  const org = await prisma.organisation.findUnique({ where: { code: ORG_CODE }, select: { id: true } })
  return org?.id ?? null
}

export async function checkStops(now = Date.now()): Promise<void> {
  const orgId = await menengaiId()
  if (!orgId) { state = { ...state, status: 'off', flags: [], checkedAt: now }; return }
  if (now - zones.at > ZONES_MS) {
    // Menengai's own geofences (its customers and yards) are authorised places too
    const fc = await findAllAsGeoJSON(orgId).catch(() => null)
    if (fc) zones = { at: now, places: placesOf(fc.features.filter((f) => f.properties.isActive !== false) as never) }
  }
  const snap = await getFleetSnapshotCached(orgId)
  const units = withMovement(snap as unknown as RawSnapshotRow[], movementState)
  const authorised = [...fromFile, ...zones.places]
  const near = [...storePlaces(), ...authorised]
  const found = flaggedUnits(units, { authorised, noGo, now })
  // An unauthorised stop is named by where it stands. A name not cached yet
  // waits PLACE_WAIT_MS at most; the lookup carries on and the next check has it.
  const places = await Promise.all(found.map((f) => (f.kind === 'unauthorised' ? placeOf(f.lat, f.lng) : null)))
  const flags: StopWatchFlag[] = found.map((f, i) => ({
    ...f,
    place: places[i],
    nearest: f.kind === 'unauthorised' ? nearestPlace(f.lat, f.lng, near) : null,
    text: flagWords(f, now, places[i]),
  }))
  state = { orgId, status: 'done', flags, checkedAt: now, message: null }

  const sent = await announce(orgId, ORG_CODE, flags, now, primed)
  primed = true
  if (sent) logger.info({ sent, flagged: flags.length }, 'stop watch: new stops toasted')
}

/**
 * Toast each flag not announced yet to the connected people who may see its unit.
 * `quiet`: only mark them announced, toasting none (a watch's first check after
 * a start, so a deploy does not toast every stop already standing at once).
 */
async function announce(orgId: string, orgCode: string, flags: readonly StopWatchFlag[], now: number, isPrimed: boolean, quiet = false): Promise<number> {
  if (quiet) {
    for (const f of flags) await firstTime(f.key, now, false)
    return 0
  }
  let sent = 0
  for (const f of flags) {
    // Who can hear it first: a stop raised while nobody is connected must not
    // be marked announced, or the person who opens the app a minute later
    // never hears of it (the 24 h key would already be spent).
    const people = await connectedUsersReaching(orgId, f.vehicleId)
    if (!people.length) continue
    if (!(await firstTime(f.key, now, isPrimed))) continue
    toastUsers(people, makeToast({
      kind: 'stop',
      level: f.kind === 'nogo' ? 'critical' : 'warning',
      title: f.kind === 'nogo' ? 'No-go zone' : f.kind === 'customer' ? 'Customer stop' : 'Unauthorised stop',
      body: f.text,
      orgId,
      vehicleId: f.vehicleId,
      // orgCode: the toast draws the organisation's logo (lib/push-org)
      data: { ...f, orgCode },
    }))
    sent++
  }
  return sent
}

// ── West Kenya (operator, 2026-11-19) ──────────────────────────────────────
// Its trucks and prime movers stopped five minutes off site or weighbridge
// (stop-watch.west-kenya), for West Kenya, Kabras and Nzoia alike, each with its
// own list; the places on site are pooled from all three.

const wkStates = new Map<string, State>()
let wkZones: { at: number; places: Place[] } = { at: 0, places: [] }
let wkPrimed = false

export async function checkWestKenya(now = Date.now()): Promise<void> {
  const orgs = await prisma.organisation.findMany({ where: { code: { in: [...WK_ORGS] } }, select: { id: true, code: true } })
  if (!orgs.length) return
  if (now - wkZones.at > ZONES_MS) {
    const fcs = await Promise.all(orgs.map((o) => findAllAsGeoJSON(o.id).catch(() => null)))
    if (fcs.some(Boolean)) {
      const onSite = fcs.flatMap((fc) => fc?.features ?? [])
        .filter((f) => f.properties.isActive !== false && WK_ALLOWED.has(String(f.properties.category)))
      wkZones = { at: now, places: placesOf(onSite as never) }
    }
  }
  // No factory, yard or weighbridge read: every stop would read unauthorised. Skip, and try again next minute.
  if (!wkZones.places.length) {
    wkZones = { at: 0, places: [] }
    logger.warn('stop watch: no West Kenya site or weighbridge geofences read, check skipped')
    return
  }
  for (const org of orgs) {
    try {
      const snap = await getFleetSnapshotCached(org.id)
      const units = withMovement(snap as unknown as RawSnapshotRow[], movementState) as WkUnit[]
      const found = westKenyaStops(units, wkZones.places, now)
      const places = await Promise.all(found.map((f) => placeOf(f.lat, f.lng)))
      const flags: StopWatchFlag[] = found.map((f, i) => ({ ...f, place: places[i], nearest: null, text: flagWords(f, now, places[i]) }))
      wkStates.set(org.id, { orgId: org.id, status: 'done', flags, checkedAt: now, message: null })
      // The first check after a start only learns what already stands (quiet)
      const sent = await announce(org.id, org.code, flags, now, wkPrimed, !wkPrimed)
      if (sent) logger.info({ org: org.code, sent, flagged: flags.length }, 'stop watch: new West Kenya stops toasted')
    } catch (err) {
      const was = wkStates.get(org.id)
      wkStates.set(org.id, { orgId: org.id, status: 'error', flags: was?.flags ?? [], checkedAt: now, message: err instanceof Error ? err.message : String(err) })
      logger.warn({ err, org: org.code }, 'stop watch: West Kenya check failed')
    }
  }
  wkPrimed = true
}

/** Start the background check. Returns a stop function. */
export function startStopWatch(): () => void {
  let live = true
  let timer: NodeJS.Timeout | null = null
  const tick = async () => {
    try {
      await checkStops()
    } catch (err) {
      state = { ...state, status: 'error', message: err instanceof Error ? err.message : String(err), checkedAt: Date.now() }
      logger.warn({ err }, 'stop watch: check failed')
    }
    // West Kenya apart: a failure of one never holds up the other
    try {
      await checkWestKenya()
    } catch (err) {
      logger.warn({ err }, 'stop watch: West Kenya check failed')
    } finally {
      if (live) { timer = setTimeout(tick, CHECK_MS); timer.unref?.() }
    }
  }
  timer = setTimeout(tick, 15_000)   // after boot, once the snapshot cache is warm
  timer.unref?.()
  return () => { live = false; if (timer) clearTimeout(timer) }
}

/** GET /organisations/:orgId/stop-watch: what is flagged now (Menengai, and West Kenya's three). */
export const current: RequestHandler = (req, res) => {
  const orgId = req.params.orgId
  const s = state.orgId && orgId === state.orgId ? state : wkStates.get(String(orgId))
  if (!s) {
    res.json({ data: { status: 'off', flags: [], checkedAt: state.checkedAt, message: null } })
    return
  }
  const scope = req.authz?.vehicleIds ?? null
  const flags = scope ? s.flags.filter((f) => scope.has(f.vehicleId)) : s.flags
  res.json({ data: { status: s.status, flags, checkedAt: s.checkedAt, message: s.message } })
}
