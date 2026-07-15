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

export interface DashboardPositionPayload {
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
  // Real per-vehicle service cycle — see controltech.simulator.ts's `_sim.maintenance`.
  odometerKm?:            number | null
  nextServiceOdoKm?:      number | null
  inMaintenance?:         boolean
  maintenanceEndsAtMs?:   number | null
  maintenanceResetOdoKm?: number
  // Populated only while en route to / at the garage — drives the map's
  // ripple-circle overlay; null once the vehicle heads back (FROM_GARAGE).
  garageLat?:             number | null
  garageLng?:             number | null
  // Simulator LogiPhase (see controltech.simulator.ts) — e.g. 'LOADING',
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
      }
      emitDashboardPosition(orgId, payload)
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
