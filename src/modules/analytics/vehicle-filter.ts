/**
 * The Analytics page's vehicle filter, resolved to vehicle ids.
 *
 * TWO SELECTIONS, ONE ANSWER. A TYPE selection ("EX,CTR") names machine
 * families; a UNIT selection names vehicles outright, because "how did THIS
 * lorry do" is a question about one plate and no category expresses it. They
 * resolve to the same thing — a list of vehicle ids — and when both are set
 * they INTERSECT: the units you picked, among the types you left ticked. That
 * is the only reading under which the controls cannot contradict each other,
 * and it means clearing either one widens the answer rather than changing its
 * meaning.
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
 * The most units one request may name.
 *
 * A guard on the query string, not a view about how many a person would pick:
 * every id lands in a cache key and in a `= ANY()` parameter, and an unbounded
 * list is an unbounded key. KASULU, the largest fleet here, carries 218 active
 * units — so a selection at this ceiling is already "the whole fleet, listed
 * out", which the empty selection expresses better and for free.
 */
export const MAX_VEHICLE_SELECTION = 300

/**
 * `?vehicles=cku1…,cku2…` → the ids, or null when the caller asked for
 * everything.
 *
 * Absent and empty both mean the whole fleet, for the same reason they do for
 * categories. Nothing here checks that an id EXISTS or belongs to the
 * organisation — that is `vehicleIdsFor`'s job, and it does it by intersecting
 * with the org's own fleet rather than by trusting the string.
 */
export function parseVehicleIds(raw: unknown): string[] | null {
  if (raw == null) return null
  const list = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_VEHICLE_SELECTION)
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
export const vehicleIdsForCategories = (orgId: string, categories: string[] | null) =>
  vehicleIdsFor(orgId, categories, null)

/**
 * The ids behind BOTH selections, or null when neither narrows anything.
 *
 * The org's own active fleet is the universe, and every filter is an
 * intersection with it. That is what makes a vehicle id from the query string
 * safe to accept without a separate ownership check: an id belonging to another
 * organisation — pasted, guessed, or left over from a company switch — is
 * simply not in the fleet this reads, so it drops out. A request naming only
 * such ids resolves to the empty array, which every aggregate answers with
 * zeroes. It cannot resolve to null, which would quietly widen a refused
 * selection into the whole fleet.
 *
 * One indexed read of the org's vehicles, and only on requests that filter.
 */
export async function vehicleIdsFor(
  orgId: string, categories: string[] | null, vehicles: string[] | null,
): Promise<string[] | null> {
  if (categories == null && vehicles == null) return null
  const rows = await prisma.vehicle.findMany({
    where:  { organisationId: orgId, isActive: true },
    select: { id: true, registrationPlate: true },
  })
  const wantedCats = categories == null ? null : new Set(categories)
  const wantedIds  = vehicles == null ? null : new Set(vehicles)
  return rows
    .filter((v) => (wantedCats == null || wantedCats.has(categoryOf(v.registrationPlate)))
                && (wantedIds  == null || wantedIds.has(v.id)))
    .map((v) => v.id)
}

/** Resolve straight off the query string — what every controller here needs. */
export const vehicleIdsFromQuery = (orgId: string, rawCats: unknown, rawVehicles?: unknown) =>
  vehicleIdsFor(orgId, parseCategories(rawCats), parseVehicleIds(rawVehicles))

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
 * The same filter on `notifications`, which has its own `vehicle_id` column.
 *
 * This read `split_part(n.feed_id, '-', 2)` first — the unit IS encoded in the
 * feed id, since lib/zone-presence builds `zn-<vehicleId>-<zoneId>-<kind>-<ms>`
 * and a cuid contains no dashes. It was also the wrong column to use: a
 * function of a column is not sargable, so every candidate row had to be read
 * and string-split, and the table has an index on
 * `(organisation_id, vehicle_id, occurred_at)` that covers exactly this
 * predicate and could not be used. The plain column is both simpler and the
 * one the planner can seek on.
 */
export const notificationVehicleSql = (ids: string[] | null) =>
  ids == null ? Prisma.empty : Prisma.sql`AND n.vehicle_id = ANY(${ids}::text[])`

/* ───────────────────────────── cache keys ────────────────────────────────── */

/**
 * A selection, canonically. Sorted, so the same two categories picked in either
 * order are one cache entry rather than two.
 */
export const categoriesKey = (categories: string[] | null): string =>
  categories?.length ? [...categories].sort().join(',') : 'all'

/**
 * A unit selection, canonically — sorted for the same reason, and separated
 * from the category part of the key because the two narrow independently.
 *
 * Long, and deliberately not hashed: a key is also what a cache dump has to be
 * read by when a figure looks wrong, and a digest turns "which selection is
 * this entry" into a question nobody can answer. 300 cuids is 7 kB in the worst
 * case, against payloads measured in hundreds of kilobytes.
 */
export const vehiclesKey = (vehicles: string[] | null): string =>
  vehicles?.length ? [...vehicles].sort().join(',') : 'all'

/**
 * The cache key for one windowed, optionally filtered read.
 *
 * FILTERED AND ANCHORED READS ARE CACHED, which reverses the original decision
 * here and is the whole point of this helper. They were computed live on the
 * reasoning that a selection is an unbounded key space — true, but the wrong
 * conclusion: these aggregates cost tens of seconds against the fleet, which is
 * precisely why they were put behind a warm cache in the first place, and
 * "unbounded" is what `maxEntries` on that cache already solves by evicting
 * oldest-first. Computing them live made every filter click a fresh
 * thirty-to-sixty-second query, so the page appeared to hang.
 *
 * The warmer still declares only the UNFILTERED, anchorless keys, so a
 * background sweep never spends the box's budget rebuilding one operator's
 * ad-hoc selection. Those keys enter on demand and age out.
 *
 * `|` separates because none of the parts can contain one: a cuid is
 * alphanumeric, an ISO instant uses `-`/`:`/`.`, and a category is an
 * upper-case plate prefix or the `__unprefixed` sentinel.
 */
export const windowCacheKey = (
  orgId: string, days: number, to: Date | undefined,
  categories: string[] | null, vehicles: string[] | null = null,
): string => `${orgId}|${days}|${to ? to.toISOString() : 'now'}|`
  + `${categoriesKey(categories)}|${vehiclesKey(vehicles)}`

/** The inverse, for a cache's `compute`. */
export function parseWindowCacheKey(key: string): {
  orgId: string; days: number; to?: Date
  categories: string[] | null; vehicles: string[] | null
} {
  const [orgId = '', days = '0', anchor = 'now', cats = 'all', units = 'all'] = key.split('|')
  return {
    orgId,
    days: Number(days),
    to: anchor === 'now' ? undefined : new Date(anchor),
    categories: cats === 'all' ? null : cats.split(','),
    vehicles: units === 'all' ? null : units.split(','),
  }
}
