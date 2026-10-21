/**
 * Reads over the two incident ledgers and their rollup.
 *
 * ## Two kinds of pagination, and the difference matters
 *
 * The DETAIL lists are keyset-paginated on `id` — the fuel module's pattern
 * verbatim. Stable under inserts, no offset drift.
 *
 * The SUMMARY lists are a `GROUP BY`, which has no row id to key on, so they use
 * an OFFSET cursor. That is acceptable here and would not be over the detail
 * tables: the aggregate reads at most a few thousand grouped rows for one
 * org-month, so the offset never walks a large result. If this ever has to page
 * through more, the upgrade is a keyset on the sort tuple — cursor as base64
 * `"<count>:<vehicleId>"` with `WHERE (count, vehicle_id) < (:c, :v)`.
 */

import { Prisma } from '../../../generated/prisma/client.js'
import { prisma } from '../../lib/prisma.js'
import { MOVING_THRESHOLD_KMH } from '../../lib/movement-state.js'
import { cachedPlace, reverseGeocode } from '../../lib/geocode.js'

/** Same constant as feed-events and notification.store — the fleet's calendar. */
const FLEET_TZ = 'Africa/Nairobi'

export interface Range { from: Date; to: Date }

/* ── speeding ─────────────────────────────────────────────────────────────── */

export interface SpeedingSummaryRow {
  vehicleId:      string
  plate:          string | null
  name:           string | null
  vehicleType:    string | null
  incidents:      number
  days:           number
  peakKmh:        number
  limitKmh:       number
  avgOverKmh:     number
  totalSeconds:   number
  totalDistanceM: number
  firstAt:        Date
  lastAt:         Date
  driverName:     string | null
}

/**
 * The summaries' search box: plate or name, anywhere in either, with spaces
 * ignored on both sides so "KBL126W" finds "KBL 126W". Both summaries join
 * `vehicles` as `v`. LIKE's own wildcards are escaped — this is a search
 * string, not a pattern language.
 */
function unitSearch(search?: string): Prisma.Sql {
  const needle = search?.replace(/\s+/g, '').toLowerCase()
  if (!needle) return Prisma.empty
  const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  return Prisma.sql`AND (replace(lower(v.registration_plate), ' ', '') LIKE ${like}
                      OR replace(lower(coalesce(v.name, '')), ' ', '') LIKE ${like})`
}

export async function speedingSummary(
  orgId: string,
  r: Range,
  opts: { sort: string; limit: number; offset: number; minCount?: number; search?: string },
): Promise<{ rows: SpeedingSummaryRow[]; hasNextPage: boolean }> {
  // Ordering is applied in SQL, not in JS: a page sorted client-side would be
  // fifty of six hundred units presented as "the worst offenders".
  //
  // EVERY key here must name an OUTPUT column of the SELECT below, and the
  // camelCase ones must be quoted. ORDER BY resolves an output alias first and
  // an input column second, which is what made this fail in two different ways
  // in production: `last_at` matched neither and errored 42703, while
  // `peak_kmh` skipped past the `"peakKmh"` alias, matched the raw column, and
  // errored 42803 — it is not in the GROUP BY. That one took out the DEFAULT
  // sort as well as "Most severe", so the Speed tab 500ed on open.
  const orderBy = {
    count:    Prisma.sql`incidents DESC, "peakKmh" DESC`,
    peak:     Prisma.sql`"peakKmh" DESC, incidents DESC`,
    duration: Prisma.sql`total_seconds DESC, incidents DESC`,
    recent:   Prisma.sql`"lastAt" DESC`,
  }[opts.sort] ?? Prisma.sql`incidents DESC, "peakKmh" DESC`

  const rows = await prisma.$queryRaw<Array<SpeedingSummaryRow & { incidents: bigint; days: bigint; total_seconds: bigint; total_distance_m: bigint }>>(Prisma.sql`
    SELECT s.vehicle_id                                   AS "vehicleId",
           v.registration_plate                           AS plate,
           v.name                                         AS name,
           v.vehicle_type                                 AS "vehicleType",
           COUNT(*)                                       AS incidents,
           COUNT(DISTINCT s.day)                          AS days,
           MAX(s.peak_kmh)                                AS "peakKmh",
           MAX(s.limit_kmh)                               AS "limitKmh",
           ROUND(AVG(s.over_by_kmh)::numeric, 1)::float8  AS "avgOverKmh",
           COALESCE(SUM(s.duration_sec), 0)               AS total_seconds,
           COALESCE(SUM(s.distance_m), 0)                 AS total_distance_m,
           MIN(s.started_at)                              AS "firstAt",
           MAX(s.started_at)                              AS "lastAt",
           (ARRAY_AGG(s.driver_name ORDER BY s.started_at DESC)
              FILTER (WHERE s.driver_name IS NOT NULL))[1] AS "driverName"
      FROM speeding_incidents s
      JOIN vehicles v ON v.id = s.vehicle_id
     WHERE s.organisation_id = ${orgId}
       AND s.started_at >= ${r.from}
       AND s.started_at <= ${r.to}
       ${unitSearch(opts.search)}
     GROUP BY s.vehicle_id, v.registration_plate, v.name, v.vehicle_type
    ${opts.minCount ? Prisma.sql`HAVING COUNT(*) >= ${opts.minCount}` : Prisma.empty}
     ORDER BY ${orderBy}
     LIMIT ${opts.limit + 1} OFFSET ${opts.offset}
  `)

  const hasNextPage = rows.length > opts.limit
  if (hasNextPage) rows.pop()

  return {
    hasNextPage,
    // COUNT and SUM come back as bigint; JSON.stringify throws on those.
    rows: rows.map(r2 => ({
      ...r2,
      incidents:      Number(r2.incidents),
      days:           Number(r2.days),
      totalSeconds:   Number(r2.total_seconds),
      totalDistanceM: Number(r2.total_distance_m),
    })) as SpeedingSummaryRow[],
  }
}

export async function speedingList(
  orgId: string,
  r: Range,
  q: { vehicleId: string; cursor?: string; limit: number },
) {
  const items = await prisma.speedingIncident.findMany({
    where: {
      organisationId: orgId,
      vehicleId:      q.vehicleId,
      startedAt:      { gte: r.from, lte: r.to },
    },
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    // id breaks ties so the keyset cannot loop on identical timestamps.
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
  })
  const hasNextPage = items.length > q.limit
  if (hasNextPage) items.pop()
  return { data: items, cursor: items.at(-1)?.id ?? null, hasNextPage }
}

export interface SpeedingInsights {
  incidents:      number
  units:          number
  peakKmh:        number | null
  totalSeconds:   number
  medianDurationSec: number | null
  repeatUnits:    number
  hourHistogram:  number[]
  dowHistogram:   number[]
  worstByCount:   { vehicleId: string; plate: string | null; incidents: number } | null
  worstByPeak:    { vehicleId: string; plate: string | null; peakKmh: number } | null
}

export async function speedingInsights(orgId: string, r: Range): Promise<SpeedingInsights> {
  const [totals, byHour, byDow, byUnit, durations] = await Promise.all([
    prisma.speedingIncident.aggregate({
      where: { organisationId: orgId, startedAt: { gte: r.from, lte: r.to } },
      _count: { _all: true },
      _max:   { peakKmh: true },
      _sum:   { durationSec: true },
    }),
    // Fleet time, not UTC. In UTC this histogram is shifted three hours and the
    // "peak hour" it reports is simply the wrong hour of the working day.
    prisma.$queryRaw<Array<{ h: number; n: bigint }>>(Prisma.sql`
      SELECT EXTRACT(HOUR FROM started_at AT TIME ZONE ${FLEET_TZ})::int AS h, COUNT(*) AS n
        FROM speeding_incidents
       WHERE organisation_id = ${orgId} AND started_at >= ${r.from} AND started_at <= ${r.to}
       GROUP BY 1
    `),
    prisma.$queryRaw<Array<{ d: number; n: bigint }>>(Prisma.sql`
      SELECT EXTRACT(DOW FROM started_at AT TIME ZONE ${FLEET_TZ})::int AS d, COUNT(*) AS n
        FROM speeding_incidents
       WHERE organisation_id = ${orgId} AND started_at >= ${r.from} AND started_at <= ${r.to}
       GROUP BY 1
    `),
    prisma.$queryRaw<Array<{ vehicleId: string; plate: string | null; incidents: bigint; peak: number }>>(Prisma.sql`
      SELECT s.vehicle_id AS "vehicleId", v.registration_plate AS plate,
             COUNT(*) AS incidents, MAX(s.peak_kmh) AS peak
        FROM speeding_incidents s
        JOIN vehicles v ON v.id = s.vehicle_id
       WHERE s.organisation_id = ${orgId} AND s.started_at >= ${r.from} AND s.started_at <= ${r.to}
       GROUP BY 1, 2
    `),
    prisma.$queryRaw<Array<{ median: number | null }>>(Prisma.sql`
      SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_sec)::float8 AS median
        FROM speeding_incidents
       WHERE organisation_id = ${orgId} AND started_at >= ${r.from} AND started_at <= ${r.to}
    `),
  ])

  const hourHistogram = Array<number>(24).fill(0)
  for (const row of byHour) hourHistogram[row.h] = Number(row.n)
  const dowHistogram = Array<number>(7).fill(0)
  for (const row of byDow) dowHistogram[row.d] = Number(row.n)

  const units = byUnit.map(u => ({ ...u, incidents: Number(u.incidents) }))
  const worstCount = [...units].sort((a, b) => b.incidents - a.incidents)[0]
  const worstPeak  = [...units].sort((a, b) => b.peak - a.peak)[0]

  return {
    incidents:         totals._count._all,
    units:             units.length,
    peakKmh:           totals._max.peakKmh,
    totalSeconds:      totals._sum.durationSec ?? 0,
    medianDurationSec: durations[0]?.median ?? null,
    // A unit that offended once may have been unlucky; twice is a pattern.
    repeatUnits:       units.filter(u => u.incidents >= 2).length,
    hourHistogram,
    dowHistogram,
    worstByCount: worstCount ? { vehicleId: worstCount.vehicleId, plate: worstCount.plate, incidents: worstCount.incidents } : null,
    worstByPeak:  worstPeak  ? { vehicleId: worstPeak.vehicleId,  plate: worstPeak.plate,  peakKmh: worstPeak.peak } : null,
  }
}

/**
 * The same window one period earlier, for "vs last month".
 *
 * Returns null when the rollup has no data that far back — the UI must render
 * "no comparison yet" rather than 0. A 100% drop that is really an absent
 * history is the classic version of this bug.
 */
export async function speedingPrevCount(orgId: string, r: Range): Promise<number | null> {
  const span = r.to.getTime() - r.from.getTime()
  const prev = { from: new Date(r.from.getTime() - span), to: r.from }

  const earliest = await prisma.speedingIncident.findFirst({
    where:   { organisationId: orgId },
    orderBy: { startedAt: 'asc' },
    select:  { startedAt: true },
  })
  if (!earliest || earliest.startedAt > prev.from) return null

  return prisma.speedingIncident.count({
    where: { organisationId: orgId, startedAt: { gte: prev.from, lt: prev.to } },
  })
}

/* ── sensor faults ────────────────────────────────────────────────────────── */

export interface FaultSummaryRow {
  vehicleId:      string
  plate:          string | null
  name:           string | null
  episodes:       number
  openNow:        number
  totalSeconds:   number
  longestSeconds: number
  firstAt:        Date
  lastAt:         Date
  kinds:          string
  /** Position, speed and movement where this unit's sensors last worked — see
   *  the FILTERed aggregates in the query, and the columns' own note on the
   *  model. All null for an episode opened before this was captured, or one
   *  whose telemetry had already aged out of the 30-day window. */
  lastFixAt:      Date | null
  lastLat:        number | null
  lastLng:        number | null
  lastSpeedKmh:   number | null
  lastMoving:     boolean | null
  lastPlace:      string | null
}

/**
 * An episode OVERLAPS the window; it does not have to start inside it.
 *
 * This was `started_at BETWEEN from AND to`, and on a ledger of episodes that
 * is the wrong question. `startedAt` is when the DATA says the fault began —
 * `lastReportedAt` for a signal_lost — so a unit that went dark in July has an
 * episode that started in July and has never closed. Ask for a day in
 * September and containment excluded it, while the sweep went on re-confirming
 * that same fault every fifteen minutes. Measured on SUKARI: the Malfunction
 * tab's badge read 147 units in a bad state while the table under it returned
 * nothing at all, because almost nothing STARTED that day.
 *
 * Overlap asks the question the reader is actually asking — "which units were
 * faulty on this day" — and an open episode overlaps every window from its
 * start to now.
 *
 * Not applied to speeding. An overspeeding incident is a point event that is
 * over in seconds, always closed, and containment and overlap agree on it.
 */
const faultOverlap = (r: Range) => Prisma.sql`
       AND e.started_at <= ${r.to}::timestamptz
       AND COALESCE(e.recovered_at, NOW()) >= ${r.from}::timestamptz`

/**
 * Seconds an episode spent faulty INSIDE the window, never its whole length.
 *
 * The companion to overlap, and not optional with it: once a three-week
 * signal_lost shows up on a one-day view, `SUM(duration_sec)` would report
 * three weeks of downtime for that day. It is also the only way an open
 * episode contributes anything at all — `duration_sec` is null until recovery,
 * so open faults summed to zero and the worst units read as the quietest.
 *
 * Both ends are clamped: the start to the window's start, the end to the
 * earlier of the window's end and NOW — an episode still open at midday cannot
 * have been faulty for the rest of today yet.
 */
const clippedSeconds = (r: Range) => Prisma.sql`
  GREATEST(0, EXTRACT(EPOCH FROM (
    LEAST(COALESCE(e.recovered_at, NOW()), ${r.to}::timestamptz)
    - GREATEST(e.started_at, ${r.from}::timestamptz)
  )))`

/**
 * Fill in a position for episodes that were written without one.
 *
 * Every episode opened from now on copies the fix behind it (see the worker),
 * but the ledger already holds rows from before that existed, and those would
 * render three empty columns forever. So for any row still missing a position
 * we take the unit's OWN last known fix.
 *
 * For the kind that dominates this ledger that is not an approximation, it is
 * the same fix: a tracker that went silent has not reported since, so its
 * latest telemetry IS where it was when it went offline. For a unit still
 * reporting with one dead channel it means "where the unit is now" rather than
 * where it was when that channel died — weaker, and the reason the capture
 * exists at all. Rows that carry a stored fix are never touched.
 *
 * Beyond the 30-day telemetry window there is nothing to find, and those rows
 * stay blank. That is honest: the position was not recorded and cannot be
 * reconstructed.
 *
 * The place label comes from the geocoder's CACHE only. Awaiting the real
 * lookup would put its 1.1s-per-miss rate limiter inside a page load; instead
 * an uncached cell is warmed in the background, so the next read has it.
 */
type Positionable = {
  vehicleId:     string
  lastFixAt?:    Date | null
  lastLat:       number | null
  lastLng:       number | null
  lastSpeedKmh:  number | null
  lastMoving:    boolean | null
  lastPlace:     string | null
}

async function fillMissingPositions(rows: Positionable[]): Promise<void> {
  const missing = rows.filter(r => r.lastLat == null)
  if (missing.length) {
    const ids = [...new Set(missing.map(r => r.vehicleId))]
    const fixes = await prisma.$queryRaw<Array<{
      vehicleId: string; lat: number; lng: number; speedKmh: number | null; capturedAt: Date
    }>>(Prisma.sql`
      SELECT DISTINCT ON (t.vehicle_id)
             t.vehicle_id  AS "vehicleId",
             t.lat         AS lat,
             t.lng         AS lng,
             t.speed_kmh   AS "speedKmh",
             t.captured_at AS "capturedAt"
        FROM vehicle_telemetries t
       WHERE t.vehicle_id = ANY(${ids}) AND t.lat IS NOT NULL
       ORDER BY t.vehicle_id, t.captured_at DESC
    `)
    const byId = new Map(fixes.map(f => [f.vehicleId, f]))
    for (const r of missing) {
      const f = byId.get(r.vehicleId)
      if (!f) continue
      r.lastFixAt    = f.capturedAt
      r.lastLat      = f.lat
      r.lastLng      = f.lng
      r.lastSpeedKmh = f.speedKmh
      r.lastMoving   = f.speedKmh == null ? null : f.speedKmh >= MOVING_THRESHOLD_KMH
    }
  }

  for (const r of rows) {
    if (r.lastPlace || r.lastLat == null || r.lastLng == null) continue
    r.lastPlace = cachedPlace(r.lastLat, r.lastLng)
    if (!r.lastPlace) void reverseGeocode(r.lastLat, r.lastLng).catch(() => {})
  }
}

export async function faultSummary(
  orgId: string,
  r: Range,
  opts: { sort: string; limit: number; offset: number; kinds?: string[]; minCount?: number; search?: string },
): Promise<{ rows: FaultSummaryRow[]; hasNextPage: boolean }> {
  const orderBy = {
    count:    Prisma.sql`episodes DESC, total_seconds DESC`,
    peak:     Prisma.sql`longest_seconds DESC`,
    duration: Prisma.sql`total_seconds DESC, episodes DESC`,
    // Quoted, because the SELECT alias is "lastAt" — see the speeding summary's
    // sort map for the whole class of bug this belongs to.
    recent:   Prisma.sql`"lastAt" DESC`,
  }[opts.sort] ?? Prisma.sql`episodes DESC, total_seconds DESC`

  const kindFilter = opts.kinds?.length
    ? Prisma.sql`AND e.kind = ANY(${opts.kinds})`
    : Prisma.empty

  const rows = await prisma.$queryRaw<Array<FaultSummaryRow & { episodes: bigint; open_now: bigint; total_seconds: bigint; longest_seconds: number | null }>>(Prisma.sql`
    SELECT e.vehicle_id                          AS "vehicleId",
           v.registration_plate                  AS plate,
           v.name                                AS name,
           COUNT(*)                              AS episodes,
           COUNT(*) FILTER (WHERE e.recovered_at IS NULL) AS open_now,
           COALESCE(SUM(${clippedSeconds(r)}), 0)::bigint AS total_seconds,
           COALESCE(MAX(${clippedSeconds(r)}), 0)::int    AS longest_seconds,
           MIN(e.started_at)                     AS "firstAt",
           MAX(e.started_at)                     AS "lastAt",
           STRING_AGG(DISTINCT e.kind, ',')      AS kinds,
           -- Where this unit's sensors were last working, taken from its most
           -- recent episode THAT HAS A POSITION. The same FILTER on all five,
           -- so they are five facts about one moment rather than coordinates
           -- from one episode beside a speed from another. last_place is
           -- filled asynchronously, so it can still be null here while the
           -- coordinates beside it are not — unresolved, not elsewhere.
           (ARRAY_AGG(e.last_fix_at    ORDER BY e.started_at DESC) FILTER (WHERE e.last_lat IS NOT NULL))[1] AS "lastFixAt",
           (ARRAY_AGG(e.last_lat       ORDER BY e.started_at DESC) FILTER (WHERE e.last_lat IS NOT NULL))[1] AS "lastLat",
           (ARRAY_AGG(e.last_lng       ORDER BY e.started_at DESC) FILTER (WHERE e.last_lat IS NOT NULL))[1] AS "lastLng",
           (ARRAY_AGG(e.last_speed_kmh ORDER BY e.started_at DESC) FILTER (WHERE e.last_lat IS NOT NULL))[1] AS "lastSpeedKmh",
           (ARRAY_AGG(e.last_moving    ORDER BY e.started_at DESC) FILTER (WHERE e.last_lat IS NOT NULL))[1] AS "lastMoving",
           (ARRAY_AGG(e.last_place     ORDER BY e.started_at DESC) FILTER (WHERE e.last_lat IS NOT NULL))[1] AS "lastPlace"
      FROM sensor_fault_episodes e
      JOIN vehicles v ON v.id = e.vehicle_id
     WHERE e.organisation_id = ${orgId}
       ${faultOverlap(r)}
       ${kindFilter}
       ${unitSearch(opts.search)}
     GROUP BY e.vehicle_id, v.registration_plate, v.name
    ${opts.minCount ? Prisma.sql`HAVING COUNT(*) >= ${opts.minCount}` : Prisma.empty}
     ORDER BY ${orderBy}
     LIMIT ${opts.limit + 1} OFFSET ${opts.offset}
  `)

  const hasNextPage = rows.length > opts.limit
  if (hasNextPage) rows.pop()

  const mapped = rows.map(r2 => ({
    ...r2,
    episodes:       Number(r2.episodes),
    openNow:        Number(r2.open_now),
    totalSeconds:   Number(r2.total_seconds),
    longestSeconds: r2.longest_seconds ?? 0,
  })) as FaultSummaryRow[]

  // Only ever the page being returned, so the cost is bounded by the page size
  // rather than by the size of the ledger.
  await fillMissingPositions(mapped)

  return { hasNextPage, rows: mapped }
}

export async function faultList(
  orgId: string,
  r: Range,
  q: { vehicleId: string; kinds?: string[]; cursor?: string; limit: number },
) {
  const items = await prisma.sensorFaultEpisode.findMany({
    where: {
      organisationId: orgId,
      vehicleId:      q.vehicleId,
      // The same overlap the summary uses — see `faultOverlap`. A unit that
      // shows in the list because it was faulty all day must not open onto an
      // empty detail table because the episode began last month.
      startedAt:      { lte: r.to },
      OR: [{ recoveredAt: null }, { recoveredAt: { gte: r.from } }],
      ...(q.kinds?.length ? { kind: { in: q.kinds } } : {}),
    },
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
  })
  const hasNextPage = items.length > q.limit
  if (hasNextPage) items.pop()
  // The detail table shows the same three columns, so it gets the same repair
  // — otherwise opening a unit would empty columns the list beside it filled.
  await fillMissingPositions(items)
  return { data: items, cursor: items.at(-1)?.id ?? null, hasNextPage }
}

/**
 * Raw SQL rather than `aggregate` + `groupBy`, because both totals are now
 * window-clipped expressions rather than a column Prisma can sum. Same window
 * and same arithmetic as the summary table above, so the strip and the rows
 * under it cannot disagree about the period they describe.
 */
export async function faultInsights(orgId: string, r: Range) {
  const [totals, byKind, open] = await Promise.all([
    prisma.$queryRaw<Array<{ episodes: bigint; units: bigint; total_seconds: bigint; longest_seconds: number }>>(Prisma.sql`
      SELECT COUNT(*)                                       AS episodes,
             COUNT(DISTINCT e.vehicle_id)                   AS units,
             COALESCE(SUM(${clippedSeconds(r)}), 0)::bigint AS total_seconds,
             COALESCE(MAX(${clippedSeconds(r)}), 0)::int    AS longest_seconds
        FROM sensor_fault_episodes e
       WHERE e.organisation_id = ${orgId}
         ${faultOverlap(r)}
    `),
    prisma.$queryRaw<Array<{ kind: string; episodes: bigint; seconds: bigint }>>(Prisma.sql`
      SELECT e.kind                                         AS kind,
             COUNT(*)                                       AS episodes,
             COALESCE(SUM(${clippedSeconds(r)}), 0)::bigint AS seconds
        FROM sensor_fault_episodes e
       WHERE e.organisation_id = ${orgId}
         ${faultOverlap(r)}
       GROUP BY e.kind
    `),
    // Open RIGHT NOW, regardless of the window — this is the actionable number
    // and it is not a fact about the reporting period.
    prisma.sensorFaultEpisode.count({
      where: { organisationId: orgId, recoveredAt: null },
    }),
  ])

  const t = totals[0]

  return {
    episodes:       Number(t?.episodes ?? 0),
    // Units, not just episodes: this is the figure a reader compares against
    // the Malfunction tab's badge, which counts UNITS in a bad state. Two
    // numbers of the same kind can be reconciled; a count of episodes beside a
    // count of units cannot.
    units:          Number(t?.units ?? 0),
    totalSeconds:   Number(t?.total_seconds ?? 0),
    longestSeconds: t?.longest_seconds ?? 0,
    openNow:        open,
    byKind: byKind
      .map(k => ({ kind: k.kind, episodes: Number(k.episodes), seconds: Number(k.seconds) }))
      .sort((a, b) => b.episodes - a.episodes),
  }
}

/**
 * The earliest incident this org has, either ledger.
 *
 * The screens print it: a report over a month that began before capture was
 * switched on is not empty because nothing happened, and saying so is the
 * difference between a fleet that looks clean and one nobody was watching.
 */
export async function captureStart(orgId: string): Promise<{ speeding: Date | null; faults: Date | null }> {
  const [s, f] = await Promise.all([
    prisma.speedingIncident.findFirst({
      where: { organisationId: orgId }, orderBy: { startedAt: 'asc' }, select: { startedAt: true },
    }),
    prisma.sensorFaultEpisode.findFirst({
      where: { organisationId: orgId }, orderBy: { startedAt: 'asc' }, select: { startedAt: true },
    }),
  ])
  return { speeding: s?.startedAt ?? null, faults: f?.startedAt ?? null }
}
