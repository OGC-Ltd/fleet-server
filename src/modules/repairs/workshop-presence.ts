/**
 * When a unit was in the workshop, as our own escalation workflow books it
 * (repairs.workflow): from the moment its booking is marked arrived (`arrive`)
 * until the job is completed and tested (`complete`), or closed or voided
 * (`resolvedAt`). A booked unit that has not yet arrived is not in it.
 *
 * Harsh accelerations inside these spans are not driving (operator,
 * 2026-10-31): the workshop revs and road-tests the unit, and those reports
 * must not reach the feed, the analytics, the trip report or a driver's
 * record. The harsh-driving worker drops them as they come in; the readers
 * drop any recorded before that.
 */
import { prisma } from '../../lib/prisma.js'

export interface WorkshopSpan { from: number; to: number }

const OPEN = Number.POSITIVE_INFINITY

const spanOf = (b: { arrivedAt: Date | null; repairItem: { completedAt: Date | null; resolvedAt: Date | null } }): WorkshopSpan | null =>
  b.arrivedAt
    ? { from: b.arrivedAt.getTime(), to: (b.repairItem.completedAt ?? b.repairItem.resolvedAt)?.getTime() ?? OPEN }
    : null

/** Was this unit in the workshop at `at`? One indexed lookup, for the worker. */
export async function inWorkshopAt(vehicleId: string, at: Date): Promise<boolean> {
  const hit = await prisma.workshopBooking.findFirst({
    where: {
      status: 'arrived',
      arrivedAt: { lte: at },
      repairItem: {
        vehicleId,
        // Still there at `at`: the stay ends when the job is completed, or
        // when it is closed if it never was.
        OR: [
          { completedAt: { gt: at } },
          { completedAt: null, resolvedAt: null },
          { completedAt: null, resolvedAt: { gt: at } },
        ],
      },
    },
    select: { id: true },
  })
  return hit != null
}

/** Every workshop stay of these units that overlaps [from, to], by vehicle. */
export async function workshopSpans(vehicleIds: string[], from: Date, to: Date): Promise<Map<string, WorkshopSpan[]>> {
  const out = new Map<string, WorkshopSpan[]>()
  if (!vehicleIds.length) return out
  const rows = await prisma.workshopBooking.findMany({
    where: { status: 'arrived', arrivedAt: { lte: to }, repairItem: { vehicleId: { in: vehicleIds } } },
    select: { arrivedAt: true, repairItem: { select: { vehicleId: true, completedAt: true, resolvedAt: true } } },
  })
  for (const b of rows) {
    const s = spanOf(b)
    if (!s || s.to < from.getTime()) continue
    const list = out.get(b.repairItem.vehicleId) ?? []
    list.push(s)
    out.set(b.repairItem.vehicleId, list)
  }
  return out
}

/** Whether `at` falls in one of the unit's workshop stays. */
export function inSpans(spans: Map<string, WorkshopSpan[]>, vehicleId: string | null, at: Date | number): boolean {
  if (!vehicleId) return false
  const t = typeof at === 'number' ? at : at.getTime()
  return (spans.get(vehicleId) ?? []).some(s => t >= s.from && t < s.to)
}
