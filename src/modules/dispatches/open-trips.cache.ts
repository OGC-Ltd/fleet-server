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

/**
 * Fold a dispatch that has JUST changed into the cached map, without rebuilding
 * the organisation.
 *
 * The sweep is a minute apart and serves stale data while it refreshes, so a
 * sales run signed out at the gate reached the vehicle's cargo fields up to two
 * sweeps after the webhook delivered it — the number was in the database and
 * the truck still read Empty. This is what closes that gap.
 *
 * ## Why a patch and not a rebuild
 *
 * A rebuild of this cache is measured at ~6 s against the live fleet, and three
 * of them at once took the API down on 2026-08-10 (see the note on `inflight`
 * in lib/warm-cache). A reconcile pass can touch hundreds of runs in one
 * second. Rebuilding per event is therefore not a slower way to be correct, it
 * is an outage; the caller batches (see dispatch-refresh) and this asks about
 * that batch only.
 *
 * ## It never builds
 *
 * A key nobody has read has nothing to patch, and building one here would make
 * a webhook pay for the 6 s that the request path is designed never to pay. The
 * first reader builds it fresh, which already includes this dispatch.
 *
 * Returns the vehicles whose run actually changed — the caller narrates from
 * that, so a redelivered webhook that changes nothing says nothing.
 */
export async function patchOpenTrips(orgId: string, vehicleIds: string[]): Promise<string[]> {
  const entry = cache.peek(orgId)
  if (!entry || vehicleIds.length === 0) return []

  const fresh   = await findOpenTripsByVehicle(orgId, vehicleIds)
  const changed: string[] = []

  for (const vehicleId of vehicleIds) {
    const before = entry.byVehicle.get(vehicleId)
    const after  = fresh.get(vehicleId)
    // A run that closed while we were away leaves the map, or the vehicle
    // would keep declaring a load it signed back in without.
    if (!after) {
      if (before) { entry.byVehicle.delete(vehicleId); changed.push(vehicleId) }
      continue
    }
    if (!before || before.externalId !== after.externalId
      || before.cargoTonnes !== after.cargoTonnes
      || before.destination !== after.destination
      || before.driverName  !== after.driverName
      || before.status      !== after.status
      // The gate guard's seal serial can land after the sign-out that opened
      // the run (FactorySuite v1.4.32), on a unit that is parked and sending
      // no positions — this push is then the only way it reaches the card.
      || before.serialNumber !== after.serialNumber) {
      changed.push(vehicleId)
    }
    entry.byVehicle.set(vehicleId, after)
  }

  return changed
}
