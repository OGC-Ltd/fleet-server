/**
 * Turning a provider weighbridge ticket into a row we keep.
 *
 * Both ways in land here — the reconcile poll and the `weighment.created` /
 * `weighment.updated` webhook — so the parsing of the provider's two awkward
 * conventions (split date/time, and a transfer that names its centre by code
 * only) is written once and cannot disagree between the paths.
 *
 * Upserts, never inserts. The provider re-serves the same ticket on every poll
 * and the webhook delivers it again on every edit, so the only safe write is
 * one keyed on the ticket's own identity — `(category, tokenNumber)`.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { Prisma, WeighmentCategory } from '../../../generated/prisma/client.js'
import { PROVIDER_UTC_OFFSET } from '../../lib/provider-time.js'
import { normalisePlate } from '../../providers/wialon/wialon.unit-name.js'
import type {
  RaiFactorySuiteCaneDeliveryRow,
  RaiFactorySuiteCaneTransferRow,
} from '../../providers/raifactorysuite/raifactorysuite.client.js'

/**
 * The factories whose scale software feeds us, and whose tickets they are.
 *
 * Until ~2026-09-17 the feed was Ndhiwa's alone and carried no factory at all,
 * so every ticket was filed under Sukari. Then Kabras and Nzoia joined it,
 * each ticket now naming its `factoryCode`, and for a week West Kenya's
 * tickets (~4,800 of them) were filed under Sukari too. Both new factories are
 * West Kenya's: every plate on them that matches a unit we hold matches a
 * WESTSUGAR one (571 Kabras, 47 Nzoia, measured 2026-09-25).
 *
 * `siteBase` keeps a yard's code unique within its organisation. The provider
 * numbers centres PER FACTORY (101 is Ndhiwa's factory, Kabras Factory Yard
 * and Nzoia Factory Yard) and Kabras and Nzoia share an organisation, so the
 * stored `centerCode` is the provider's code plus this. Ndhiwa is 0 so Sukari's
 * codes, and every link and tab built on them, are unchanged.
 *
 * A factory not listed is dropped with a warning rather than guessed at: a
 * ticket filed under the wrong company is the bug this table exists to fix.
 */
export const WEIGHBRIDGE_FACTORIES: Record<string, {
  /** The organisation a ticket from this feed belongs to — unless its yard is in `yardOrgs`. */
  orgCode:      string
  siteBase:     number
  /** Where a ticket's lorry may be matched, after the ticket's own organisation. */
  vehicleOrgs?: readonly string[]
}> = {
  NDHIWA: { orgCode: 'SUKARI',    siteBase: 0 },
  // Kabras and Nzoia became organisations of their own on 2026-10-07. Each
  // mill's FACTORY YARD belongs to that mill (YARD_ORGS); every other yard
  // either feed names (Magut, Busia, Misikhu, Naitiri, Khalaba, Lake Agro,
  // Selient, Kitale, Makhese, Weyeta) stays West Kenya's — the operator's split.
  //
  // Lorries cross all three: of the Kabras-feed tickets that matched a unit,
  // 753 were West Kenya lorries, 599 Kabras and 1 Nzoia. So a lorry is looked
  // for in the ticket's own organisation first, then across the group.
  // `siteBase` is unchanged, so every stored site code still reads the same.
  KABRAS: { orgCode: 'WESTSUGAR', siteBase: 1000, vehicleOrgs: ['KABRAS', 'NZOIA', 'WESTSUGAR'] },
  NZOIA:  { orgCode: 'WESTSUGAR', siteBase: 2000, vehicleOrgs: ['NZOIA', 'KABRAS', 'WESTSUGAR'] },
}

/** Yards that are not their feed's default organisation's, by site code
 *  (after SITE_ALIASES, so a yard is one key whichever feed names it). */
export const YARD_ORGS: Readonly<Record<number, string>> = {
  1101: 'KABRAS',  // KABRAS FACTORY YARD
  2101: 'NZOIA',   // NZOIA FACTORY YARD — both feeds
}

/** The organisation code a ticket belongs to, from its feed and stored site code. */
export const weighmentOrgCode = (factoryCode: string, site: number): string | null => {
  const f = WEIGHBRIDGE_FACTORIES[factoryCode]
  return f ? (YARD_ORGS[site] ?? f.orgCode) : null
}

/** Rows from before the feed named its factory were all Ndhiwa's. */
export const LEGACY_FACTORY = 'NDHIWA'

/** The provider's centre code as the site code we store. */
export const siteCodeOf = (factoryCode: string, centerCode: number): number => {
  const raw = (WEIGHBRIDGE_FACTORIES[factoryCode]?.siteBase ?? 0) + centerCode
  return SITE_ALIASES[raw] ?? raw
}

/**
 * One yard, one site code.
 *
 * Each feed numbers yards its own way, so a yard BOTH feeds name came out as
 * two sites — measured 2026-10-07: Weyeta Yard as 1200 (Kabras feed, 362
 * tickets) and 2103 (Nzoia feed, 275), Nzoia Factory Yard as 1201 (6) and
 * 2101 (1,712). The operator saw each twice. The Kabras feed's codes fold
 * into the Nzoia feed's, which holds the yard's weighbridges and most of its
 * tickets.
 */
export const SITE_ALIASES: Readonly<Record<number, number>> = {
  1200: 2103,  // WEYETA YARD
  1201: 2101,  // NZOIA FACTORY YARD
}

/**
 * Site code -> name.
 *
 * A DELIVERY row carries both, so this table is not needed to read one. An
 * Ndhiwa TRANSFER carries `centerFrom` and no name at all, which is the whole
 * reason this exists: without it every transfer would render as a number.
 *
 * Seeded with Ndhiwa's four, measured against the live feed 2026-09-10. An
 * unknown code is labelled rather than dropped, and `learnCentre` below keeps
 * it current from the feed itself, so that label is temporary in practice.
 */
const CENTRE_NAMES = new Map<number, string>([
  [101, 'FACTORY'],
  [102, 'OPAPO'],
  [103, 'OYANI'],
  [104, 'NYAONDO'],
])

// There is deliberately no `knownCentres()` export any more. It existed to
// seed the page's tab strip, and a hardcoded list is the wrong authority for
// WHOSE bridges these are — see `findOrgCentres` in the repository, which asks
// the organisation's own tickets. The map below survives for the one job it is
// genuinely the authority on: naming the centre a TRANSFER refers to by code.

/** Record a code->name pair seen on a row, so a new yard names itself the
 *  first time it weighs anything rather than waiting for a deploy. */
function learnCentre(code: number, name: string | null | undefined): void {
  if (!name || CENTRE_NAMES.get(code) === name) return
  if (CENTRE_NAMES.has(code)) {
    logger.warn({ code, was: CENTRE_NAMES.get(code), now: name }, 'Weighbridge centre renamed by the provider')
  } else {
    logger.info({ code, name }, 'Weighbridge centre seen for the first time')
  }
  CENTRE_NAMES.set(code, name)
}

const centreName = (code: number): string => CENTRE_NAMES.get(code) ?? `Centre ${code}`

/**
 * A provider date + its HHMM companion, as an instant.
 *
 * The two halves arrive apart: `"2026-09-09T00:00:00"` (always midnight) and
 * `1138`, which is 11:38 — an HHMM INTEGER, not minutes past midnight. Read
 * the wrong way it stays plausible until mid-afternoon and then produces times
 * past 24:00, so the minute part is checked rather than trusted.
 *
 * Stamped `+03:00` for the same reason every other provider timestamp is (see
 * lib/provider-time): the payload carries no offset, both fleets run on EAT,
 * and resolving it against the host clock would put the whole page three hours
 * out on the production box and be right on a dev machine.
 */
export function weighmentAt(date: string | null | undefined, hhmm: number | null | undefined): Date | null {
  if (!date) return null
  const day = date.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null

  const t = hhmm ?? 0
  const h = Math.floor(t / 100)
  const m = t % 100
  if (!Number.isFinite(t) || h > 23 || m > 59 || t < 0) {
    // Not a fatal payload: the DATE is still true and a ticket without a
    // usable clock is better than no ticket. Fall back to midnight and say so
    // once, because it is also what a units change upstream would look like.
    logger.warn({ date, hhmm }, 'Weighbridge time is not HHMM — storing the date at midnight')
    return new Date(`${day}T00:00:00${PROVIDER_UTC_OFFSET}`)
  }

  const pad = (n: number) => String(n).padStart(2, '0')
  return new Date(`${day}T${pad(h)}:${pad(m)}:00${PROVIDER_UTC_OFFSET}`)
}

/** The columns a ticket writes, whichever feed it came from. */
export type WeighmentFields = Omit<Prisma.WeighmentUncheckedCreateInput, 'id' | 'receivedAt' | 'updatedAt' | 'source'>

/**
 * A provider row as the columns it writes.
 *
 * Exported so it can be tested against payloads captured from the live feed
 * rather than against fixtures written from the same understanding as the
 * parser — which is the failure mode for a format whose two awkward parts (the
 * HHMM clock, and a transfer that names its centre by code) both look
 * plausible when read wrongly.
 */
export function normaliseWeighment(
  row: RaiFactorySuiteCaneDeliveryRow | RaiFactorySuiteCaneTransferRow,
  organisationId: string,
  vehicleId: string | null,
): WeighmentFields {
  return row.category === 'CANE_TRANSFER'
    ? normaliseTransfer(row, organisationId, vehicleId)
    : normaliseDelivery(row, organisationId, vehicleId)
}

function normaliseDelivery(row: RaiFactorySuiteCaneDeliveryRow, organisationId: string, vehicleId: string | null): WeighmentFields {
  const factoryCode = row.factoryCode ?? LEGACY_FACTORY
  const site = siteCodeOf(factoryCode, row.centerCode)
  learnCentre(site, row.centerName)
  return {
    organisationId,
    factoryCode,
    category:      WeighmentCategory.CANE_DELIVERY,
    tokenNumber:   BigInt(row.tokenNumber),
    tokenAt:       weighmentAt(row.tokenDate, row.tokenTime) ?? new Date(),
    vehicleNo:     row.vehicleNo,
    vehiclePlate:  normalisePlate(row.vehicleNo),
    vehicleId,
    driverName:    row.driverName,
    centerCode:    site,
    centerName:    row.centerName ?? centreName(site),
    grossWeightKg: row.grossWeight ?? null,
    grossAt:       weighmentAt(row.grossDate, row.grossTime),
    grossOperator: row.grossOperator ?? null,
    grossBridgeNo: row.grossWeighbridgeNo ?? null,
    tareWeightKg:  row.tareWeight ?? null,
    tareAt:        weighmentAt(row.tareDate, row.tareTime),
    tareOperator:  row.tareOperator ?? null,
    tareBridgeNo:  row.tareWeighbridgeNo ?? null,
    netWeightKg:   row.netWeight ?? null,
    productCode:   row.productCode ?? null,
    productName:   row.productName ?? null,
  }
}

/**
 * A transfer's CENTRE legs go in the shared columns and its FACTORY legs in
 * the `factory_*` ones — so a grid row reads the same whichever feed produced
 * it, and the centre tab a ticket appears under is the place it was loaded.
 */
function normaliseTransfer(row: RaiFactorySuiteCaneTransferRow, organisationId: string, vehicleId: string | null): WeighmentFields {
  const factoryCode = row.factoryCode ?? LEGACY_FACTORY
  // Ndhiwa names the origin in `centerFrom`; Kabras and Nzoia leave that null
  // and name the yard in `centerCode`, with its weights at the top level.
  const from = row.centerFrom ?? row.centerCode
  if (from == null) throw new Error(`Transfer ${row.tokenNumber} names no centre`)
  const site = siteCodeOf(factoryCode, from)
  learnCentre(site, row.centerName)
  return {
    organisationId,
    factoryCode,
    category:      WeighmentCategory.CANE_TRANSFER,
    tokenNumber:   BigInt(row.tokenNumber),
    tokenAt:       weighmentAt(row.tokenDate, row.tokenTime) ?? new Date(),
    vehicleNo:     row.vehicleNo,
    vehiclePlate:  normalisePlate(row.vehicleNo),
    vehicleId,
    driverName:    row.driverName,
    centerCode:    site,
    centerName:    row.centerName ?? centreName(site),
    grossWeightKg: row.centerGrossWeight ?? row.grossWeight ?? null,
    grossAt:       weighmentAt(row.centerGrossDate, row.centerGrossTime),
    grossOperator: row.centerGrossOperator ?? null,
    grossBridgeNo: row.centerGrossWeighbridgeNo ?? null,
    tareWeightKg:  row.centerTareWeight ?? row.tareWeight ?? null,
    tareAt:        weighmentAt(row.centerTareDate, row.centerTareTime),
    tareOperator:  row.centerTareOperator ?? null,
    tareBridgeNo:  row.centerTareWeighbridgeNo ?? null,
    netWeightKg:   row.centerNetWeight ?? row.netWeight ?? null,
    factoryGrossWeightKg: row.factoryGrossWeight ?? null,
    factoryGrossAt:       weighmentAt(row.factoryGrossDate, row.factoryGrossTime),
    factoryGrossOperator: row.factoryGrossOperator ?? null,
    factoryGrossBridgeNo: row.factoryGrossWeighbridgeNo ?? null,
    factoryTareWeightKg:  row.factoryTareWeight ?? null,
    factoryTareAt:        weighmentAt(row.factoryTareDate, row.factoryTareTime),
    factoryTareOperator:  row.factoryTareOperator ?? null,
    factoryTareBridgeNo:  row.factoryTareWeighbridgeNo ?? null,
    factoryNetWeightKg:   row.factoryNetWeight ?? null,
  }
}

/**
 * Our vehicle for this plate, if we hold one.
 *
 * Deliberately NOT `resolveEventOrg`. That function decides which
 * organisation an event belongs to from the unit's owner, which is right for a
 * dispatch — the event is about the lorry — and wrong here: a weighbridge
 * ticket is the factory's record of its own scale, whoever's lorry drove onto it.
 * Most of these lorries are contractors' and match nothing we hold, so a null
 * is the normal case and not a failure.
 */
async function findVehicleId(organisationIds: string[], rawPlate: string): Promise<string | null> {
  const written = rawPlate.trim().toUpperCase().replace(/\s+/g, ' ')
  const wanted = normalisePlate(rawPlate)
  // In order: the factory's own organisation first, then its group.
  for (const organisationId of organisationIds) {
    const exact = await prisma.vehicle.findFirst({
      where:  { organisationId, registrationPlate: written },
      select: { id: true },
    })
    if (exact) return exact.id

    // The provider's spacing is not stable ("KCP 134P" and "KCP134P" both
    // occur), and no index can serve a REPLACE() on the column — so this scan
    // is the fallback, not the first move.
    const rows = await prisma.vehicle.findMany({
      where:  { organisationId },
      select: { id: true, registrationPlate: true },
    })
    const hit = rows.find(v => normalisePlate(v.registrationPlate) === wanted)
    if (hit) return hit.id
  }
  return null
}

/** Organisation id per code. Cached: the mapping cannot change without a
 *  deploy, and a null is cached too so an unknown code does not query per row. */
const orgIds = new Map<string, string | null>()
async function orgIdOf(code: string | null): Promise<string | null> {
  if (!code) return null
  if (orgIds.has(code)) return orgIds.get(code) ?? null
  const org = await prisma.organisation.findUnique({ where: { code }, select: { id: true } })
  orgIds.set(code, org?.id ?? null)
  return org?.id ?? null
}

/** Organisation ids a ticket's lorry may be matched in: the ticket's own first. */
async function vehicleOrgIdsFor(factoryCode: string, ownOrgId: string): Promise<string[]> {
  const ids = await Promise.all((WEIGHBRIDGE_FACTORIES[factoryCode]?.vehicleOrgs ?? []).map(orgIdOf))
  return [ownOrgId, ...ids.filter((id): id is string => !!id && id !== ownOrgId)]
}

/** Once per factory per process: the reconciler re-serves every row each pass. */
const warned = new Set<string>()
function warnUnmapped(factoryCode: string): void {
  if (warned.has(factoryCode)) return
  warned.add(factoryCode)
  logger.warn({ factoryCode }, 'Weighbridge tickets dropped: factory maps to no organisation; add it to WEIGHBRIDGE_FACTORIES')
}

export interface IngestOptions {
  /** 'webhook' when pushed, 'reconciler' on the poll that backstops it. */
  source?: string
}

/**
 * Store one ticket, from either feed.
 *
 * Returns false only when the row cannot be placed at all — an unmapped
 * factory, or a payload with no token. Everything else is an upsert, so a
 * ticket that arrives four times (webhook create, webhook update, and two
 * reconcile passes) is one row that ends up carrying the latest of each field.
 */
export async function handleWeighment(
  row: RaiFactorySuiteCaneDeliveryRow | RaiFactorySuiteCaneTransferRow,
  opts: IngestOptions = {},
): Promise<boolean> {
  const source = opts.source ?? 'reconciler'
  if (row?.tokenNumber == null || !row.vehicleNo) return false

  const factoryCode = row.factoryCode ?? LEGACY_FACTORY
  // The yard decides the organisation, so read the site the ticket is stored
  // under first (a transfer names it as its origin) — see WEIGHBRIDGE_FACTORIES.
  const site = normaliseWeighment(row, '', null).centerCode
  const organisationId = await orgIdOf(weighmentOrgCode(factoryCode, site))
  if (!organisationId) {
    warnUnmapped(factoryCode)
    return false
  }

  const vehicleId = await findVehicleId(await vehicleOrgIdsFor(factoryCode, organisationId), row.vehicleNo)
  const fields = normaliseWeighment(row, organisationId, vehicleId)

  await prisma.weighment.upsert({
    where:  { category_tokenNumber: { category: fields.category, tokenNumber: fields.tokenNumber } },
    create: { ...fields, source },
    // Every field, not just the ones that "should" change: a ticket is edited
    // at the scale (a re-weigh, a corrected plate) and the whole row is what
    // the provider re-serves. Merging selectively would leave a corrected
    // weight sitting beside its old operator and timestamp.
    update: { ...fields, source },
  })
  return true
}
