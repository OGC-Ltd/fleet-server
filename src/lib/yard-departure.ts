/**
 * "Left the yard" — measured, not declared.
 *
 * ## Why this exists
 *
 * The provider already sends a MOVEMENT/EXIT event and the feed used to narrate
 * it as a gate crossing. It is not one. Measured over seven days on the live
 * account, 281 of 283 dispatches (99.3%) were followed by their EXIT event
 * within one second — median gap 9 ms, p90 13 ms. The provider emits it inside
 * the dispatch transaction, so it carries no fact the dispatch line does not
 * already carry.
 *
 * The consequence was a feed that announced a departure the instant paperwork
 * was raised. On 2026-08-04 the feed said KTCC 870B "left the yard to kwoyo u k"
 * at 05:25:14.429 while the truck was still standing in the compound: twenty-five
 * minutes later it had moved 440 m from where it was dispatched, at a peak of
 * 16 km/h, and was stationary. Meanwhile the Active Trip card — which measures —
 * correctly said "not yet left the yard", and the two surfaces contradicted each
 * other in front of the operator.
 *
 * So the provider's claim is suppressed at the webhook (see
 * raifactorysuite-events.handleMovement) and the real event is derived here from
 * the vehicle's own fixes: one feed item the first time a dispatched vehicle is
 * seen beyond the yard radius.
 *
 * ## Shape
 *
 * Deliberately mirrors zone-presence: a per-org cache of the one thing this
 * needs (the yard point), per-vehicle state in memory, and a first frame that
 * only SEEDS — otherwise a restart would announce a departure for every vehicle
 * already out on the road.
 *
 * The dispatch lookup happens only on the transition, which is at most once per
 * vehicle per run, so the steady state costs one distance calculation per frame.
 */

import { prisma } from './prisma.js'
import { logger } from './logger.js'
import { publishNotification } from './notifications/notification.store.js'
import { haversineM, YARD_RADIUS_M } from './dispatch-trip.js'

/** orgId → the organisation's yard point, or null when it has none recorded. */
const yardCache = new Map<string, { yard: { lat: number; lng: number } | null; loadedAt: number }>()
const YARD_TTL_MS = 5 * 60_000

/** vehicleId → was it inside the yard radius on the previous frame? */
const insideYard = new Map<string, boolean>()

async function getYard(orgId: string): Promise<{ lat: number; lng: number } | null> {
  const hit = yardCache.get(orgId)
  if (hit && Date.now() - hit.loadedAt < YARD_TTL_MS) return hit.yard

  const org = await prisma.organisation.findUnique({
    where:  { id: orgId },
    select: { hubLat: true, hubLng: true },
  })
  const yard = org?.hubLat != null && org.hubLng != null
    ? { lat: org.hubLat, lng: org.hubLng }
    : null
  yardCache.set(orgId, { yard, loadedAt: Date.now() })
  return yard
}

export interface YardDepartureInput {
  orgId:      string
  vehicleId:  string
  plate:      string
  driverName: string | null | undefined
  lat:        number | null
  lng:        number | null
  capturedAt: string
}

/**
 * Publish a departure the first time a dispatched vehicle is seen outside the
 * yard. Safe to call on every frame.
 */
export async function trackYardDeparture(p: YardDepartureInput): Promise<void> {
  const { lat, lng } = p
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return

  const yard = await getYard(p.orgId)
  if (!yard) return

  const out    = haversineM(yard, { lat, lng }) > YARD_RADIUS_M
  const before = insideYard.get(p.vehicleId)
  insideYard.set(p.vehicleId, !out)

  // First sighting seeds only — a restart must not announce the departure of
  // every vehicle that is already on the road.
  if (before === undefined) return
  // Only the inside → outside crossing is news. Coming back is the provider's
  // RETURN event and the trip's own 'back' leg.
  if (!before || !out) return

  // Only now, on the transition itself, is a dispatch worth looking up.
  const dispatch = await prisma.dispatch.findFirst({
    where:   { vehicleId: p.vehicleId, actualReturnAt: null },
    orderBy: { dispatchedAt: 'desc' },
    select:  { id: true, destination: true, dispatchedAt: true },
  })
  // No open dispatch: the vehicle is moving, but nothing claimed it was going
  // anywhere. That is not a departure, it is just traffic.
  if (!dispatch) return

  const at   = new Date(p.capturedAt)
  const who  = p.driverName ? ` · ${p.driverName}` : ''
  const dest = dispatch.destination ? ` to ${dispatch.destination}` : ''
  // How long it actually stood in the yard after being dispatched — the number
  // the provider's version could never carry, because it fired at zero.
  const waitedMs = at.getTime() - dispatch.dispatchedAt.getTime()
  const waited   = waitedMs >= 60_000
    ? ` ${Math.round(waitedMs / 60_000)} min after dispatch`
    : ''

  await publishNotification({
    orgId:     p.orgId,
    // Keyed on the DISPATCH, so a vehicle that noses out of the radius and back
    // on GPS noise updates one row instead of narrating a convoy.
    id:        `yd-${dispatch.id}`,
    source:    'telemetry',
    alertType: 'MOVEMENT_EXIT',
    severity:  'info',
    text:      `${p.plate}${who} left the yard${dest}${waited}.`,
    at,
    plate:     p.plate,
    vehicleId: p.vehicleId,
  })

  logger.debug({ plate: p.plate, dispatch: dispatch.id, waitedMs }, 'Yard departure published')
}

/** Drop cached yard points — for tests and for a hub coordinate being corrected. */
export function invalidateYardCache(orgId?: string): void {
  if (orgId) yardCache.delete(orgId)
  else       yardCache.clear()
}

/** Forget per-vehicle state. Tests only. */
export function resetYardPresence(): void {
  insideYard.clear()
}
