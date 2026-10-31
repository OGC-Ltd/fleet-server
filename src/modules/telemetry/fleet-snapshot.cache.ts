// Warmed cache for the fleet snapshot (/vehicles/snapshot) — see
// lib/warm-cache.ts for the pattern. The snapshot is only each client's
// FIRST paint of the fleet: the live SSE stream layers realtime updates on
// top immediately after (and the clients already stale-while-revalidate
// snapshots from localStorage), so serving one at most a sweep interval old
// is safe — and it takes page loads from tens of seconds to milliseconds.

import { createWarmCache } from '../../lib/warm-cache.js'
import { emitDashboardFuelIncident } from '../../lib/sse.js'
import { logger } from '../../lib/logger.js'
import { findFleetSnapshot } from './telemetry.repository.js'

type Snapshot = Awaited<ReturnType<typeof findFleetSnapshot>>

/**
 * What the previous BUILD said about each unit's fuel incident, per org, as a
 * comparable string ('' for none).
 *
 * The snapshot is the only place a unit's open incident is decided, and open
 * browsers read it once, at page load: a position frame cannot carry a fuel
 * verdict. So a theft raised while the page was open never turned its unit red
 * or moved the CRITICAL count until a reload. Each build is now compared with
 * the last, and every unit whose incident changed is pushed (`fuel_incident`).
 *
 * Kept apart from the cached value on purpose: patchSnapshotIncidentReview and
 * forgetSnapshotIncident edit that value in place, and a baseline read from it
 * would miss the change those patches stand in for.
 */
const lastIncidents = new Map<string, Map<string, string>>()

function announceIncidentChanges(orgId: string, snap: Snapshot): void {
  const next = new Map<string, string>()
  for (const v of snap) next.set(v.vehicleId, v.fuelIncident ? JSON.stringify(v.fuelIncident) : '')
  const prev = lastIncidents.get(orgId)
  lastIncidents.set(orgId, next)
  // The first build after a start has nothing to compare against; every open
  // client read its incidents from a snapshot of its own.
  if (!prev) return
  let changed = 0
  for (const v of snap) {
    if ((prev.get(v.vehicleId) ?? '') === next.get(v.vehicleId)) continue
    emitDashboardFuelIncident(orgId, { vehicleId: v.vehicleId, fuelIncident: v.fuelIncident })
    changed++
  }
  if (changed) logger.info({ orgId, changed }, 'fleet-snapshot: fuel incidents changed — pushed to open dashboards')
}

// Key format: `${orgId}`
const cache = createWarmCache<Snapshot>({
  name: 'fleet-snapshot',
  compute: async (orgId) => {
    const snap = await findFleetSnapshot(orgId)
    announceIncidentChanges(orgId, snap)
    return snap
  },
  warmKeysFor: (orgId) => [orgId],
})

export function getFleetSnapshotCached(orgId: string): Promise<Snapshot> {
  return cache.get(orgId)
}

/**
 * Debounce for refreshFleetSnapshotIncidents. An adjudication pass writes and
 * announces several verdicts in a row; waiting this long after the last one
 * builds once, after the pass's writes have landed, rather than once each.
 */
const INCIDENT_REBUILD_DEBOUNCE_MS = 2_000
const rebuildTimers = new Map<string, NodeJS.Timeout>()

/**
 * A fuel verdict was just announced for this org: rebuild the snapshot shortly
 * instead of on the next sweep, so open dashboards hear about it in seconds.
 * Fire-and-forget — a failure leaves the sweep to catch up within a minute.
 */
export function refreshFleetSnapshotIncidents(orgId: string): void {
  const pending = rebuildTimers.get(orgId)
  if (pending) clearTimeout(pending)
  const timer = setTimeout(() => {
    rebuildTimers.delete(orgId)
    cache.rebuild(orgId).catch((err) => {
      logger.warn({ err, orgId }, 'fleet-snapshot: rebuild after a fuel verdict failed — the sweep will catch up')
    })
  }, INCIDENT_REBUILD_DEBOUNCE_MS)
  timer.unref?.()
  rebuildTimers.set(orgId, timer)
}

/**
 * Put an administrator's escalation or de-escalation on the cached snapshot's
 * incident in place, as forgetSnapshotIncident does for a deletion, so a page
 * load straight after sees the decision. The next rebuild reads it from the row.
 */
export function patchSnapshotIncidentReview(
  orgId: string, incidentId: string,
  review: { status: string; at: string | null; by: string | null; note: string | null },
): void {
  const snap = cache.peek(orgId)
  if (!snap) return
  for (const v of snap) {
    if (v.fuelIncident?.id === incidentId) v.fuelIncident = { ...v.fuelIncident, review }
  }
}

/**
 * Take a dismissed fuel incident off the cached snapshot in place, rather than
 * waiting up to a sweep for the rebuild (whose query already excludes it). The
 * next rebuild replaces this patch either way.
 */
export function forgetSnapshotIncident(orgId: string, incidentId: string): void {
  const snap = cache.peek(orgId)
  if (!snap) return
  for (const v of snap) {
    if (v.fuelIncident?.id === incidentId) v.fuelIncident = null
  }
}
