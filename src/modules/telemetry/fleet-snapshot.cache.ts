// Warmed cache for the fleet snapshot (/vehicles/snapshot) — see
// lib/warm-cache.ts for the pattern. The snapshot is only each client's
// FIRST paint of the fleet: the live SSE stream layers realtime updates on
// top immediately after (and the clients already stale-while-revalidate
// snapshots from localStorage), so serving one at most a sweep interval old
// is safe — and it takes page loads from tens of seconds to milliseconds.

import { createWarmCache } from '../../lib/warm-cache.js'
import { findFleetSnapshot } from './telemetry.repository.js'

type Snapshot = Awaited<ReturnType<typeof findFleetSnapshot>>

// Key format: `${orgId}`
const cache = createWarmCache<Snapshot>({
  name: 'fleet-snapshot',
  compute: (orgId) => findFleetSnapshot(orgId),
  warmKeysFor: (orgId) => [orgId],
})

export function getFleetSnapshotCached(orgId: string): Promise<Snapshot> {
  return cache.get(orgId)
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
