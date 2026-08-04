// Warmed cache for the fuel ledger aggregate (analytics.repository's
// fuelConsumption) — see lib/warm-cache.ts for the pattern, and
// deliveries.cache.ts for the sibling this mirrors.
//
// Cached QUANTITIES only. Cost is applied per request in fuel-pricing.ts, so
// `pricePerLitre` never enters the key and one warmed entry serves every caller
// whatever rate they ask for.
//
// The fuel sync writes on a 15-minute cron (FUEL_SYNC_CRON), so a 60s warm
// sweep is comfortably fresher than the data it caches.

import { createWarmCache } from '../../lib/warm-cache.js'
import { fuelConsumption } from './analytics.repository.js'

/** The trailing windows the Analytics page can request. Matches deliveries. */
export const FUEL_COST_WINDOWS_DAYS = [7, 30, 90]

type FuelConsumptionPayload = Awaited<ReturnType<typeof fuelConsumption>>

// Key format: `${orgId}:${days}`
const cache = createWarmCache<FuelConsumptionPayload>({
  name: 'fuel-cost',
  compute: (key) => {
    const sep = key.lastIndexOf(':')
    return fuelConsumption(key.slice(0, sep), { days: Number(key.slice(sep + 1)) })
  },
  warmKeysFor: (orgId) => FUEL_COST_WINDOWS_DAYS.map(d => `${orgId}:${d}`),
})

export function getFuelConsumption(orgId: string, days: number): Promise<FuelConsumptionPayload> {
  return cache.get(`${orgId}:${days}`)
}
