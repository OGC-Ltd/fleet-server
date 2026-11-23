/**
 * Links a Control Tech run's driver to its truck, and keeps the link until the
 * truck's NEXT dispatch.
 *
 * Operator, 2026-11-23: "we still need to capture the driver returned but do
 * not unlink the vehicle from that driver until the next dispatch". Before
 * this, the sign-in (`actualReturnTime`) closed the link, so a truck back in
 * the yard read "Unassigned" until somebody signed it out again. Measured over
 * the 205 tracked SUKARI returns of 21-23 Nov, the sign-in came a median 11
 * minutes after the truck reached the yard, but 28 came more than 2 h after
 * (night arrivals signed in the next morning), and 6 came before the truck was
 * back.
 *
 * So the sign-in is now RECORDED (`returnedAt`), and the link ends at the start
 * of the vehicle's next live dispatch or sales run (`unassignedAt`). This
 * happens whether or not that next run's driver resolves to a user: the truck
 * has been taken by someone else either way. A cancelled run holds nothing
 * (its span is zero), and cancelling a run gives the truck back to whoever had
 * it before.
 */
import { prisma as defaultPrisma } from '../../lib/prisma.js'
import type { PrismaClient } from '../../../generated/prisma/client.js'

const RUN_PREFIX = 'controltech:'

export interface RunLink {
  vehicleId:  string
  /** The run's driver, or null when the name did not resolve to exactly one user. */
  userId:     string | null
  /** `controltech:dispatch:<id>` or `controltech:sale:<id>`. */
  marker:     string
  /** The provider's run id, as stored on `dispatches.external_id`. */
  externalId: string
  startedAt:  Date
  returnedAt: Date | null
  cancelled:  boolean
}

type Db = Pick<PrismaClient, 'vehicleAssignment' | 'dispatch'>

/**
 * When the next live run after `after` took the vehicle, or null. Read from
 * both the dispatch log (which holds runs whose driver did not resolve) and
 * the run assignments (which a backfill may have written without a dispatch
 * row), and the earlier of the two wins.
 */
async function nextRunStart(db: Db, vehicleId: string, after: Date, notExternalId: string, notMarker: string): Promise<Date | null> {
  const [dispatch, assignment] = await Promise.all([
    db.dispatch.findFirst({
      where:   { vehicleId, dispatchedAt: { gt: after }, status: { not: 'CANCELLED' }, externalId: { not: notExternalId } },
      orderBy: { dispatchedAt: 'asc' },
      select:  { dispatchedAt: true },
    }),
    db.vehicleAssignment.findFirst({
      // A cancelled run's row is zero-length (unassignedAt = assignedAt): skip it.
      where:   { vehicleId, assignedAt: { gt: after }, notes: { startsWith: RUN_PREFIX, not: notMarker },
                 OR: [{ unassignedAt: null }, { unassignedAt: { gt: after } }] },
      orderBy: { assignedAt: 'asc' },
      select:  { assignedAt: true, unassignedAt: true },
    }),
  ])
  const fromAssignment = assignment && assignment.unassignedAt?.getTime() !== assignment.assignedAt.getTime()
    ? assignment.assignedAt : null
  const times = [dispatch?.dispatchedAt, fromAssignment].filter((t): t is Date => t != null)
  return times.length ? new Date(Math.min(...times.map(t => t.getTime()))) : null
}

/** Idempotent: re-reading the same run on every reconcile pass changes nothing. */
export async function linkRun(run: RunLink, db: Db = defaultPrisma): Promise<void> {
  const { vehicleId, marker, startedAt, cancelled } = run

  if (!cancelled) {
    // This run takes the truck: every earlier run still holding it at this
    // moment lets go here.
    await db.vehicleAssignment.updateMany({
      where: {
        vehicleId,
        assignedAt: { lt: startedAt },
        notes:      { startsWith: RUN_PREFIX, not: marker },
        OR:         [{ unassignedAt: null }, { unassignedAt: { gt: startedAt } }],
      },
      data: { unassignedAt: startedAt },
    })
  } else {
    // A cancelled run never took the truck. If an earlier pass let the
    // previous driver go at this moment, give the truck back to them, until
    // whatever run really came next.
    const handedBack = await nextRunStart(db, vehicleId, startedAt, run.externalId, marker)
    await db.vehicleAssignment.updateMany({
      where: { vehicleId, assignedAt: { lt: startedAt }, unassignedAt: startedAt,
               notes: { startsWith: RUN_PREFIX, not: marker } },
      data:  { unassignedAt: handedBack },
    })
  }

  const existing = await db.vehicleAssignment.findFirst({ where: { notes: marker }, select: { id: true } })
  if (!run.userId) {
    // The driver no longer resolves (or never did): a row written earlier
    // would keep naming them, so a cancelled run's row is still closed.
    if (existing && cancelled) {
      await db.vehicleAssignment.update({ where: { id: existing.id }, data: { unassignedAt: startedAt } })
    }
    return
  }

  const until = cancelled
    ? startedAt
    : await nextRunStart(db, vehicleId, startedAt, run.externalId, marker)
  const payload = {
    vehicleId,
    userId:         run.userId,
    assignmentType: 'PRIMARY' as const,
    assignedAt:     startedAt,
    unassignedAt:   until,
    returnedAt:     run.returnedAt,
    notes:          marker,
  }
  if (existing) await db.vehicleAssignment.update({ where: { id: existing.id }, data: payload })
  else          await db.vehicleAssignment.create({ data: payload })
}
