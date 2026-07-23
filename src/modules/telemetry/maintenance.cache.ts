// Warmed caches for the Maintenance page's read endpoints — see
// lib/warm-cache.ts for the pattern.
//
//  - History: the org-wide daily activity series (/maintenance/history). The
//    fleettrack page's default all-months view requests days=366 with no `to`,
//    so that window is kept hot per org; calendar-anchored selections
//    (`to` given) are cached on first use so re-selecting a range is instant.
//  - Vehicle maintenance: service records + garage visits for EVERY vehicle,
//    batched per org, so selecting a vehicle in the grid never waits on the
//    remote DB.

import { createWarmCache } from '../../lib/warm-cache.js'
import {
  findMaintenanceHistory,
  findOrgVehicleMaintenance,
  type OrgVehicleMaintenance,
} from './telemetry.repository.js'

/** The window the fleettrack Maintenance page requests for its default
 *  all-months view — the one the warmer keeps hot. */
export const DEFAULT_HISTORY_WINDOW_DAYS = 366

type HistoryPayload = Awaited<ReturnType<typeof findMaintenanceHistory>>

// Key format: `${orgId}:${days}` (trailing window ending now) or
// `${orgId}:${days}:${YYYY-MM-DD}` (calendar-anchored).
const historyCache = createWarmCache<HistoryPayload>({
  name: 'maintenance-history',
  compute: (key) => {
    const [orgId, days, toDay] = key.split(':')
    return findMaintenanceHistory(orgId!, Number(days), toDay ? new Date(toDay) : undefined)
  },
  warmKeysFor: (orgId) => [`${orgId}:${DEFAULT_HISTORY_WINDOW_DAYS}`],
})

export function getMaintenanceHistoryCached(orgId: string, days: number, to?: Date): Promise<HistoryPayload> {
  const toDay = to ? `:${to.toISOString().slice(0, 10)}` : ''
  return historyCache.get(`${orgId}:${days}${toDay}`)
}

// Key format: `${orgId}`
const vehicleMaintCache = createWarmCache<OrgVehicleMaintenance>({
  name: 'vehicle-maintenance',
  compute: (orgId) => findOrgVehicleMaintenance(orgId),
  warmKeysFor: (orgId) => [orgId],
})

export function getOrgVehicleMaintenance(orgId: string): Promise<OrgVehicleMaintenance> {
  return vehicleMaintCache.get(orgId)
}
