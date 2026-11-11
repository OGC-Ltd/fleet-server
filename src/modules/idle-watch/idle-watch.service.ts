/**
 * The idle watch, on the server (new-ui PR #56 ran it in each browser: every
 * person saw different alerts, timed from when their own browser first saw a
 * unit stopped). Every CHECK_MS it reads Menengai's fleet snapshot and keeps
 * the listed units idle now (idle-watch.rules); the Alerts page and its corner
 * badge read them from GET /organisations/:orgId/idle-watch.
 */

import type { RequestHandler } from 'express'
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { movementState } from '../../lib/movement-state.js'
import { getFleetSnapshotCached } from '../telemetry/fleet-snapshot.cache.js'
import { findAllAsGeoJSON } from '../geofences/geofence.repository.js'
import { AUTHORISED } from '../stop-watch/stop-watch.places.js'
import { nearestPlace, placesOf, storePlaces, type Nearest, type Place } from '../stop-watch/stop-watch.rules.js'
import {
  ORG_CODE, IDLE_MS, CRITICAL_MS, WORK_HOURS, idleUnits, idleWords,
  type IdleAlert, type IdleUnit, type IdleWatch,
} from './idle-watch.rules.js'

export const CHECK_MS = 60_000
const ZONES_MS = 60 * 60_000

export interface IdleWatchAlert extends IdleAlert { nearest: Nearest | null; text: string }

interface State {
  orgId: string | null
  status: 'loading' | 'done' | 'error' | 'off'
  alerts: IdleWatchAlert[]
  notReporting: IdleWatch['notReporting']
  notOnPlatform: string[]
  checkedAt: number | null
  message: string | null
}

let state: State = { orgId: null, status: 'loading', alerts: [], notReporting: [], notOnPlatform: [], checkedAt: null, message: null }
let zones: { at: number; places: Place[] } = { at: 0, places: [] }
const fromFile = placesOf(AUTHORISED)
/** The yard and depots: standing there is where a unit belongs. */
const excluded = storePlaces()

/** The rule, as the page explains it. */
const RULE = {
  idleMs: IDLE_MS,
  criticalMs: CRITICAL_MS,
  hours: `${String(Math.floor(WORK_HOURS.start)).padStart(2, '0')}:${String((WORK_HOURS.start % 1) * 60).padStart(2, '0')}–${String(Math.floor(WORK_HOURS.end)).padStart(2, '0')}:${String((WORK_HOURS.end % 1) * 60).padStart(2, '0')}`,
  excluded: excluded.map((p) => p.name),
}

async function menengaiId(): Promise<string | null> {
  if (state.orgId) return state.orgId
  const org = await prisma.organisation.findUnique({ where: { code: ORG_CODE }, select: { id: true } })
  return org?.id ?? null
}

/** Snapshot rows with each unit's current run, its stop time and whether the server saw it stop. */
function withRuns(rows: readonly Record<string, unknown>[]): IdleUnit[] {
  return rows.map((r) => {
    const capturedAt = (r.capturedAt as string | null) ?? null
    const fixMs = capturedAt ? Date.parse(capturedAt) : NaN
    const mv = movementState(String(r.vehicleId), (r.lastMovedAt as string | null) ?? null, Number.isFinite(fixMs) ? fixMs : null)
    return {
      vehicleId: String(r.vehicleId),
      plate: (r.plate as string | null) ?? null,
      name: (r.name as string | null) ?? null,
      lat: (r.lat as number | null) ?? null,
      lng: (r.lng as number | null) ?? null,
      speedKmh: (r.speedKmh as number | null) ?? null,
      engineOn: (r.engineOn as boolean | null) ?? null,
      capturedAt,
      movement: mv ? { state: mv.state, since: mv.since, exact: mv.exact } : null,
    }
  })
}

export async function checkIdle(now = Date.now()): Promise<void> {
  const orgId = await menengaiId()
  if (!orgId) { state = { ...state, status: 'off', alerts: [], checkedAt: now }; return }
  if (now - zones.at > ZONES_MS) {
    // Menengai's own geofences name where a unit stands
    const fc = await findAllAsGeoJSON(orgId).catch(() => null)
    if (fc) zones = { at: now, places: placesOf(fc.features.filter((f) => f.properties.isActive !== false) as never) }
  }
  const snap = await getFleetSnapshotCached(orgId)
  const watch = idleUnits(withRuns(snap as unknown as Record<string, unknown>[]), { excluded, now })
  const near = [...excluded, ...fromFile, ...zones.places]
  const alerts: IdleWatchAlert[] = watch.alerts.map((a) => ({
    ...a,
    nearest: nearestPlace(a.lat, a.lng, near),
    text: `${a.plate} has stood ${a.sinceExact ? '' : 'at least '}${idleWords(a.idleMs)} of working hours.`,
  }))
  const before = state.alerts.length
  state = { orgId, status: 'done', alerts, notReporting: watch.notReporting, notOnPlatform: watch.notOnPlatform, checkedAt: now, message: null }
  if (alerts.length !== before) logger.info({ idle: alerts.length }, 'idle watch: idle units changed')
}

/** Start the background check. Returns a stop function. */
export function startIdleWatch(): () => void {
  let live = true
  let timer: NodeJS.Timeout | null = null
  const tick = async () => {
    try {
      await checkIdle()
    } catch (err) {
      state = { ...state, status: 'error', message: err instanceof Error ? err.message : String(err), checkedAt: Date.now() }
      logger.warn({ err }, 'idle watch: check failed')
    } finally {
      if (live) { timer = setTimeout(tick, CHECK_MS); timer.unref?.() }
    }
  }
  timer = setTimeout(tick, 20_000)   // after boot, once the snapshot cache is warm
  timer.unref?.()
  return () => { live = false; if (timer) clearTimeout(timer) }
}

/**
 * GET /organisations/:orgId/idle-watch: the listed units idle now (Menengai
 * only; any other organisation answers `off`), within the caller's scope.
 */
export const current: RequestHandler = (req, res) => {
  const orgId = req.params.orgId
  if (!state.orgId || orgId !== state.orgId) {
    res.json({ data: { status: 'off', alerts: [], notReporting: [], notOnPlatform: [], checkedAt: state.checkedAt, message: null, rule: RULE } })
    return
  }
  const scope = req.authz?.vehicleIds ?? null
  const mine = <T extends { vehicleId: string }>(xs: T[]) => (scope ? xs.filter((x) => scope.has(x.vehicleId)) : xs)
  res.json({
    data: {
      status: state.status,
      alerts: mine(state.alerts),
      notReporting: mine(state.notReporting),
      // Plates, not units: only those who see the whole fleet are told
      notOnPlatform: scope ? [] : state.notOnPlatform,
      checkedAt: state.checkedAt,
      message: state.message,
      rule: RULE,
    },
  })
}
