/**
 * Archived geofences (geofences.archived_at set) are kept only so history that
 * names them by id still resolves: old feed lines, machine-operation areas.
 * Everything that decides or draws something now reads live fences only:
 * containment, the map, Planner matching, reports.
 *
 * isActive is a separate thing: false only switches enforcement off (keep-out
 * breaches, NOGO_ZONE rules), and the fence stays in use. The exception is the
 * organisations below, where the user decided on 2026-11-18 that an inactive
 * fence is also left off the live map and off a unit's zone history.
 */

/** Prisma `where` fragment: the fence is in use. */
export const LIVE_FENCE = { archivedAt: null } as const

/** Organisations whose inactive fences are not drawn on the map or listed in zone history. */
export const HIDE_INACTIVE_FENCE_ORGS: readonly string[] = ['MENENGAI']

export function hidesInactiveFences(orgCode: string | null | undefined): boolean {
  return HIDE_INACTIVE_FENCE_ORGS.includes(String(orgCode ?? '').toUpperCase())
}

/**
 * Organisations whose Wialon zones may not be imported any more: their own
 * fences replace them (user 2026-11-18: "we will be building our own").
 */
export const NO_WIALON_ZONE_IMPORT_ORGS: readonly string[] = ['MENENGAI']
