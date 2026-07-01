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
  doorStatus:   string | undefined
  engineTempC:  number | null
  oilLevelPct:  number | null
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
  const unsub = eventBus.subscribe('telemetry:processed', ({ frame, orgId, vehicleId, vehicleName, plate, tankCapacityMl }) => {
    try {
      const fuelLevelPct = (frame.fuelLevelMl != null && tankCapacityMl)
        ? Math.round((frame.fuelLevelMl / tankCapacityMl) * 100)
        : null

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
        doorStatus:   frame.doorStatus,
        engineTempC:  frame.engineTempC ?? null,
        oilLevelPct:  frame.oilLevelPct ?? null,
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
    } catch (err) {
      logger.warn({ err, deviceId: frame.deviceId }, 'telemetry.worker: failed to emit dashboard position')
    }
  })

  logger.info('Telemetry worker started')
  return unsub
}
