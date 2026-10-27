/**
 * Notification history reads — cache first, Postgres behind it.
 *
 * Until now there was no way to read notification history at all: the only
 * path to a notification was the live SSE stream plus a 60-item in-memory ring
 * buffer replayed on connect. A client that reloaded after a restart, or one
 * that simply wanted yesterday, had nothing.
 */

import { hiddenSources, withoutRestricted, SCOPE_EXEMPT_SOURCES } from './restricted-sources.js'
import { prisma } from '../prisma.js'
import { readCachedNotifications, primeCache, readCachedVehicleDay, cacheVehicleDay, type NotificationItem } from './notification-cache.js'
import { env } from '../../config/env.js'
import { fleetDayBounds } from '../provider-time.js'
import { groupMovementItems } from './movement-window.js'

const FLEET_TZ = 'Africa/Nairobi'
const clockFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: FLEET_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
})

export interface NotificationPage {
  items:  NotificationItem[]
  /** Where the answer came from — surfaced so cache behaviour is observable. */
  source: 'cache' | 'database'
}

export interface NotificationQuery {
  limit?:  number
  before?: Date
  /**
   * Restrict to these `alertType`s, e.g. `['fuelFilling','fuelInconsistency']`.
   *
   * Why a filtered read exists at all: the feed is chronological and capped, so
   * a busy organisation's routine traffic buries everything else. Kasulu emits
   * roughly thirteen zone crossings a minute, which is about three minutes of
   * history in a 40-item panel — and a fuel event arrives with a timestamp up
   * to two hours old, because Wialon only recognises a filling once settled
   * readings follow it. Correctly ordered, it therefore sorts below several
   * hundred zone crossings and is never on the page. That is not a bug in the
   * ordering; it is what a single chronological feed does at that event rate,
   * and the answer is to be able to ask for one kind of event.
   */
  alertTypes?: string[]
  /** Restrict to these severities, e.g. `['critical']`. */
  severities?: string[]
  /**
   * Restrict to ONE vehicle (its cuid, the same `vehicleId` every feed item
   * carries).
   *
   * Same argument as `alertTypes`, from the other direction: an operator who
   * has clicked a unit on the map is asking "what has THIS truck been doing",
   * and a chronological org feed answers with everything except that, because
   * one vehicle is 1/224th of Kasulu's traffic. The live SSE stream can be
   * filtered client-side, but only over the couple of hundred items a browser
   * happens to be holding — anything older has to come from here.
   */
  vehicleId?: string
  /**
   * One FLEET day, `YYYY-MM-DD`, Africa/Nairobi — the same calendar the
   * playback endpoint and every rollup in this codebase use.
   *
   * A day rather than a free `from`/`to` range on purpose. Operations works in
   * shifts, so "what did this unit do on the 27th" is the question actually
   * being asked; and a day is a bounded, COMPLETE set, which is what makes the
   * per-vehicle cache below possible at all. An arbitrary range is neither.
   */
  day?: string
  /**
   * The caller's vehicle scope (req.authz.vehicleIds): null for the whole
   * fleet. A scoped caller, such as a technician limited to flagged units, is
   * shown only notifications naming a unit in it; one naming no unit is
   * withheld, the same fail-closed rule as the live stream (lib/sse).
   */
  vehicleIds?: Set<string> | null
  /** Restrict to these `source`s, e.g. `['repair']` for a technician. */
  sources?: string[]
  /** Restricted sources this reader may see (restricted-sources feedGrantsFor). */
  grants?: string[] | null
}

/**
 * The vehicle-scope clause: units in scope, plus any source this reader is
 * allowed that is exempt from scope (restricted-sources SCOPE_EXEMPT_SOURCES).
 */
function scopedTo(vehicleIds: Set<string>, sources: string[] | undefined) {
  const exempt = (sources ?? []).filter((s) => SCOPE_EXEMPT_SOURCES.has(s))
  return exempt.length
    ? { OR: [{ vehicleId: { in: [...vehicleIds] } }, { source: { in: exempt } }] }
    : { vehicleId: { in: [...vehicleIds] } }
}

/** DB row → the same shape the SSE feed and the cache use. */
function toItem(row: {
  feedId: string; severity: string; text: string; source: string
  alertType: string | null; plate: string | null; vehicleId: string | null; occurredAt: Date
  actorId?: string | null
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
    ...(row.actorId ? { actorId: row.actorId } : {}),
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
  { limit = 50, before, alertTypes, severities, vehicleId, day, vehicleIds = null, sources, grants = null }: NotificationQuery = {},
): Promise<NotificationPage> {
  if (vehicleIds && vehicleId && !vehicleIds.has(vehicleId)) return { items: [], source: 'database' }
  // A read naming no sources is not a technician's: restricted sources it was
  // not granted stay out (notifications/restricted-sources).
  const hide = <T extends { source?: string | null }>(items: T[]) => (sources?.length ? items : withoutRestricted(items, grants))

  /**
   * A whole vehicle-day is allowed past the paging cap.
   *
   * 200 is the right bound for a scrolling org feed, where the next page is one
   * `before` away. A day is not a page — it is the complete answer to a
   * question, and returning 200 of a unit's 154..N events would be a silent
   * truncation of something the operator asked for in full. The busiest
   * measured vehicle-day carried 154 notifications, so 500 clears it with room.
   */
  const dayRange = day ? fleetDayBounds(day) : null
  const capped = Math.min(Math.max(limit, 1), dayRange ? 500 : 200)

  /**
   * A COMPLETED vehicle-day is served from its own cache.
   *
   * Only when the day is over. A day still running would cache a partial answer
   * that then never updates — the worst kind of wrong, because it looks
   * authoritative. Today always reads through.
   */
  const dayComplete = Boolean(dayRange && dayRange.to.getTime() <= Date.now())
  if (vehicleId && day && dayComplete && !before && !alertTypes?.length && !severities?.length && !sources?.length) {
    const cached = await readCachedVehicleDay(vehicleId, day)
    // `[]` is a real answer here — a unit that reported nothing that day — so
    // only a null miss falls through.
    if (cached) return { items: hide(cached), source: 'cache' }
  }

  // The cache is one mixed, capped, chronological set — it cannot answer a
  // filtered question without lying by omission, because the rows that match
  // may well be the ones it evicted. Filtered reads go to Postgres, where the
  // whole history is. They are also rare: this is a user selecting a view, not
  // the page every dashboard loads.
  //
  // A DAY is a filter too. It was missing from this test, so a first-page day
  // read was answered from the org cache — the latest 200 rows whatever their
  // day — and the Live Feed's "today" opened on last night and stopped there,
  // with the day's cursor pointing before the day began. It also primed the
  // cache from a day-bounded page, which for a past day is old history
  // shadowing everything newer.
  const filtered = Boolean(alertTypes?.length || severities?.length || vehicleId || dayRange || vehicleIds || sources?.length)

  if (!before && !filtered) {
    const cached = await readCachedNotifications(orgId, capped)
    // A short cache is a legitimate answer only if it holds everything asked
    // for; otherwise fall through so the caller gets a full page.
    if (cached && cached.length >= capped) return { items: hide(cached), source: 'cache' }
    if (cached && cached.length > 0 && cached.length >= env.NOTIFICATION_CACHE_MAX) {
      return { items: hide(cached), source: 'cache' }
    }
  }

  const rows = await prisma.notification.findMany({
    where:   {
      organisationId: orgId,
      // `before` pages back inside whatever window is in force, so a day read
      // and a cursor compose rather than one overwriting the other.
      ...(dayRange
        ? { occurredAt: { gte: dayRange.from, lt: before && before < dayRange.to ? before : dayRange.to } }
        : before ? { occurredAt: { lt: before } } : {}),
      ...(vehicleId ? { vehicleId } : vehicleIds ? scopedTo(vehicleIds, sources) : {}),
      ...(alertTypes?.length ? { alertType: { in: alertTypes } } : {}),
      ...(severities?.length ? { severity:  { in: severities } } : {}),
      ...(sources?.length ? { source: { in: sources } } : { source: { notIn: hiddenSources(grants) } }),
    },
    orderBy: { occurredAt: 'desc' },
    take:    capped,
    select:  {
      feedId: true, severity: true, text: true, source: true,
      alertType: true, plate: true, vehicleId: true, occurredAt: true, actorId: true,
    },
  })

  // Postgres keeps one row per crossing; the feed shows a vehicle's crossings
  // within five minutes as one line. Grouped here with the live window's rule,
  // so a reload shows what the live feed did (see movement-window).
  const items = groupMovementItems(rows.map(toItem))

  // Warm the cache from the authoritative store so the next first-page read is
  // hot. Only for the UNFILTERED first page — priming from a deep page would
  // leave the cache holding old history and shadowing anything newer, and
  // priming from a filtered one would replace the whole feed with a slice of it.
  if (!before && !filtered && items.length > 0) {
    void primeCache(orgId, items.slice(0, env.NOTIFICATION_CACHE_MAX))
  }

  /**
   * And write the vehicle-day back, which is the whole point of the shape.
   *
   * Empty days included — a quiet day is the commonest answer and the most
   * wasteful to keep re-deriving. Not written when the read hit the cap, since
   * that would cache a truncated day as if it were the whole one.
   */
  if (vehicleId && day && dayRange && dayComplete && !before && !alertTypes?.length && !severities?.length
      && !sources?.length && rows.length < capped) {
    void cacheVehicleDay(vehicleId, day, items, dayRange.from.getTime())
  }

  return { items: hide(items), source: 'database' }
}
