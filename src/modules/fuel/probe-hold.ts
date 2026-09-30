/**
 * Units on PROBE HOLD: flagged for a fuel probe repair, so never flagged for a
 * critical fuel theft until that is resolved (operator, 2026-10-01).
 *
 * A probe found faulty reads falls that did not happen, and every one of them
 * would otherwise come back as a "possible theft" on a unit everybody already
 * knows is waiting on the workshop. The hold starts the moment the unit is
 * flagged for the repair and ends only when the issue is resolved:
 *
 *   an open fuel probe job in Repairs (targetKind 'probe', or a
 *     fuel_probe_dead fault), not yet signed off; or
 *   a fuel case found to be a faulty probe (PROBE_FAULT) that has not closed.
 *     A repair signed off UNSUCCESSFUL leaves its cases PROBE_FAULT, so the
 *     hold survives a failed repair and lifts only on PROBE_FIXED.
 *
 * What the hold changes: no theft announcement from the adjudicator, no red
 * unit or fuel theft alert on the map, and a provider fuel-drain notification
 * arrives as a warning, not critical. What it does not: the ledger still
 * records every drain, so the history is there once the probe is trusted again.
 */

import { prisma } from '../../lib/prisma.js'

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
