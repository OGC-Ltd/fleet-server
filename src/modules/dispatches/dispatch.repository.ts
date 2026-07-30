/**
 * Active dispatches, with the two things a dispatcher actually wants: how far
 * the vehicle has got, and when it is due back.
 *
 * ## What is real here, and what is not
 *
 * The provider (RaiFactorySuite) is the only source of "where is it going", and
 * it gives a NAME — `destinationOrPurpose`, free text, 152 distinct values in
 * use ("OPAPO", "GOT KOJOWI", "OSOGO KAJ"): cane collection zones in a local
 * naming system. There are no coordinates, and the names are not in any
 * gazetteer we can trust — probing Nominatim on the fourteen busiest returned
 * five matches, three of them plainly wrong (a primary school 20 km away, a
 * road 25 km away). So this module never converts a destination to a point, and
 * therefore never computes a distance-to-go or a road-route ETA. Anything of
 * that shape would be a number we made up.
 *
 * What IS measurable:
 *
 *   FROM      the vehicle's own first fix at or after the dispatch clock —
 *             telemetry, not an assumption about the yard.
 *   COVERED   the sum of great-circle hops through its real fixes since
 *             dispatch. Ground covered, not distance-as-the-crow-flies, and
 *             explicitly NOT "distance remaining".
 *   DUE BACK  the dispatcher's own `expectedReturnTime` when they set one
 *             (about a third of open dispatches), otherwise the MEDIAN of this
 *             fleet's completed round trips to the same destination. That is
 *             the fleet's own history, and it carries its sample size so the
 *             UI can say how well-founded it is.
 *
 * ## Why the distance is often zero
 *
 * Because it usually is. Measured live on 2026-07-30: of 55 open dispatches, 24
 * had no fix at all since their dispatch was raised and only 3 had moved
 * measurably (30.2 km, 5.1 km, 2.3 km). Dispatch time is when the paperwork was
 * raised, and a tractor can sit in the yard for hours after that. So `fixCount`
 * and `lastFixAt` travel with the distance: "no fixes since dispatch" and
 * "hasn't moved" are different facts and must not render as the same 0.0 km.
 */

import { prisma } from '../../lib/prisma.js'

const OPEN_STATUSES = ['DISPATCHED', 'OVERDUE']

/** Minimum completed trips before a destination's median is worth quoting. */
export const MIN_DURATION_SAMPLES = 5

/** Fixes closer together than this are dwell, not travel — see the track endpoint. */
const MIN_SPACING_M = 15

export interface ActiveDispatch {
  externalId:   string
  vehicleId:    string | null
  plate:        string
  driverName:   string
  destination:  string | null
  status:       string
  dispatchedAt: string
  /** Provider's own commitment, if the dispatcher set one. */
  expectedReturnAt: string | null
  /** Median hours for completed trips to this destination, and how many. */
  typicalHours: number | null
  typicalSamples: number
  /** Where "due back" came from, so the UI never implies more than it knows. */
  dueBackAt: string | null
  dueBackSource: 'provider' | 'history' | null
  /** Metres travelled through real fixes since dispatch. Null = nothing to sum. */
  coveredM: number | null
  fixCount: number
  firstFixAt: string | null
  lastFixAt: string | null
  /**
   * Where the run started, as the vehicle itself reported it: the position of
   * the FIRST fix at or after the dispatch clock. This is the only origin that
   * is measured rather than assumed — the provider records no start location,
   * and the yard would be a guess.
   *
   * Read it with `firstFixAt` beside it. Telemetry retention is finite, so on
   * an old dispatch the earliest fix we still hold can be long after the
   * paperwork was raised, and then this is "where we first saw it", not "where
   * it set off". The UI is given both so it can say which it has.
   */
  firstFixLat: number | null
  firstFixLng: number | null
}

/**
 * Median round-trip hours per destination, over COMPLETED dispatches.
 *
 * Median rather than mean: the tail is long (a completed trip in the live data
 * ranges from under an hour to 76), and one truck that sat out a weekend would
 * drag a mean into uselessness.
 *
 * Postgres does this in one pass with percentile_cont; pulling every completed
 * dispatch into Node to sort per destination would move thousands of rows to
 * compute a handful of numbers.
 */
export async function destinationDurations(
  organisationId: string,
): Promise<Map<string, { medianHours: number; samples: number }>> {
  // GROUP BY the NORMALISED name, not the raw column. The dispatchers type it
  // freehand and the casing wanders — "OPAPO", "Opapo", "koduogo" all occur —
  // so grouping on the raw text splits one destination's history across several
  // buckets. Measured: OPAPO's sample count fell from 65 to 63 that way, and
  // smaller runs dropped under the 5-trip floor and lost their estimate
  // altogether. The key must match the lookup key the caller builds.
  const rows = await prisma.$queryRaw<{ destination: string; n: bigint; median_h: number }[]>`
    SELECT UPPER(TRIM(destination)) AS destination,
           COUNT(*) AS n,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (actual_return_at - dispatched_at)) / 3600
           ) AS median_h
      FROM dispatches
     WHERE organisation_id  = ${organisationId}
       AND actual_return_at IS NOT NULL
       AND destination      IS NOT NULL
       -- Guard the provider's own bad rows: a return stamped before the
       -- dispatch would produce a negative "typical" duration.
       AND actual_return_at > dispatched_at
     GROUP BY UPPER(TRIM(destination))
    HAVING COUNT(*) >= ${MIN_DURATION_SAMPLES}
  `
  return new Map(rows.map(r => [
    r.destination,
    { medianHours: Number(Number(r.median_h).toFixed(1)), samples: Number(r.n) },
  ]))
}

/**
 * Ground covered since dispatch, per vehicle, in ONE query for the whole set.
 *
 * The distance is summed in SQL with a window function rather than by pulling
 * every fix into Node: an open dispatch can span days and a unit reports on a
 * timer, so the raw fix count runs to thousands per vehicle. Hops shorter than
 * MIN_SPACING_M are dropped for the same reason the track endpoint thins them —
 * a parked machine's GPS jitter would otherwise accumulate kilometres of
 * "travel" while standing still.
 *
 * Haversine in SQL, not PostGIS: the extension is not installed, and at these
 * distances the sphere is accurate to a few metres.
 */
async function coveredSince(
  pairs: { vehicleId: string; since: Date }[],
): Promise<Map<string, {
  coveredM: number; fixCount: number; firstFixAt: Date; lastFixAt: Date
  firstLat: number | null; firstLng: number | null
}>> {
  if (pairs.length === 0) return new Map()

  // `$queryRawUnsafe` interpolates the VALUES list, so both halves are pinned to
  // shapes that cannot carry SQL: ids must look like the cuids our own registry
  // issues, and the bound is rebuilt from the Date's UTC parts rather than
  // passed through as text.
  const safe = pairs.filter(p => /^[a-z0-9]{20,32}$/i.test(p.vehicleId))
  if (safe.length === 0) return new Map()
  const vehicleIds = safe.map(p => p.vehicleId)

  // Plain TIMESTAMP, not TIMESTAMPTZ. `vehicle_telemetry.captured_at` is
  // `timestamp without time zone` holding UTC (Prisma's DateTime mapping), so a
  // timestamptz bound would be converted using the SESSION timezone — correct on
  // a UTC box, silently hours off anywhere else. That is the same class of bug
  // that put the Live Feed three hours into the future (see lib/provider-time).
  const utc = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '')
  const sinceCase = safe.map(p => `('${p.vehicleId}', TIMESTAMP '${utc(p.since)}')`).join(',')

  const rows = await prisma.$queryRawUnsafe<{
    vehicle_id: string; covered_m: number; fix_count: bigint; first_fix: Date; last_fix: Date
    first_lat: number | null; first_lng: number | null
  }[]>(`
    WITH bounds(vehicle_id, since) AS (VALUES ${sinceCase}),
    fixes AS (
      SELECT t.vehicle_id, t.captured_at, t.lat, t.lng,
             LAG(t.lat) OVER w AS prev_lat,
             LAG(t.lng) OVER w AS prev_lng
        FROM vehicle_telemetries t
        JOIN bounds b ON b.vehicle_id = t.vehicle_id
       WHERE t.captured_at >= b.since
         AND t.lat IS NOT NULL AND t.lng IS NOT NULL
      WINDOW w AS (PARTITION BY t.vehicle_id ORDER BY t.captured_at)
    ),
    hops AS (
      SELECT vehicle_id, captured_at, lat, lng,
             CASE WHEN prev_lat IS NULL THEN 0 ELSE
               2 * 6371000 * asin(sqrt(
                 power(sin(radians(lat - prev_lat) / 2), 2) +
                 cos(radians(prev_lat)) * cos(radians(lat)) *
                 power(sin(radians(lng - prev_lng) / 2), 2)
               ))
             END AS hop_m
        FROM fixes
    )
    SELECT vehicle_id,
           COALESCE(SUM(CASE WHEN hop_m >= ${MIN_SPACING_M} THEN hop_m ELSE 0 END), 0) AS covered_m,
           COUNT(*)      AS fix_count,
           MIN(captured_at) AS first_fix,
           MAX(captured_at) AS last_fix,
           -- The position AT the earliest fix, not MIN(lat) — the minimum
           -- latitude and the minimum longitude in the set are two different
           -- fixes, and together they name a place the vehicle was never at.
           (array_agg(lat ORDER BY captured_at))[1] AS first_lat,
           (array_agg(lng ORDER BY captured_at))[1] AS first_lng
      FROM hops
     WHERE vehicle_id = ANY($1)
     GROUP BY vehicle_id
  `, vehicleIds)

  return new Map(rows.map(r => [r.vehicle_id, {
    coveredM:   Math.round(Number(r.covered_m)),
    fixCount:   Number(r.fix_count),
    firstFixAt: r.first_fix,
    lastFixAt:  r.last_fix,
    firstLat:   r.first_lat != null ? Number(r.first_lat) : null,
    firstLng:   r.first_lng != null ? Number(r.first_lng) : null,
  }]))
}

/** Every dispatch still out, enriched. Ordered oldest first — the overdue end. */
export async function findActive(organisationId: string): Promise<ActiveDispatch[]> {
  const open = await prisma.dispatch.findMany({
    where:   { organisationId, actualReturnAt: null, status: { in: OPEN_STATUSES } },
    orderBy: { dispatchedAt: 'asc' },
    select: {
      externalId: true, vehicleId: true, plate: true, driverName: true,
      destination: true, status: true, dispatchedAt: true, expectedReturnAt: true,
    },
  })
  if (open.length === 0) return []

  const durations = await destinationDurations(organisationId)
  const covered = await coveredSince(
    open.filter(d => d.vehicleId).map(d => ({ vehicleId: d.vehicleId!, since: d.dispatchedAt })),
  )

  return open.map((d) => {
    const key  = d.destination?.trim().toUpperCase() ?? ''
    const typ  = durations.get(key)
    const trk  = d.vehicleId ? covered.get(d.vehicleId) : undefined

    // Provider first, history second, nothing third. A dispatcher's stated
    // return time is a commitment; our median is an observation; neither is
    // invented, and the UI is told which it got.
    let dueBackAt: Date | null = d.expectedReturnAt
    let dueBackSource: ActiveDispatch['dueBackSource'] = d.expectedReturnAt ? 'provider' : null
    if (!dueBackAt && typ) {
      dueBackAt = new Date(d.dispatchedAt.getTime() + typ.medianHours * 3_600_000)
      dueBackSource = 'history'
    }

    return {
      externalId:   d.externalId,
      vehicleId:    d.vehicleId,
      plate:        d.plate,
      driverName:   d.driverName,
      destination:  d.destination,
      status:       d.status,
      dispatchedAt: d.dispatchedAt.toISOString(),
      expectedReturnAt: d.expectedReturnAt?.toISOString() ?? null,
      typicalHours:   typ?.medianHours ?? null,
      typicalSamples: typ?.samples ?? 0,
      dueBackAt:      dueBackAt?.toISOString() ?? null,
      dueBackSource,
      // Null, not 0, when there is no fix to measure from: "we have not heard
      // from it since it left" is not "it has not moved".
      coveredM:   trk && trk.fixCount > 1 ? trk.coveredM : null,
      fixCount:   trk?.fixCount ?? 0,
      firstFixAt: trk?.firstFixAt?.toISOString() ?? null,
      lastFixAt:  trk?.lastFixAt?.toISOString() ?? null,
      firstFixLat: trk?.firstLat ?? null,
      firstFixLng: trk?.firstLng ?? null,
    }
  })
}
