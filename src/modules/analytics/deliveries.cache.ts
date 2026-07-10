// Warmed cache for the deliveries dashboard aggregate (analytics.repository's
// deliveriesAnalytics) — see lib/warm-cache.ts for the pattern. The fleettrack
// Analytics page offers 7d / 30d / 90d ranges, so the warmer keeps all three
// hot per org; any other window is cached on first use. Requests with an
// explicit `to` anchor bypass this cache entirely (unbounded key space).

import { createWarmCache } from '../../lib/warm-cache.js'
import { deliveriesAnalytics } from './analytics.repository.js'

/** The trailing windows the fleettrack Analytics page can request. */
export const DELIVERY_WINDOWS_DAYS = [7, 30, 90]

type DeliveriesPayload = Awaited<ReturnType<typeof deliveriesAnalytics>>

// Key format: `${orgId}:${days}`
const cache = createWarmCache<DeliveriesPayload>({
  name: 'deliveries',
  compute: (key) => {
    const sep = key.lastIndexOf(':')
    return deliveriesAnalytics(key.slice(0, sep), { days: Number(key.slice(sep + 1)) })
  },
  warmKeysFor: (orgId) => DELIVERY_WINDOWS_DAYS.map(d => `${orgId}:${d}`),
})

export function getDeliveriesAnalytics(orgId: string, days: number): Promise<DeliveriesPayload> {
  return cache.get(`${orgId}:${days}`)
}
