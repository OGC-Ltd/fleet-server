/**
 * FactorySuite webhook events by name, for the ones the receiver does not
 * route to a feature of its own. From 19 Nov 2026 the WORK_PLANNER_HOOK
 * webhook, the default, carries all of FactorySuite's list except
 * alert.created, dispatch.* and movement.created, which stay on
 * FACTORY_SUITE_HOOK.
 *
 * Machine register changes (machine.created, machine.updated) bring the
 * register sync forward. The rest below are acknowledged and not used yet.
 * They are routed by NAME, before any payload shape is tried: a vehicle
 * request or a gate delivery carries a plate, a driver, a `type` or weights,
 * and must never be stored as a dispatch, a sale or a weighment because its
 * shape happens to fit. Their payloads name people (visitors, drivers,
 * tenants, guards), so the receiver logs only their field names, once per
 * event name.
 */

const UNUSED_PREFIXES = [
  // Field and Data Centre
  'sighting.', 'meter.readings.', 'fieldaudit.', 'fieldcheck.', 'milestone.',
  // Department paperwork
  'shiftreport.', 'shifthandover.', 'clerkentry.',
  // Gate, security and transport requests
  'vehiclerequest.', 'delivery.', 'recovery.', 'visitor.', 'quarters.',
  // Registers we do not mirror (vehicles come from Wialon, drivers from our own roster)
  'driver.', 'vehicle.', 'trailer.',
  // FactorySuite's own work-area fences
  'machine.geofence.',
] as const

/** A machine was added to FactorySuite's register or its details changed. */
export function isMachineRegisterEvent(kind: string): boolean {
  return kind === 'machine.created' || kind === 'machine.updated'
}

/** A FactorySuite event we know and acknowledge without using (yet). */
export function isUnusedEvent(kind: string): boolean {
  return UNUSED_PREFIXES.some(p => kind.startsWith(p))
}
