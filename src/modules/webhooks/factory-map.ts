/**
 * Which RaiFactorySuite factory belongs to which of our organisations — and,
 * more importantly, why the factory is NOT how an event gets routed.
 *
 * ## Why this file exists rather than the two copies it replaces
 *
 * The table was declared twice — once in raifactorysuite-alerts.service and
 * once in raifactorysuite-events.service — with a comment on each saying it
 * mirrored the sync scripts. Two tables that must agree and nothing making
 * them agree: adding a factory to one and not the other silently routes that
 * site's alerts and its dispatches to different places, and the symptom is
 * "some of it arrives", which is the hardest kind to notice.
 *
 * ## The mapping is a filter, and that is the point
 *
 * A factoryCode absent from this table is not an error in the payload — the
 * provider serves factories we do not track, and it is right to drop those.
 * What was wrong is dropping them QUIETLY: the events path returned false and
 * the webhook controller counted zero, which suppressed even the summary log
 * line, so a whole factory's traffic arrived, parsed cleanly, and vanished
 * leaving nothing behind to find. `skipUnmappedFactory` below is the fix — one
 * warning per factory code, not one per event, so a misconfiguration is loud
 * on the first delivery and silent on the next ten thousand.
 *
 * ## A factory is a PLACE, not an owner
 *
 * This is the correction of 2026-09-09, and it is the whole reason
 * `resolveEventOrg` exists below.
 *
 * Naitiri is a West Kenya Sugar factory, so `NAITIRI → WESTSUGAR` reads as
 * obviously right and was used as the routing key for every dispatch, movement
 * and sale the site produced. It is wrong, because units from OTHER
 * organisations load there. KCP 134P is a Menengai truck that collects sugar at
 * Naitiri; every event it produced was stamped WESTSUGAR and broadcast to the
 * West Kenya Sugar feed, where it does not belong, while Menengai — whose truck
 * it is, and whose operator is waiting for it — saw nothing at all.
 *
 * The provider cannot help us here, and this is worth being precise about
 * because the obvious fix is to ask it. Its `/vehicles` registry lists KCP 134P
 * as `factoryCode: NAITIRI` (measured 2026-09-09: of 625 vehicles, 624 are
 * NDHIWA and that one is NAITIRI). It has no concept of Menengai. So fetching
 * the unit from the provider when an event lands returns the SAME wrong answer
 * the factory code does — the ownership we need exists only in our own
 * `vehicles` table, put there by the Wialon sync.
 *
 * Hence: resolve by PLATE against our registry, and fall back to the factory
 * only for a unit we do not hold.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { normalisePlate } from '../../providers/wialon/wialon.unit-name.js'

/**
 * A factory the provider serves: who runs it, what to call it in a sentence,
 * and where it is.
 *
 * The coordinates are not decoration. A sale leaving Naitiri for a customer
 * starts at NAITIRI — not at the owning organisation's hub, which for a
 * Menengai unit is the Nakuru refinery ~250 km away. Anything measuring how far
 * this run has to go must start from here, so the point belongs next to the
 * routing rather than in whichever module happened to need it first.
 *
 * Measured, not looked up: these are the densest 1.1 km cell of each site's
 * fixes on 2026-08-31, the same derivation behind dashboard.weather's location
 * list (which is where they lived until this file needed them too).
 *
 * NDHIWA is the exception: it is the site as GIVEN by the operator
 * (2026-09-13), not as derived. It carried 0.3358 / 34.4928 — copied from the
 * "Sukari HQ" entry in that weather list, which sits near Kakamega, on the
 * WRONG SIDE OF THE EQUATOR and about 129 km from the mill.
 *
 * The telemetry agrees with the figure we were given, which is why it is worth
 * recording both: the median of 268,032 SUKARI fixes is -0.82001 / 34.38443 and
 * the factory's own two weighbridges, derived separately for
 * weighments/weighbridge.geography, are -0.8227 / 34.3832 — the yard, from two
 * directions, around a stated gate at -0.82340 / 34.38449.
 *
 * Nothing read this yet, which is exactly why it survived: a coordinate with no
 * consumer is never wrong out loud. The first thing to measure a distance from
 * the Ndhiwa gate would have been 129 km short.
 */
export interface Factory {
  /** Our organisation `code` — the factory's OPERATOR, not the owner of any
   *  particular unit that visits it. */
  orgCode: string
  /** How the factory is named in a feed line: "loaded at Naitiri". */
  label:   string
  lat:     number
  lng:     number
  /**
   * What leaves this gate on a SALES run, named the way an operator would.
   *
   * A property of the SITE, not of the load: the provider's `/sales` payload
   * carries a tonnage and a destination and never says what the tonnage is of.
   * Naitiri is a sugar factory, so a sales run out of it is processed sugar —
   * that is the only place the fact is known, so it is recorded here rather
   * than guessed at the point of display.
   *
   * Read by the Current Cargo card and written onto the trip's CargoManifest.
   */
  commodity: string
  /** How that commodity travels. Processed sugar leaves in 50 kg bags, so it is
   *  PACKAGED; cane is tipped loose and is BULK. Written onto the manifest so
   *  analytics can group by it without re-deriving from the name. */
  cargoType: 'BULK' | 'PACKAGED'
}

/**
 * Provider factoryCode → the factory.
 *
 * The provider serves two. NDHIWA has been here since this integration was
 * written; NAITIRI is a West Kenya Sugar factory and had never been added, so
 * every dispatch, gate movement and alert it produced was discarded on arrival
 * — half the provider's traffic, for as long as the integration has run.
 */
export const FACTORIES: Record<string, Factory> = {
  NDHIWA:  { orgCode: 'SUKARI',    label: 'Ndhiwa',  lat: -0.82340, lng: 34.38449,
             commodity: 'Raw Sugarcane',   cargoType: 'BULK' },
  NAITIRI: { orgCode: 'WESTSUGAR', label: 'Naitiri', lat: 0.7821, lng: 34.8776,
             commodity: 'Processed Sugar', cargoType: 'PACKAGED' },
}

/** Kilograms in the bags this fleet counts sugar in. */
export const BAG_KG = 50

/**
 * Bags in a load, or null when there is no weight to divide.
 *
 * Refuses a zero or negative tonnage rather than reporting "0 bags": the
 * provider models `tonnage` as optional, and a run whose weight has not been
 * entered yet is not a run carrying nothing. Every surface that shows a bag
 * count derives it here, so the feed line, the cargo card and the persisted
 * manifest cannot disagree about what 29 tonnes comes to.
 */
export function bagsFromTonnes(tonnage: number | null | undefined): number | null {
  if (tonnage == null || !Number.isFinite(tonnage) || tonnage <= 0) return null
  return Math.round((tonnage * 1000) / BAG_KG)
}

/**
 * Kept as the operator-of-record mapping the alerts path still uses.
 *
 * An alert names a factory and sometimes a plate inside free text; it is a
 * statement about the SITE, so it routes to the site's operator. Only the
 * events that name a unit outright (dispatch, movement, sale) go through
 * `resolveEventOrg`.
 */
export const FACTORY_TO_ORG: Record<string, string> =
  Object.fromEntries(Object.entries(FACTORIES).map(([code, f]) => [code, f.orgCode]))

export const factoryOf = (factoryCode: string): Factory | null =>
  FACTORIES[factoryCode] ?? null

/**
 * Gates whose OUTBOUND load is processed sugar.
 *
 * Derived from `cargoType` rather than listed, because that column already
 * carries the fact: sugar leaves in 50 kg bags (PACKAGED), cane is tipped loose
 * (BULK). A second hand-written list of "the sugar factories" would be a
 * promise to keep two things in step that nothing checks.
 *
 * Read by analytics/sugar-hauls, which needs to know which gate's TRANSPORT
 * dispatches are sugar going out rather than cane coming in. At Ndhiwa a cane
 * dispatch is an inbound delivery and has no business in a sugar-haul table; at
 * Naitiri there is no cane to deliver, so a run leaving that gate is sugar
 * whichever office raised the paperwork.
 */
export const SUGAR_GATES: string[] = Object.entries(FACTORIES)
  .filter(([, f]) => f.cargoType === 'PACKAGED')
  .map(([code]) => code)

/**
 * Cached because it is asked once per event on a hot path and the answer
 * cannot change without a deploy. A null is cached too: an unmapped factory
 * must not re-query for every one of its events.
 */
const orgIdCache = new Map<string, string | null>()

export async function resolveOrgId(factoryCode: string): Promise<string | null> {
  if (orgIdCache.has(factoryCode)) return orgIdCache.get(factoryCode) ?? null
  const code = FACTORY_TO_ORG[factoryCode]
  if (!code) { orgIdCache.set(factoryCode, null); return null }
  const org = await prisma.organisation.findUnique({ where: { code }, select: { id: true } })
  if (!org) {
    // Mapped to an organisation that is not in the database — a typo in the
    // table, or a tenant that was renamed. Worth its own line: it looks
    // identical to "not mapped" from the caller's side and is a quite
    // different mistake.
    logger.warn({ factoryCode, orgCode: code }, 'Factory maps to an organisation code that does not exist')
  }
  orgIdCache.set(factoryCode, org?.id ?? null)
  return org?.id ?? null
}

export interface EventOrg {
  organisationId: string
  /** Our vehicle row, when the plate resolved. Null when we do not hold it. */
  vehicleId:      string | null
  /** The plate in its stored, written form — use this for every downstream
   *  lookup so the provider's spacing never decides whether a query matches. */
  plate:          string
  /** The factory the event happened AT, for the narration. Null if unmapped. */
  factory:        Factory | null
  /** True when the org came from our vehicle registry rather than the factory. */
  viaPlate:       boolean
}

/**
 * Who should see an event about this unit at this factory.
 *
 * The plate decides. `Vehicle.registrationPlate` is globally UNIQUE, so this is
 * one indexed lookup and there is no organisation to scope it by — which is the
 * point, since scoping it by the factory's operator is exactly the bug.
 *
 * Matched on the normalised form because the provider's spelling is not stable
 * ("KCP 134P" and "KCP134P" both occur) while the column holds the written form
 * ("KCP 134P"). Comparing raw text would miss, fall through to the factory, and
 * silently reinstate the misrouting for precisely the units this exists for —
 * so the comparison is done on `normalisePlate` and the WRITTEN form is what
 * gets returned and stored.
 *
 * Falls back to the factory's operator for a unit we do not hold. That is not a
 * guess: a plate absent from our registry is a vehicle we do not track, and the
 * site that reported it is the only organisation with any claim on the event.
 */
export async function resolveEventOrg(
  factoryCode: string,
  rawPlate:    string,
): Promise<EventOrg | null> {
  const factory = factoryOf(factoryCode)
  const wanted  = normalisePlate(rawPlate)

  // Normalised comparison against a column that stores the written form. There
  // are only hundreds of vehicles per org and this is indexed on the plate, but
  // the index cannot serve a REPLACE() on the column — so match the exact
  // written form first (the overwhelmingly common case, and an index hit) and
  // only fall back to the normalised scan when the provider's spacing differs.
  const vehicle =
    (await prisma.vehicle.findFirst({
      where:  { registrationPlate: rawPlate.trim().toUpperCase().replace(/\s+/g, ' ') },
      select: { id: true, organisationId: true, registrationPlate: true },
    })) ??
    (await findByNormalisedPlate(wanted))

  if (vehicle) {
    // The unit's owner and the factory's operator disagreeing is the NORMAL
    // case this function exists for, not an error — but it is worth a line the
    // first time each unit does it, because it is also what a plate collision
    // looks like. Three West Sugar machines share a registration with Sukari
    // plant (see prisma/fix-plate-format.ts); the UNIQUE column means one row
    // won, and if it won wrongly this log is the only place that shows.
    const operatorId = await resolveOrgId(factoryCode)
    if (operatorId && operatorId !== vehicle.organisationId) noteVisitor(rawPlate, factoryCode)

    return {
      organisationId: vehicle.organisationId,
      vehicleId:      vehicle.id,
      plate:          vehicle.registrationPlate,
      factory,
      viaPlate:       true,
    }
  }

  const organisationId = await resolveOrgId(factoryCode)
  if (!organisationId) return null
  return {
    organisationId,
    vehicleId: null,
    plate:     rawPlate.trim().toUpperCase().replace(/\s+/g, ' '),
    factory,
    viaPlate:  false,
  }
}

/**
 * The spacing-insensitive fallback.
 *
 * Separate from the equality above so the common path stays a plain index hit
 * and the cost of this one is visible where it is paid. It is a sequential scan
 * — no index can serve a function of the column — but it runs only when the
 * provider spelled the plate differently from the way we store it, and the
 * table is a few thousand rows.
 *
 * The expression mirrors `normalisePlate` exactly (strip everything that is not
 * A-Z0-9, uppercase). If that function's definition ever changes, this changes
 * with it or the fallback silently stops matching.
 */
async function findByNormalisedPlate(wanted: string) {
  if (!wanted) return null
  const rows = await prisma.$queryRaw<
    { id: string; organisationId: string; registrationPlate: string }[]
  >`
    SELECT id,
           organisation_id    AS "organisationId",
           registration_plate AS "registrationPlate"
      FROM vehicles
     WHERE UPPER(REGEXP_REPLACE(registration_plate, '[^A-Za-z0-9]', '', 'g')) = ${wanted}
     LIMIT 2
  `
  // More than one row means two vehicles differ only by punctuation — a
  // collision the UNIQUE column does not catch. Refuse rather than pick: which
  // organisation owns the unit is not a question a tie-break gets to answer.
  if (rows.length > 1) {
    logger.warn({ plate: wanted, matches: rows.map(r => r.registrationPlate) },
      'Plate matches two vehicles once punctuation is ignored — not routing by plate')
    return null
  }
  return rows[0] ?? null
}

/** Units already noted as visiting a factory their owner does not operate, so
 *  the log carries one line per unit rather than one per event. */
const visitors = new Set<string>()

function noteVisitor(plate: string, factoryCode: string): void {
  const key = `${normalisePlate(plate)}@${factoryCode}`
  if (visitors.has(key)) return
  visitors.add(key)
  logger.info(
    { plate, factoryCode },
    'Unit belongs to a different organisation than the factory it is at — routing to its OWNER',
  )
}

/** Factory codes already warned about, so the log carries one line per factory
 *  rather than one per event. Reset only by a restart, which is when a changed
 *  table would take effect anyway. */
const warned = new Set<string>()

/**
 * Say once, loudly, that a factory's events are being discarded.
 *
 * Call this wherever `resolveOrgId` returns null. The alerts path has always
 * logged this; the events path never did, which is why NAITIRI's dispatches
 * and gate movements left no trace at all.
 */
export function skipUnmappedFactory(factoryCode: string, what: string, id?: string): void {
  if (warned.has(factoryCode)) return
  warned.add(factoryCode)
  logger.warn(
    { factoryCode, event: what, sampleId: id, mapped: Object.keys(FACTORIES) },
    'Provider event for an unmapped factory — DISCARDED. Add it to FACTORIES to keep it.',
  )
}
