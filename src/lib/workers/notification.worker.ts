/**
 * Notification worker — subscribes to 'alert:triggered' on the event bus
 * and fans out to two channels:
 *   1. Dashboard SSE  — updates the alert feed in the browser tab already open.
 *   2. Web Push       — reaches the user even when the tab is closed / backgrounded.
 */

import { eventBus }           from '../event-bus.js'
import { logger }             from '../logger.js'
import { emitDashboardAlert } from '../sse.js'
import { pushService }        from '../../modules/notifications/notifications.service.js'

const ALERT_LABELS: Record<string, string> = {
  overspeeding:        'Overspeeding detected',
  fuelInconsistency:   'Fuel inconsistency — possible theft',
  doorOpenWhileMoving: 'Door open while vehicle is moving',
  lowFuel:             'Low fuel warning',
  outsideGeofence:     'Vehicle outside assigned geofence',
  lowBattery:          'Low device battery',
}

export function startNotificationWorker(): () => void {
  const unsub = eventBus.subscribe('alert:triggered', async (alert) => {
    try {
      const payload = {
        alertType:   alert.type,
        title:       ALERT_LABELS[alert.type] ?? alert.type,
        vehicleId:   alert.vehicleId,
        vehicleName: alert.vehicleName,
        plate:       alert.plate,
        capturedAt:  alert.capturedAt.toISOString(),
        lat:         alert.lat,
        lng:         alert.lng,
        speedKmh:    alert.speedKmh,
        fuelLevelMl: alert.fuelLevelMl,
        meta:        alert.meta,
      }

      // 1. Org-level SSE — dashboard alert feed
      emitDashboardAlert(alert.orgId, payload)

      // 2. Web Push — all subscribers for this org
      await pushService.broadcastToOrg(alert.orgId, {
        title: `Fleet Alert — ${alert.plate}`,
        body:  ALERT_LABELS[alert.type] ?? alert.type,
        data:  payload,
        tag:   `${alert.orgId}:${alert.type}:${alert.vehicleId}`,
      })
    } catch (err) {
      logger.warn({ err, alert }, 'notification.worker: failed to dispatch alert')
    }
  })

  logger.info('Notification worker started')
  return unsub
}
