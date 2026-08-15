/**
 * WHEN it cleared the gate — measured, not declared.
 *
 * ## Why this exists
 *
 * Not to decide whether a vehicle left: the yard signs it out, and the feed
 * says so on that record (see raifactorysuite-events.handleDispatch), for every
 * unit including the majority here that carry no tracker. This module answers
 * the question the paperwork cannot — at what time the barrier was actually
 * crossed, and therefore how long the unit stood in the yard after being signed
 * out. Measured over seven days on the live account, 281 of 283 dispatches
 * (99.3%) had their MOVEMENT/EXIT event within one second of the sign-out
 * (median 9 ms), because the provider emits it inside the dispatch transaction:
 * it is the sign-out clock again, not an observation of the gate.
 *
 * ## Why the gate, and not a radius round the yard
 *
 * This used to fire on the first fix more than `YARD_RADIUS_M` (800 m) from the
 * organisation's HUB point. On SUKARI the hub sits **17 m from the gate**, so
 * that rule announced the departure one full radius PAST the barrier — by
 * construction, not by accident. Replayed over 54 departures across 21 days:
 *
 *   metres past the gate, hub radius:  median 867 m · p90 4,210 m · max 20 km
 *   metres past the gate, this rule:   median 118 m · p90   554 m
 *   warning gained:                    median 264 s · p90 1,113 s
 *
 * The operator's complaint — "we are told it left when it is already 800 m
 * away" — was exactly the radius, restated.
 *
 * The gate is a coordinate, not a geofence. The Wialon zone set covers neither
 * the whole site nor the wider operating area, so nothing here depends on it.
 * It is also re-derivable at any time: a gate is where outbound vehicles HALT,
 * and those halts cluster to within 13-20 m, far tighter than any other
 * signature on the way out.
 *
 * ## Shape
 *
 * Two radii, not one. A vehicle must be seen INSIDE `gateRadiusM` and then
 * beyond `gateRadiusM + DEPARTURE_BUFFER_M`. The band is what stops a truck
 * idling at the barrier, or jittering on GPS noise, from narrating a convoy —
 * and unlike waiting for consecutive frames it costs no delay, which is the
 * whole point of the change.
 *
 * A vehicle never seen at the gate gets a BOUNDED notification instead of a
 * precise one: 9 of 54 departures in the replay had no fix at the gate at all,
 * behind coverage gaps whose 99th percentile is 20 minutes. We know it left. We
 * do not know when, and inventing a time would be the one thing this module
 * exists to avoid.
 */

import { prisma } from './prisma.js'
import { logger } from './logger.js'
import { publishNotification } from './notifications/notification.store.js'
import { haversineM, YARD_RADIUS_M } from './dispatch-trip.js'
import { isPlausibleFix } from './fix-plausibility.js'

/**
 * Hysteresis band outside the gate radius. Sized above the fleet's positional
 * jitter while parked (a few tens of metres) and well below the distance a
 * departing truck covers between fixes at the 30 s median cadence.
 */
const DEPARTURE_BUFFER_M = 40

/** Used when an organisation records a gate but no radius for it. */
const DEFAULT_GATE_RADIUS_M = 60

interface OrgGeo {
  hub:  { lat: number; lng: number } | null
  gate: { lat: number; lng: number; radiusM: number } | null
}

const geoCache = new Map<string, { geo: OrgGeo; loadedAt: number }>()
const GEO_TTL_MS = 5 * 60_000

interface VehicleState {
  /** Outside the hub radius on the previous frame; undefined until seeded. */
  beyondHub?: boolean
  /** Seen inside the gate radius since the last announcement. */
  sawGate: boolean
  /** Dispatch already announced, so a later frame cannot restate it. */
  announcedFor: string | null
  /**
   * Seen OUTSIDE the gate's hysteresis band since the last arrival announced.
   * The mirror of `sawGate`: it is what arms an arrival, so a unit that never
   * left cannot be narrated as coming back.
   */
  sawAway: boolean
}

const state = new Map<string, VehicleState>()

async function getGeo(orgId: string): Promise<OrgGeo> {
  const hit = geoCache.get(orgId)
  if (hit && Date.now() - hit.loadedAt < GEO_TTL_MS) return hit.geo

  const org = await prisma.organisation.findUnique({
    where:  { id: orgId },
    select: { hubLat: true, hubLng: true, gateLat: true, gateLng: true, gateRadiusM: true },
  })
  const geo: OrgGeo = {
    hub: org?.hubLat != null && org.hubLng != null ? { lat: org.hubLat, lng: org.hubLng } : null,
    gate: org?.gateLat != null && org.gateLng != null
      ? { lat: org.gateLat, lng: org.gateLng, radiusM: org.gateRadiusM ?? DEFAULT_GATE_RADIUS_M }
      : null,
  }
  geoCache.set(orgId, { geo, loadedAt: Date.now() })
  return geo
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
 * Publish a departure the first time a dispatched vehicle is seen clear of the
 * gate. Safe to call on every frame.
 */
export async function trackYardDeparture(p: YardDepartureInput): Promise<void> {
  const { lat, lng } = p
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return

  const atMs = new Date(p.capturedAt).getTime()
  if (!Number.isFinite(atMs)) return
  // A position the vehicle could not have reached cannot be evidence that it
  // went anywhere. 5.15% of fixes in departure windows fail this.
  if (!isPlausibleFix({ vehicleId: p.vehicleId, lat, lng, atMs })) return

  const geo = await getGeo(p.orgId)
  if (!geo.gate && !geo.hub) return

  const here = { lat, lng }
  const beyondHub = geo.hub ? haversineM(geo.hub, here) > YARD_RADIUS_M : false

  const seeded = state.get(p.vehicleId)
  if (!seeded) {
    // First sighting seeds only — a restart must not announce the departure of
    // every vehicle already on the road.
    state.set(p.vehicleId, {
      beyondHub,
      sawGate: geo.gate ? haversineM(geo.gate, here) <= geo.gate.radiusM : false,
      // Seeded the same way and for the same reason: a unit first sighted out
      // on the road is already away, so its next approach is a real arrival —
      // but a restart must not narrate one for a unit sitting in the yard.
      sawAway: geo.gate
        ? haversineM(geo.gate, here) > geo.gate.radiusM + DEPARTURE_BUFFER_M
        : false,
      announcedFor: null,
    })
    return
  }
  const st = seeded

  const wasBeyondHub = st.beyondHub
  st.beyondHub = beyondHub

  // ── the gate rule ──
  if (geo.gate) {
    const fromGate = haversineM(geo.gate, here)
    if (fromGate <= geo.gate.radiusM) {
      // At the barrier. Coming back also re-arms the next departure.
      st.sawGate = true
      return
    }
    if (st.sawGate) {
      // Inside the hysteresis band the vehicle has not committed to leaving.
      if (fromGate > geo.gate.radiusM + DEPARTURE_BUFFER_M) {
        await announce(p, st, 'gate')
      }
      return
    }
  }

  // ── fallback ──
  // Either the org has no gate recorded, or this vehicle was never seen at it.
  // The hub radius is coarse — that is precisely why the gate rule exists — so
  // when a gate IS configured and we simply missed the vehicle at it, the
  // notification says so rather than implying we watched it leave.
  if (wasBeyondHub === false && beyondHub) {
    await announce(p, st, geo.gate ? 'bounded' : 'yard')
  }
}

/**
 * Publish an arrival the first time a vehicle that had been away is seen back
 * inside the gate radius. Safe to call on every frame.
 *
 * ## Why this exists at all, given the provider already sends RETURN
 *
 * Because RETURN only covers units RaiFactorySuite knows about. Verified
 * 2026-08-10: KTCC 505D is bound to `wialon:29697275`, was reporting minutes
 * before this was written, and has ZERO dispatch rows — FactorySuite has never
 * heard of it, so no provider event will ever narrate its crossings. It is not
 * alone: only 284 of Sukari's 597 active vehicles carry a Wialon device at all,
 * and the two registries do not agree about which units exist.
 *
 * So the two sources cover different halves of the yard, and neither is
 * complete. This one is the measured half.
 *
 * ## The rule is the departure rule, mirrored
 *
 * Departure: inside the gate radius, then beyond radius + buffer.
 * Arrival:   beyond radius + buffer, then inside the gate radius.
 *
 * Same band, same reason — a truck idling at the barrier or jittering on GPS
 * noise crosses one threshold repeatedly, and the hysteresis is what stops that
 * becoming a convoy of feed lines. Direction comes from the ORDER those two
 * thresholds are crossed, not from the heading field: heading is noisy at the
 * low speeds a vehicle actually approaches a barrier at, and is absent
 * entirely on some frames.
 *
 * ## No dispatch required
 *
 * Unlike a departure, which is "just traffic" without a dispatch behind it, an
 * arrival at the gate is self-evidently an arrival — and requiring a dispatch
 * would silently exclude exactly the units this exists to cover. When there IS
 * an open dispatch the wording says where it came back from; nothing writes
 * `actualReturnAt`, because the dispatch lifecycle belongs to the provider.
 */
export async function trackYardArrival(p: YardDepartureInput): Promise<void> {
  const { lat, lng } = p
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return

  const atMs = new Date(p.capturedAt).getTime()
  if (!Number.isFinite(atMs)) return
  if (!isPlausibleFix({ vehicleId: p.vehicleId, lat, lng, atMs })) return

  const geo = await getGeo(p.orgId)
  // Arrivals are gate-only. There is no hub fallback on purpose: the hub radius
  // is 800 m, and "came within 800 m of the yard" is not an arrival — it is the
  // coarse rule this module was written to replace, and it would fire on every
  // unit that merely drove past. An org with no gate recorded gets nothing here
  // rather than something misleading. Kasulu is in exactly that position today.
  if (!geo.gate) return

  const st = state.get(p.vehicleId)
  // Seeding is trackYardDeparture's job — both run on the same frame from
  // telemetry.worker, and it is called first. If it declined this fix (an
  // implausible position, say) there is no state and nothing to compare against.
  if (!st) return

  const fromGate = haversineM(geo.gate, { lat, lng })

  if (fromGate > geo.gate.radiusM + DEPARTURE_BUFFER_M) {
    st.sawAway = true
    return
  }
  if (fromGate <= geo.gate.radiusM && st.sawAway) {
    await announceArrival(p)
    st.sawAway = false
  }
}

async function announceArrival(p: YardDepartureInput): Promise<void> {
  const at   = new Date(p.capturedAt)
  const who  = p.driverName ? ` · ${p.driverName}` : ''

  // Only worth a lookup on the transition itself, same as the departure path.
  const dispatch = await prisma.dispatch.findFirst({
    where:   { vehicleId: p.vehicleId, actualReturnAt: null },
    orderBy: { dispatchedAt: 'desc' },
    select:  { id: true, destination: true, dispatchedAt: true },
  })
  const from = dispatch?.destination ? ` from ${dispatch.destination}` : ''
  const awayMs = dispatch ? at.getTime() - dispatch.dispatchedAt.getTime() : 0
  const away = awayMs >= 60_000
    ? ` — out ${awayMs >= 3_600_000
        ? `${(awayMs / 3_600_000).toFixed(1)} h`
        : `${Math.round(awayMs / 60_000)} min`}`
    : ''

  await publishNotification({
    orgId: p.orgId,
    // Keyed on the CROSSING, not on a dispatch: a unit with no dispatch has no
    // other stable key, and a unit with one can legitimately arrive twice
    // against the same dispatch if the provider never closed it. The
    // hysteresis band above is what prevents a duplicate for one crossing.
    id:        `ya-${p.vehicleId}-${at.getTime()}`,
    source:    'telemetry',
    alertType: 'MOVEMENT_ENTRY',
    severity:  'success',
    text:      `${p.plate}${who} arrived at the gate${from}${away}.`,
    at,
    plate:     p.plate,
    vehicleId: p.vehicleId,
  })

  logger.debug(
    { plate: p.plate, dispatch: dispatch?.id ?? null, awayMs },
    'Gate arrival published',
  )
}

/**
 * `gate`    — watched it clear the barrier; the precise case.
 * `yard`    — org has no gate recorded, so the old hub radius still applies and
 *             the wording stays honest about which boundary was crossed.
 * `bounded` — org HAS a gate but this vehicle was never seen at it.
 */
type Precision = 'gate' | 'yard' | 'bounded'

async function announce(p: YardDepartureInput, st: VehicleState, precision: Precision): Promise<void> {
  // Only now, on the transition itself, is a dispatch worth looking up.
  const dispatch = await prisma.dispatch.findFirst({
    where:   { vehicleId: p.vehicleId, actualReturnAt: null },
    orderBy: { dispatchedAt: 'desc' },
    select:  { id: true, destination: true, dispatchedAt: true },
  })
  // No open dispatch: the vehicle is moving, but nothing claimed it was going
  // anywhere. That is not a departure, it is just traffic.
  if (!dispatch) return
  // A dispatch is announced once. Without this the bounded fallback could
  // restate — and blunt — a departure the gate had already reported precisely.
  if (st.announcedFor === dispatch.id) return

  const at   = new Date(p.capturedAt)
  const who  = p.driverName ? ` · ${p.driverName}` : ''
  const dest = dispatch.destination ? ` to ${dispatch.destination}` : ''
  // How long it actually stood in the yard after being signed out — the number
  // the provider's version could never carry, because it fired at zero.
  const waitedMs = at.getTime() - dispatch.dispatchedAt.getTime()
  const waited   = waitedMs >= 60_000
    ? ` ${Math.round(waitedMs / 60_000)} min after sign-out`
    : ''

  // CONFIRMS the sign-out, and does not restate it. The feed already announced
  // this vehicle leaving when the yard signed it out (see the dispatch line in
  // raifactorysuite-events) — that is the record every unit produces. What
  // these fixes add, for the minority carrying a tracker, is WHEN the barrier
  // was actually crossed and therefore how long the unit then stood there.
  const text =
    precision === 'gate' ? `${p.plate}${who} cleared the gate${dest}${waited}.`
    : precision === 'yard' ? `${p.plate}${who} cleared the yard${dest}${waited}.`
    // Never seen at the gate — say what is known and not more. Stamping the
    // first fix we happened to receive as the crossing time would be exactly
    // the provider's mistake in a different costume. The departure itself is
    // not in doubt here; only its time is.
    : `${p.plate}${who} is clear of the yard${dest} — departure time not observed (no fix at the gate).`

  await publishNotification({
    orgId:     p.orgId,
    // Keyed on the DISPATCH, so a vehicle that noses out and back on GPS noise
    // updates one row instead of narrating a convoy.
    id:        `yd-${dispatch.id}`,
    source:    'telemetry',
    alertType: 'MOVEMENT_EXIT',
    severity:  'info',
    text,
    at,
    plate:     p.plate,
    vehicleId: p.vehicleId,
  })

  st.announcedFor = dispatch.id
  st.sawGate = false
  logger.debug({ plate: p.plate, dispatch: dispatch.id, waitedMs, precision }, 'Gate departure published')
}

/** Drop cached org geometry — for tests and for a gate coordinate being corrected. */
export function invalidateYardCache(orgId?: string): void {
  if (orgId) geoCache.delete(orgId)
  else       geoCache.clear()
}

/** Forget per-vehicle state. Tests only. */
export function resetYardPresence(): void {
  state.clear()
}
