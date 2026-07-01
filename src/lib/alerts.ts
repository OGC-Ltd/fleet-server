/**
 * Shared alert definitions + DB-persistence helper.
 *
 * ALERT_LABELS and ALERT_SEVERITY are the single source of truth for how each
 * AlertType is labelled and how severe it is. Both are imported by
 * notification.worker.ts (SSE/push broadcasts) and by syncFrameAlerts (DB writes).
 *
 * syncFrameAlerts is called once per vehicle per poll cycle. It:
 *   • creates a new open VehicleAlert for every flag that is currently true
 *     but has no existing open row yet.
 *   • resolves (sets resolvedAt) every open row whose flag is no longer active,
 *     making the critical state in the DB reflect current reality.
 *
 * This is what makes "persisted until resolved" work: the DB row stays open
 * (resolvedAt = null) for the entire duration of the condition, survives page
 * reloads, and closes the moment the condition clears.
 */

import { prisma }     from './prisma.js'
import type { AlertType } from './event-bus.js'
import type { VehicleTelemetryFrame } from '../providers/telemetry-provider.js'

export const ALERT_LABELS: Record<AlertType, string> = {
  overspeeding:        'Overspeeding detected',
  fuelInconsistency:   'Fuel inconsistency — possible theft',
  doorOpenWhileMoving: 'Door open while vehicle is moving',
  lowFuel:             'Low fuel reserve — trip halted',
  outsideGeofence:     'Vehicle outside assigned geofence',
  lowBattery:          'Low device battery',
  highEngineTemp:      'Engine overheating — trip halted',
  lowOil:              'Critically low engine oil — trip halted',
}

export const ALERT_SEVERITY: Record<AlertType, 'WARNING' | 'CRITICAL'> = {
  overspeeding:        'WARNING',
  fuelInconsistency:   'CRITICAL',
  doorOpenWhileMoving: 'WARNING',
  lowFuel:             'CRITICAL',
  outsideGeofence:     'WARNING',
  lowBattery:          'WARNING',
  highEngineTemp:      'CRITICAL',
  lowOil:              'CRITICAL',
}

export async function syncFrameAlerts(
  orgId:       string,
  vehicleId:   string,
  frame:       VehicleTelemetryFrame,
  activeTypes: AlertType[],
): Promise<void> {
  // 1. Resolve any open alert whose flag is no longer active
  //    Prisma's `notIn: []` matches everything, so an empty activeTypes list
  //    correctly resolves all currently-open alerts for this vehicle.
  await prisma.vehicleAlert.updateMany({
    where: {
      vehicleId,
      resolvedAt: null,
      ...(activeTypes.length > 0 ? { type: { notIn: activeTypes } } : {}),
    },
    data: { resolvedAt: new Date() },
  })

  if (activeTypes.length === 0) return

  // 2. Find which of the active flags already have an open row
  const existing = await prisma.vehicleAlert.findMany({
    where: { vehicleId, resolvedAt: null, type: { in: activeTypes } },
    select: { type: true },
  })
  const openSet = new Set(existing.map(a => a.type))

  // 3. Create rows only for flags that have no open alert yet
  const toCreate = activeTypes.filter(t => !openSet.has(t))
  if (toCreate.length === 0) return

  await prisma.vehicleAlert.createMany({
    data: toCreate.map(type => ({
      organisationId: orgId,
      vehicleId,
      type,
      severity:    ALERT_SEVERITY[type],
      message:     ALERT_LABELS[type],
      lat:         frame.lat,
      lng:         frame.lng,
      speedKmh:    frame.speedKmh,
      fuelLevelMl: frame.fuelLevelMl != null ? Math.round(frame.fuelLevelMl) : null,
      meta: {
        batteryVoltageV: frame.batteryVoltageV,
        doorStatus:      frame.doorStatus,
        fuelUsedMl:      frame.fuelUsedMl,
      },
      triggeredAt: frame.capturedAt,
    })),
  })
}
