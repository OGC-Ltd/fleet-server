// Warmed cache for "what is every vehicle out on right now" — see
// lib/warm-cache.ts.
//
// The fleet snapshot decorates 597 rows with their open dispatch on every
// request, and the snapshot itself is served from memory. Querying dispatches
// on the request path would put the pooler back in front of it (~1 s a query)
// for data that changes a few times an hour: there are about fifty open
// dispatches at any moment across a fleet of six hundred.
//
// The yard rides along in the same entry. It is a per-organisation constant
// that only sync:destinations changes, and the trip geometry is useless
// without it, so fetching the two together keeps them consistent and costs one
// extra row.

import { createWarmCache } from '../../lib/warm-cache.js'
import { prisma } from '../../lib/prisma.js'
import { findOpenTripsByVehicle, type OpenTrip } from './dispatch.repository.js'
import type { Point } from '../../lib/dispatch-trip.js'

export interface OpenTripsForOrg {
  /** The measured yard, or null before sync:destinations has run for this org. */
  yard: Point | null
  /**
   * What to call it. The organisation's own name — the yard is the plant, and
   * the provider gives a dispatch a destination but never an origin, so there
   * is no other label for the end every run starts and finishes at.
   */
  yardName: string | null
  byVehicle: Map<string, OpenTrip>
}

const cache = createWarmCache<OpenTripsForOrg>({
  name: 'open-trips',
  compute: async (orgId) => {
    const [org, byVehicle] = await Promise.all([
      prisma.organisation.findUnique({ where: { id: orgId }, select: { name: true, hubLat: true, hubLng: true } }),
      findOpenTripsByVehicle(orgId),
    ])
    const yard = org?.hubLat != null && org.hubLng != null
      ? { lat: org.hubLat, lng: org.hubLng }
      : null
    return { yard, yardName: org?.name ?? null, byVehicle }
  },
  warmKeysFor: (orgId) => [orgId],
})

export function getOpenTripsCached(orgId: string): Promise<OpenTripsForOrg> {
  return cache.get(orgId)
}
