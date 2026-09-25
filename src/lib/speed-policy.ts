/**
 * Speed limits that depend on WHERE a unit is, per organisation.
 *
 * The fleet-wide limit (OVERSPEED_LIMIT_KMH, with OVERSPEED_LIMIT_BY_TYPE) is
 * one number per vehicle type. Kasulu runs two: 60 km/h inside the factory
 * premises and 100 km/h on the national roads (set 2026-09-25). Nothing maps
 * the roads themselves, so the rule is read off the org's own surveyed zones:
 * inside a zone of a listed category, that category's limit; anywhere else,
 * `outsideKmh`.
 *
 * Kasulu's factory is the "Factory site Location" polygon, the only zone
 * lib/zone-taxonomy files as `factory` (the haulage road from the factory is
 * filed as `road`, deliberately — see categorise). Its farms, haulage roads,
 * logistic centres and workshops are all outside it, so they take the road
 * limit — as agreed when this was set.
 *
 * Keyed by org CODE, not id, so it reads the same in every environment.
 */

import { prisma } from './prisma.js'
import { logger } from './logger.js'
import { zoneCategoriesAt, loadOrgZones } from './zone-presence.js'
import type { ZoneCategory } from './zone-taxonomy.js'

export interface SpeedPolicy {
  /** Anywhere not inside one of `insideKmh`'s zones. */
  outsideKmh: number
  /** Limit inside a zone of this category. The LOWEST applies where several overlap. */
  insideKmh:  Partial<Record<ZoneCategory, number>>
}

export const SPEED_POLICIES: Readonly<Record<string, SpeedPolicy>> = {
  KASULU: { outsideKmh: 100, insideKmh: { factory: 60 } },
}

/** Where a limit came from — recorded on each speeding incident. */
export type LimitSource = 'type' | 'fleet' | 'zone' | 'road'

export interface ZoneLimit {
  kmh:    number
  source: 'zone' | 'road'
  /** The zone category that set it, or null on the road. */
  zone:   ZoneCategory | null
}

/** org id -> org code, for orgs with a policy only. Refreshed hourly. */
let policyOrgs = new Map<string, SpeedPolicy>()
let loadedAt = 0
let loading: Promise<void> | null = null
const ORGS_TTL_MS = 60 * 60_000

async function loadPolicyOrgs(): Promise<void> {
  const codes = Object.keys(SPEED_POLICIES)
  if (!codes.length) { policyOrgs = new Map(); loadedAt = Date.now(); return }
  const rows = await prisma.organisation.findMany({
    where:  { code: { in: codes } },
    select: { id: true, code: true },
  })
  policyOrgs = new Map(rows.map(r => [r.id, SPEED_POLICIES[r.code]!]))
  loadedAt = Date.now()
}

/**
 * Make sure `zoneLimitAt` can answer for this org: the policy table is resolved
 * to ids, and the org's zones are cached. Cheap when both are warm. A failure
 * is logged and swallowed — the fleet limit still applies without it.
 */
export async function warmSpeedPolicy(orgId: string): Promise<void> {
  try {
    if (Date.now() - loadedAt > ORGS_TTL_MS) {
      loading ??= loadPolicyOrgs().finally(() => { loading = null })
      await loading
    }
    if (policyOrgs.has(orgId)) await loadOrgZones(orgId)
  } catch (err) {
    logger.warn({ err, orgId }, 'Speed policy could not be loaded; using the fleet limit')
  }
}

/** The org's zone policy, if it has one and it has been warmed. */
export function speedPolicyFor(orgId: string): SpeedPolicy | null {
  return policyOrgs.get(orgId) ?? null
}

/**
 * The zone-based limit at a point, or null when the org has no policy.
 *
 * With no fix, or before the org's zones have loaded, the answer is the road
 * limit: there is no evidence the unit is inside the factory, and the stricter
 * figure must not be asserted without it.
 */
export function zoneLimitAt(orgId: string, lat: number | null | undefined, lng: number | null | undefined): ZoneLimit | null {
  const policy = policyOrgs.get(orgId)
  if (!policy) return null
  const road: ZoneLimit = { kmh: policy.outsideKmh, source: 'road', zone: null }
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return road
  const inside = zoneCategoriesAt(orgId, lat, lng)
  if (!inside) return road
  let best: ZoneLimit = road
  for (const [cat, kmh] of Object.entries(policy.insideKmh) as [ZoneCategory, number][]) {
    if (inside.has(cat) && (best.source === 'road' || kmh < best.kmh)) best = { kmh, source: 'zone', zone: cat }
  }
  return best
}

/** Tests only. */
export function _setPolicyOrgsForTest(map: Map<string, SpeedPolicy>): void {
  policyOrgs = map
  loadedAt = Date.now()
}
