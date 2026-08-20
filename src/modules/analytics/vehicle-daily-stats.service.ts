/**
 * The daily rollup behind the probe report and the idle ratio.
 *
 * ## Why the report cannot just aggregate telemetry
 *
 * It used to. One query grouped thirty days of `vehicle_telemetries` by
 * vehicle, and it cost 10.4 s of the report's 14.3 s build.
 *
 * The tempting fix — a covering index on `(vehicle_id, captured_at)` — does not
 * work here, and the reason is worth writing down so nobody reaches for it
 * again. A retention policy holds the telemetry table at about thirty days, so
 * the report's own window covers effectively ALL of it: measured 2026-08-20,
 * 134 rows of 9,225,230 fell outside, and `EXPLAIN` reported `Rows Removed by
 * Filter: 45`. There is no selectivity for an index to exploit. The scan has to
 * touch every row, and the only question is how many bytes that costs —
 * 176,073 blocks read against 8,731 cached, 1,375 MB pulled through an 88 MB
 * `shared_buffers`, 21 s of I/O wait across three workers. A covering index
 * would have moved perhaps a quarter of those bytes, in exchange for 1.1 GB of
 * storage and an extra write on each of the ~400 k daily inserts, and it would
 * have grown along with the fleet.
 *
 * A rollup removes the scan instead of making it cheaper. One row per vehicle
 * per day is ~8,500 rows for the whole window, and it does not grow when the
 * trackers report more often.
 *
 * ## Why the figures survive being split by day
 *
 * Every one of them is decomposable: `pings` and `levelPings` sum, `peakMl`,
 * `lastAliveAt` and `lastLevelAt` take a max. Summing thirty daily rows gives
 * bit-for-bit what grouping thirty days of frames gave. That is what makes this
 * a rollup rather than an approximation, and it is why the report's thresholds
 * did not have to move.
 *
 * ## Today is deliberately absent
 *
 * A day still running has no final count, and the report needs today's numbers
 * to be current rather than as of the last sweep. So the job records COMPLETE
 * days only and the report adds today live — one day of frames instead of
 * thirty.
 */

import { Prisma } from '../../../generated/prisma/client.js'
import { prisma } from '../../lib/prisma.js'
import { fleetDayStart, fleetDayKey } from '../../lib/provider-time.js'
import { REACH_METRES, DIG_SPEED_KMH, MAX_GAP_SECONDS, MIN_DIG_FIXES, SNAP_DEGREES } from './excavator-area.service.js'
import { logger } from '../../lib/logger.js'

/** What one day's aggregate looks like, before it is stored or added to. */
export interface VehicleDayFigures {
  vehicleId:   string
  pings:       number
  levelPings:  number
  peakMl:      number | null
  lastAliveAt: Date | null
  lastLevelAt: Date | null
  /** Fixes with the engine running — the idle ratio's denominator. */
  engineFixes: number
  /** Of those, the ones the unit was not moving for. */
  idleFixes:   number
}

/**
 * Speed at or below which a running engine counts as idling rather than
 * working. Two km/h — walking pace — because GPS jitter on a stationary machine
 * reads a km/h or so and a machine creeping at 1 km/h is not travelling.
 *
 * Defined here, beside the query that writes the stored counts, because the
 * history and the live read of today must count the same thing. Moving it makes
 * the two disagree until the backfill is re-run.
 */
export const IDLE_SPEED_KMH = 2

/**
 * Aggregate one fleet day of frames, per vehicle.
 *
 * Shared by the nightly job and by the report's live read of today, so the two
 * can never drift into computing the same figure two different ways.
 *
 * `orgId` narrows it for the live path, which only ever wants one org's units;
 * the job passes nothing and does the whole fleet in one pass.
 */
export async function vehicleFiguresForDay(
  dayStart: Date, dayEnd: Date, orgId?: string,
): Promise<VehicleDayFigures[]> {
  // Narrowing to an org needs the join; the job wants every unit and should not
  // pay for one. Built as a fragment so the org id stays a bound parameter.
  const scope = orgId
    ? Prisma.sql`JOIN vehicles v ON v.id = t.vehicle_id
                  AND v.is_active AND v.organisation_id = ${orgId}`
    : Prisma.empty

  const rows = await prisma.$queryRaw<Array<{
    vehicle_id: string; pings: bigint; level_pings: bigint
    peak_ml: number | null; last_alive_at: Date | null; last_level_at: Date | null
    engine_fixes: bigint; idle_fixes: bigint
  }>>`
    SELECT t.vehicle_id,
           count(*)               AS pings,
           count(t.fuel_level_ml) AS level_pings,
           max(t.fuel_level_ml)   AS peak_ml,
           -- ABOVE zero: a probe pinned at a flat zero is reporting and is also
           -- broken, and the report's DIED state depends on telling those apart.
           max(t.captured_at) FILTER (WHERE t.fuel_level_ml > 0)         AS last_alive_at,
           max(t.captured_at) FILTER (WHERE t.fuel_level_ml IS NOT NULL) AS last_level_at,
           -- The idle ratio's two counts, from the same frames.
           count(*) FILTER (WHERE t.engine_on = true) AS engine_fixes,
           count(*) FILTER (WHERE t.engine_on = true
                              AND coalesce(t.speed_kmh, 0) <= ${IDLE_SPEED_KMH}) AS idle_fixes
      FROM vehicle_telemetries t
      ${scope}
     WHERE t.captured_at >= ${dayStart}
       AND t.captured_at <  ${dayEnd}
     GROUP BY 1`

  return rows.map(r => ({
    vehicleId:   r.vehicle_id,
    pings:       Number(r.pings),
    levelPings:  Number(r.level_pings),
    peakMl:      r.peak_ml,
    lastAliveAt: r.last_alive_at,
    lastLevelAt: r.last_level_at,
    engineFixes: Number(r.engine_fixes),
    idleFixes:   Number(r.idle_fixes),
  }))
}

/**
 * Record one complete fleet day.
 *
 * Replace-the-day rather than per-row upsert. Three hundred round trips inside
 * one transaction is the shape that hit P2028 on the sensor sync — the
 * transaction outran its five-second budget — and this instance has under
 * 300 MB free. Two statements do the same work, and re-running a day repairs it
 * rather than doubling it, which is what makes the backfill safe to retry and
 * lets the job catch up a day it missed.
 */
/**
 * One excavator's worked ground for one day.
 *
 * Per vehicle, deliberately. The all-machines-at-once form scanned the whole
 * day's telemetry joined to the plate filter, and measured 2026-08-20 a plain
 * count over those rows — no geometry whatsoever — could not finish inside
 * 45 s. Per vehicle the `(vehicle_id, captured_at)` index gives one contiguous
 * range, which is about 19 s for the busiest machine: too slow for a request,
 * fine for a nightly job, and each call stays well inside the 60 s client
 * timeout that the combined query kept breaching.
 *
 * Positions are snapped and deduplicated before the union. A digging machine
 * holds one spot for hours — MUFINDI - EX 29 sent 12,371 frames on 2026-08-18
 * from 954 distinct half-metre positions — and identical points add nothing to
 * a union.
 */
async function excavatorDay(
  vehicleId: string, dayStart: Date, dayEnd: Date,
): Promise<{ areaM2: number; digSeconds: number; digFixes: number } | null> {
  const rows = await prisma.$queryRaw<Array<{
    area_m2: number | null; dig_seconds: number; dig_fixes: bigint
  }>>`
    WITH dig AS (
      SELECT t.lat, t.lng,
             EXTRACT(EPOCH FROM (t.captured_at - lag(t.captured_at) OVER (
               ORDER BY t.captured_at))) AS gap
        FROM vehicle_telemetries t
       WHERE t.vehicle_id = ${vehicleId}
         AND t.captured_at >= ${dayStart}
         AND t.captured_at <  ${dayEnd}
         AND t.lat IS NOT NULL AND t.lng IS NOT NULL
         AND NOT (t.lat = 0 AND t.lng = 0)
         AND t.engine_on = true
         AND coalesce(t.speed_kmh, 0) <= ${DIG_SPEED_KMH}
    ),
    pos AS (
      SELECT DISTINCT ST_SnapToGrid(ST_MakePoint(lng, lat), ${SNAP_DEGREES}) AS pt FROM dig
    )
    SELECT (SELECT ST_Area(ST_Union(
              ST_Buffer(pt::geography, ${REACH_METRES})::geometry
            )::geography) FROM pos) AS area_m2,
           coalesce(sum(least(gap, ${MAX_GAP_SECONDS})) FILTER (WHERE gap > 0), 0)::float8 AS dig_seconds,
           count(*)::bigint AS dig_fixes
      FROM dig`

  const r = rows[0]
  if (!r || Number(r.dig_fixes) < MIN_DIG_FIXES || r.area_m2 == null) return null
  return {
    areaM2:     Math.round(r.area_m2),
    digSeconds: Math.round(r.dig_seconds),
    digFixes:   Number(r.dig_fixes),
  }
}

export async function recordVehicleDailyStats(inDay: Date): Promise<{ day: string; written: number; withArea: number }> {
  const dayStart = fleetDayStart(inDay)
  const dayEnd   = new Date(dayStart.getTime() + 86_400_000)
  const day      = fleetDayKey(dayStart)

  const figures = await vehicleFiguresForDay(dayStart, dayEnd)

  await prisma.vehicleDailyStat.deleteMany({ where: { day } })
  if (figures.length > 0) {
    await prisma.vehicleDailyStat.createMany({
      data: figures.map(f => ({
        vehicleId: f.vehicleId, day,
        pings: f.pings, levelPings: f.levelPings, peakMl: f.peakMl,
        lastAliveAt: f.lastAliveAt, lastLevelAt: f.lastLevelAt,
        engineFixes: f.engineFixes, idleFixes: f.idleFixes,
      })),
      // A vehicle deleted between the aggregate and the write would otherwise
      // fail the whole day on a foreign key.
      skipDuplicates: true,
    })
  }

  // Excavator worked-area, one machine at a time. Sequential on purpose: each
  // of these reads and unions a day of a machine's digging, and running them
  // together is what put this on a 1 GB instance's memory ceiling.
  const excavators = await prisma.vehicle.findMany({
    where:  { isActive: true, registrationPlate: { contains: 'EX ' } },
    select: { id: true },
  })

  let withArea = 0
  for (const v of excavators) {
    try {
      const dug = await excavatorDay(v.id, dayStart, dayEnd)
      if (!dug) continue
      await prisma.vehicleDailyStat.updateMany({
        where: { vehicleId: v.id, day },
        data:  { digAreaM2: dug.areaM2, digSeconds: dug.digSeconds },
      })
      withArea++
    } catch (err) {
      // One machine's geometry failing must not cost the whole day's rollup.
      logger.warn({ err, vehicleId: v.id }, 'excavator area failed for one unit')
    }
  }

  const out = { day: day.toISOString().slice(0, 10), written: figures.length, withArea }
  logger.info(out, 'vehicle daily stats recorded')
  return out
}
