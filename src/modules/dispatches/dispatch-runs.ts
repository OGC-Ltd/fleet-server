/**
 * The runs (dispatches) that overlap a period, with who took the keys.
 *
 * For reports that need to name the driver AT THE TIME something happened,
 * not the driver on the vehicle now. The Driver Conduct Report is the first:
 * it used to name whoever had the unit when the report was RUN, so last
 * Tuesday's harsh braking went to whoever has the truck today, and a unit
 * whose run had closed came out with no driver at all (operator, 16 Nov 2026).
 *
 * Every run is returned as stored: sign-out (`dispatchedAt`), sign-in
 * (`actualReturnAt`, null while out or never closed), and the driver name the
 * gate wrote. Deciding which run covers a given moment (a run never signed
 * back in cannot be open for ever) is left to the report, which knows what it
 * is attributing.
 */

import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'

/** The longest period one request may cover: a month, the longest a report runs. */
export const MAX_SPAN_DAYS = 32

/**
 * How far before `from` a run may have been signed out and still count. A run
 * signed out yesterday evening and still out this morning overlaps this
 * morning; one signed out a week ago and never closed is not this morning's.
 */
export const LOOKBACK_HOURS = 36

export const runsQuerySchema = z.object({
  from: z.coerce.date(),
  to:   z.coerce.date(),
}).refine((q) => q.to > q.from, { message: '`to` must be after `from`', path: ['to'] })
  .refine((q) => q.to.getTime() - q.from.getTime() <= MAX_SPAN_DAYS * 86_400_000,
    { message: `The period may cover at most ${MAX_SPAN_DAYS} days`, path: ['to'] })

export type RunsQuery = z.infer<typeof runsQuerySchema>

export interface DispatchRun {
  id:             string
  vehicleId:      string | null
  plate:          string
  driverName:     string
  kind:           string
  status:         string
  dispatchedAt:   string
  actualReturnAt: string | null
}

/**
 * Runs that overlap [from, to): signed out before `to`, and not signed back in
 * before `from`. `vehicleIds` is the caller's vehicle scope: null is the whole
 * fleet; a set narrows to those units, and a run with no vehicle (a plate we
 * do not hold) is then left out, since it cannot be shown to be in scope.
 */
export async function findRuns(
  organisationId: string,
  vehicleIds: ReadonlySet<string> | null,
  from: Date,
  to: Date,
): Promise<DispatchRun[]> {
  if (vehicleIds && vehicleIds.size === 0) return []
  const rows = await prisma.dispatch.findMany({
    where: {
      organisationId,
      dispatchedAt: { lt: to, gte: new Date(from.getTime() - LOOKBACK_HOURS * 3_600_000) },
      OR: [{ actualReturnAt: null }, { actualReturnAt: { gt: from } }],
      ...(vehicleIds ? { vehicleId: { in: [...vehicleIds] } } : {}),
    },
    orderBy: { dispatchedAt: 'asc' },
    select: {
      externalId: true, vehicleId: true, plate: true, driverName: true,
      kind: true, status: true, dispatchedAt: true, actualReturnAt: true,
    },
  })
  return rows.map((d) => ({
    id:             d.externalId,
    vehicleId:      d.vehicleId,
    plate:          d.plate,
    driverName:     d.driverName,
    kind:           String(d.kind),
    status:         d.status,
    dispatchedAt:   d.dispatchedAt.toISOString(),
    actualReturnAt: d.actualReturnAt?.toISOString() ?? null,
  }))
}
