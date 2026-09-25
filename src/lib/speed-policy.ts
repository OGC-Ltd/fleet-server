/**
 * Speed limits that depend on WHAT a unit is and WHERE it is, per organisation.
 *
 * The fleet-wide limit (OVERSPEED_LIMIT_KMH, with OVERSPEED_LIMIT_BY_TYPE) is
 * one number per vehicle type, the same in every org. An org listed here
 * replaces it with its own rules: a rule per vehicle type, and a `default`
 * rule for every type not listed. A rule is read off the org's own surveyed
 * zones — nothing maps the roads themselves: inside a zone of a category in
 * `insideKmh`, that category's limit; anywhere else, `outsideKmh`.
 *
 * Kasulu (set 2026-09-25):
 *   · LMVs — light motor vehicles, the SALOON type; all 26 are named
 *     "LMV nn" — 60 km/h inside the factory premises, 100 km/h on the
 *     national roads;
 *   · every other unit — buses, lorries, trucks, tractors, plant and the
 *     untyped — 40 km/h inside the factory premises, 80 km/h on the
 *     highway (everywhere outside it; raised from 40 everywhere, same day).
 *
 * Kasulu's factory is the "Factory site Location" polygon, the only zone
 * lib/zone-taxonomy files as `factory` (the haulage road from the factory is
 * filed as `road`, deliberately — see categorise). Its farms, haulage roads,
 * logistic centres and workshops are all outside it, so an LMV there takes the
 * road limit — as agreed when this was set.
 *
 * Keyed by org CODE, not id, so it reads the same in every environment; types
 * are Vehicle.vehicleType, upper case.
 */

import { prisma } from './prisma.js'
import { logger } from './logger.js'
import { zoneCategoriesAt, loadOrgZones } from './zone-presence.js'
import type { ZoneCategory } from './zone-taxonomy.js'

/** One vehicle type's limits in one org. */
export interface SpeedRule {
  /** Anywhere not inside one of `insideKmh`'s zones — or everywhere, without them. */
  outsideKmh: number
  /** Limit inside a zone of this category. The LOWEST applies where several overlap. */
  insideKmh?: Partial<Record<ZoneCategory, number>>
}

export interface SpeedPolicy {
  /** For every vehicle type not in `byType`. */
  default: SpeedRule
  /** By Vehicle.vehicleType, upper case. */
  byType?: Readonly<Record<string, SpeedRule>>
}

export const SPEED_POLICIES: Readonly<Record<string, SpeedPolicy>> = {
  KASULU: {
    default: { outsideKmh: 80, insideKmh: { factory: 40 } },
    byType:  { SALOON: { outsideKmh: 100, insideKmh: { factory: 60 } } },
  },
}

/**
 * Where a limit came from — recorded on each speeding incident.
 * 'zone' and 'road' are a place-dependent rule, inside / outside its zones;
 * 'org' is an org rule that is one number everywhere.
 */
export type LimitSource = 'type' | 'fleet' | 'zone' | 'road' | 'org'

export interface ZoneLimit {
  kmh:    number
  source: 'zone' | 'road' | 'org'
  /** The zone category that set it, or null outside one. */
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

/** The org's policy, if it has one and it has been warmed. */
export function speedPolicyFor(orgId: string): SpeedPolicy | null {
  return policyOrgs.get(orgId) ?? null
}

/** The rule one vehicle type is held to under a policy. */
export function ruleFor(policy: SpeedPolicy, vehicleType: string | null | undefined): SpeedRule {
  return policy.byType?.[(vehicleType ?? '').toUpperCase()] ?? policy.default
}

/**
 * The org's limit for this vehicle type at a point, or null when the org has
 * no policy.
 *
 * With no fix, or before the org's zones have loaded, the answer is the
 * outside limit: there is no evidence the unit is inside the factory, and the
 * stricter figure must not be asserted without it.
 */
export function zoneLimitAt(
  orgId: string,
  vehicleType: string | null | undefined,
  lat: number | null | undefined,
  lng: number | null | undefined,
): ZoneLimit | null {
  const policy = policyOrgs.get(orgId)
  if (!policy) return null
  const rule = ruleFor(policy, vehicleType)
  const zones = Object.entries(rule.insideKmh ?? {}) as [ZoneCategory, number][]
  // One number everywhere for this type: no zones to look up.
  if (!zones.length) return { kmh: rule.outsideKmh, source: 'org', zone: null }
  const road: ZoneLimit = { kmh: rule.outsideKmh, source: 'road', zone: null }
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return road
  const inside = zoneCategoriesAt(orgId, lat, lng)
  if (!inside) return road
  let best: ZoneLimit = road
  for (const [cat, kmh] of zones) {
    if (inside.has(cat) && (best.source === 'road' || kmh < best.kmh)) best = { kmh, source: 'zone', zone: cat }
  }
  return best
}

/** Tests only. */
export function _setPolicyOrgsForTest(map: Map<string, SpeedPolicy>): void {
  policyOrgs = map
  loadedAt = Date.now()
}
