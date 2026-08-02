/**
 * `publishNotification` — the ONE place a Live Feed item is born.
 *
 * Three things had been emitting feed items straight into the SSE transport
 * (notification.worker for provider alerts, zone-presence for geofence
 * arrivals, feed-events for phase transitions). Each one reached whoever had a
 * browser tab open at that instant and left no trace anywhere. This routes all
 * three through a single call that:
 *
 *   1. writes Postgres  — durable history, swept by the retention job
 *   2. writes Redis     — hot per-org feed for the history endpoint
 *   3. emits SSE        — the live dashboard, exactly as before
 *
 * ## Ordering, and what is allowed to fail
 *
 * SSE is emitted FIRST and synchronously. The live feed is the latency-
 * sensitive path and the one users actually watch; it must not wait on a
 * remote Postgres round trip (~1 s over the pooler) or on Redis. Persistence
 * happens after, detached — if Postgres is down the operator still sees the
 * alert on screen, which is strictly better than seeing nothing.
 *
 * That ordering means a notification can be displayed and never stored, if the
 * database is unreachable at that moment. This is a deliberate trade: the
 * alternative is a slow feed that stalls whenever the pooler hiccups. The
 * reconcile poller already re-surfaces provider alerts we missed, so the
 * durable record self-heals for the sources that have one.
 */

import { prisma } from '../prisma.js'
import { logger } from '../logger.js'
import { emitDashboardFeed } from '../sse.js'
import { cacheNotification, type NotificationItem } from './notification-cache.js'

const FLEET_TZ = 'Africa/Nairobi'
const clockFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: FLEET_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
})

export interface PublishNotificationInput {
  orgId: string
  /**
   * Stable per-event id, prefixed by its emitter (`pa-`, `wn-`, `dp-`, `mv-`,
   * `zn-`, `feed-`). It is the UNIQUE key in Postgres, so re-publishing the
   * same event updates one row instead of duplicating the feed.
   */
  id:         string
  source:     string
  alertType?: string | null
  severity:   'info' | 'success' | 'warning' | 'critical'
  text:       string
  /** When it HAPPENED, not now. */
  at:         Date
  plate?:     string | null
  vehicleId?: string | null
  /**
   * False for history being replayed at boot: it is already in Postgres and
   * already in the cache, so re-writing both would be pure churn. The SSE
   * emit still happens, which is the whole point of a replay.
   */
  persist?:   boolean
  /**
   * Extra fields that ride along on the SSE payload and in the cache but have
   * no column in Postgres — e.g. feed-events' `lat`/`lng`, which clients use
   * to build a maps pin for the WhatsApp share. They survive a cache read and
   * are lost on a Postgres fallback, which is the right trade: they are a
   * convenience on live items, not history worth a schema change.
   */
  extra?:     Record<string, unknown>
}

/**
 * Emit a notification to the live feed, then durably record it.
 *
 * Synchronous by design — callers are event-bus handlers and telemetry
 * workers that must not be made async just to fire a notification.
 */
export function publishNotification(input: PublishNotificationInput): NotificationItem {
  const { orgId, id, source, alertType = null, severity, text, at, plate = null, vehicleId = null, persist = true, extra } = input

  const item: NotificationItem = {
    id,
    time: clockFmt.format(at),
    ts:   at.toISOString(),
    type: severity,
    text,
    source,
    alertType,
    plate,
    vehicleId,
    ...extra,
  }

  // 1. Live dashboards first — never blocked by storage.
  emitDashboardFeed(orgId, item)

  if (!persist) return item

  // 2. Durable record. Detached: a failed write logs and is dropped rather
  //    than propagating into a poll cycle or an HTTP handler.
  void writeNotification(input)
    .catch((err) => logger.warn({ err, feedId: id }, 'Notification persist failed — item was still delivered live'))

  // 3. Hot cache. No-op without Redis.
  void cacheNotification(orgId, item)

  return item
}

/** The durable write on its own, so both callers below share one upsert. */
function writeNotification(input: PublishNotificationInput): Promise<unknown> {
  const { orgId, id, source, alertType = null, severity, text, at, plate = null, vehicleId = null } = input
  return prisma.notification.upsert({
    where:  { feedId: id },
    create: {
      feedId: id, organisationId: orgId, vehicleId, source,
      alertType, severity, text, plate, occurredAt: at,
    },
    // A redelivery may carry corrected wording or a resolved vehicle; the
    // occurredAt is rewritten too so a re-sync repairs rows stored before a
    // timestamp fix (the same reason ingestAlerts rewrites createdAt).
    update: { severity, text, plate, vehicleId, occurredAt: at },
  })
}

/**
 * Same feed item, but the durable write is AWAITED.
 *
 * `publishNotification` deliberately detaches persistence so a live poll cycle
 * is never blocked by the pooler. That trade is wrong for a one-shot CLI: a
 * script that publishes and exits would race its own writes and lose most of
 * them, because nothing keeps the process alive for the detached promise.
 *
 * Same choke point, same row shape — only the timing differs.
 */
export async function publishNotificationDurable(input: PublishNotificationInput): Promise<NotificationItem> {
  const item = publishNotification({ ...input, persist: false })
  await writeNotification(input)
  await cacheNotification(input.orgId, item)
  return item
}
