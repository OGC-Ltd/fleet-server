/**
 * The Analytics page's VEHICLE TYPE filter, resolved to vehicle ids.
 *
 * ## Why ids rather than a SQL predicate
 *
 * A "type" on this fleet is the plate's machine-family prefix — `MUFINDI - EX
 * 26` is an excavator — and that rule already exists once, in `machinePrefix`.
 * Re-expressing it as a regex inside each of the six aggregates that need
 * filtering would be six copies of a rule that has to agree with
 * `fleet-state`'s `category` field forever, and the first plate that does not
 * fit ("MUFINDI: OPTIM - CM 01") is the one they would disagree about.
 *
 * So the filter is resolved ONCE per request into a list of vehicle ids, and
 * every aggregate takes the same list. Prisma queries get `vehicleId: { in }`,
 * raw SQL gets `v.id = ANY(...)`. One rule, one place, and a filtered figure
 * can never describe a different set of machines than the composition ring
 * that was clicked to produce it.
 *
 * The extra query costs one indexed read of 218 rows on KASULU, and only on
 * requests that actually carry a filter.
 *
 * ## The vocabulary is the fleet's own, not the provider's
 *
 * KASULU's provider types are PLANT / SALOON / UNSPECIFIED / LORRY / BUS /
 * TRACTOR / TRUCK — 79 of 218 units are simply "PLANT" and 22 "UNSPECIFIED",
 * so 46% of the fleet lands in two buckets that tell an operator nothing about
 * what is on site. The plate prefix separates the same machines into EX, CTR,
 * MTR, DZ, WL, GR, BH. That is what the composition ring on the Analytics page
 * already draws, and a filter must speak the vocabulary of the chart it
 * filters.
 *
 * SUKARI's plates are ordinary registrations (KTCC, KTCB, KHMA, KCJ) and the
 * prefix rule answers on them perfectly happily — with REGISTRATION SERIES,
 * which look like machine families in a dropdown and group vehicles by nothing
 * an operator cares about. So this module is honest about what it computes and
 * does not pretend to judge: whether a fleet names its plates by machine is the
 * client's call, and the dash gates the control on its own `isPlantFleet` list
 * rather than on how many entries come back.
 */

import { Prisma } from '../../../generated/prisma/client.js'
import { prisma } from '../../lib/prisma.js'
import { machinePrefix } from '../fuel/fuel-theft-classifier.js'

/**
 * Plates carrying no recognisable prefix.
 *
 * Counted in the fleet and selectable as a group, never silently dropped: 14
 * of KASULU's 218 units are named `MUFINDI: 013` and a filter that could not
 * reach them would make the "all" total disagree with the sum of its parts.
 * The literal is shared with the dash — see `UNPREFIXED` in AnalyticsScreen.
 */
export const UNPREFIXED = '__unprefixed'

/** The category of one plate, by the same rule `fleet-state` labels units with. */
export const categoryOf = (plate: string): string =>
  machinePrefix(plate).trim() || UNPREFIXED

/**
 * `?categories=EX,CTR` → `['EX','CTR']`, or null when the caller asked for
 * everything.
 *
 * An empty or absent parameter is NOT an empty selection. "No categories
 * chosen" means the whole fleet on this page — the filter opens with nothing
 * ticked and shows every machine — so an empty list must resolve to the
 * unfiltered path rather than to a query that can only return nothing.
 */
export function parseCategories(raw: unknown): string[] | null {
  if (raw == null) return null
  const list = String(raw)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
  return list.length > 0 ? [...new Set(list)] : null
}

/**
 * The vehicle ids behind a category selection, or null when unfiltered.
 *
 * Returns an EMPTY ARRAY, not null, when the selection matches nothing: those
 * are different answers. Null means "do not filter"; empty means "the operator
 * asked for a category this fleet has none of", and the aggregates must then
 * return zeroes rather than the whole fleet.
 */
export async function vehicleIdsForCategories(
  orgId: string, categories: string[] | null,
): Promise<string[] | null> {
  if (categories == null) return null
  const wanted = new Set(categories)
  const rows = await prisma.vehicle.findMany({
    where:  { organisationId: orgId, isActive: true },
    select: { id: true, registrationPlate: true },
  })
  return rows.filter((v) => wanted.has(categoryOf(v.registrationPlate))).map((v) => v.id)
}

/** Resolve straight off the query string — what every controller here needs. */
export const vehicleIdsFromQuery = (orgId: string, raw: unknown) =>
  vehicleIdsForCategories(orgId, parseCategories(raw))

export interface VehicleCategory {
  /** The prefix itself — EX, CTR, `__unprefixed`. Labelling is the client's. */
  category: string
  units:    number
}

/**
 * What categories this fleet HAS, with unit counts, for the filter control.
 *
 * Read from the fleet rather than from a hard-coded list, because the list is
 * per-fleet and grows without warning — the same reason `typeLabel` on the
 * Analytics page maps unknown values through a rule instead of a table.
 *
 * This reports what the prefix rule FINDS, and nothing more. On a fleet whose
 * plates are ordinary registrations that is a list of registration series, not
 * of machine types; see the header for why telling those apart is the caller's
 * job and not something a count of entries can do.
 *
 * Most units first: a category of one should not head the list.
 */
export async function listCategories(orgId: string): Promise<VehicleCategory[]> {
  const rows = await prisma.vehicle.findMany({
    where:  { organisationId: orgId, isActive: true },
    select: { registrationPlate: true },
  })
  const counts = new Map<string, number>()
  for (const v of rows) {
    const c = categoryOf(v.registrationPlate)
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  return [...counts]
    .map(([category, units]) => ({ category, units }))
    .sort((a, b) => b.units - a.units || a.category.localeCompare(b.category))
}


/**
 * The filter as a SQL fragment, for the raw aggregates.
 *
 * A CONDITIONAL fragment rather than a `${ids} IS NULL OR ...` predicate baked
 * into every query. Two reasons, and the first is the one that matters:
 *
 *   · The unfiltered query text stays BYTE-IDENTICAL to what it was before
 *     this filter existed. That path is the one every visitor loads and the one
 *     the warm caches hold; it cannot regress on a plan change or on however
 *     Prisma decides to serialise a null array, because it is not a different
 *     query.
 *   · An always-present predicate parameterises the id list twice per query
 *     even when there is no list.
 *
 * An EMPTY array is deliberately still a fragment: `= ANY('{}')` is false for
 * every row, which is the right answer for "a category this fleet has none of".
 * Only `null` — meaning unfiltered — produces `Prisma.empty`.
 */
export const vehicleSql = (ids: string[] | null) =>
  ids == null ? Prisma.empty : Prisma.sql`AND v.id = ANY(${ids}::text[])`

/**
 * The same filter where there is no `vehicles` row to join.
 *
 * `notifications` carries the unit inside its feed id — lib/zone-presence
 * builds `zn-<vehicleId>-<zoneId>-<kind>-<ms>` — and a cuid contains no dashes,
 * so part 2 is exactly the vehicle id.
 */
export const feedVehicleSql = (ids: string[] | null) =>
  ids == null ? Prisma.empty
    : Prisma.sql`AND split_part(n.feed_id, '-', 2) = ANY(${ids}::text[])`
