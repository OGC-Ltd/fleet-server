import { prisma } from '../../lib/prisma.js'
import { probeHoldVehicleIds } from '../fuel/probe-hold.js'
import { overspeedLimitFor } from '../../lib/derived-alerts.js'
import { warmSpeedPolicy } from '../../lib/speed-policy.js'
import { Prisma } from '../../../generated/prisma/client.js'
import { ALERT_SOURCE } from '../../lib/alerts.js'
import { logger } from '../../lib/logger.js'
import type { TelemetryListQuery, TrackQuery } from './telemetry.schema.js'
import { PLAYBACK_SCAN_CAP } from './telemetry.schema.js'

export async function findPings(vehicleId: string, orgId: string, q: TelemetryListQuery) {
  // Verify vehicle belongs to org before returning data
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, organisationId: orgId },
    select: { id: true },
  })
  if (!vehicle) return null

  const where = {
    vehicleId,
    ...(q.from || q.to
      ? { capturedAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
      : {}),
  }

  const pings = await prisma.vehicleTelemetry.findMany({
    where: { ...where, ...(q.cursor ? { id: { lt: q.cursor } } : {}) },
    orderBy: { capturedAt: 'desc' },
    take: q.limit + 1,
  })

  const hasNextPage = pings.length > q.limit
  if (hasNextPage) pings.pop()
  const nextCursor = hasNextPage ? (pings.at(-1)?.id ?? null) : null

  return { data: pings, cursor: nextCursor?.toString() ?? null, hasNextPage }
}

/**
 * Rows scanned for one track. At the 30 s poll cadence this is ~41 hours, so a
 * normal 12 h window never reaches it; it exists only so an open-ended `from`
 * cannot try to stream a year of history into memory.
 */
const TRACK_SCAN_CAP = 5000

/**
 * How long the unit must send NOTHING before the line may be broken.
 *
 * 12 missed polls at the 30 s cadence. The point of breaking a track is to
 * refuse to draw a stretch we have no evidence for — one production track
 * contained a 9.4 km single hop across a 1.7 h silence, drawn as a straight
 * line through open country — so the test belongs on real reporting silence
 * and nothing else. See `gapBefore` in findTrack.
 */
const TRACK_HOLE_MS = 6 * 60_000

/**
 * A drawn point. `gapBefore` means the unit went quiet before reaching it.
 *
 * `spd`/`hdg`/`eng` are here for the time marks the map hangs off this track —
 * a dot the operator clicks answers "where was it at 13:07" and is expected to
 * read out the same three channels playback does. They ride on rows this query
 * already fetches (engineOn was being read for engineOffSinceMs regardless), so
 * the cost is two columns on the wire per KEPT point — a few hundred over a
 * window, not per fix — and no extra query. A sampled track fills them the same
 * way; see findSampledFixes.
 */
export interface TrackPoint {
  t: number
  lat: number
  lng: number
  /** km/h at the fix, null where the unit sent none. */
  spd?: number | null
  /** Compass bearing 0-360, null where the unit sent none. */
  hdg?: number | null
  /** Ignition at the fix. Absent, not false, when the source did not read it. */
  eng?: boolean
  gapBefore?: true
}

/** Does this vehicle belong to this org? The guard every track path shares. */
/** `db`: the report pool (lib/report-db) for a report's reads; the live pool otherwise. */
export async function vehicleExistsInOrg(vehicleId: string, orgId: string, db: typeof prisma = prisma) {
  const vehicle = await db.vehicle.findFirst({
    where: { id: vehicleId, organisationId: orgId },
    select: { id: true },
  })
  return vehicle !== null
}

/** Metres between two lat/lng points (equirectangular — exact enough here). */
export function metresBetween(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371000, rad = Math.PI / 180
  const dLat = (bLat - aLat) * rad
  const dLng = (bLng - aLng) * rad * Math.cos(((aLat + bLat) / 2) * rad)
  return Math.sqrt(dLat * dLat + dLng * dLng) * R
}

/**
 * The vehicle's travelled track over a window: three columns, thinned, oldest
 * first — the shape a polyline actually needs.
 *
 * Returns `truncated` so the caller can say how far back the track really
 * reaches instead of asserting the requested window. That distinction matters:
 * a vehicle with no fixes in the window is NOT the same as one that sat still,
 * and the map had been reporting both as "no movement".
 */
export async function findTrack(vehicleId: string, orgId: string, q: TrackQuery) {
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, organisationId: orgId },
    select: { id: true },
  })
  if (!vehicle) return null

  // Newest-first with the cap, so a truncated scan drops the OLDEST end and the
  // track still runs up to the present. Reversed to ascending below.
  const rows = await prisma.vehicleTelemetry.findMany({
    where: {
      vehicleId,
      ...(q.from || q.to
        ? { capturedAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
        : {}),
    },
    orderBy: { capturedAt: 'desc' },
    take: TRACK_SCAN_CAP + 1,
    // engineOn rides along for engineOffSinceMs below, and all three motion
    // channels ride along for the per-point readouts (see TrackPoint). They are
    // three more columns on rows already being read, not another query.
    select: {
      capturedAt: true, lat: true, lng: true,
      engineOn: true, speedKmh: true, headingDeg: true,
    },
  })

  const truncated = rows.length > TRACK_SCAN_CAP
  if (truncated) rows.pop()

  const fixes = rows.length
  const points: TrackPoint[] = []
  // Ascending, dropping fixes with no position and any that have not moved far
  // enough from the last one kept.
  //
  // `gapBefore` marks the points the caller must NOT join a line to, and it has
  // to be decided here because only this loop can tell the two silences apart.
  // Thinning removes every fix a standing vehicle emits, so by the time the
  // client sees the points, "reported from one spot for ten minutes" and "sent
  // nothing for ten minutes" look identical — both are two surviving points ten
  // minutes apart. The client was breaking the line on that, so a tracker that
  // never missed a beat had its route cut into pieces wherever the unit paused.
  // Measured 2026-08-08 on a prime mover: 2,107 fixes, 28 s apart, no holes at
  // all — drawn as nine separate runs.
  let prevFixT: number | null = null
  let holeBefore = false
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (r.lat == null || r.lng == null || !Number.isFinite(r.lat) || !Number.isFinite(r.lng)) continue

    // Measured against every positioned row, kept or thinned — that is what
    // makes this a statement about the DATA rather than about the drawing.
    const t = r.capturedAt.getTime()
    if (prevFixT != null && t - prevFixT > TRACK_HOLE_MS) holeBefore = true
    prevFixT = t

    const prev = points[points.length - 1]
    if (prev && metresBetween(prev.lat, prev.lng, r.lat, r.lng) < q.minSpacingM) continue
    // The hole belongs to the next point actually drawn, so it survives however
    // many thinned-away fixes follow it.
    points.push({
      t, lat: r.lat, lng: r.lng,
      spd: r.speedKmh, hdg: r.headingDeg, eng: r.engineOn,
      ...(holeBefore ? { gapBefore: true as const } : {}),
    })
    holeBefore = false
  }

  // Always keep the final fix, so the track reaches where the vehicle actually
  // stopped even if that last hop was shorter than the spacing threshold.
  const lastRow = rows.find(r => r.lat != null && r.lng != null)
  if (lastRow?.lat != null && lastRow.lng != null) {
    const last = points[points.length - 1]
    const t = lastRow.capturedAt.getTime()
    if (!last || last.t !== t) {
      points.push({
        t, lat: lastRow.lat, lng: lastRow.lng,
        spd: lastRow.speedKmh, hdg: lastRow.headingDeg, eng: lastRow.engineOn,
        ...(holeBefore ? { gapBefore: true as const } : {}),
      })
    }
  }

  // When the key was last turned off, if it is still off.
  //
  // A track says where a unit WAS, and its last point is wherever the window
  // ran out — which is not the same as the journey having ended. The signal
  // that it ended is the ignition: 222 of 224 units report a real one
  // (`engine operation` / io_239, see the Wialon adapter), so engineOn is an
  // ignition line rather than a restatement of speed, and a unit can idle for
  // an hour without its journey being over.
  //
  // Walk back from the newest row while the engine is off; the oldest row of
  // that unbroken run is when it went off. `null` means the engine was on at
  // the last fix — a journey still in progress has no end to date.
  //
  // The column is `Boolean @default(false)`, so a provider that sends no
  // ignition at all reads as OFF rather than as unknown. That is safe for this
  // fleet — the Wialon adapter always sets the field explicitly, falling back
  // to speed on the two units with no ignition line — but it is why this reads
  // `!== false` rather than trusting a truthiness test.
  let engineOffSinceMs: number | null = null
  let engineOffRunsPastWindow = false
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].engineOn !== false) break
    engineOffSinceMs = rows[i].capturedAt.getTime()
    // Every row in the window is an off reading, so it went off at or before
    // the oldest one we can see and the caller must not read this as exact.
    if (i === rows.length - 1) engineOffRunsPastWindow = true
  }

  return {
    resolution: 'full' as const,             // every fix in the window was read
    sampleBucketSec: null,                   // ...so nothing here stands for a bucket
    samples: null,
    points,
    fixes,                                   // rows in the window before thinning
    truncated,                               // scan cap hit: earliest is not the window start
    firstAt: points[0]?.t ?? null,
    lastAt:  points[points.length - 1]?.t ?? null,
    engineOffSinceMs,                        // key last turned off, or null if it is on
    engineOffRunsPastWindow,                 // ...and it was already off when the window opened
  }
}

/** One replayed fix. `spd`/`hdg` are what make the marker move believably. */
export interface PlaybackPoint {
  t: number
  lat: number
  lng: number
  /** km/h at the fix. 100% populated on this fleet; null-safe regardless. */
  spd: number | null
  /** Compass bearing 0-360. Also 100% populated. */
  hdg: number | null
  /** Ignition at the fix — an idling unit and a moving one look alike without it. */
  eng: boolean
  gapBefore?: true
}

/**
 * Every positioned fix for one vehicle across one window, with motion.
 *
 * The extra two columns over `findTrack` are the whole reason this exists.
 * `heading_deg` and `speed_kmh` are populated on 100% of 2,288,187 fixes
 * measured over 7 days, so a playback marker can point the right way and read
 * out a speed without any ingestion work — the track endpoint simply never
 * selected them, because a static polyline has no use for either.
 *
 * Returned RAW and unsimplified. Thinning is a separate, pure step
 * (lib/simplify-path) so it can be tested against fabricated shapes rather than
 * against whatever the database happens to hold, and so `toleranceM=0` can
 * return exactly what was read.
 */
export async function findPlaybackFixes(
  vehicleId: string, orgId: string, from: Date, to: Date,
) {
  if (!(await vehicleExistsInOrg(vehicleId, orgId))) return null

  // ASCENDING here, unlike findTrack. That endpoint reads newest-first so a
  // truncated scan keeps the RECENT end; a playback day is bounded at both
  // ends, and if one has to be lost it must be the late one — a replay that
  // starts at 06:00 and stops early is readable, one that begins mid-morning
  // with no explanation is not.
  const rows = await prisma.vehicleTelemetry.findMany({
    where: { vehicleId, capturedAt: { gte: from, lt: to } },
    orderBy: { capturedAt: 'asc' },
    take: PLAYBACK_SCAN_CAP + 1,
    select: {
      capturedAt: true, lat: true, lng: true,
      speedKmh: true, headingDeg: true, engineOn: true,
    },
  })

  const truncated = rows.length > PLAYBACK_SCAN_CAP
  if (truncated) rows.pop()

  const fixes = rows.length
  const points: PlaybackPoint[] = []

  // `gapBefore` is decided against every POSITIONED row, kept or not — the same
  // rule findTrack uses and for the same reason: a silence is a fact about the
  // data, and measuring it after thinning would turn every collapsed dwell into
  // a fake reporting hole.
  let prevFixT: number | null = null
  let holeBefore = false
  for (const r of rows) {
    if (r.lat == null || r.lng == null || !Number.isFinite(r.lat) || !Number.isFinite(r.lng)) continue
    const t = r.capturedAt.getTime()
    if (prevFixT != null && t - prevFixT > TRACK_HOLE_MS) holeBefore = true
    prevFixT = t
    points.push({
      t, lat: r.lat, lng: r.lng,
      spd: r.speedKmh, hdg: r.headingDeg, eng: r.engineOn,
      ...(holeBefore ? { gapBefore: true as const } : {}),
    })
    holeBefore = false
  }

  return { points, fixes, truncated }
}

/**
 * One unit's sensor channels over a window, ascending, as COLUMNS.
 *
 * Columnar because the payload is the cost: a row object repeats every key for
 * every fix, and at ~3,000 fixes a day the keys outweigh the numbers. Times are
 * seconds after `from`, positions are rounded to ~1 m. Nulls stay null — a
 * missing reading is not a zero.
 */
export async function findDaySeries(
  vehicleId: string, orgId: string, from: Date, to: Date, after: Date | null, db: typeof prisma = prisma,
) {
  if (!(await vehicleExistsInOrg(vehicleId, orgId, db))) return null

  const rows = await db.vehicleTelemetry.findMany({
    where: { vehicleId, capturedAt: after ? { gt: after, lt: to } : { gte: from, lt: to } },
    orderBy: { capturedAt: 'asc' },
    take: PLAYBACK_SCAN_CAP + 1,
    select: {
      capturedAt: true, lat: true, lng: true, speedKmh: true,
      engineOn: true, fuelLevelMl: true, engineHoursMeter: true,
    },
  })

  const truncated = rows.length > PLAYBACK_SCAN_CAP
  if (truncated) rows.pop()

  const base = from.getTime()
  const round = (v: number | null, dp: number) =>
    v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp
  const cols = {
    t:   [] as number[],
    lat: [] as (number | null)[], lng: [] as (number | null)[],
    spd: [] as (number | null)[], eng: [] as (0 | 1 | null)[],
    fuelMl: [] as (number | null)[], hrs: [] as (number | null)[],
  }
  for (const r of rows) {
    cols.t.push(Math.round((r.capturedAt.getTime() - base) / 1000))
    cols.lat.push(round(r.lat, 5))
    cols.lng.push(round(r.lng, 5))
    cols.spd.push(round(r.speedKmh, 0))
    cols.eng.push(r.engineOn == null ? null : r.engineOn ? 1 : 0)
    cols.fuelMl.push(round(r.fuelLevelMl, 0))
    cols.hrs.push(round(r.engineHoursMeter, 3))
  }
  return { cols, truncated }
}

// ───────────────────────── long windows & zone timeline ────────────────────

/**
 * Samples taken across a long window, and PostGIS probes allowed for the zone
 * timeline. Both are budgets on WORK, not on time, which is what makes a
 * 30-day request cost the same as a 3-day one.
 *
 * The number comes off the plans, not off a preference. Measured against prod
 * 2026-08-09, one unit:
 *
 *   window   fixes    plain fetch     zone timeline
 *   12 h      3,073        331 ms            439 ms
 *   24 h      6,855        513 ms            806 ms
 *   48 h     17,804      9,221 ms          >45 s (cancelled)
 *   30 d    160,890      >60 s (cancelled)
 *
 * The cliff is not CPU, it is random heap IO: one unit's pings are scattered
 * through an 807 MB heap interleaved with 330 other units, and the instance has
 * 225 MB of shared_buffers to cache it with. Past ~20k rows almost every fetch
 * misses.
 *
 * A bucketed LATERAL never hits that cliff. `ORDER BY captured_at LIMIT 1`
 * inside each bucket is an index range scan that stops on its first row, so the
 * work is O(buckets) and completely independent of how many fixes the window
 * actually holds. 1,000 buckets over 30 days costs what 1,000 buckets over a
 * day costs.
 *
 * The budgets are small because a bucket probe is not free. Each one is an
 * index descent plus a heap fetch that, on a cold cache, is a random read.
 * Measured end-to-end against prod on the busiest unit, 30-day request:
 *
 *   TRACK_SAMPLE_BUDGET 1500 -> 19.9 s     400 -> 5.7 s
 *   ZONE_PROBE_BUDGET    350 -> 15.2 s     300 -> ~3.9 s (after the
 *                                          fence_area fix below)
 *
 * ZONE_PROBE_BUDGET is lower again because each sample also costs a GiST probe
 * against geofences — and memoisation does NOT save a moving unit, whose
 * coordinates are distinct by definition (13,239 misses out of 13,379 on a
 * 30-day moving-fix scan).
 *
 * These are COLD-cache numbers on a 1 GB instance, which is the case that has
 * to fit. Both budgets would rise a long way once
 * prisma/postgis/03-track-covering-index.sql is applied, since that is what
 * removes the random read. Re-measure before raising them.
 */
const TRACK_SAMPLE_BUDGET = 400
const ZONE_PROBE_BUDGET   = 300

/**
 * Hard ceiling on the two raw queries below, enforced by Postgres rather than
 * by hope.
 *
 * On 2026-08-09 an unbounded maintenance query pinned this instance until every
 * backend was stuck on IO and the API stopped answering. Nothing that reads
 * this table on a request path may be able to do that again: `SET LOCAL` inside
 * the transaction means the server cancels the statement itself, even if the
 * client has gone away.
 */
const RAW_QUERY_TIMEOUT_MS = 8_000

/** Bucket width for a window, in whole seconds, never below the poll cadence. */
function bucketSeconds(from: Date, to: Date, budget: number) {
  const spanSec = Math.max(1, (to.getTime() - from.getTime()) / 1000)
  // Floor of 30 s: below the reporting cadence extra buckets buy no detail,
  // they just come back empty and cost a probe each.
  return Math.max(30, Math.ceil(spanSec / budget))
}

/**
 * The part of the requested window the unit actually reported in.
 *
 * Worth two extra index probes because the alternative is hundreds of wasted
 * ones. Telemetry on this fleet only begins 2026-07-26, so a 30-day request
 * today spends half its bucket budget probing prehistory that cannot contain a
 * fix — measured at 19.9 s for a window whose real span was 14 days. Clamping
 * first spends the whole budget on the range that has data, and makes the
 * buckets finer for free.
 *
 * `min`/`max` with an equality on vehicle_id are index probes, not a scan.
 */
async function reportedSpan(vehicleId: string, from: Date, to: Date) {
  const span = await prisma.vehicleTelemetry.aggregate({
    where: {
      vehicleId,
      capturedAt: { gte: from, lte: to },
      lat: { not: null },
      lng: { not: null },
    },
    _min: { capturedAt: true },
    _max: { capturedAt: true },
  })

  const lo = span._min.capturedAt
  const hi = span._max.capturedAt
  if (!lo || !hi) return null                  // unit said nothing in this window
  // A single fix gives a zero-length span; widen it so generate_series emits
  // one bucket rather than none.
  return { lo, hi: hi > lo ? hi : new Date(lo.getTime() + 1000) }
}

/**
 * Prisma's own ceiling on the interactive transaction, which is a SEPARATE
 * clock from the statement timeout and defaults to 5 s.
 *
 * It has to outlive the database-side guard, and getting this wrong is not a
 * tuning detail — it inverts which mechanism fires. Caught end-to-end on
 * 2026-08-09: a 30-day sampled fetch ran 5.7 s, comfortably inside its 8 s
 * statement timeout and on course to succeed, but Prisma's default 5 s expired
 * first and threw P2028. That is not a `query_canceled`, so it fell straight
 * past the handler below and surfaced as a 500 on a request that should have
 * returned data.
 *
 * Neither the mocked unit tests nor the small-fixture database test could see
 * this: one never opens a transaction and the other never runs long enough.
 */
const TX_TIMEOUT_MS = RAW_QUERY_TIMEOUT_MS + 2_000

/**
 * Runs `fn` with a statement timeout. A timeout is returned as `null` rather
 * than thrown: both callers are enrichments on a track that has already been
 * fetched, and losing the enrichment must not lose the track.
 */
async function withTimeout<T>(label: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T | null> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${RAW_QUERY_TIMEOUT_MS}`)
      return fn(tx)
    }, { timeout: TX_TIMEOUT_MS })
  } catch (err) {
    // 57014 = query_canceled, the statement timeout doing its job. P2028 is
    // Prisma's own transaction expiry — it should now be unreachable given the
    // headroom above, but it means exactly the same thing to a caller and must
    // degrade the same way rather than becoming a 500.
    const code = (err as { code?: string })?.code
    const msg  = err instanceof Error ? err.message : String(err)
    if (code === '57014' || code === 'P2028' || /statement timeout|canceling statement|expired transaction/i.test(msg)) {
      // Worth a line: a timeout here is the instance telling us the budgets
      // above are no longer right for the data volume, and it is otherwise
      // invisible to ops because the caller still gets a usable response.
      logger.warn({ query: label, timeoutMs: RAW_QUERY_TIMEOUT_MS }, 'Track query hit its statement timeout')
      return null
    }
    throw err
  }
}

/** One positioned sample, plus whether its bucket was the first after silence. */
export interface SampledFix {
  captured_at: Date
  lat: number
  lng: number
  engine_on: boolean
  /** km/h at the sampled fix. Carried so a sampled track's time marks read out
   *  the same channels a full-fidelity one's do — a bucket probe already
   *  fetches the heap row, so the two columns are free. */
  speed_kmh: number | null
  /** Compass bearing 0-360 at the sampled fix. */
  heading_deg: number | null
  /** The bucket before this one held no fix at all — real reporting silence. */
  gap_before: boolean
}

/**
 * A track over a window too long to read fix-by-fix.
 *
 * One fix per time bucket, oldest first. Gap detection survives the
 * downsampling because an EMPTY bucket is evidence in its own right: the
 * LATERAL looked for a fix in that span and the unit had not sent one. That is
 * the same claim `findTrack` makes from consecutive timestamps, just at bucket
 * resolution instead of ping resolution — so the caller still gets an honest
 * broken line rather than a straight hop across a silence.
 */
export async function findSampledFixes(vehicleId: string, from: Date, to: Date) {
  const span = await reportedSpan(vehicleId, from, to)
  if (!span) return { rows: [], bucketSec: 0 }

  const bucketSec = bucketSeconds(span.lo, span.hi, TRACK_SAMPLE_BUDGET)

  const rows = await withTimeout('sampled-track', tx => tx.$queryRaw<SampledFix[]>`
    WITH buckets AS (
      SELECT b AS bucket_start
      FROM generate_series(${span.lo}::timestamptz, ${span.hi}::timestamptz,
                           make_interval(secs => ${bucketSec}::int)) AS b
    ),
    picked AS (
      SELECT b.bucket_start, t.captured_at, t.lat, t.lng, t.engine_on,
             t.speed_kmh, t.heading_deg
      FROM buckets b
      LEFT JOIN LATERAL (
        SELECT t."captured_at", t."lat", t."lng", t."engine_on",
               t."speed_kmh", t."heading_deg"
        FROM "vehicle_telemetries" t
        WHERE t."vehicle_id"  = ${vehicleId}
          AND t."captured_at" >= b.bucket_start
          AND t."captured_at" <  b.bucket_start + make_interval(secs => ${bucketSec}::int)
          AND t."lat" IS NOT NULL AND t."lng" IS NOT NULL
        ORDER BY t."captured_at"
        LIMIT 1
      ) t ON true
    ),
    flagged AS (
      -- The empty buckets ARE the gap evidence, so the flag has to be computed
      -- while they are still in the set. Filtering them in this same query
      -- level would not work: WHERE runs before window functions, so lag()
      -- would only ever see buckets that found a fix and no gap could be
      -- detected at all.
      SELECT captured_at, lat, lng, engine_on, speed_kmh, heading_deg,
             -- The PREVIOUS bucket came back empty, and this one did not.
             (lag(captured_at)   OVER (ORDER BY bucket_start) IS NULL
              AND lag(bucket_start) OVER (ORDER BY bucket_start) IS NOT NULL) AS gap_before
      FROM picked
    )
    SELECT captured_at, lat, lng, engine_on, speed_kmh, heading_deg, gap_before
    FROM flagged
    WHERE captured_at IS NOT NULL
    ORDER BY captured_at
  `)

  return rows === null ? null : { rows, bucketSec }
}

/** One continuous stay inside one zone — or outside every zone, when null. */
export interface ZoneVisitRow {
  zone_id:    string | null
  zone_name:  string | null
  zone_type:  string | null
  /** Inside this zone raises a violation; the other 99 are context only. */
  enforced:   boolean | null
  entered_at: Date
  left_at:    Date
  samples:    bigint
}

/**
 * Where a unit has been, as a sequence of zone visits.
 *
 * Two things about this query are not obvious and are both deliberate.
 *
 * **It takes the smallest enclosing zone, not every match.** Measured on prod
 * 2026-08-09: a single ping on this estate falls inside SIXTEEN geofences at
 * once — all 67 circular zones carry r = 1000 m and blanket the site, and
 * `FARM #215` alone overlaps 84 others. A plain join reports the unit in
 * sixteen places simultaneously, with identical counts, which looks like
 * working output. `ORDER BY ST_Area(f.geom) LIMIT 1` is the same smallest-first
 * rule lib/zone-presence.ts already applies in memory; the two must not
 * disagree about where a vehicle is.
 *
 * **A LEFT join, so "nowhere" is a visit too.** A unit leaving the estate is
 * the single most interesting thing a backtrack can show, and an inner join
 * would delete exactly that segment from the timeline.
 *
 * Consecutive samples in the same zone collapse into one visit by the usual
 * gaps-and-islands pair of window functions, so a unit that enters, leaves and
 * re-enters reads as three visits rather than one smeared range.
 */
export async function findZoneTimeline(vehicleId: string, orgId: string, from: Date, to: Date) {
  const span = await reportedSpan(vehicleId, from, to)
  if (!span) return { rows: [], bucketSec: 0 }

  const bucketSec = bucketSeconds(span.lo, span.hi, ZONE_PROBE_BUDGET)

  const rows = await withTimeout('zone-timeline', tx => tx.$queryRaw<ZoneVisitRow[]>`
    WITH fence_area AS MATERIALIZED (
      -- Every fence's true area, computed ONCE.
      --
      -- The obvious spelling of this query puts ST_Area straight in the
      -- LATERAL's ORDER BY, which recomputes it for all ~15 matching fences on
      -- every probe — 5,000-odd spheroid area calculations over rings of up to
      -- 872 vertices. Measured 15.2 s that way against 3.9 s like this, for
      -- identical output.
      --
      -- Planar ST_Area(geom::geometry) is the tempting shortcut. Measured
      -- 2026-08-09, it is not a correctness problem here but it is not a win
      -- either: 62 of the 107 fences rank differently under it, yet ZERO pairs
      -- whose areas differ by more than 1% ever invert — the reshuffling is
      -- entirely among the 67 identical-radius circles, so it would not change
      -- which fence is picked. It is simply slower than this (4.4 s vs 3.9 s)
      -- while being approximate. MATERIALIZED keeps the exact spheroid number
      -- and pays for it once, so there is nothing to trade away.
      SELECT f."id",
             ST_Area(f."geom")                              AS area_m2,
             (f."is_active" AND f."mode" = 'BLOCKLIST')     AS enforced
      FROM "geofences" f
      WHERE f."organisation_id" = ${orgId} AND f."geom" IS NOT NULL
    ),
    buckets AS (
      SELECT b AS bucket_start
      FROM generate_series(${span.lo}::timestamptz, ${span.hi}::timestamptz,
                           make_interval(secs => ${bucketSec}::int)) AS b
    ),
    samples AS (
      SELECT t.captured_at, t.lat, t.lng
      FROM buckets b
      CROSS JOIN LATERAL (
        SELECT t."captured_at", t."lat", t."lng"
        FROM "vehicle_telemetries" t
        WHERE t."vehicle_id"  = ${vehicleId}
          AND t."captured_at" >= b.bucket_start
          AND t."captured_at" <  b.bucket_start + make_interval(secs => ${bucketSec}::int)
          AND t."lat" IS NOT NULL AND t."lng" IS NOT NULL
        ORDER BY t."captured_at"
        LIMIT 1
      ) t
    ),
    attributed AS (
      SELECT s.captured_at,
             z.id AS zone_id, z.name AS zone_name, z.type::text AS zone_type,
             z.enforced
      FROM samples s
      LEFT JOIN LATERAL (
        -- NOT filtered by is_active, deliberately. 99 of the 107 fences here
        -- were bulk-imported from Wialon and never switched on, and
        -- lib/zone-presence.ts still reports them — it uses is_active only to
        -- decide whether being inside one is ENFORCED, never whether the
        -- vehicle is inside it. Filtering here would make a backtrack disagree
        -- with the live map about where the same unit was, and would empty the
        -- timeline almost completely: the first draft of this query returned a
        -- single null-zone visit for a fortnight of movement.
        --
        -- The join to fence_area only supplies the sort key. Candidate
        -- selection still runs against the real table so geofences_geom_idx
        -- can drive it — a GiST index cannot be used against a CTE.
        SELECT f."id", f."name", f."type", fa.enforced
        FROM "geofences" f
        JOIN fence_area fa ON fa."id" = f."id"
        WHERE f."organisation_id" = ${orgId}
          AND ST_Intersects(f."geom", ST_SetSRID(ST_MakePoint(s.lng, s.lat), 4326)::geography)
        ORDER BY fa.area_m2
        LIMIT 1
      ) z ON true
    ),
    marked AS (
      SELECT *,
             CASE WHEN zone_id IS DISTINCT FROM lag(zone_id) OVER (ORDER BY captured_at)
                  THEN 1 ELSE 0 END AS is_new_visit
      FROM attributed
    ),
    numbered AS (
      SELECT *, sum(is_new_visit) OVER (ORDER BY captured_at ROWS UNBOUNDED PRECEDING) AS visit_no
      FROM marked
    )
    SELECT zone_id, zone_name, zone_type, bool_or(enforced) AS enforced,
           min(captured_at) AS entered_at,
           max(captured_at) AS left_at,
           count(*)         AS samples
    FROM numbered
    GROUP BY visit_no, zone_id, zone_name, zone_type
    ORDER BY min(captured_at)
  `)

  return rows === null ? null : { rows, bucketSec }
}

export async function findLatest(vehicleId: string, orgId: string) {
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, organisationId: orgId },
    select: { id: true },
  })
  if (!vehicle) return null

  return prisma.vehicleTelemetry.findFirst({
    where: { vehicleId },
    orderBy: { capturedAt: 'desc' },
  })
}

/** Latest telemetry snapshot for every vehicle in an org — powers the initial map render. */
/**
 * How long a vehicle stays flagged after a fuel incident.
 *
 * A FIXED window that clears itself, per the operator (2026-08-16) — no
 * acknowledgement table, no endpoint, no button. 24 hours rather than 12 so an
 * overnight siphon is still red when the day shift arrives, which is the shift
 * that can actually go and look at the machine.
 *
 * The cost of a timer rather than an acknowledgement is that nothing records
 * whether a human saw it, so an incident can expire unnoticed by a shift that
 * was not watching. That is the accepted trade for not building the table
 * tonight, and it is the obvious next increment the first time someone asks
 * "did anyone look at this one".
 */
import { ANNOUNCED_CAUSES, ANNOUNCED_REASON_SLUGS } from '../fuel/fuel-theft-classifier.js'
import { env } from '../../config/env.js'

export const FUEL_INCIDENT_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * The cause reasons, beyond the announced CAUSES, that make an open fuel
 * incident — the red vehicle, the fuel alerts list, the incident window.
 *
 * Since FUEL RATE and FUEL DOWN went to the daily summary (FUEL_RATE_ALERTS,
 * 2026-09-27), none: the fuel alerts are theft cases only (operator: "the fuel
 * alert captures only theft cases and all other cases go into the daily
 * summary"). The rule this file already follows — never tell an operator in
 * colour what we decided not to tell them in words — applied to that change.
 * With FUEL_RATE_ALERTS=live they count again, as they did before it.
 *
 * Shared with the dismissal in fuel.repository, which clears the same set: a
 * dismissed theft must not also dismiss the unit's FUEL RATE / FUEL DOWN rows,
 * which the summary would then leave out.
 */
export function incidentReasonSlugs(): string[] {
  return env.FUEL_RATE_ALERTS === 'live' ? [...ANNOUNCED_REASON_SLUGS] : []
}

/**
 * How far back the card counts REPEATS, as opposed to how far back a vehicle
 * stays red.
 *
 * Deliberately much longer than FUEL_INCIDENT_WINDOW_MS and deliberately a
 * different question. A unit goes red for a day because something happened to
 * it today; it is a repeat offender because of what has happened to it over a
 * month. Kept in step with REPEAT_WINDOW_MS in the adjudication service, which
 * writes the same count into the notification text.
 */
export const FUEL_REPEAT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * A clean slate: nothing that BEGAN before this moment is announced.
 *
 * Set once, on the operator's instruction (2026-08-17), to take the CRITICAL
 * count to zero across both orgs and let the fleet re-flag itself from live
 * events. Two Kasulu drains were open at the time — MUFINDI - DG 12
 * (burn-above-class-ceiling, 02:45Z) and MUFINDI - DZ 20 (burn-far-above-band,
 * 06:04Z); Sukari was already clear.
 *
 * ## Why an epoch and not a delete
 *
 * Deleting the rows would have done neither of the things it looks like it
 * does. `fuel_thefts` is SYNCED from Wialon, and the settle pass re-reads a
 * rotating slice over a 24 h window ending 6 h back with `reconcile` on,
 * CREATING ledger rows for provider events it cannot find — so both drains,
 * which began that same morning, would have been re-created and re-adjudicated
 * within hours and gone red again. It would also have destroyed audit rows
 * that the reports and the fuel ledger still count. See lib/queues/fuel-events.
 *
 * ## Why not an acknowledgement column
 *
 * Because that is a different feature and nobody has asked for it. Clearing
 * ONE incident, with a name and a time against it, needs a column, an endpoint
 * and a button; this is a one-off line under the fleet, and a constant that
 * says so is honest about being exactly that.
 *
 * ## It does not stop anything
 *
 * Only the announcement is suppressed, and only for drains already in the past
 * when the line was drawn. Adjudication, the ledger, the fuel reports and the
 * notification feed are all untouched, and any drain beginning after this
 * moment announces normally — which is the whole point of a fresh start.
 *
 * Removing this constant restores every suppressed incident that is still
 * inside the 24 h window; after 2026-08-18T07:45Z it has no effect at all and
 * can be deleted.
 */
export const FUEL_INCIDENT_EPOCH = new Date('2026-08-17T07:45:00.000Z')

export async function findFleetSnapshot(orgId: string) {
  await warmSpeedPolicy(orgId)
  // The live fleet is every ACTIVE vehicle in the org — the registry synced
  // from the RaiFactorySuite API (sync:vehicles). Vehicles the provider has
  // decommissioned/dropped stay in the DB for history but leave the fleet.
  const vehicles = await prisma.vehicle.findMany({
    where: { organisationId: orgId, isActive: true },
    select: {
      id: true,
      name: true,
      registrationPlate: true,
      vehicleType: true,
      tankCapacityLitres: true,
      // What the machine is, per RaiFactorySuite's register (KASULU only).
      machineName: true,
      // The register's standard burn rate (KASULU only), for the card's
      // "today against standard".
      ratedConsumption: true,
      ratedConsumptionBasis: true,
      // The provider's own unit id — how lib/connection-state is keyed, so the
      // service layer can attach the provider's connection verdict.
      deviceId: true,
      // NEWEST open assignment, not an arbitrary one.
      //
      // `take: 1` with no ordering left Postgres free to return any row, and a
      // vehicle routinely has several open at once: assignments are derived
      // from dispatch history rather than from an assignment endpoint, and a
      // run whose return never landed leaves its link open forever. Measured
      // 2026-08-03 on SUKARI — 19 of the 52 vehicles then out carried more than
      // one, up to four, and some named a different person from the driver on
      // the current run. The dispatch driver overrides this entirely while a
      // run is open (see telemetry.service); this fixes what is shown the rest
      // of the time.
      assignments: {
        where:   { unassignedAt: null },
        orderBy: { assignedAt: 'desc' },
        select:  { user: { select: { fullName: true, driverRatingScore: true } } },
        take:    1,
      },
    },
    orderBy: { name: 'asc' },
  })

  const vehicleIds = vehicles.map(v => v.id)
  if (vehicleIds.length === 0) return []

  // Latest ping per vehicle in ONE query. LATERAL per vehicle (not DISTINCT ON
  // over the whole table): each vehicle walks its (vehicle_id, captured_at)
  // index newest-first and stops at the first row. The `_sim.*` extractions
  // below are legacy simulator extras — live RaiFactorySuite pings simply return
  // NULL for them and the clients degrade gracefully (no journey leg/phase).
  interface PingRow {
    vehicle_id: string
    lat: number | null; lng: number | null; heading_deg: number | null
    speed_kmh: number | null; engine_on: boolean
    fuel_level_ml: number | null; fuel_used_ml: number | null; cargo_weight_kg: number | null
    cargo_desc: string | null
    captured_at: Date; leg: unknown
    odometer_km: number | null; engine_hours: number | null; maintenance: unknown; phase: string | null
    last_moved_at: Date | null
    fuel_probe_fault: boolean | null
    camera_fitted: boolean | null
    camera_stream_url: string | null
    camera_recording: boolean | null
    camera_signal_lost: boolean | null
  }
  const pings = await prisma.$queryRaw<PingRow[]>`
    SELECT p.* FROM unnest(ARRAY[${Prisma.join(vehicleIds)}]::text[]) AS v(id)
    CROSS JOIN LATERAL (
      SELECT
        t.vehicle_id,
        t.lat, t.lng, t.heading_deg, t.speed_kmh, t.engine_on,
        t.fuel_level_ml, t.fuel_used_ml, t.cargo_weight_kg, t.captured_at,
        -- On-board recorder. Real COLUMNS, not a flags-blob extraction like
        -- fuel_probe_fault below: a stream URL is read on every snapshot for
        -- any unit that has one, and digging it out of JSON on each row is
        -- work the column type already does.
        t.camera_fitted, t.camera_stream_url, t.camera_recording, t.camera_signal_lost,
        r.payload->'_sim'->'leg' AS leg,
        r.payload->'_sim'->>'cargoDesc' AS cargo_desc,
        (r.payload->>'odometer_km')::float AS odometer_km,
        (r.payload->>'engine_hours')::float AS engine_hours,
        r.payload->'_sim'->'maintenance' AS maintenance,
        r.payload->'_sim'->>'phase' AS phase,
        -- Why fuel_level_ml is null, when it is: the probe is reporting
        -- outside its calibrated range. Written by the Wialon adapter into
        -- the flags blob; absent (SQL NULL) for every other provider.
        (r.payload->'flags'->>'fuelProbeFault')::boolean AS fuel_probe_fault,
        -- Newest ping with actual movement — powers the "stationary for …"
        -- readout on parked vehicles (same index walk, newest-first, stops at
        -- the first moving row).
        (SELECT t2.captured_at FROM vehicle_telemetries t2
          WHERE t2.vehicle_id = v.id AND t2.speed_kmh > 0
          ORDER BY t2.captured_at DESC
          LIMIT 1) AS last_moved_at
      FROM vehicle_telemetries t
      JOIN vehicle_telemetry_raws r ON r.telemetry_id = t.id
      WHERE t.vehicle_id = v.id
      ORDER BY t.captured_at DESC
      LIMIT 1
    ) p
  `
  const pingByVehicle = new Map(pings.map(p => [p.vehicle_id, p]))

  // ── open fuel incidents ──────────────────────────────────────────────────
  //
  // The dashboard turns a vehicle RED from `flags.fuelInconsistency`, and on
  // live data that flag has never once been set: the Wialon adapter hardcodes
  // it false, because a position payload cannot see a fuel event. The whole
  // red path — marker, pulse, critical count — has been dead since the fleet
  // moved to Wialon. This is what feeds it.
  //
  // Only an ANNOUNCED cause counts, and the set comes from the classifier
  // rather than being named here. A second hardcoded list is a second one that
  // drifts: when UNEXPLAINED_BURN was withdrawn from the feed on 2026-08-17,
  // an inline list here would have kept turning vehicles red for it — telling
  // an operator in colour what we had just decided not to tell them in words.
  //
  // A vehicle does not go red for a drain we decided was ordinary consumption,
  // a probe swing, or one we could not attribute at all.
  //
  // One query for the whole org rather than a LATERAL per vehicle: the window
  // is a day and announced causes are ~3 a day fleet-wide, so this reads a
  // handful of rows off (drain_cause, began_at) and the join is done in
  // memory. DISTINCT ON keeps the newest per vehicle.
  const incidents = await prisma.$queryRaw<Array<{
    vehicle_id: string; id: string; drain_cause: string; cause_reason: string | null
    cause_confidence: number | null; stolen_ml: number; began_at: Date; detected_at: Date
    initial_location: string | null; final_fuel_level_ml: number | null
    initial_fuel_level_ml: number | null
    verdict: string; verdict_reason: string | null; verdict_confidence: number | null
    recovered_ml: number | null
    initial_speed_kmh: number | null; final_speed_kmh: number | null
    review_status: string | null; reviewed_at: Date | null; review_note: string | null
    reviewed_by: string | null
  }>>`
    SELECT DISTINCT ON (t.vehicle_id)
           t.vehicle_id, t.id, t.drain_cause::text AS drain_cause, t.cause_reason,
           t.cause_confidence, t.stolen_ml, t.began_at, t.detected_at,
           t.initial_location, t.final_fuel_level_ml, t.initial_fuel_level_ml,
           t.verdict::text AS verdict, t.verdict_reason, t.verdict_confidence,
           t.recovered_ml, t.initial_speed_kmh, t.final_speed_kmh,
           t.review_status::text AS review_status, t.reviewed_at, t.review_note,
           u.full_name AS reviewed_by
      FROM fuel_thefts t
      LEFT JOIN users u ON u.id = t.reviewed_by_id
     WHERE t.vehicle_id = ANY(${vehicleIds}::text[])
       AND (t.drain_cause::text = ANY(${ANNOUNCED_CAUSES as unknown as string[]}::text[])
         OR t.cause_reason      = ANY(${incidentReasonSlugs()}::text[]))
       AND t.began_at >= ${new Date(Date.now() - FUEL_INCIDENT_WINDOW_MS)}
       -- The clean slate. Both bounds are on began_at, so this is the same
       -- index walk with a tighter floor — no extra cost. See the constant.
       AND t.began_at >= ${FUEL_INCIDENT_EPOCH}
       -- Dismissed from the dashboard by an operator. The row stays (and still
       -- counts in the 30-day history below); it is just no longer announced.
       AND t.dismissed_at IS NULL
     ORDER BY t.vehicle_id, t.began_at DESC`
  // Units already reported for a fuel probe repair (fuel/probe-hold). Their
  // fuel incidents show like any other's (operator, 2026-10-13: "do not put a
  // unit on hold, but we can highlight it was reported"); the flag travels as
  // `probeHold` below so the card and the alert can say it was reported.
  const onHold = await probeHoldVehicleIds(vehicleIds)
  const incidentByVehicle = new Map(incidents.map(i => [i.vehicle_id, i]))

  /**
   * The unit's recent record, for the vehicles that have an open incident.
   *
   * A second query rather than an aggregate bolted onto the one above, because
   * that one is a DISTINCT ON returning the NEWEST row per vehicle and this is
   * a count over ALL of them — different shapes, and fusing them would need a
   * window function over a range this one does not otherwise read.
   *
   * Cheap regardless: it is restricted to the handful of vehicles that already
   * have an incident, and thirty days of announcements across the whole fleet
   * is 22 rows. Empty map when nothing is flagged, which is the usual case.
   *
   * The clean-slate epoch is deliberately NOT applied here. It suppresses the
   * ANNOUNCEMENT of drains from before the line; the ledger, the reports and
   * the notification feed all still count them, and this is a ledger fact. It
   * also has to agree with `getIncidentHistory` in the adjudication service,
   * which writes the same count into the notification text — two numbers
   * describing the same unit must not disagree because one of them respects a
   * one-off display cutoff.
   */
  const flaggedIds = [...incidentByVehicle.keys()]
  const historyByVehicle = new Map<string, { n: number; ml: number; siphons: number; firstAt: Date }>()
  if (flaggedIds.length > 0) {
    const hist = await prisma.$queryRaw<Array<{
      vehicle_id: string; n: bigint; ml: bigint; siphons: bigint; first_at: Date
    }>>`
      SELECT t.vehicle_id,
             count(*)::bigint                     AS n,
             coalesce(sum(t.stolen_ml), 0)::bigint AS ml,
             count(*) FILTER (WHERE t.drain_cause::text = 'SIPHON')::bigint AS siphons,
             min(t.began_at)                      AS first_at
        FROM fuel_thefts t
       WHERE t.vehicle_id = ANY(${flaggedIds}::text[])
         AND t.began_at >= ${new Date(Date.now() - FUEL_REPEAT_WINDOW_MS)}
         AND (t.drain_cause::text = ANY(${ANNOUNCED_CAUSES as unknown as string[]}::text[])
           OR t.cause_reason      = ANY(${ANNOUNCED_REASON_SLUGS as unknown as string[]}::text[]))
       GROUP BY t.vehicle_id`
    for (const h of hist) {
      historyByVehicle.set(h.vehicle_id, {
        n: Number(h.n), ml: Number(h.ml), siphons: Number(h.siphons), firstAt: h.first_at,
      })
    }
  }

  return vehicles.map((v) => {
      const ping            = pingByVehicle.get(v.id)
      const incident        = incidentByVehicle.get(v.id)
      const fuelLevelMl     = ping?.fuel_level_ml ?? null
      // Tank capacity comes from the provider's registry. When it hasn't been
      // provisioned we report NO percentage rather than inventing one against
      // an assumed tank — clients render "—".
      const tankCapacityMl  = v.tankCapacityLitres != null ? v.tankCapacityLitres * 1000 : null
      const fuelLevelPct    = fuelLevelMl != null && tankCapacityMl != null
        ? Math.round((fuelLevelMl / tankCapacityMl) * 100)
        : null
      const lowFuel         = fuelLevelPct != null && fuelLevelPct < 20
      const maintenance = ping?.maintenance as
        { nextServiceOdoKm: number; inMaintenance: boolean; maintenanceEndsAtMs: number | null; resetOdoKm: number; garageLat: number | null; garageLng: number | null } | null | undefined

      return {
        vehicleId:      v.id,
        deviceId:       v.deviceId,
        plate:          v.registrationPlate,
        name:           v.name,
        vehicleType:    v.vehicleType,
        // The limit this unit is actually judged against, resolved by the one
        // function that owns it. Sent so the browser stops carrying its own
        // copy of 80: vehicleMap, playback and two cards each had one, and a
        // per-TYPE limit set here would have left every one of them wrong.
        // A Map lookup on a string parsed once at boot — free.
        // Where the org's limit depends on place (lib/speed-policy), the one
        // at the unit's last fix.
        speedLimitKmh:  overspeedLimitFor(v.vehicleType, { orgId, lat: ping?.lat, lng: ping?.lng }),
        driver:             v.assignments[0]?.user.fullName          ?? null,
        driverRatingScore:  v.assignments[0]?.user.driverRatingScore ?? null,
        lat:            ping?.lat          ?? null,
        lng:            ping?.lng          ?? null,
        headingDeg:     ping?.heading_deg  ?? null,
        speedKmh:       ping?.speed_kmh    ?? null,
        engineOn:       ping?.engine_on    ?? false,
        fuelLevelMl,
        // Capacity travels with the snapshot so the card can render the fuel
        // gauge as "44 / 95 L", not just a bare percentage.
        tankCapacityLitres: v.tankCapacityLitres ?? null,
        // "Excavator", "Bull Dozer" — RaiFactorySuite's machine register name,
        // set on the KASULU units it lists and null everywhere else. The unit
        // card shows it in place of the label it reads off the unit code.
        machineName: v.machineName ?? null,
        // The register's standard burn: L/h when the basis is HOURS, km/L when
        // DISTANCE. Null on every unit the register does not rate, so the
        // card compares only where there is a standard to compare with.
        ratedConsumption:      v.ratedConsumption ?? null,
        ratedConsumptionBasis: v.ratedConsumption != null ? v.ratedConsumptionBasis ?? null : null,
        // Separates "the probe is broken" from "no probe fitted" — both of
        // which leave fuelLevelMl null, and only one of which is a job for
        // the workshop.
        fuelProbeFault: ping?.fuel_probe_fault ?? false,
        // Already reported for a fuel probe repair (fuel/probe-hold). Nothing
        // is held back for it; the card and the alerts say it was reported.
        probeHold: onHold.has(v.id),

        // On-board recorder. `hasCamera` defaults FALSE (no recorder is the
        // overwhelming norm — one unit of 1,496), but the rest stay NULL: a
        // false `recording` would claim the recorder was checked and idle, and
        // for a unit with no camera nothing was checked at all.
        hasCamera:        ping?.camera_fitted ?? false,
        cameraStreamUrl:  ping?.camera_stream_url ?? null,
        cameraRecording:  ping?.camera_recording ?? null,
        cameraSignalLost: ping?.camera_signal_lost ?? null,
        fuelUsedMl:     ping?.fuel_used_ml ?? null,
        cargoWeightKg:  ping?.cargo_weight_kg ?? null,
        cargoDesc:      ping?.cargo_desc ?? null,
        capturedAt:     ping?.captured_at?.toISOString() ?? null,
        // Newest moving ping — clients render "stationary for now − this".
        lastMovedAt:    ping?.last_moved_at?.toISOString() ?? null,
        lowFuel,
        fuelLevelPct,
        leg:            ping?.leg ?? null,
        odometerKm:          ping?.odometer_km ?? null,
        engineHours:         ping?.engine_hours ?? null,
        nextServiceOdoKm:    maintenance?.nextServiceOdoKm ?? null,
        inMaintenance:       maintenance?.inMaintenance ?? false,
        maintenanceEndsAtMs: maintenance?.maintenanceEndsAtMs ?? null,
        maintenanceResetOdoKm: maintenance?.resetOdoKm ?? 0,
        garageLat:      maintenance?.garageLat ?? null,
        garageLng:      maintenance?.garageLng ?? null,
        phase:          ping?.phase ?? null,

        // Everything the card and the map popup need to explain a red vehicle
        // without a second request. Null on the great majority.
        fuelIncident: incident == null ? null : {
          /**
           * The unit's record over the last 30 days, so the incident modal can
           * open with "4th flagged event, 192.7 L in total" rather than making
           * the operator work that out by scrolling the feed. `repeatCount` is
           * 1 on a first event, which is six of the eleven flagged vehicles.
           */
          repeatCount:   historyByVehicle.get(v.id)?.n       ?? 1,
          repeatMl:      historyByVehicle.get(v.id)?.ml      ?? incident.stolen_ml,
          repeatSiphons: historyByVehicle.get(v.id)?.siphons ?? 0,
          repeatSinceAt: historyByVehicle.get(v.id)?.firstAt?.toISOString()
                      ?? incident.began_at.toISOString(),
          id:          incident.id,
          cause:       incident.drain_cause,
          reason:      incident.cause_reason,
          confidence:  incident.cause_confidence,
          volumeMl:    incident.stolen_ml,
          beganAt:     incident.began_at.toISOString(),
          detectedAt:  incident.detected_at.toISOString(),
          location:    incident.initial_location,
          // Both ends of the tank, so the card can state the fall rather than
          // only its size — "205.6 L down to 158.0 L" is checkable against the
          // gauge in a way "47.6 L" is not.
          tankBeforeMl: incident.initial_fuel_level_ml,
          tankAfterMl:  incident.final_fuel_level_ml,
          // Whether this one may be described as a possible theft. Derived
          // HERE from the cause rather than left to the client, so a second
          // implementation of the vocabulary rule cannot drift from the
          // server's — the same reasoning that keeps `confirmed` derived from
          // `verdictReason`. See modules/fuel/fuel-theft-classifier.
          mayUseTheftWording: incident.drain_cause === 'SIPHON',

          // ── how the verdict was reached, not just what it was ────────────
          //
          // The cause answers "why did the fuel leave". These answer "how do
          // we know", which is a different question and the one an operator
          // asks second. `verdictReason` names the rule that settled whether
          // the fuel left AT ALL, `recoveredMl` says how much came back
          // before we decided it had not, and `confirmed` says whether our own
          // telemetry watched it or we are relaying the provider.
          verdict:           incident.verdict,
          verdictReason:     incident.verdict_reason,
          verdictConfidence: incident.verdict_confidence,
          recoveredMl:       incident.recovered_ml,
          // Derived here for the same reason mayUseTheftWording is: the set of
          // reasons that mean "we watched this ourselves" is the server's to
          // define, and a copy in the client is a copy that drifts.
          confirmed: incident.verdict_reason === 'level-stayed-down'
                  || incident.verdict_reason === 'level-recovered',
          speedAtStart: incident.initial_speed_kmh,
          speedAtEnd:   incident.final_speed_kmh,
          // An administrator's escalation or de-escalation, made from the
          // incident window (fuel.service reviewTheft). Null until someone
          // decides. A live alert is never DISMISSED/UNDER_REVIEW: those
          // belong to deleted alerts, which this query excludes.
          review: incident.review_status == null ? null : {
            status: incident.review_status,
            at:     incident.reviewed_at?.toISOString() ?? null,
            by:     incident.reviewed_by,
            note:   incident.review_note,
          },
        },
      }
    })
}

export async function findGeofencesForVehicle(vehicleId: string) {
  return prisma.vehicleGeofence.findMany({
    where: { vehicleId },
    include: { geofence: true },
  })
}

/** Per-vehicle, per-alertType incident counts over the last 90 days.
 *  Only the four types that feed the driver rating are fetched. */
export async function findAlertHistoryCounts(orgId: string) {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)

  const rows = await prisma.vehicleAlert.findMany({
    where: {
      organisationId: orgId,
      type: { in: ['overspeeding', 'lowFuel', 'outsideGeofence', 'fuelInconsistency'] },
      triggeredAt: { gte: since },
      meta: { path: ['source'], equals: ALERT_SOURCE },
    },
    select: { vehicleId: true, type: true },
  })

  const counts: Record<string, Record<string, number>> = {}
  for (const { vehicleId, type } of rows) {
    if (!counts[vehicleId]) counts[vehicleId] = {}
    counts[vehicleId][type] = (counts[vehicleId][type] ?? 0) + 1
  }

  return Object.entries(counts).flatMap(([vehicleId, types]) =>
    Object.entries(types).map(([alertType, count]) => ({ vehicleId, alertType, count }))
  )
}

interface MaintenanceHistoryRow {
  day: Date
  trip_count: bigint
  distance_km: number
  avg_speed_kmh: number
  fuel_consumed_ml: number
  overspeeding_count: bigint
  fuel_inconsistency_count: bigint
}

/** Daily-bucketed, org-wide history for `days` days ending on `to` (default:
 *  today, i.e. the last 14 days) — real trip and alert activity (not a
 *  snapshot), used by the fleet Maintenance page's historical charts and its
 *  calendar-driven range/single-day selection. Every metric here is a
 *  genuine driver of wear-and-tear (distance, speed, overspeeding,
 *  fuel-system incidents), so it reads as maintenance-relevant history
 *  rather than an arbitrary trip report.
 *  Missing days are filled with zeros (generate_series), not skipped, so a
 *  day with no activity still plots as a real zero rather than a gap. */
export async function findMaintenanceHistory(orgId: string, days = 14, to: Date = new Date()) {
  const rows = await prisma.$queryRaw<MaintenanceHistoryRow[]>`
    WITH bounds AS (
      SELECT date_trunc('day', ${to}::timestamp) AS end_day,
             date_trunc('day', ${to}::timestamp) - (${days}::int - 1) * interval '1 day' AS start_day
    ),
    day_series AS (
      SELECT generate_series((SELECT start_day FROM bounds), (SELECT end_day FROM bounds), interval '1 day') AS day
    ),
    trip_agg AS (
      SELECT date_trunc('day', t.began_at) AS day,
             count(*)                       AS trip_count,
             sum(t.mileage_km)              AS distance_km,
             avg(t.avg_speed_kmh)           AS avg_speed_kmh,
             sum(t.consumed_ml)             AS fuel_consumed_ml
      FROM trips t
      JOIN vehicles v ON v.id = t.vehicle_id
      WHERE v.organisation_id = ${orgId}
        AND t.began_at >= (SELECT start_day FROM bounds)
        AND t.began_at <  (SELECT end_day FROM bounds) + interval '1 day'
      GROUP BY 1
    ),
    alert_agg AS (
      SELECT date_trunc('day', a.triggered_at) AS day,
             count(*) FILTER (WHERE a.type = 'overspeeding')      AS overspeeding_count,
             count(*) FILTER (WHERE a.type = 'fuelInconsistency') AS fuel_inconsistency_count
      FROM vehicle_alerts a
      WHERE a.organisation_id = ${orgId}
        AND a.type IN ('overspeeding', 'fuelInconsistency')
        AND a.triggered_at >= (SELECT start_day FROM bounds)
        AND a.triggered_at <  (SELECT end_day FROM bounds) + interval '1 day'
        AND a.meta->>'source' = ${ALERT_SOURCE}
      GROUP BY 1
    )
    SELECT
      d.day,
      COALESCE(ta.trip_count, 0)               AS trip_count,
      COALESCE(ta.distance_km, 0)               AS distance_km,
      COALESCE(ta.avg_speed_kmh, 0)              AS avg_speed_kmh,
      COALESCE(ta.fuel_consumed_ml, 0)           AS fuel_consumed_ml,
      COALESCE(aa.overspeeding_count, 0)         AS overspeeding_count,
      COALESCE(aa.fuel_inconsistency_count, 0)   AS fuel_inconsistency_count
    FROM day_series d
    LEFT JOIN trip_agg  ta ON ta.day = d.day
    LEFT JOIN alert_agg aa ON aa.day = d.day
    ORDER BY d.day
  `

  return rows.map(r => ({
    day:                    r.day.toISOString().slice(0, 10),
    tripCount:              Number(r.trip_count),
    distanceKm:             Math.round(Number(r.distance_km)),
    avgSpeedKmh:            Math.round(Number(r.avg_speed_kmh) * 10) / 10,
    fuelConsumedL:          Math.round(Number(r.fuel_consumed_ml) / 100) / 10,
    overspeedingCount:      Number(r.overspeeding_count),
    fuelInconsistencyCount: Number(r.fuel_inconsistency_count),
  }))
}

/** Real, persisted service history for one vehicle — one row per completed
 *  MAINTENANCE-phase service (see simulation.persistence.ts), newest first.
 *  Powers the Maintenance page's per-vehicle service-history report. */
export async function findVehicleServiceHistory(orgId: string, vehicleId: string) {
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, organisationId: orgId },
    select: { id: true },
  })
  if (!vehicle) return null

  const records = await prisma.vehicleServiceRecord.findMany({
    where: { vehicleId },
    orderBy: { servicedAt: 'desc' },
  })

  return records.map(r => ({
    id:                   r.id,
    servicedAt:           r.servicedAt.toISOString(),
    odometerKm:           r.odometerKm,
    previousServiceOdoKm: r.previousServiceOdoKm,
    nextServiceOdoKm:     r.nextServiceOdoKm,
    kmCovered:            r.previousServiceOdoKm != null ? r.odometerKm - r.previousServiceOdoKm : null,
  }))
}

/** Real, persisted garage-visit history for one vehicle — one row per time
 *  the vehicle was redirected to a third-party garage because its service
 *  came due while out on the road (see the simulator's TO_GARAGE/AT_GARAGE
 *  phases + simulation.persistence.ts), newest first. */
export async function findVehicleGarageVisits(orgId: string, vehicleId: string) {
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, organisationId: orgId },
    select: { id: true },
  })
  if (!vehicle) return null

  const visits = await prisma.vehicleGarageVisit.findMany({
    where: { vehicleId },
    orderBy: { enteredAt: 'desc' },
  })

  return visits.map(v => ({
    id:              v.id,
    garageName:      v.garageName,
    garageLat:       v.garageLat,
    garageLng:       v.garageLng,
    enteredAt:       v.enteredAt.toISOString(),
    exitedAt:        v.exitedAt.toISOString(),
    durationMinutes: v.durationMinutes,
    odometerKm:      v.odometerKm,
    severityScore:   v.severityScore,
    itemsFixed:      v.itemsFixed as { name: string; replaced: boolean }[],
  }))
}

export interface OrgVehicleMaintenance {
  /** Every vehicle id in the org — membership check for the per-vehicle endpoints. */
  vehicleIds: string[]
  services:   Record<string, ReturnType<typeof mapServiceRecord>[]>
  visits:     Record<string, ReturnType<typeof mapGarageVisit>[]>
}

const mapServiceRecord = (r: { id: string; servicedAt: Date; odometerKm: number; previousServiceOdoKm: number | null; nextServiceOdoKm: number | null }) => ({
  id:                   r.id,
  servicedAt:           r.servicedAt.toISOString(),
  odometerKm:           r.odometerKm,
  previousServiceOdoKm: r.previousServiceOdoKm,
  nextServiceOdoKm:     r.nextServiceOdoKm,
  kmCovered:            r.previousServiceOdoKm != null ? r.odometerKm - r.previousServiceOdoKm : null,
})

const mapGarageVisit = (v: { id: string; garageName: string; garageLat: number; garageLng: number; enteredAt: Date; exitedAt: Date; durationMinutes: number; odometerKm: number; severityScore: number; itemsFixed: unknown }) => ({
  id:              v.id,
  garageName:      v.garageName,
  garageLat:       v.garageLat,
  garageLng:       v.garageLng,
  enteredAt:       v.enteredAt.toISOString(),
  exitedAt:        v.exitedAt.toISOString(),
  durationMinutes: v.durationMinutes,
  odometerKm:      v.odometerKm,
  severityScore:   v.severityScore,
  itemsFixed:      v.itemsFixed as { name: string; replaced: boolean }[],
})

/** Service history + garage visits for EVERY vehicle in the org, grouped by
 *  vehicle — the batched source the maintenance cache warms so the per-vehicle
 *  endpoints (rows shaped exactly like findVehicleServiceHistory /
 *  findVehicleGarageVisits, newest first) never wait on the remote DB. */
export async function findOrgVehicleMaintenance(orgId: string): Promise<OrgVehicleMaintenance> {
  const [vehicles, serviceRecords, garageVisits] = await Promise.all([
    prisma.vehicle.findMany({ where: { organisationId: orgId }, select: { id: true } }),
    prisma.vehicleServiceRecord.findMany({
      where:   { vehicle: { organisationId: orgId } },
      orderBy: { servicedAt: 'desc' },
    }),
    prisma.vehicleGarageVisit.findMany({
      where:   { vehicle: { organisationId: orgId } },
      orderBy: { enteredAt: 'desc' },
    }),
  ])

  const services: OrgVehicleMaintenance['services'] = {}
  for (const r of serviceRecords) (services[r.vehicleId] ??= []).push(mapServiceRecord(r))
  const visits: OrgVehicleMaintenance['visits'] = {}
  for (const v of garageVisits) (visits[v.vehicleId] ??= []).push(mapGarageVisit(v))

  return { vehicleIds: vehicles.map(v => v.id), services, visits }
}

/** All currently-open (unresolved) alerts for an org — used to seed the
 *  Operations feed on page load so critical state survives a browser refresh. */
export async function findActiveAlerts(orgId: string) {
  const rows = await prisma.vehicleAlert.findMany({
    // Scope to THIS server's alerts (meta.source) so the feed ignores any
    // competing writer's alerts on the shared DB. A freshly-parked fleet raises
    // none, so the feed starts empty until operations begin.
    where: { organisationId: orgId, resolvedAt: null, meta: { path: ['source'], equals: ALERT_SOURCE } },
    include: {
      vehicle: { select: { name: true, registrationPlate: true } },
    },
    orderBy: { triggeredAt: 'desc' },
  })
  return rows.map(r => ({
    id:          r.id,
    alertType:   r.type,
    severity:    r.severity,
    title:       r.message,
    vehicleId:   r.vehicleId,
    vehicleName: r.vehicle.name,
    plate:       r.vehicle.registrationPlate,
    lat:         r.lat,
    lng:         r.lng,
    speedKmh:    r.speedKmh,
    fuelLevelMl: r.fuelLevelMl,
    triggeredAt: r.triggeredAt.toISOString(),
  }))
}
