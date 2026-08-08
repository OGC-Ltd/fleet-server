/**
 * Notification worker — the single fan-out point for BOTH alert families:
 *
 *   'alert:triggered' — alerts we derive ourselves from telemetry flags.
 *   'provider:alert'  — alerts the provider composed (raifactorysuite dispatch
 *                       and driver governance, Wialon notifications, gate
 *                       movements).
 *
 * Each goes to two channels:
 *   1. Dashboard SSE  — updates the feed in the browser tab already open.
 *   2. Web Push       — reaches the user even when the tab is closed/backgrounded.
 *
 * Provider alerts used to skip this worker entirely and call the SSE emitters
 * directly from their intake service, so they never produced a push. They do
 * now, which is why this file owns both subscriptions.
 *
 * Push is fire-and-forget from the caller's point of view: the bus is
 * synchronous, so an awaited broadcast here would hold up whatever published
 * the event (a poll cycle, or the webhook request handler answering the
 * provider before it gives up and drops the event).
 */

import { eventBus }           from '../event-bus.js'
import type { ProviderAlertEvent } from '../event-bus.js'
import { logger }             from '../logger.js'
import { emitDashboardAlert } from '../sse.js'
import { publishNotification } from '../notifications/notification.store.js'
import { pushService }        from '../../modules/notifications/notifications.service.js'
import { ALERT_LABELS, ALERT_SEVERITY } from '../alerts.js'

/**
 * Suppresses a repeat push for the same org+type+vehicle inside this window.
 * The DB upsert already makes webhook REDELIVERY idempotent, but nothing stops
 * the provider composing a genuinely new alert row for a condition that hasn't
 * changed (an overdue tractor stays overdue), and the reconcile poller can
 * legitimately surface the same situation the webhook just did.
 */
const PUSH_DEDUPE_MS = 10 * 60_000
const lastPushedAt = new Map<string, number>()

function shouldPush(key: string): boolean {
  const now = Date.now()
  const prev = lastPushedAt.get(key) ?? 0
  if (now - prev < PUSH_DEDUPE_MS) return false
  lastPushedAt.set(key, now)
  // Bounded: without this the map grows one entry per distinct alert forever.
  if (lastPushedAt.size > 5_000) {
    for (const [k, t] of lastPushedAt) if (now - t > PUSH_DEDUPE_MS) lastPushedAt.delete(k)
  }
  return true
}

function handleProviderAlert(a: ProviderAlertEvent): void {
  // 1. Live feed + durable history + hot cache, in one call.
  //
  //    Storage is its OWN flag. This used to pass `persist: a.notify`, which
  //    conflated "don't wake anyone's phone for this" with "don't keep it" —
  //    so the routine narration that sets notify:false (dispatches, gate
  //    movements) was broadcast to open tabs and then dropped. Those are the
  //    events an operator most often goes looking for afterwards.
  publishNotification({
    orgId:     a.orgId,
    id:        a.id,
    source:    a.source,
    alertType: a.alertType,
    severity:  a.severity,
    text:      a.text,
    at:        a.at,
    plate:     a.plate,
    vehicleId: a.vehicleId,
    persist:   a.persist ?? true,
  })

  if (!a.notify) return

  // 2. Banner/toast — criticals only.
  if (a.severity === 'critical') {
    emitDashboardAlert(a.orgId, {
      alertType:   a.alertType,
      severity:    'CRITICAL',
      title:       a.text,
      plate:       a.plate,
      vehicleId:   a.vehicleId,
      triggeredAt: a.at.toISOString(),
      source:      a.source,
    })
  }

  // 3. Web Push — criticals and warnings. `info`/`success` are narration
  //    (a dispatch left the yard); waking a phone for those is noise.
  if (a.severity !== 'critical' && a.severity !== 'warning') return

  const key = `${a.orgId}:${a.alertType}:${a.vehicleId ?? a.plate ?? a.id}`
  if (!shouldPush(key)) return

  void pushService.broadcastToOrg(a.orgId, {
    title: a.plate ? `Fleet Alert — ${a.plate}` : 'Fleet Alert',
    body:  a.text,
    data:  {
      alertType: a.alertType,
      severity:  a.severity,
      source:    a.source,
      plate:     a.plate,
      vehicleId: a.vehicleId,
      triggeredAt: a.at.toISOString(),
    },
    tag: key,
  }).catch(err => logger.warn({ err, alert: a }, 'notification.worker: provider alert push failed'))
}

export function startNotificationWorker(): () => void {
  const unsubTelemetry = eventBus.subscribe('alert:triggered', (alert) => {
    try {
      const payload = {
        alertType:   alert.type,
        severity:    ALERT_SEVERITY[alert.type],
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
      void pushService.broadcastToOrg(alert.orgId, {
        title: `Fleet Alert — ${alert.plate}`,
        body:  ALERT_LABELS[alert.type] ?? alert.type,
        data:  payload,
        tag:   `${alert.orgId}:${alert.type}:${alert.vehicleId}`,
      }).catch(err => logger.warn({ err, alert }, 'notification.worker: telemetry alert push failed'))
    } catch (err) {
      logger.warn({ err, alert }, 'notification.worker: failed to dispatch alert')
    }
  })

  const unsubProvider = eventBus.subscribe('provider:alert', (alert) => {
    try {
      handleProviderAlert(alert)
    } catch (err) {
      logger.warn({ err, alert }, 'notification.worker: failed to dispatch provider alert')
    }
  })

  logger.info('Notification worker started')
  return () => { unsubTelemetry(); unsubProvider() }
}
