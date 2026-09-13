// Warmed cache for the deliveries dashboard aggregate (analytics.repository's
// deliveriesAnalytics) — see lib/warm-cache.ts for the pattern.
//
// EVERY shape of the read is cached: the trailing windows the warmer keeps hot
// per org, and also anchored (`to`) and vehicle-filtered ones, which enter on
// demand and age out under `maxEntries`.
//
// Those two used to bypass the cache entirely, on the reasoning that their key
// space is unbounded. The key space IS unbounded and that is exactly what an
// entry cap with oldest-first eviction is for; bypassing put a multi-second
// aggregate on the request path, so every click of the Analytics page's filter
// waited on the database and the page appeared to hang.

import { createWarmCache } from '../../lib/warm-cache.js'
import { deliveriesAnalytics } from './analytics.repository.js'
import { windowCacheKey, parseWindowCacheKey, vehicleIdsFor } from './vehicle-filter.js'

/** The trailing windows the fleettrack Analytics page can request. */
export const DELIVERY_WINDOWS_DAYS = [7, 30, 90]

type DeliveriesPayload = Awaited<ReturnType<typeof deliveriesAnalytics>>

const cache = createWarmCache<DeliveriesPayload>({
  name: 'deliveries',
  maxEntries: 200,
  compute: async (key) => {
    const { orgId, days, to, categories, vehicles } = parseWindowCacheKey(key)
    return deliveriesAnalytics(orgId, { days, to },
      await vehicleIdsFor(orgId, categories, vehicles))
  },
  // Only the plain trailing windows over the whole fleet are warmed — a sweep
  // rebuilding one operator's ad-hoc selection would spend the box's budget on
  // an answer nobody is waiting for.
  warmKeysFor: (orgId) =>
    DELIVERY_WINDOWS_DAYS.map(d => windowCacheKey(orgId, d, undefined, null)),
})

export function getDeliveriesAnalytics(
  orgId: string, days: number, to?: Date,
  categories: string[] | null = null, vehicles: string[] | null = null,
): Promise<DeliveriesPayload> {
  return cache.get(windowCacheKey(orgId, days, to, categories, vehicles))
}
