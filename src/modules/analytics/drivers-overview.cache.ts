// Warmed cache for the batched drivers overview (analytics.repository's
// driversOverview) — see lib/warm-cache.ts for the pattern. The three
// /analytics/drivers* endpoints serve from this; the remote DB is never on
// the request path for the default window.

import { createWarmCache } from '../../lib/warm-cache.js'
import { driversOverview, type DriversOverview } from './analytics.repository.js'

/** The trailing window (days) the fleettrack Drivers page requests — the one
 *  the warmer keeps hot. Other windows are cached on first use. */
export const DEFAULT_DRIVER_WINDOW_DAYS = 90

// Key format: `${orgId}:${days}`
const cache = createWarmCache<DriversOverview>({
  name: 'drivers-overview',
  compute: (key) => {
    const sep = key.lastIndexOf(':')
    return driversOverview(key.slice(0, sep), Number(key.slice(sep + 1)))
  },
  warmKeysFor: (orgId) => [`${orgId}:${DEFAULT_DRIVER_WINDOW_DAYS}`],
})

export function getDriversOverview(orgId: string, days: number): Promise<DriversOverview> {
  return cache.get(`${orgId}:${days}`)
}
