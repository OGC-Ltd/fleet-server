/**
 * Ground a bulldozer's blade has passed over, for one machine for one day.
 *
 * ## Why the excavator method does not transfer
 *
 * `excavator-area.service` buffers DISTINCT SNAPPED POINTS by an 8 m reach
 * radius, which is right for a machine that plants itself and slews: the arm
 * sweeps a disc around a stationary body, so the body's position is the thing
 * to buffer.
 *
 * A dozer travels. It covers 1.27 km per engine hour, so at roughly 0.35 m/s
 * and a 28 s median sampling interval its consecutive fixes sit about ten
 * metres apart. Buffering those points by a blade half-width of 1.5 m would
 * produce a string of disconnected three-metre discs with seven-metre holes
 * between them — an under-count that looks like a measurement.
 *
 * So the SEGMENT between consecutive fixes is buffered instead, which is the
 * swath the blade actually cut on the way. Same union, same geography, opposite
 * primitive.
 *
 * ## The blade
 *
 * 3.0 m wide, buffered at half that. This is the operator's own instruction of
 * 2026-08-26 — take a medium excavator's dozer blade and use that width —
 * rather than a figure derived from telemetry, which carries no blade
 * dimension. A machine fitted with a wider blade under-reports here, and one
 * with a narrower blade over-reports, and both are proportional: the number
 * scales linearly with BLADE_WIDTH_M and can be restated if a real inventory
 * of blades ever appears.
 *
 * ## This is an UPPER BOUND, and must be labelled as one
 *
 * Every reason the excavator figure carries that caveat applies here and one
 * more does too:
 *
 * - Ground pushed over twice counts once, which is right, but ground the dozer
 *   crossed while NOT cutting — tramming between cuts, reversing for another
 *   pass — is counted the same as ground it worked. Nothing in the telemetry
 *   says whether the blade was down.
 * - The straight segment between two fixes is not the curve the machine drove.
 *
 * It has NOT been validated against a block of known extent. Until it has, this
 * is a plausible arithmetic on real positions, not a measured area, and it
 * should not be put in front of an operator as hectares worked.
 *
 * ## Why there is no `engine_on` filter
 *
 * The excavator query has one and it belongs there — a slewing machine is
 * stationary, so without the ignition flag there is nothing to say it was
 * running. Movement is this query's evidence instead, and on this fleet the
 * flag actively destroys days. Measured over one fleet day on 21 dozers:
 *
 * - On units with NO ignition line — DZ 04, 05, 07, 09, 14 — `engine_on` is
 *   `speed > 0` and its count EXACTLY equals the moving count (136=136,
 *   573=573, 327=327). The filter is a tautology there, adding nothing.
 * - On `MUFINDI: DZ 03` the line reports OFF across all 1,038 of its fixes
 *   while the machine moved 33 times. That is a dead flag, not a parked day,
 *   and the filter discarded the whole day's ground.
 *
 * A segment of at least JITTER_FLOOR_M covered in under MAX_GAP_SECONDS at a
 * possible speed IS the machine running under power. Nothing the ignition wire
 * could add is worth losing a unit like DZ 03 for.
 */

import { prisma } from '../../lib/prisma.js'
import { MAX_GAP_SECONDS, SNAP_DEGREES } from './excavator-area.service.js'
import { PLAUSIBLE_KMH, JITTER_FLOOR_M } from '../../lib/fix-plausibility.js'

/** Blade width in metres — the operator's medium-excavator dozer blade. */
export const BLADE_WIDTH_M = 3.0

/** What a segment is buffered by on each side. */
export const BLADE_HALF_WIDTH_M = BLADE_WIDTH_M / 2

/**
 * Fixes a day needs before its area is worth reporting.
 *
 * Twenty, matching MIN_DIG_FIXES. A handful of positions can union into a
 * plausible-looking figure that describes a machine being driven across a yard,
 * and the excavator side already settled that this is the bar.
 */
export const MIN_DOZE_FIXES = 20

/**
 * One dozer's worked ground for one day, in square metres.
 *
 * Null when the day holds too few fixes to describe anything, or when the
 * geometry produces nothing — never zero, because zero would read as "this
 * machine worked no ground" where the honest answer is that we cannot say.
 */
export async function dozerDay(
  vehicleId: string, dayStart: Date, dayEnd: Date,
): Promise<{ areaM2: number; segments: number; workedSeconds: number } | null> {
  const rows = await prisma.$queryRaw<Array<{
    area_m2: number | null; segments: bigint; worked_seconds: number
  }>>`
    WITH pts AS (
      SELECT t.lat, t.lng, t.captured_at,
             lag(t.lat)         OVER w AS plat,
             lag(t.lng)         OVER w AS plng,
             lag(t.captured_at) OVER w AS pat
        FROM vehicle_telemetries t
       WHERE t.vehicle_id = ${vehicleId}
         AND t.captured_at >= ${dayStart}
         AND t.captured_at <  ${dayEnd}
         AND t.lat IS NOT NULL AND t.lng IS NOT NULL
         AND NOT (t.lat = 0 AND t.lng = 0)
      WINDOW w AS (ORDER BY t.captured_at)
    ), hops AS (
      SELECT lat, lng, plat, plng,
             extract(epoch FROM (captured_at - pat)) AS dt,
             6371000 * 2 * asin(sqrt(
               power(sin(radians(lat - plat) / 2), 2)
               + cos(radians(plat)) * cos(radians(lat))
                 * power(sin(radians(lng - plng) / 2), 2)
             )) AS hop_m
        FROM pts WHERE plat IS NOT NULL AND pat IS NOT NULL
    ), good AS (
      SELECT * FROM hops
       -- A segment spanning a reporting gap is not ground the blade crossed,
       -- it is a straight line drawn across whatever happened while the unit
       -- was silent. The same two guards the fleet's distance now uses: too
       -- short is jitter, too fast is a position that is simply wrong.
       WHERE dt > 0 AND dt <= ${MAX_GAP_SECONDS}
         AND hop_m >= ${JITTER_FLOOR_M}
         AND (hop_m / dt) * 3.6 <= ${PLAUSIBLE_KMH}
    ), seg AS (
      -- DISTINCT on the snapped endpoints, as the excavator side dedupes
      -- points: a dozer making repeated passes over one strip has covered that
      -- strip once, and unioning ten thousand identical segments costs
      -- geometry time to reach the same answer.
      SELECT DISTINCT
             ST_MakeLine(
               ST_SnapToGrid(ST_MakePoint(plng, plat), ${SNAP_DEGREES}),
               ST_SnapToGrid(ST_MakePoint(lng,  lat),  ${SNAP_DEGREES})
             ) AS ln
        FROM good
    )
    SELECT (SELECT ST_Area(ST_Union(
              ST_Buffer(ln::geography, ${BLADE_HALF_WIDTH_M})::geometry
            )::geography) FROM seg) AS area_m2,
           (SELECT count(*) FROM seg)::bigint AS segments,
           (SELECT coalesce(sum(dt), 0) FROM good)::float8 AS worked_seconds`

  const r = rows[0]
  if (!r || Number(r.segments) < MIN_DOZE_FIXES || r.area_m2 == null) return null
  return {
    areaM2:        Math.round(r.area_m2),
    segments:      Number(r.segments),
    workedSeconds: Math.round(r.worked_seconds),
  }
}
