/**
 * Reads behind the weighbridge page.
 *
 * Two things happen here that are not a plain SELECT, and both are here rather
 * than in the browser because both need the WHOLE day even when the grid is
 * showing one centre:
 *
 *   · the day's stats — tickets, distinct lorries, heaviest load — which the
 *     page states "across all bridges" and would otherwise silently mean
 *     "across the bridge you happen to have open";
 *   · each lorry's ticket SEQUENCE and the gaps between them, which is a
 *     question about the lorry's day and not about the centre. A tractor that
 *     weighs at Opapo, then at the factory, has done two weighments with a gap
 *     between them; computing that inside a centre filter would report two
 *     firsts and no gap at all.
 */

import { prisma } from '../../lib/prisma.js'
import { Prisma, WeighmentCategory } from '../../../generated/prisma/client.js'

/** Columns the page needs. `select` rather than the whole row: the table is
 *  wide and nothing on screen wants `receivedAt` or `source`. */
const ROW_SELECT = {
  id: true, category: true, tokenNumber: true, tokenAt: true,
  vehicleNo: true, vehiclePlate: true, vehicleId: true, driverName: true,
  centerCode: true, centerName: true,
  grossWeightKg: true, grossAt: true, grossOperator: true, grossBridgeNo: true,
  tareWeightKg: true, tareAt: true, tareOperator: true, tareBridgeNo: true,
  netWeightKg: true,
  factoryGrossWeightKg: true, factoryGrossAt: true, factoryGrossOperator: true, factoryGrossBridgeNo: true,
  factoryTareWeightKg: true, factoryTareAt: true, factoryTareOperator: true, factoryTareBridgeNo: true,
  factoryNetWeightKg: true,
  productName: true,
} satisfies Prisma.WeighmentSelect

export type WeighmentRow = Prisma.WeighmentGetPayload<{ select: typeof ROW_SELECT }>

/**
 * Every ticket in the day, all centres, oldest first.
 *
 * One read serves the whole page: the stats strip, the per-centre tab counts
 * and the grid are three views of this set, and reading it three times would
 * let them disagree about a ticket that landed between the queries.
 *
 * A day is small — 787 tickets across the four bridges on 2026-09-09, the
 * busiest day in the provider's window — so there is nothing to page and no
 * budget worth defending.
 */
export async function findDay(organisationId: string, from: Date, to: Date): Promise<WeighmentRow[]> {
  return prisma.weighment.findMany({
    where:   { organisationId, tokenAt: { gte: from, lt: to } },
    orderBy: { tokenAt: 'asc' },
    select:  ROW_SELECT,
  })
}

/**
 * The days that actually hold tickets, newest first.
 *
 * The date picker needs a floor: the provider serves about two days and this
 * table only holds what we were running to receive, so most of the calendar is
 * genuinely empty and an empty grid on 2026-08-01 should read as "nothing was
 * captured then", not as a fault.
 */
export async function findCapturedRange(organisationId: string): Promise<{ first: Date; last: Date } | null> {
  const span = await prisma.weighment.aggregate({
    where: { organisationId },
    _min:  { tokenAt: true },
    _max:  { tokenAt: true },
  })
  const first = span._min.tokenAt
  const last  = span._max.tokenAt
  return first && last ? { first, last } : null
}

/** How many tickets we hold in total, per category — for the empty state,
 *  which has to tell "no tickets today" apart from "the feed has never run". */
export async function countByCategory(organisationId: string): Promise<Record<WeighmentCategory, number>> {
  const rows = await prisma.weighment.groupBy({
    by:    ['category'],
    where: { organisationId },
    _count: { _all: true },
  })
  const out = { CANE_DELIVERY: 0, CANE_TRANSFER: 0 } as Record<WeighmentCategory, number>
  for (const r of rows) out[r.category] = r._count._all
  return out
}
