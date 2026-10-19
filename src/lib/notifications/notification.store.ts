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
import { holdMovement, isGroupableMovement, setMovementEmitter } from './movement-window.js'

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
 * How long a published feedId stays suppressible.
 *
 * Sized off the widest republish window any emitter has: fuel publishes by
 * event AGE over a 2-hour horizon (queues/fuel-events NOTIFY_AGE_MS), so an
 * event is re-offered on every cycle for two hours. An hour of margin keeps a
 * late straggler from slipping through as a fresh item.
 */
const DEDUPE_TTL_MS = 3 * 60 * 60_000

/** Bounded so a long-running process cannot grow this without limit. */
const DEDUPE_MAX_ENTRIES = 20_000

/** feedId → { fingerprint of the last published content, last seen }. */
const published = new Map<string, { fp: number; at: number }>()

/**
 * FNV-1a, 32-bit. A hash rather than the text itself so 20,000 remembered
 * notifications cost tens of KB instead of megabytes on a box that is already
 * swapping. Collisions cost one suppressed republish of a corrected wording,
 * which is why the fingerprint covers the fields an operator would notice.
 */
function fingerprint(input: PublishNotificationInput): number {
  const s = `${input.severity}|${input.text}|${input.plate ?? ''}|${input.vehicleId ?? ''}|${input.at.getTime()}`
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Has this exact notification already been published?
 *
 * The feed's contract is that a `feedId` identifies one event, and Postgres
 * already enforces that with a unique upsert. Nothing downstream of it did:
 * SSE re-emitted, which put a duplicate React key in the dashboard panel, and
 * the Redis cache stored the payload rather than the id, so a republish whose
 * wording had drifted became a second cached row. Both are now impossible
 * before they start, for every emitter rather than for fuel alone.
 *
 * Content-sensitive on purpose. A redelivery carrying a corrected volume, a
 * resolved plate or a repaired timestamp is a genuine UPDATE and must go out;
 * a byte-identical re-offer is noise. Comparing the fingerprint separates the
 * two without the caller having to know which it is holding.
 *
 * In-process, deliberately. `publishNotification` is synchronous — its callers
 * are poll-cycle handlers that must not be made async to fire a notification —
 * so this cannot be a Redis round trip. That is correct for the single
 * instance we run (additional instances set POLL_ENABLED=false and emit
 * nothing); `SET <fp> NX EX` on the cache connection is the upgrade path if
 * that ever changes. Same shape as notification.worker's push dedupe.
 *
 * Suppressing the SSE emit is safe even for a client that connected after the
 * first emission: the dashboard replays this org's recent history from the
 * durable store on connect, so a client never depends on catching a live frame.
 */
function admit(input: PublishNotificationInput): boolean {
  const now  = Date.now()
  const fp   = fingerprint(input)
  const prev = published.get(input.id)

  if (prev && prev.fp === fp && now - prev.at < DEDUPE_TTL_MS) {
    // Touch it: as long as an emitter keeps re-offering the same event, keep
    // suppressing it, rather than letting it lapse mid-storm and re-emit once.
    prev.at = now
    return false
  }

  published.set(input.id, { fp, at: now })

  if (published.size > DEDUPE_MAX_ENTRIES) {
    for (const [k, v] of published) if (now - v.at > DEDUPE_TTL_MS) published.delete(k)
    // Still over after dropping the expired — evict oldest-first (Map iterates
    // in insertion order) rather than let the map grow unbounded.
    if (published.size > DEDUPE_MAX_ENTRIES) {
      const excess = published.size - DEDUPE_MAX_ENTRIES
      let n = 0
      for (const k of published.keys()) { published.delete(k); if (++n >= excess) break }
    }
  }

  return true
}

/** Test seam — the dedupe map is process-global and would leak between cases. */
export function __resetPublishDedupe(): void {
  published.clear()
}

/** The feed item as SSE, the cache and the dashboard all consume it. */
function buildItem(input: PublishNotificationInput): NotificationItem {
  const { id, severity, text, at, source, alertType = null, plate = null, vehicleId = null, extra } = input
  return {
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
}

/**
 * Emit a notification to the live feed, then durably record it.
 *
 * Synchronous by design — callers are event-bus handlers and telemetry
 * workers that must not be made async just to fire a notification.
 *
 * An exact republish of an already-published `feedId` is dropped here and
 * reaches nothing: no SSE frame, no row, no cache write. See `admit`.
 */
export function publishNotification(input: PublishNotificationInput): NotificationItem {
  const { orgId, id, persist = true } = input

  const item = buildItem(input)

  if (!admit(input)) return item

  // A routine crossing waits up to five minutes for the vehicle's related ones
  // and reaches the feed as one line — see movement-window. The ROW is written
  // now, as always: reports read movements one row per event. A replay
  // (persist: false) is history already told, so it is never held.
  if (persist && isGroupableMovement(input)) {
    void writeNotification(input)
      .catch((err) => logger.warn({ err, feedId: id }, 'Notification persist failed — item is still held for the feed'))
    holdMovement(orgId, item, emitLive)
    return item
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

/** What a closed movement window does with its one line: SSE, then the hot cache. */
function emitLive(orgId: string, item: NotificationItem): void {
  emitDashboardFeed(orgId, item)
  void cacheNotification(orgId, item)
}
setMovementEmitter(emitLive)

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

export interface DurablePublishResult {
  item: NotificationItem
  /**
   * False when this was an exact republish and nothing was emitted or written.
   * Callers report it so a cycle's log says what it actually did — the fuel
   * sync re-offers every event inside a 2-hour window on each 15-minute cycle,
   * and "published: 0, deduped: 6" is the honest description of the second one.
   */
  published: boolean
}

/**
 * Same feed item, but the durable write is AWAITED.
 *
 * `publishNotification` deliberately detaches persistence so a live poll cycle
 * is never blocked by the pooler. That trade is wrong for a one-shot CLI: a
 * script that publishes and exits would race its own writes and lose most of
 * them, because nothing keeps the process alive for the detached promise.
 *
 * Same choke point, same row shape, same dedupe — only the timing differs.
 */
export async function publishNotificationDurable(input: PublishNotificationInput): Promise<DurablePublishResult> {
  const item = buildItem(input)

  // An exact republish costs a pooler round trip for an upsert that changes
  // nothing, which on this connection is about a second. Skip the whole call.
  if (!admit(input)) return { item, published: false }

  emitDashboardFeed(input.orgId, item)
  await writeNotification(input)
  await cacheNotification(input.orgId, item)
  return { item, published: true }
}
