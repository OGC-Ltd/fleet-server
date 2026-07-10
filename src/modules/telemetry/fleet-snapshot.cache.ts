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
