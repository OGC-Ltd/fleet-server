/**
 * Telemetry worker — subscribes to 'telemetry:processed' on the event bus
 * and broadcasts org-wide position snapshots to the dashboard SSE channel.
 *
 * This is the single place that translates a raw VehicleTelemetryFrame into
 * the position payload the dashboard map expects.
 */

import { eventBus }              from '../event-bus.js'
import { logger }                from '../logger.js'
import { emitDashboardPosition } from '../sse.js'
import { deriveFeedEvents } from '../feed-events.js'
import { trackZonePresence, assignedZoneStatus } from '../zone-presence.js'
import { trackYardDeparture } from '../yard-departure.js'
import { connectionStatus } from '../connection-state.js'
import { noteMovement, movementState } from '../movement-state.js'
import type { MovementState } from '../movement-state.js'
import type { AssignedZoneStatus } from '../zone-presence.js'

export interface DashboardPositionPayload {
  /** Assigned keep-out zones this vehicle is currently inside (may be stale
   *  by one poll cycle — see where it is populated below). */
  zones?:       AssignedZoneStatus
  /** Current moving/resting run — see lib/movement-state. */
  movement?:    MovementState | null
  /**
   * The PROVIDER's connection verdict for this tracker (Wialon `netconn`), or
   * null when the poller has no current answer. Distinct from "has reported
   * recently" — see lib/connection-state.
   */
  connectionOnline?: boolean | null
  vehicleId:    string
  vehicleName:  string
  plate:        string
  deviceId:     string
  capturedAt:   string   // ISO-8601
  lat:          number | null
  lng:          number | null
  headingDeg:   number | null
  speedKmh:     number | null
  engineOn:     boolean
  fuelLevelMl:  number | null
  fuelLevelPct: number | null   // 0–100; computed from tankCapacityMl
  cargoWeightKg: number | null
  // Product description on board — e.g. Aquamist's 'Still water — 5 L bottles'
  // (null for Sukari bulk loads, which the dash labels from vehicleType).
  cargoDesc:    string | null
  doorStatus:   string | undefined
  engineTempC:  number | null
  oilLevelPct:  number | null
  // Current journey leg (from→to + progress) for on-road routing on the map.
  leg?: {
    from: string; fromLat: number; fromLng: number
    to:   string; toLat:   number; toLng:   number
    progress: number; coveredKm: number; totalKm: number; moving: boolean
    beganAtMs: number; plannedArrivalMs: number
  } | null
  // Real per-vehicle service cycle — see raifactorysuite.simulator.ts's `_sim.maintenance`.
  odometerKm?:            number | null
  nextServiceOdoKm?:      number | null
  inMaintenance?:         boolean
  maintenanceEndsAtMs?:   number | null
  maintenanceResetOdoKm?: number
  // Populated only while en route to / at the garage — drives the map's
  // ripple-circle overlay; null once the vehicle heads back (FROM_GARAGE).
  garageLat?:             number | null
  garageLng?:             number | null
  // Simulator LogiPhase (see raifactorysuite.simulator.ts) — e.g. 'LOADING',
  // 'OFFLOADING', 'TO_FARM'. Drives the map's purple loading/offloading
  // flag+route treatment, distinct from the generic 'parked' status (which
  // doesn't say *why* the vehicle stopped moving).
  phase?:                 string | null
  flags: {
    overspeeding:        boolean
    fuelInconsistency:   boolean
    doorOpenWhileMoving: boolean
    lowFuel:             boolean
    outsideGeofence:     boolean
    lowBattery:          boolean
    highEngineTemp:      boolean
    lowOil:              boolean
  }
}

export function startTelemetryWorker(): () => void {
  const unsub = eventBus.subscribe('telemetry:processed', ({ frame, orgId, vehicleId, vehicleName, plate, tankCapacityMl, driverName }) => {
    try {
      const fuelLevelPct = (frame.fuelLevelMl != null && tankCapacityMl)
        ? Math.round((frame.fuelLevelMl / tankCapacityMl) * 100)
        : null

      const maintenance = (frame.rawPayload as {
        _sim?: { maintenance?: { nextServiceOdoKm: number; inMaintenance: boolean; maintenanceEndsAtMs: number | null; resetOdoKm: number; garageLat: number | null; garageLng: number | null } }
      } | undefined)?._sim?.maintenance

      // Did the tracker actually report ignition on this frame? The Wialon
      // adapter stamps this; without it engineOn is speed-derived and cannot
      // support an idling claim.
      const ignitionKnown = Boolean(
        (frame.rawPayload as { ignition_known?: boolean } | undefined)?.ignition_known,
      )

      const payload: DashboardPositionPayload = {
        vehicleId,
        vehicleName,
        plate,
        deviceId:     frame.deviceId,
        capturedAt:   frame.capturedAt.toISOString(),
        lat:          frame.lat,
        lng:          frame.lng,
        headingDeg:   frame.headingDeg,
        speedKmh:     frame.speedKmh,
        engineOn:     frame.engineOn,
        fuelLevelMl:  frame.fuelLevelMl,
        fuelLevelPct,
        cargoWeightKg: frame.cargoWeightKg ?? null,
        cargoDesc:    (frame.rawPayload as { _sim?: { cargoDesc?: string | null } } | undefined)?._sim?.cargoDesc ?? null,
        doorStatus:   frame.doorStatus,
        engineTempC:  frame.engineTempC ?? null,
        oilLevelPct:  frame.oilLevelPct ?? null,
        leg:          (frame.rawPayload as { _sim?: { leg?: DashboardPositionPayload['leg'] } } | undefined)?._sim?.leg ?? null,
        odometerKm:       (frame.rawPayload as { odometer_km?: number } | undefined)?.odometer_km ?? null,
        nextServiceOdoKm:    maintenance?.nextServiceOdoKm ?? null,
        inMaintenance:       maintenance?.inMaintenance ?? false,
        maintenanceEndsAtMs: maintenance?.maintenanceEndsAtMs ?? null,
        maintenanceResetOdoKm: maintenance?.resetOdoKm ?? 0,
        garageLat:    maintenance?.garageLat ?? null,
        garageLng:    maintenance?.garageLng ?? null,
        phase:        (frame.rawPayload as { _sim?: { phase?: string } } | undefined)?._sim?.phase ?? null,
        flags: {
          overspeeding:        frame.flags.overspeeding,
          fuelInconsistency:   frame.flags.fuelInconsistency,
          doorOpenWhileMoving: frame.flags.doorOpenWhileMoving,
          lowFuel:             frame.flags.lowFuel,
          outsideGeofence:     frame.flags.outsideGeofence,
          lowBattery:          frame.flags.lowBattery,
          highEngineTemp:      frame.flags.highEngineTemp,
          lowOil:              frame.flags.lowOil,
        },
        // Which of this vehicle's ASSIGNED keep-out zones it is currently
        // inside — see zone-presence.assignedZoneStatus.
        //
        // Computed from the PREVIOUS frame's evaluation, because
        // trackZonePresence below is deliberately fire-and-forget to keep the
        // DB-backed zone lookup off the emit path. At a 2 s poll cadence the
        // badge is at most one cycle behind, which is invisible next to the
        // ~30 s a marker tween already runs for.
        zones: assignedZoneStatus(orgId, vehicleId),
        // How long this vehicle has been moving, idling, or standing still.
        // Folded in BEFORE the payload is built so the frame that starts a
        // journey is the frame that reports it. Ignition is passed only when
        // the unit genuinely reports it (see wialon.adapter's ignition_known);
        // otherwise engineOn is speed-derived and idling is unknowable.
        movement: (
          noteMovement(vehicleId, frame.speedKmh, frame.capturedAt.getTime(), ignitionKnown ? frame.engineOn : null),
          movementState(vehicleId, null, frame.capturedAt.getTime())
        ),
        // The provider's connection verdict, carried so a live frame refreshes
        // it rather than leaving the client on the value from its first paint.
        // A unit emitting a frame is very nearly always online — the value of
        // sending it here is that it stays in step with the snapshot's field
        // instead of the client having two sources for one fact.
        connectionOnline: connectionStatus(frame.deviceId)?.online ?? null,
      }
      emitDashboardPosition(orgId, payload)

      // Zone arrivals/departures against the org's named geofences. This is
      // the Live Feed's only narrative for a GPS-only provider like Wialon,
      // whose frames carry no phase to derive from — see zone-presence.
      void trackZonePresence({
        orgId, vehicleId, plate, driverName,
        lat: payload.lat, lng: payload.lng, capturedAt: payload.capturedAt,
      }).catch(err => logger.warn({ err, vehicleId }, 'Zone presence tracking failed'))

      // The MEASURED "left the yard" — the provider's own EXIT event fires
      // inside the dispatch transaction and proves nothing, so the feed derives
      // this from the vehicle's fixes instead. See lib/yard-departure.
      void trackYardDeparture({
        orgId, vehicleId, plate, driverName,
        lat: payload.lat, lng: payload.lng, capturedAt: payload.capturedAt,
      }).catch(err => logger.warn({ err, vehicleId }, 'Yard departure tracking failed'))

      // Human live-feed items (dispatch / arrival / offload / alerts) derived
      // from phase transitions between consecutive frames — see feed-events.
      deriveFeedEvents(orgId, {
        vehicleId,
        plate,
        driverName,
        capturedAt:    payload.capturedAt,
        lat:           payload.lat,
        lng:           payload.lng,
        speedKmh:      payload.speedKmh,
        cargoWeightKg: payload.cargoWeightKg,
        cargoDesc:     payload.cargoDesc,
        phase:         payload.phase ?? null,
        leg:           payload.leg ?? null,
        flags:         payload.flags,
      })
    } catch (err) {
      logger.warn({ err, deviceId: frame.deviceId }, 'telemetry.worker: failed to emit dashboard position')
    }
  })

  logger.info('Telemetry worker started')
  return unsub
}
