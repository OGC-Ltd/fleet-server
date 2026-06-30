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
  doorStatus:   string | undefined
  flags: {
    overspeeding:        boolean
    fuelInconsistency:   boolean
    doorOpenWhileMoving: boolean
    lowFuel:             boolean
    outsideGeofence:     boolean
    lowBattery:          boolean
  }
}

export function startTelemetryWorker(): () => void {
  const unsub = eventBus.subscribe('telemetry:processed', ({ frame, orgId, vehicleId, vehicleName, plate }) => {
    try {
      const payload: DashboardPositionPayload = {
        vehicleId,
        vehicleName,
        plate,
        deviceId:    frame.deviceId,
        capturedAt:  frame.capturedAt.toISOString(),
        lat:         frame.lat,
        lng:         frame.lng,
        headingDeg:  frame.headingDeg,
        speedKmh:    frame.speedKmh,
        engineOn:    frame.engineOn,
        fuelLevelMl: frame.fuelLevelMl,
        doorStatus:  frame.doorStatus,
        flags:       frame.flags,
      }
      emitDashboardPosition(orgId, payload)
    } catch (err) {
      logger.warn({ err, deviceId: frame.deviceId }, 'telemetry.worker: failed to emit dashboard position')
    }
  })

  logger.info('Telemetry worker started')
  return unsub
}
