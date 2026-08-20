/**
 * The ground an excavator actually worked over, in square metres, and the hours
 * it spent doing it.
 *
 * ## Why the obvious geometries fail
 *
 * Swath × distance is the earthmoving standard and is meaningless here: an
 * excavator covers 0.55 km per engine hour against a road vehicle's 29. It does
 * not travel over the ground it works, it sits on it.
 *
 * A convex hull of the day's fixes fails differently and more convincingly.
 * Tried against KASULU on 2026-08-19 it gave `MUFINDI: EX 17` 18.5 million m²
 * across a 9.8 km span — the machine had been floated between two sites and the
 * hull spanned both, counting the road between them as worked ground. A hull
 * cannot tell "worked all of this" from "worked at either end of it".
 *
 * ## What this measures instead
 *
 * The machine's own working footprint: a circle of REACH_METRES at every fix
 * where it was digging, unioned. That is the ground the bucket could have
 * touched, and it is the shape of the work rather than the shape of the day's
 * travel. Two spots 10 km apart contribute two small discs, not the corridor
 * between them.
 *
 * Digging means engine on and speed at or below DIG_SPEED_KMH — tramming
 * between faces is excluded, which is the same distinction that keeps the hull
 * honest.
 *
 * ## What it is not
 *
 * An upper bound on ground touched, not a survey. It assumes the machine could
 * reach anywhere within REACH_METRES of where it stood, which is true of its
 * arm and not necessarily true of its work — a machine trenching in a line
 * sweeps far less than the discs suggest. It is the right figure for "how much
 * ground did this unit range over", and the wrong one for billing.
 */

import { prisma } from '../../lib/prisma.js'
import { fleetDayStart } from '../../lib/provider-time.js'

/**
 * The excavator's working reach, metres — supplied by the operator, 2026-08-20.
 *
 * One number for the class rather than per machine, which is what makes this
 * computable at all: `vehicles.model` is empty on all 218 units, so there is no
 * per-model figure to look up. Changing it rescales every area here, so it is a
 * named constant and not a literal inside the query.
 */
export const REACH_METRES = 8

/** At or below this the machine is digging, not tramming between faces. */
export const DIG_SPEED_KMH = 2

/** Longest gap between fixes that still counts as continuous work — matches
 *  the rollup's cap so these hours are the same measure as every other. */
const MAX_GAP_SECONDS = 900

/** Fixes below which a day's geometry is too thin to report. */
const MIN_DIG_FIXES = 20

export interface ExcavatorDay {
  vehicleId: string
  plate:     string
  /** Ground the bucket could have touched, square metres. */
  areaM2:    number
  /** Hours the machine spent digging over that ground. */
  digHours:  number
  /** Fixes behind the geometry — the measurement's own sample size. */
  digFixes:  number
  /** Square metres per digging hour. The rate, which is what makes two days
   *  comparable when they are different lengths. */
  m2PerHour: number
}

/**
 * One fleet day of excavator work.
 *
 * Defaults to the last COMPLETE day rather than today: the figure is a day's
 * output, and a day four hours old reports a quarter of one while looking like
 * a full result.
 */
export async function excavatorAreaByDay(
  orgId: string, day?: Date,
): Promise<{ day: string; reachMetres: number; units: ExcavatorDay[]; totalM2: number }> {
  const start = day ?? new Date(fleetDayStart().getTime() - 24 * 3_600_000)
  const end   = new Date(start.getTime() + 24 * 3_600_000)

  const rows = await prisma.$queryRaw<Array<{
    vehicle_id: string; plate: string; area_m2: number; dig_seconds: number; dig_fixes: bigint
  }>>`
    WITH dig AS (
      SELECT t.vehicle_id,
             v.registration_plate AS plate,
             t.lat, t.lng,
             EXTRACT(EPOCH FROM (t.captured_at - lag(t.captured_at) OVER (
               PARTITION BY t.vehicle_id ORDER BY t.captured_at))) AS gap
        FROM vehicle_telemetries t
        JOIN vehicles v ON v.id = t.vehicle_id
       WHERE v.organisation_id = ${orgId}
         AND v.is_active
         AND v.registration_plate LIKE '%EX %'
         AND t.captured_at >= ${start}
         AND t.captured_at <  ${end}
         AND t.lat IS NOT NULL AND t.lng IS NOT NULL
         AND NOT (t.lat = 0 AND t.lng = 0)
         AND t.engine_on = true
         AND coalesce(t.speed_kmh, 0) <= ${DIG_SPEED_KMH}
    )
    SELECT vehicle_id,
           min(plate) AS plate,
           -- The union of the machine's reach at every place it dug.
           ST_Area(ST_Union(
             ST_Buffer(ST_MakePoint(lng, lat)::geography, ${REACH_METRES})::geometry
           )::geography) AS area_m2,
           -- Integrated, never a fix count times an assumed interval: the
           -- sampling runs p50 28 s but p99 905 s, so any single interval is
           -- wrong for most units and gave 103 hours inside a 24-hour day.
           coalesce(sum(least(gap, ${MAX_GAP_SECONDS})) FILTER (WHERE gap > 0), 0)::float8 AS dig_seconds,
           count(*)::bigint AS dig_fixes
      FROM dig
     GROUP BY vehicle_id
    HAVING count(*) >= ${MIN_DIG_FIXES}
     ORDER BY 3 DESC`

  const units: ExcavatorDay[] = rows.map((r) => {
    const digHours = Math.round((r.dig_seconds / 3600) * 10) / 10
    const areaM2   = Math.round(r.area_m2)
    return {
      vehicleId: r.vehicle_id,
      plate:     r.plate,
      areaM2,
      digHours,
      digFixes:  Number(r.dig_fixes),
      m2PerHour: digHours > 0 ? Math.round(areaM2 / digHours) : 0,
    }
  })

  return {
    day: start.toISOString(),
    reachMetres: REACH_METRES,
    units,
    totalM2: units.reduce((a, u) => a + u.areaM2, 0),
  }
}

/**
 * How long a built day stays fresh.
 *
 * An hour, and generous at that: the default day is already complete, so its
 * answer cannot change. The TTL exists because the union of several thousand
 * buffers costs about eleven seconds, not because the data moves.
 */
const CACHE_TTL_MS = 60 * 60_000

const cache    = new Map<string, { at: number; data: Awaited<ReturnType<typeof excavatorAreaByDay>> }>()
const inflight = new Map<string, Promise<Awaited<ReturnType<typeof excavatorAreaByDay>>>>()

export async function getExcavatorArea(orgId: string, day?: Date) {
  const key = `${orgId}:${day ? day.toISOString().slice(0, 10) : 'last'}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data

  const running = inflight.get(key)
  if (running) return running

  const p = excavatorAreaByDay(orgId, day)
    .then((built) => { cache.set(key, { at: Date.now(), data: built }); return built })
    .finally(() => { inflight.delete(key) })
  inflight.set(key, p)
  return p
}
