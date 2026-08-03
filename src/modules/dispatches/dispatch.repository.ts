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
import { arrivalRadiusM } from '../../lib/dispatch-trip.js'
import { fleetDayStart } from '../../lib/provider-time.js'

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
 * The open dispatch on each vehicle, as the fleet snapshot needs it.
 *
 * Separate from `findActive` on purpose. That one answers "what is out right
 * now" for a dispatcher's list and pays for a per-vehicle distance-covered sum
 * over every fix since dispatch. This one answers "what is THIS vehicle doing"
 * for 597 rows of a snapshot, so it carries only what the trip card renders and
 * costs one indexed read plus one bounded lookup per open dispatch — of which
 * there are about fifty, not six hundred.
 */
export interface OpenTrip {
  externalId:   string
  driverName:   string
  destination:  string | null
  status:       string
  dispatchedAt: string
  expectedReturnAt: string | null
  dueBackAt:     string | null
  dueBackSource: 'provider' | 'history' | null
  /** The destination's MEASURED point, null for a name we cannot place. */
  destinationLat: number | null
  destinationLng: number | null
  /** Median spread of that measurement, and how many trips it came from. */
  destinationSpreadM: number
  destinationSamples: number
  /** First moment this run was seen at the destination. Null = not yet. */
  arrivedAt: string | null
  /** Newest fix at or after the dispatch clock. Null = silent since dispatch. */
  lastFixAt: string | null
  /**
   * GROUND COVERED since local midnight — real distance through the vehicle's
   * own fixes, not a straight line.
   *
   * Distinct from the trip's `percent`, which is a POSITION along the round
   * trip, and the two are routinely far apart: a unit that reached Oyani
   * yesterday and has not moved since is half way through its round trip and
   * has driven nothing today. Both numbers are true and neither substitutes
   * for the other, so both are carried and each is labelled for what it is.
   * Null when there is no fix to measure from.
   */
  distanceTodayM: number | null
}

export async function findOpenTripsByVehicle(organisationId: string): Promise<Map<string, OpenTrip>> {
  const open = await prisma.dispatch.findMany({
    where:   {
      organisationId,
      actualReturnAt: null,
      status:    { in: OPEN_STATUSES },
      vehicleId: { not: null },
      // Today's runs on the fleet's own clock, plus the tail of yesterday's.
      //
      // "Open" and "current" are not the same thing. A dispatch stays open
      // until the provider records a return and some never get one, so the row
      // sits DISPATCHED indefinitely — days-old paperwork presented as the
      // vehicle's active trip. That is what this cuts out.
      //
      // It cannot be TODAY alone, though. This fleet's median round trip to
      // Nyaondo is about nineteen hours and the local day rolls over at
      // midnight, so a truck that left at 23:16 and is still driving at 01:00
      // was "dispatched yesterday" while being the most in-transit vehicle on
      // the board. Measured at 02:00 EAT on 2026-08-03, a strict same-day
      // filter matched ZERO of 46 open dispatches while six units were
      // demonstrably on the road. The extra day is admitted here and the
      // service then keeps only those still genuinely out — see getFleetSnapshot.
      dispatchedAt: { gte: new Date(fleetDayStart().getTime() - 24 * 3_600_000) },
    },
    orderBy: { dispatchedAt: 'desc' },
    select: {
      externalId: true, vehicleId: true, driverName: true, destination: true,
      status: true, dispatchedAt: true, expectedReturnAt: true,
    },
  })
  if (open.length === 0) return new Map()

  // ONE run per vehicle, decided before anything else is computed.
  //
  // `open` is newest-first, so the first row seen for a vehicle is the run it
  // is on now. Six of Sukari's 52 open dispatches are second rows on a vehicle
  // that already had one — the provider not having closed the previous trip —
  // and this used to be resolved at the very END, after the arrival lookup had
  // been built from every row. That lookup was keyed by vehicle alone, so the
  // duplicate silently overwrote the real one and the vehicle inherited the
  // ARRIVAL OF ITS PREVIOUS TRIP: KDL 715E showed "arrived 18:05 on 1 Aug" for
  // a run raised at 20:41 on the 2nd, and therefore read as already home.
  // Deciding here means every derived value below is about the same dispatch.
  const current = new Map<string, typeof open[number]>()
  for (const d of open) if (!current.has(d.vehicleId!)) current.set(d.vehicleId!, d)
  const runs = [...current.values()]

  // Destination points, for the names in play only.
  const names = [...new Set(runs.map(d => d.destination?.trim().toUpperCase()).filter(Boolean) as string[])]
  const places = names.length
    ? await prisma.dispatchDestination.findMany({
        where:  { organisationId, name: { in: names } },
        select: { name: true, lat: true, lng: true, spreadM: true, samples: true },
      })
    : []
  const placeByName = new Map(places.map(p => [p.name, p]))

  const durations = await destinationDurations(organisationId)

  // Distance driven TODAY, for the same vehicles, in one query. Reuses
  // coveredSince — the same haversine, the same MIN_SPACING_M jitter floor —
  // so this figure and the per-vehicle brief's cannot drift apart.
  const dayStart = fleetDayStart()
  const today = await coveredSince(runs.map(d => ({ vehicleId: d.vehicleId!, since: dayStart })))

  // Arrival + last fix per open dispatch, in ONE round trip.
  //
  // Arrival is the EARLIEST fix inside the destination's radius at or after the
  // dispatch clock, which is what makes the return leg knowable: a unit heading
  // home retraces the outbound corridor, so its distance from the yard alone
  // cannot say which way it is pointing.
  //
  // The radius is per destination (it scales with how tightly that name's trips
  // agreed), so it is carried in the VALUES list rather than being one constant.
  const probes = runs
    .map(d => {
      const place = d.destination ? placeByName.get(d.destination.trim().toUpperCase()) : undefined
      return place ? { vehicleId: d.vehicleId!, since: d.dispatchedAt, place } : { vehicleId: d.vehicleId!, since: d.dispatchedAt, place: null }
    })
    // Same guard as coveredSince: ids are pinned to the cuid shape, and the
    // bound is rebuilt from UTC parts, so neither can carry SQL.
    .filter(p => /^[a-z0-9]{20,32}$/i.test(p.vehicleId))

  const fixes = new Map<string, { arrivedAt: Date | null; lastFixAt: Date | null }>()
  if (probes.length > 0) {
    const utc = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '')
    const values = probes.map(p => {
      const lat = p.place ? p.place.lat : 'NULL'
      const lng = p.place ? p.place.lng : 'NULL'
      const rad = p.place ? arrivalRadiusM(p.place.spreadM) : 0
      // Half-side of a bounding box that comfortably contains the radius, in
      // degrees. One degree of latitude is ~111.32 km everywhere; longitude
      // shrinks by cos(lat), which at 1°S is a 0.015% correction — far inside
      // the 1.5× slack, so the box is simply taken as square.
      const deg = p.place ? (rad * 1.5) / 111_320 : 0
      return `('${p.vehicleId}', TIMESTAMP '${utc(p.since)}', ${lat}::float8, ${lng}::float8, ${rad}::float8, ${deg}::float8)`
    }).join(',')

    const rows = await prisma.$queryRawUnsafe<{
      vehicle_id: string; arrived_at: Date | null; last_fix_at: Date | null
    }[]>(`
      WITH probe(vehicle_id, since, dest_lat, dest_lng, radius_m, bbox_deg) AS (VALUES ${values})
      SELECT p.vehicle_id,
             (SELECT t.captured_at FROM vehicle_telemetries t
               WHERE t.vehicle_id = p.vehicle_id
                 AND t.captured_at >= p.since
                 AND p.dest_lat IS NOT NULL
                 AND t.lat IS NOT NULL AND t.lng IS NOT NULL
                 -- Cheap box first. An open dispatch can span days and a unit
                 -- reports on a timer, so this walks thousands of fixes per
                 -- vehicle; two float comparisons reject almost all of them,
                 -- and only the survivors pay for a haversine. Measured on the
                 -- live fleet, this took the whole lookup from 10.7 s to well
                 -- under a second across 46 open dispatches.
                 AND t.lat BETWEEN p.dest_lat - p.bbox_deg AND p.dest_lat + p.bbox_deg
                 AND t.lng BETWEEN p.dest_lng - p.bbox_deg AND p.dest_lng + p.bbox_deg
                 AND 2 * 6371000 * asin(sqrt(
                       power(sin(radians(t.lat - p.dest_lat) / 2), 2) +
                       cos(radians(p.dest_lat)) * cos(radians(t.lat)) *
                       power(sin(radians(t.lng - p.dest_lng) / 2), 2))) <= p.radius_m
               ORDER BY t.captured_at ASC LIMIT 1) AS arrived_at,
             (SELECT t.captured_at FROM vehicle_telemetries t
               WHERE t.vehicle_id = p.vehicle_id AND t.captured_at >= p.since
               ORDER BY t.captured_at DESC LIMIT 1) AS last_fix_at
        FROM probe p
    `)
    for (const r of rows) fixes.set(r.vehicle_id, { arrivedAt: r.arrived_at, lastFixAt: r.last_fix_at })
  }

  const out = new Map<string, OpenTrip>()
  for (const d of runs) {
    const vehicleId = d.vehicleId!
    const key   = d.destination?.trim().toUpperCase() ?? ''
    const place = placeByName.get(key)
    const typ   = durations.get(key)
    const f     = fixes.get(vehicleId)

    // Provider first, history second, nothing third.
    //
    // A stated return time is only a commitment if it is AFTER the dispatch.
    // The provider emits rows where the two are identical — two of the eight
    // trips live on 2026-08-03 — and taken at face value those render as due
    // back at the moment they left, i.e. permanently overdue. Same guard the
    // duration statistics already apply to completed rows; here it falls
    // through to the fleet's own median instead of quoting nonsense.
    const stated = d.expectedReturnAt
    const statedIsUsable = stated != null && stated.getTime() > d.dispatchedAt.getTime()
    let dueBackAt: Date | null = statedIsUsable ? stated : null
    let dueBackSource: OpenTrip['dueBackSource'] = statedIsUsable ? 'provider' : null
    if (!dueBackAt && typ) {
      dueBackAt = new Date(d.dispatchedAt.getTime() + typ.medianHours * 3_600_000)
      dueBackSource = 'history'
    }

    out.set(vehicleId, {
      externalId:   d.externalId,
      driverName:   d.driverName,
      destination:  d.destination,
      status:       d.status,
      dispatchedAt: d.dispatchedAt.toISOString(),
      expectedReturnAt: d.expectedReturnAt?.toISOString() ?? null,
      dueBackAt:        dueBackAt?.toISOString() ?? null,
      dueBackSource,
      destinationLat:     place?.lat ?? null,
      destinationLng:     place?.lng ?? null,
      destinationSpreadM: place?.spreadM ?? 0,
      destinationSamples: place?.samples ?? 0,
      arrivedAt: f?.arrivedAt?.toISOString() ?? null,
      lastFixAt: f?.lastFixAt?.toISOString() ?? null,
      // Null, not 0, with fewer than two fixes: "we have heard nothing today"
      // is not "it has not moved today".
      distanceTodayM: (() => {
        const t = today.get(vehicleId)
        return t && t.fixCount > 1 ? t.coveredM : null
      })(),
    })
  }
  return out
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
