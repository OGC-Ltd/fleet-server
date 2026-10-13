/**
 * Units REPORTED for a fuel probe repair (the name "probe hold" is older than
 * the rule). The unit counts as reported from the moment it is flagged for the
 * repair until the issue is resolved:
 *
 *   an open fuel probe job in Repairs (targetKind 'probe', or a
 *     fuel_probe_dead fault), not yet signed off; or
 *   a fuel case found to be a faulty probe (PROBE_FAULT) that has not closed.
 *     A repair signed off UNSUCCESSFUL leaves its cases PROBE_FAULT, so the
 *     flag survives a failed repair and lifts only on PROBE_FIXED.
 *
 * What it changes: nothing is held back. 2026-10-01 to 2026-10-13 such a unit
 * was never flagged for a fuel theft until the repair closed; the operator
 * reversed that on 2026-10-13: "do not put a unit on hold, but we can
 * highlight it was reported". So its alerts are raised, announced and shown
 * like any other, at their own severity, and each says the unit is already
 * reported (PROBE_REPORTED_NOTE in the message; `probeHold` on the unit and
 * the alert for the screens).
 */

import { prisma } from '../../lib/prisma.js'

/** Said at the end of a fuel alert's message on a reported unit. */
export const PROBE_REPORTED_NOTE = 'This unit is already reported for a fuel probe repair.'

/** The vehicles among `vehicleIds` that are on probe hold. */
export async function probeHoldVehicleIds(vehicleIds: string[]): Promise<Set<string>> {
  if (vehicleIds.length === 0) return new Set()
  const rows = await prisma.$queryRaw<Array<{ vehicle_id: string }>>`
    SELECT ri.vehicle_id
      FROM repair_report_items ri
     WHERE ri.vehicle_id = ANY(${vehicleIds}::text[])
       AND ri.resolved_at IS NULL
       AND (ri.target_kind = 'probe' OR ri.fault_kind = 'fuel_probe_dead')
    UNION
    SELECT t.vehicle_id
      FROM fuel_theft_followups f
      JOIN fuel_thefts t ON t.id = f.theft_id
     WHERE t.vehicle_id = ANY(${vehicleIds}::text[])
       AND f.status = 'PROBE_FAULT'`
  return new Set((rows ?? []).map((r) => r.vehicle_id))
}

/** Is this one vehicle on probe hold? */
export async function isOnProbeHold(vehicleId: string): Promise<boolean> {
  return (await probeHoldVehicleIds([vehicleId])).has(vehicleId)
}
