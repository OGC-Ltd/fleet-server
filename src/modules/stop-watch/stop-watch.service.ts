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
import {
  ORG_CODE, flagWords, flaggedUnits, nearestPlace, placesOf, storePlaces, withMovement,
  type Nearest, type Place, type RawSnapshotRow, type StopFlag,
} from './stop-watch.rules.js'

export const CHECK_MS = 60_000
const ZONES_MS = 60 * 60_000
const KEEP_S = 24 * 3600

export interface StopWatchFlag extends StopFlag { nearest: Nearest | null; text: string }

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
async function firstTime(key: string, now: number): Promise<boolean> {
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
  return primed
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
  const flags: StopWatchFlag[] = flaggedUnits(units, { authorised, noGo, now }).map((f) => ({
    ...f,
    nearest: f.kind === 'unauthorised' ? nearestPlace(f.lat, f.lng, near) : null,
    text: flagWords(f, now),
  }))
  state = { orgId, status: 'done', flags, checkedAt: now, message: null }

  let sent = 0
  for (const f of flags) {
    // Who can hear it first: a stop raised while nobody is connected must not
    // be marked announced, or the person who opens the app a minute later
    // never hears of it (the 24 h key would already be spent).
    const people = await connectedUsersReaching(orgId, f.vehicleId)
    if (!people.length) continue
    if (!(await firstTime(f.key, now))) continue
    toastUsers(people, makeToast({
      kind: 'stop',
      level: f.kind === 'nogo' ? 'critical' : 'warning',
      title: f.kind === 'nogo' ? 'No-go zone' : f.kind === 'customer' ? 'Customer stop' : 'Unauthorised stop',
      body: f.text,
      orgId,
      vehicleId: f.vehicleId,
      // orgCode: the toast draws Menengai's logo (lib/push-org)
      data: { ...f, orgCode: ORG_CODE },
    }))
    sent++
  }
  primed = true
  if (sent) logger.info({ sent, flagged: flags.length }, 'stop watch: new stops toasted')
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
    } finally {
      if (live) { timer = setTimeout(tick, CHECK_MS); timer.unref?.() }
    }
  }
  timer = setTimeout(tick, 15_000)   // after boot, once the snapshot cache is warm
  timer.unref?.()
  return () => { live = false; if (timer) clearTimeout(timer) }
}

/** GET /organisations/:orgId/stop-watch: what is flagged now (Menengai only). */
export const current: RequestHandler = (req, res) => {
  const orgId = req.params.orgId
  if (!state.orgId || orgId !== state.orgId) {
    res.json({ data: { status: 'off', flags: [], checkedAt: state.checkedAt, message: null } })
    return
  }
  const scope = req.authz?.vehicleIds ?? null
  const flags = scope ? state.flags.filter((f) => scope.has(f.vehicleId)) : state.flags
  res.json({ data: { status: state.status, flags, checkedAt: state.checkedAt, message: state.message } })
}
