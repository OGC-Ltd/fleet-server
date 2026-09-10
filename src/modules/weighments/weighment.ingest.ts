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
import { resolveOrgId } from '../webhooks/factory-map.js'
import type {
  RaiFactorySuiteCaneDeliveryRow,
  RaiFactorySuiteCaneTransferRow,
} from '../../providers/raifactorysuite/raifactorysuite.client.js'

/** The factory these bridges belong to. Weighbridge tickets carry no factory
 *  code of their own — Sukari's scale software is the only thing that writes
 *  them, and it only knows its own sites. */
const WEIGHBRIDGE_FACTORY = 'NDHIWA'

/**
 * Centre code → name.
 *
 * A DELIVERY row carries both, so this table is not needed to read one. A
 * TRANSFER carries `centerFrom` and no name at all, which is the whole reason
 * this exists: without it every transfer would render as a number.
 *
 * Measured against the live feed 2026-09-10 — 729 delivery rows across exactly
 * these four sites, and the three origins transfers use (102, 103, 104) are
 * all present. An unknown code is labelled rather than dropped: a fifth bridge
 * opening is a thing that happens, and "Centre 105" is a usable answer while
 * this table catches up. `learnCentre` below keeps it current from the
 * delivery feed itself, so that label is temporary in practice.
 */
const CENTRE_NAMES = new Map<number, string>([
  [101, 'FACTORY'],
  [102, 'OPAPO'],
  [103, 'OYANI'],
  [104, 'NYAONDO'],
])

/** Every centre we know of, for the page's tab strip. Ordered with the factory
 *  first because that is where two thirds of the tickets are. */
export function knownCentres(): { code: number; name: string }[] {
  return [...CENTRE_NAMES.entries()]
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.code - b.code)
}

/** Record a code→name pair seen on a delivery row, so a new bridge names
 *  itself the first time it weighs anything rather than waiting for a deploy. */
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
  learnCentre(row.centerCode, row.centerName)
  return {
    organisationId,
    category:      WeighmentCategory.CANE_DELIVERY,
    tokenNumber:   BigInt(row.tokenNumber),
    tokenAt:       weighmentAt(row.tokenDate, row.tokenTime) ?? new Date(),
    vehicleNo:     row.vehicleNo,
    vehiclePlate:  normalisePlate(row.vehicleNo),
    vehicleId,
    driverName:    row.driverName,
    centerCode:    row.centerCode,
    centerName:    row.centerName ?? centreName(row.centerCode),
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
  return {
    organisationId,
    category:      WeighmentCategory.CANE_TRANSFER,
    tokenNumber:   BigInt(row.tokenNumber),
    tokenAt:       weighmentAt(row.tokenDate, row.tokenTime) ?? new Date(),
    vehicleNo:     row.vehicleNo,
    vehiclePlate:  normalisePlate(row.vehicleNo),
    vehicleId,
    driverName:    row.driverName,
    centerCode:    row.centerFrom,
    centerName:    centreName(row.centerFrom),
    grossWeightKg: row.centerGrossWeight ?? null,
    grossAt:       weighmentAt(row.centerGrossDate, row.centerGrossTime),
    grossOperator: row.centerGrossOperator ?? null,
    grossBridgeNo: row.centerGrossWeighbridgeNo ?? null,
    tareWeightKg:  row.centerTareWeight ?? null,
    tareAt:        weighmentAt(row.centerTareDate, row.centerTareTime),
    tareOperator:  row.centerTareOperator ?? null,
    tareBridgeNo:  row.centerTareWeighbridgeNo ?? null,
    netWeightKg:   row.centerNetWeight ?? null,
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
 * ticket is Sukari's record of its own scale, whoever's lorry drove onto it.
 * Most of these lorries are contractors' and match nothing we hold, so a null
 * is the normal case and not a failure.
 */
async function findVehicleId(organisationId: string, rawPlate: string): Promise<string | null> {
  const written = rawPlate.trim().toUpperCase().replace(/\s+/g, ' ')
  const exact = await prisma.vehicle.findFirst({
    where:  { organisationId, registrationPlate: written },
    select: { id: true },
  })
  if (exact) return exact.id

  // The provider's spacing is not stable ("KCP 134P" and "KCP134P" both
  // occur), and no index can serve a REPLACE() on the column — so this scan is
  // the fallback, not the first move.
  const wanted = normalisePlate(rawPlate)
  const rows = await prisma.vehicle.findMany({
    where:  { organisationId },
    select: { id: true, registrationPlate: true },
  })
  return rows.find(v => normalisePlate(v.registrationPlate) === wanted)?.id ?? null
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

  const organisationId = await resolveOrgId(WEIGHBRIDGE_FACTORY)
  if (!organisationId) {
    logger.warn({ factoryCode: WEIGHBRIDGE_FACTORY }, 'Weighbridge ticket dropped: factory maps to no organisation')
    return false
  }

  const vehicleId = await findVehicleId(organisationId, row.vehicleNo)
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
