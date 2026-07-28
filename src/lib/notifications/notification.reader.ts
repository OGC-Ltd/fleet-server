/**
 * Notification history reads — cache first, Postgres behind it.
 *
 * Until now there was no way to read notification history at all: the only
 * path to a notification was the live SSE stream plus a 60-item in-memory ring
 * buffer replayed on connect. A client that reloaded after a restart, or one
 * that simply wanted yesterday, had nothing.
 */

import { prisma } from '../prisma.js'
import { readCachedNotifications, primeCache, type NotificationItem } from './notification-cache.js'
import { env } from '../../config/env.js'

const FLEET_TZ = 'Africa/Nairobi'
const clockFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: FLEET_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
})

export interface NotificationPage {
  items:  NotificationItem[]
  /** Where the answer came from — surfaced so cache behaviour is observable. */
  source: 'cache' | 'database'
}

/** DB row → the same shape the SSE feed and the cache use. */
function toItem(row: {
  feedId: string; severity: string; text: string; source: string
  alertType: string | null; plate: string | null; vehicleId: string | null; occurredAt: Date
}): NotificationItem {
  return {
    id:        row.feedId,
    time:      clockFmt.format(row.occurredAt),
    ts:        row.occurredAt.toISOString(),
    type:      row.severity,
    text:      row.text,
    source:    row.source,
    alertType: row.alertType,
    plate:     row.plate,
    vehicleId: row.vehicleId,
  }
}

/**
 * Newest-first notifications for an organisation.
 *
 * The cache is consulted only for the FIRST page (no `before`), because that
 * is the page every dashboard loads and the only one worth keeping hot. Paging
 * back through history goes to Postgres, where the
 * `[organisationId, occurredAt]` index makes it a range scan.
 */
export async function getNotifications(
  orgId: string,
  { limit = 50, before }: { limit?: number; before?: Date } = {},
): Promise<NotificationPage> {
  const capped = Math.min(Math.max(limit, 1), 200)

  if (!before) {
    const cached = await readCachedNotifications(orgId, capped)
    // A short cache is a legitimate answer only if it holds everything asked
    // for; otherwise fall through so the caller gets a full page.
    if (cached && cached.length >= capped) return { items: cached, source: 'cache' }
    if (cached && cached.length > 0 && cached.length >= env.NOTIFICATION_CACHE_MAX) {
      return { items: cached, source: 'cache' }
    }
  }

  const rows = await prisma.notification.findMany({
    where:   { organisationId: orgId, ...(before ? { occurredAt: { lt: before } } : {}) },
    orderBy: { occurredAt: 'desc' },
    take:    capped,
    select:  {
      feedId: true, severity: true, text: true, source: true,
      alertType: true, plate: true, vehicleId: true, occurredAt: true,
    },
  })

  const items = rows.map(toItem)

  // Warm the cache from the authoritative store so the next first-page read is
  // hot. Only for the first page — priming from a deep page would leave the
  // cache holding old history and shadowing anything newer.
  if (!before && items.length > 0) {
    void primeCache(orgId, items.slice(0, env.NOTIFICATION_CACHE_MAX))
  }

  return { items, source: 'database' }
}
