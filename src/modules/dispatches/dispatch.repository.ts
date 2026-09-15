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
import { arrivalRadiusM, YARD_RADIUS_M, type Point } from '../../lib/dispatch-trip.js'
import { PLAUSIBLE_KMH, JITTER_FLOOR_M } from '../../lib/fix-plausibility.js'
import { fleetDayStart } from '../../lib/provider-time.js'
import { factoryOf, bagsFromTonnes } from '../webhooks/factory-map.js'
import { knownDestination } from './known-destinations.js'

const OPEN_STATUSES = ['DISPATCHED', 'OVERDUE']

/** Minimum completed trips before a destination's median is worth quoting. */
export const MIN_DURATION_SAMPLES = 5

/**
 * Fixes closer together than this are dwell, not travel.
 *
 * Was 15 m here against `measureKm`'s 20 m and no floor at all on the daily
 * trend. Now the fleet's shared floor — measured 2026-08-27, the difference
 * between 15 and 20 is 1.52% of KASULU's distance and 1.98% of SUKARI's, which
 * was never worth three answers. See JITTER_FLOOR_M.
 */
const MIN_SPACING_M = JITTER_FLOOR_M

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
  /**
   * Where this run STARTED, and what to call it.
   *
   * Not the owning organisation's yard, which is what every consumer assumed
   * until this existed. A dispatch is raised at a GATE, and the gate belongs to
   * the site, not to the fleet: the three open sales runs on the live database
   * (2026-09-15) are Menengai trucks signed out at Naitiri, which is West Kenya
   * Sugar's factory. Menengai has no `hubLat` at all, so those runs had no
   * origin, no leg length, no percentage and no bar — and had Menengai carried
   * a hub, the trip would have been measured from a refinery ~250 km from the
   * gate the truck actually left, which is worse than measuring nothing.
   *
   * Null when the row names no factory (every dispatch written before the
   * `factory_code` column, and any source that does not report one). Callers
   * fall back to the organisation's hub, which is the old behaviour and is
   * correct for a fleet dispatching out of its own yard.
   */
  originLat:  number | null
  originLng:  number | null
  originName: string | null
  /**
   * Whether `dispatchedAt` is a GUARD'S SIGN-OUT or a clerk's clock.
   *
   * The distinction decides whether a client may draw a journey for a unit that
   * is still standing at the gate. On a CANE dispatch the timestamp is when the
   * paperwork was raised and a tractor can sit in the yard for hours after it,
   * so a journey drawn at that moment asserts a departure nobody can evidence —
   * measured on the live fleet, 12 of 46 units carrying an open dispatch had
   * not moved. On a SALES run it is `signOutTime`: the guard has physically
   * released the truck, and `handleSale` refuses to store a run without one
   * rather than inventing a clock. That IS the departure, and the run should
   * read as begun from the moment it lands even while the lorry is still
   * inside the yard radius.
   */
  departureIsSignOut: boolean
  /**
   * The run's document number, as the gate wrote it. Null on every row today.
   *
   * The provider models no such field — see the sale payload in
   * webhooks/raifactorysuite-events — so this is carried, not invented: it is
   * populated only if a payload turns up with one, and the surfaces that show
   * it show nothing when it is null rather than falling back to the internal
   * UUID, which is not a number anybody at a gate can read back.
   *
   * Hard-wired to null, and there is NO column behind it.
   *
   * There was, briefly, in schema.prisma — and it took the whole dispatch and
   * sales ingest down for forty minutes on 2026-09-15. The reasoning behind it
   * is worth keeping, because it is wrong in a way that looks careful: the
   * column was added to the schema, the migration was left for a human (they
   * are applied by hand against the shared RDS instance — see the note at the
   * top of .github/workflows/deploy.yml), and the code was written neither to
   * SELECT the field nor to WRITE it, which appeared to make the deploy safe in
   * either order.
   *
   * It is not, because a Prisma write RETURNS THE ROW. `prisma.dispatch.upsert`
   * with no `select` returns every scalar field, and the generated client builds
   * that RETURNING clause from schema.prisma — so every upsert asked Postgres
   * for `serial_number` and got `42703 column does not exist`. handleSale and
   * handleDispatch failed on every reconcile pass, and the symptom was not an
   * error anyone was looking at: sign-outs simply stopped arriving, so a truck
   * drove out of Naitiri with no trip behind it and the dash looked broken.
   *
   * The rule, plainly: a column in schema.prisma is load-bearing for every
   * write to that table the moment it exists, whether or not any code names it.
   * Schema and database go together or not at all.
   *
   * So the field stays as a null that the plumbing and the rendering carry, and
   * the column arrives — schema line, migration, and `serialNumber: true` in
   * the select below — as ONE change, applied before it deploys, on the day
   * there is actually a serial to put in it.
   */
  serialNumber: string | null
  expectedReturnAt: string | null
  dueBackAt:     string | null
  dueBackSource: 'provider' | 'history' | null
  /** The destination's MEASURED point, null for a name we cannot place. */
  destinationLat: number | null
  destinationLng: number | null
  /** Median spread of that measurement, and how many trips it came from. */
  destinationSpreadM: number
  destinationSamples: number
  /**
   * How the destination got its coordinates.
   *
   * 'stated'   the operator gave us the point (known-destinations). Samples is
   *            0 and that is not a weakness — there is nothing to sample.
   * 'measured' averaged from this fleet's completed trips to the name; grade
   *            it by `destinationSamples` and `destinationSpreadM`.
   * null       the name could not be placed at all; there is no far end.
   */
  destinationSource: 'stated' | 'measured' | null
  /**
   * What is on the bed right now, for a SALES run.
   *
   * The Current Cargo card had no source for this and always read "Empty · 0
   * TONNES": it is fed from `vehicle_telemetry.cargo_weight_kg`, and this fleet
   * has no load cells — wialon.adapter hardcodes the channel null on every
   * frame. The sales office knows the weight, so the OPEN RUN is where the card
   * can learn it, exactly as the driver name is already taken from the run
   * rather than from the stale assignment.
   *
   * All three are null on a cane run, which carries no declared weight.
   */
  cargoTonnes: number | null
  cargoBags:   number | null
  cargoName:   string | null
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
      kind: true, tonnageT: true, factoryCode: true,
      // NOT serialNumber. See the field on OpenTrip below: the column exists in
      // the schema and in prisma/migrations, and is read here the moment that
      // migration has been applied to the shared RDS instance. Selecting it
      // first would make every snapshot in the fleet fail on a column that is
      // not there yet, which is a poor trade for a field no row carries.
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
  //
  // A STATED point wins over a measured one. `dispatch_destinations` is built
  // from completed round trips, and the Naitiri sugar run never produces one —
  // the guard signs a truck out and back in minutes later, so all twelve live
  // Raiply rows closed in under half an hour and the table holds nothing for
  // the route. See known-destinations for why that is a permanent hole rather
  // than a thin sample, and why the operator's gate is the better figure even
  // when the measurement does exist.
  const names = [...new Set(runs.map(d => d.destination?.trim().toUpperCase()).filter(Boolean) as string[])]
  const measured = names.length
    ? await prisma.dispatchDestination.findMany({
        where:  { organisationId, name: { in: names } },
        select: { name: true, lat: true, lng: true, spreadM: true, samples: true },
      })
    : []
  const placeByName = new Map(measured.map(p => [p.name, p]))
  // Which of the two placed each name, carried onward. `destinationSamples` is
  // a count of completed trips and cannot answer this: a stated gate has none
  // and always will, so a client grading confidence by sample count alone would
  // caption the operator's own coordinate "approximate".
  const statedNames = new Set<string>()
  for (const name of names) {
    const stated = knownDestination(name)
    if (!stated) continue
    statedNames.add(name)
    placeByName.set(name, { name, lat: stated.lat, lng: stated.lng, spreadM: stated.spreadM, samples: 0 })
  }

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

    // The gate this run left from. A Menengai truck signed out at Naitiri
    // starts at Naitiri; its owner's yard is 250 km away and is not where the
    // wheels turned. Null falls the caller back to the organisation's hub.
    const gate = d.factoryCode ? factoryOf(d.factoryCode) : null

    out.set(vehicleId, {
      externalId:   d.externalId,
      driverName:   d.driverName,
      destination:  d.destination,
      status:       d.status,
      dispatchedAt: d.dispatchedAt.toISOString(),
      originLat:    gate?.lat   ?? null,
      originLng:    gate?.lng   ?? null,
      originName:   gate?.label ?? null,
      departureIsSignOut: d.kind === 'SALES',
      // Null until the migration lands — see the select above. Nothing is lost
      // in the meantime: no row has a serial, because the provider sends none.
      serialNumber: null,
      expectedReturnAt: d.expectedReturnAt?.toISOString() ?? null,
      dueBackAt:        dueBackAt?.toISOString() ?? null,
      dueBackSource,
      destinationLat:     place?.lat ?? null,
      destinationLng:     place?.lng ?? null,
      destinationSpreadM: place?.spreadM ?? 0,
      destinationSamples: place?.samples ?? 0,
      destinationSource:  place ? (statedNames.has(key) ? 'stated' : 'measured') : null,
      // The load, named by the factory it left. A cane run declares no weight,
      // so these stay null and the card falls back to telemetry as before.
      cargoTonnes: d.kind === 'SALES' ? d.tonnageT : null,
      cargoBags:   d.kind === 'SALES' ? bagsFromTonnes(d.tonnageT) : null,
      cargoName:   d.kind === 'SALES'
        ? (d.factoryCode ? factoryOf(d.factoryCode)?.commodity ?? null : null)
        : null,
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
 *
 * EXPORTED because it is the fleet's ONE definition of "ground covered". The
 * per-vehicle brief used to carry its own copy of this SQL, and the copy bound
 * its lower bound as a driver parameter rather than as the naive-UTC TIMESTAMP
 * literal below — two statements measuring the same truck, agreeing only by
 * inspection and only on a UTC session. There is now one query, and it cannot
 * drift from itself.
 */
export async function coveredSince(
  pairs: { vehicleId: string; since: Date }[],
): Promise<Map<string, {
  coveredM: number; fixCount: number; firstFixAt: Date; lastFixAt: Date
  firstLat: number | null; firstLng: number | null
  /** Earliest fix in the window reporting a non-zero speed, or null. */
  firstMovingAt: Date | null
  /**
   * Metres REJECTED as physically impossible — hops clearing the jitter floor
   * but implying over PLAUSIBLE_KMH. Not included in `coveredM`.
   *
   * Carried so the filter is auditable from its callers rather than being a
   * silent subtraction. On a healthy unit this is near zero; a unit where it
   * dominates has a tracker fault, not a driving pattern, and measured
   * 2026-08-27 that describes most of SUKARI — the worst fifteen units ran
   * 67-91% impossible.
   */
  implausibleM: number
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

  /**
   * The earliest bound anyone asked for, as a planner-visible constant.
   *
   * Both this and the `= ANY($1)` inside the CTE below are LOGICALLY REDUNDANT:
   * the join to `bounds` already implies them, and the result set is identical
   * with or without. They are there for the planner, which cannot see through
   * the VALUES list.
   *
   * Without them `captured_at >= b.since` is a join-dependent predicate, so
   * nothing constrains the outer relation and the plan was a PARALLEL SEQ SCAN
   * of the whole table — 1,725,998 rows per worker across three workers on a
   * 5.17M-row table, 98,972 blocks read from disk, for an answer of 3,728 rows.
   * Measured on prod 2026-08-10 with the 98 vehicles the open-trips cache asks
   * about:
   *
   *   as shipped              5,206 ms   seq scan, 98,972 block reads
   *   with these two lines       59 ms   index scan, 0 reads (28,377 cache hits)
   *
   * Same 3,728 rows either way. That 5.2 s was 85% of findOpenTripsByVehicle's
   * 6.2 s, which is what the warm-cache sweep runs every 60 s per org.
   */
  const floor = safe.reduce((min, p) => (p.since < min ? p.since : min), safe[0]!.since)

  const rows = await prisma.$queryRawUnsafe<{
    vehicle_id: string; covered_m: number; implausible_m: number; fix_count: bigint; first_fix: Date; last_fix: Date
    first_lat: number | null; first_lng: number | null; first_moving: Date | null
  }[]>(`
    WITH bounds(vehicle_id, since) AS (VALUES ${sinceCase}),
    fixes AS (
      SELECT t.vehicle_id, t.captured_at, t.lat, t.lng, t.speed_kmh,
             LAG(t.lat) OVER w AS prev_lat,
             LAG(t.lng) OVER w AS prev_lng,
             LAG(t.captured_at) OVER w AS prev_at
        FROM vehicle_telemetries t
        JOIN bounds b ON b.vehicle_id = t.vehicle_id
       WHERE t.captured_at >= b.since
         AND t.lat IS NOT NULL AND t.lng IS NOT NULL
         -- Redundant by construction, and the difference between an index scan
         -- and a seq scan of the whole table. See the floor constant above for
         -- the measurements. Do not "tidy these away" as duplicates of the join.
         AND t.captured_at >= TIMESTAMP '${utc(floor)}'
         AND t.vehicle_id  = ANY($1)
      WINDOW w AS (PARTITION BY t.vehicle_id ORDER BY t.captured_at)
    ),
    hops AS (
      SELECT vehicle_id, captured_at, lat, lng, speed_kmh,
             CASE WHEN prev_lat IS NULL THEN 0 ELSE
               2 * 6371000 * asin(sqrt(
                 power(sin(radians(lat - prev_lat) / 2), 2) +
                 cos(radians(prev_lat)) * cos(radians(lat)) *
                 power(sin(radians(lng - prev_lng) / 2), 2)
               ))
             END AS hop_m,
             EXTRACT(EPOCH FROM (captured_at - prev_at)) AS dt
        FROM fixes
    )
    SELECT vehicle_id,
           -- A hop the vehicle could not physically have made is not distance.
           --
           -- The jitter floor below drops hops too SHORT to be travel; nothing
           -- dropped ones too LONG, and a teleport is by definition a long hop,
           -- so bad fixes were over-represented in metres by exactly the amount
           -- that makes them dangerous. Measured 2026-08-27 over 24 h: 34.76% of
           -- SUKARI's summed distance and 1.95% of KASULU's came from hops
           -- implying over 120 km/h, while NO fix in the fleet ever REPORTS a
           -- speed above 116. The device does not claim to be moving that fast,
           -- so it is the position that is wrong.
           --
           -- An implied SPEED rather than a flat ceiling, for the reason
           -- lib/fix-plausibility gives: a stale fix an hour old is legitimately
           -- far away and a fresh one 900 m out is not, so the test has to scale
           -- with the gap. NULLIF guards a zero gap, whose implied speed is
           -- infinite and which is therefore excluded — as it should be.
           COALESCE(SUM(CASE WHEN hop_m >= ${MIN_SPACING_M}
                              AND (hop_m / NULLIF(dt, 0)) * 3.6 <= ${PLAUSIBLE_KMH}
                             THEN hop_m ELSE 0 END), 0) AS covered_m,
           -- Reported, not silently dropped. A filter that removes a third of a
           -- fleet's distance has to be visible, both to justify itself and so a
           -- unit whose share climbs is recognised as a tracker fault rather
           -- than a vehicle that stopped working.
           COALESCE(SUM(CASE WHEN hop_m >= ${MIN_SPACING_M}
                              AND NOT ((hop_m / NULLIF(dt, 0)) * 3.6 <= ${PLAUSIBLE_KMH})
                             THEN hop_m ELSE 0 END), 0) AS implausible_m,
           COUNT(*)      AS fix_count,
           MIN(captured_at) AS first_fix,
           MAX(captured_at) AS last_fix,
           -- The position AT the earliest fix, not MIN(lat) — the minimum
           -- latitude and the minimum longitude in the set are two different
           -- fixes, and together they name a place the vehicle was never at.
           (array_agg(lat ORDER BY captured_at))[1] AS first_lat,
           (array_agg(lng ORDER BY captured_at))[1] AS first_lng,
           -- When the wheels first turned in this window. Rides along because
           -- the per-vehicle brief needs it over the SAME window as the
           -- distance, and a second query would be a second window to get wrong.
           MIN(captured_at) FILTER (WHERE speed_kmh > 0) AS first_moving
      FROM hops
     WHERE vehicle_id = ANY($1)
     GROUP BY vehicle_id
  `, vehicleIds)

  return new Map(rows.map(r => [r.vehicle_id, {
    coveredM:     Math.round(Number(r.covered_m)),
    implausibleM: Math.round(Number(r.implausible_m)),
    fixCount:   Number(r.fix_count),
    firstFixAt: r.first_fix,
    lastFixAt:  r.last_fix,
    firstLat:   r.first_lat != null ? Number(r.first_lat) : null,
    firstLng:   r.first_lng != null ? Number(r.first_lng) : null,
    firstMovingAt: r.first_moving ?? null,
  }]))
}

/**
 * When the vehicle was first seen CLEAR OF THE YARD on this run — i.e. the
 * moment it actually left, as opposed to the moment the paperwork was raised.
 *
 * The two are routinely hours apart on this fleet: of the vehicles carrying an
 * open dispatch, a quarter are still standing in the yard, so "dispatched
 * 06:10" answers a different question from "left 09:42" and an operator asking
 * where the day went needs the second one.
 *
 * Measured, with the caveat stated in its name: this is the first fix beyond
 * YARD_RADIUS_M at or after the dispatch clock. If a unit was already out when
 * the dispatch was raised, that is the first fix of the run rather than a
 * departure — which is why the caller only quotes it once the trip geometry
 * agrees the unit has in fact left.
 *
 * Same binding discipline as `coveredSince`: the id is pinned to the cuid shape
 * and the bound is a naive-UTC TIMESTAMP literal, because `captured_at` is
 * `timestamp without time zone` holding UTC and a driver-bound parameter would
 * be re-read through the session timezone.
 */
export async function firstFixClearOfYard(
  vehicleId: string,
  since: Date,
  yard: Point,
  radiusM: number = YARD_RADIUS_M,
): Promise<Date | null> {
  if (!/^[a-z0-9]{20,32}$/i.test(vehicleId)) return null
  // Numeric, finite, or nothing goes into the string. The yard comes from our
  // own organisation row and the radius from a constant, but this is an
  // interpolated statement and the guard costs nothing.
  const lat = Number(yard.lat), lng = Number(yard.lng), rad = Number(radiusM)
  if (![lat, lng, rad].every(Number.isFinite)) return null
  const utc = since.toISOString().replace('T', ' ').replace('Z', '')

  const rows = await prisma.$queryRawUnsafe<{ left_at: Date | null }[]>(`
    SELECT MIN(t.captured_at) AS left_at
      FROM vehicle_telemetries t
     WHERE t.vehicle_id = '${vehicleId}'
       AND t.captured_at >= TIMESTAMP '${utc}'
       AND t.lat IS NOT NULL AND t.lng IS NOT NULL
       AND 2 * 6371000 * asin(sqrt(
             power(sin(radians(t.lat - ${lat}::float8) / 2), 2) +
             cos(radians(${lat}::float8)) * cos(radians(t.lat)) *
             power(sin(radians(t.lng - ${lng}::float8) / 2), 2))) > ${rad}::float8
  `)
  return rows[0]?.left_at ?? null
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
