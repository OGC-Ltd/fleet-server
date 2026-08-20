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
import { createWarmCache } from '../../lib/warm-cache.js'
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

/**
 * Grid the digging positions are snapped to before they are deduplicated, in
 * degrees. 5e-6 deg is about 0.55 m at this latitude.
 *
 * Sized against REACH_METRES rather than against GPS accuracy: the question is
 * how far the snapped disc sits from the true one, and half a metre of centre
 * shift on an eight-metre radius is under a tenth of the reach.
 */
const SNAP_DEGREES = 0.000005

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
    ),
    -- Distinct DIGGING POSITIONS, and the per-vehicle totals, separately.
    --
    -- The union has to see each place the machine stood, not each frame it sent
    -- while standing there. An excavator holds one spot for hours: MUFINDI - EX
    -- 29 sent 12,371 digging frames on 2026-08-18, and buffering every one of
    -- them built twelve thousand 33-vertex polygons to merge pairwise for a
    -- single machine. Identical positions contribute nothing to a union, so
    -- collapsing them first is free area and a far smaller computation.
    --
    -- Snapped to about half a metre before the DISTINCT, because raw GPS jitter
    -- means a stationary machine never reports the exact same pair twice. Half
    -- a metre against an eight-metre reach is well inside what this figure
    -- already claims — an upper bound on ground the bucket could reach, not a
    -- survey.
    pos AS (
      SELECT DISTINCT vehicle_id,
             ST_SnapToGrid(ST_MakePoint(lng, lat), ${SNAP_DEGREES}) AS pt
        FROM dig
    ),
    -- Counted over every frame, not over the distinct positions: these are
    -- measurements of time and sampling, and deduplicating them would be wrong.
    tot AS (
      SELECT vehicle_id,
             min(plate) AS plate,
             coalesce(sum(least(gap, ${MAX_GAP_SECONDS})) FILTER (WHERE gap > 0), 0)::float8 AS dig_seconds,
             count(*)::bigint AS dig_fixes
        FROM dig GROUP BY vehicle_id
    ),
    area AS (
      SELECT vehicle_id,
             ST_Area(ST_Union(
               ST_Buffer(pt::geography, ${REACH_METRES})::geometry
             )::geography) AS area_m2
        FROM pos GROUP BY vehicle_id
    )
    SELECT tot.vehicle_id,
           tot.plate,
           area.area_m2,
           tot.dig_seconds,
           tot.dig_fixes
      FROM tot JOIN area ON area.vehicle_id = tot.vehicle_id
     WHERE tot.dig_fixes >= ${MIN_DIG_FIXES}
     ORDER BY area.area_m2 DESC`

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
 * Served from the warmer.
 *
 * An hour between rebuilds, and generous at that: the default day is already
 * complete, so its answer cannot change. The interval exists because the union
 * of several thousand reach buffers costs seven to eleven seconds, not because
 * the data moves.
 *
 * Only the default day is warmed. A named past day is asked for occasionally,
 * is equally immutable once built, and enters the cache on first use — warming
 * every date anyone had ever picked would have the sweep rebuilding history
 * nobody is looking at.
 */
const AREA_REFRESH_MS = 60 * 60_000

const areaCache = createWarmCache<Awaited<ReturnType<typeof excavatorAreaByDay>>>({
  name: 'excavator-area',
  refreshMs: AREA_REFRESH_MS,
  warmKeysFor: (orgId) => [`${orgId}|last`],
  compute: (key) => {
    const sep = key.lastIndexOf('|')
    const day = key.slice(sep + 1)
    return excavatorAreaByDay(key.slice(0, sep), day === 'last' ? undefined : new Date(day))
  },
})

export async function getExcavatorArea(orgId: string, day?: Date) {
  return areaCache.get(`${orgId}|${day ? day.toISOString().slice(0, 10) : 'last'}`)
}
