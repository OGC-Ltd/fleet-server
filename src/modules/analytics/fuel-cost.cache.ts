// Warmed cache for the fuel ledger aggregate (analytics.repository's
// fuelConsumption) — see lib/warm-cache.ts for the pattern, and
// deliveries.cache.ts for the sibling this mirrors, including why anchored and
// vehicle-filtered reads are cached here rather than computed on the request.
//
// Cached QUANTITIES only. Cost is applied per request in fuel-pricing.ts, so
// `pricePerLitre` never enters the key and one warmed entry serves every caller
// whatever rate they ask for.
//
// The fuel sync writes on a 15-minute cron (FUEL_SYNC_CRON), so a 60s warm
// sweep is comfortably fresher than the data it caches.

import { createWarmCache } from '../../lib/warm-cache.js'
import { fuelConsumption } from './analytics.repository.js'
import { windowCacheKey, parseWindowCacheKey, vehicleIdsFor } from './vehicle-filter.js'

/** The trailing windows the Analytics page can request. Matches deliveries. */
export const FUEL_COST_WINDOWS_DAYS = [7, 30, 90]

type FuelConsumptionPayload = Awaited<ReturnType<typeof fuelConsumption>>

const cache = createWarmCache<FuelConsumptionPayload>({
  name: 'fuel-cost',
  maxEntries: 200,
  compute: async (key) => {
    const { orgId, days, to, categories, vehicles } = parseWindowCacheKey(key)
    return fuelConsumption(orgId, { days, to },
      await vehicleIdsFor(orgId, categories, vehicles))
  },
  warmKeysFor: (orgId) =>
    FUEL_COST_WINDOWS_DAYS.map(d => windowCacheKey(orgId, d, undefined, null)),
})

export function getFuelConsumption(
  orgId: string, days: number, to?: Date,
  categories: string[] | null = null, vehicles: string[] | null = null,
): Promise<FuelConsumptionPayload> {
  return cache.get(windowCacheKey(orgId, days, to, categories, vehicles))
}
