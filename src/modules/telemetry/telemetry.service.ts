import {
  findPings, findTrack, findLatest, findActiveAlerts, findAlertHistoryCounts,
  findSampledFixes, findZoneTimeline, vehicleExistsInOrg, metresBetween,
  findPlaybackFixes, findDaySeries,
  type TrackPoint,
} from './telemetry.repository.js'
import { simplifyPath } from '../../lib/simplify-path.js'
import { buildPlaybackEvents } from './playback-events.js'
import { getMaintenanceHistoryCached, getOrgVehicleMaintenance } from './maintenance.cache.js'
import { getFleetSnapshotCached } from './fleet-snapshot.cache.js'
import type { TelemetryListQuery, TrackQuery, PlaybackQuery, DaySeriesQuery } from './telemetry.schema.js'
import { TRACK_MAX_WINDOW_DAYS, TRACK_FULL_FIDELITY_HOURS } from './telemetry.schema.js'
import { NotFoundError, BadRequestError, ServiceUnavailableError } from '../../core/errors/errors.js'
import { assignedZoneStatus } from '../../lib/zone-presence.js'
import { movementState } from '../../lib/movement-state.js'
import { connectionStatus } from '../../lib/connection-state.js'
import { getOpenTripsCached } from '../dispatches/open-trips.cache.js'
import { tripGeometry } from '../../lib/dispatch-trip.js'
import { fleetDayStart, fleetDayKey, fleetDayBounds as sharedFleetDayBounds } from '../../lib/provider-time.js'
import { prisma } from '../../lib/prisma.js'
import { overspeedLimitFor } from '../../lib/derived-alerts.js'
import { warmSpeedPolicy, speedPolicyFor } from '../../lib/speed-policy.js'

/** Fleet-local midnight as an ISO string, so it compares against `departedAt`
 *  (which is already an ISO instant) without re-parsing per vehicle. */
const fleetDayStartIso = () => fleetDayStart().toISOString()

export async function listPings(vehicleId: string, orgId: string, q: TelemetryListQuery) {
  const result = await findPings(vehicleId, orgId, q)
  if (!result) throw new NotFoundError('Vehicle not found')
  return result
}

/**
 * A vehicle's travelled track, and optionally the zones it passed through.
 *
 * ## Two fidelities, because one does not stretch to a month
 *
 * Up to TRACK_FULL_FIDELITY_HOURS the track is every fix the unit sent, thinned
 * by distance in findTrack — unchanged, and still the path the map uses.
 *
 * Beyond that it switches to one fix per time bucket. This is not a nicety: a
 * 30-day window on a busy unit is 160,890 fixes, and reading them cost over a
 * minute on prod before the statement was cancelled, because the rows are
 * scattered through an 807 MB heap the instance can only cache 225 MB of. The
 * bucketed form does bounded index probes instead, so a month costs about what
 * a day costs. See the budgets in telemetry.repository.
 *
 * `resolution` tells the caller which one it got. Nothing infers it from the
 * window, and no field silently changes meaning between the two — a sampled
 * track reports `samples`, a full one reports `fixes`, and a client that
 * ignores `resolution` cannot accidentally read one as the other.
 */
export async function getVehicleTrack(vehicleId: string, orgId: string, q: TrackQuery) {
  const to   = q.to   ?? new Date()
  const from = q.from ?? null

  if (from && from >= to) {
    throw new BadRequestError('`from` must be earlier than `to`')
  }

  const windowMs    = from ? to.getTime() - from.getTime() : null
  const windowHours = windowMs === null ? null : windowMs / 3_600_000

  if (windowHours !== null && windowHours > TRACK_MAX_WINDOW_DAYS * 24) {
    // Refused, not clamped. A caller that asked for a year and received a month
    // labelled as a month would draw conclusions from a window it never
    // requested; better it learns the limit than misreads the answer.
    throw new BadRequestError(
      `Track window may not exceed ${TRACK_MAX_WINDOW_DAYS} days (asked for ${Math.round(windowHours / 24)})`,
    )
  }

  // No explicit `from` keeps the original behaviour exactly: newest fixes up to
  // the scan cap, however far back that reaches.
  const sampled = windowHours !== null && windowHours > TRACK_FULL_FIDELITY_HOURS

  const result = sampled
    ? await buildSampledTrack(vehicleId, orgId, from!, to, q)
    : await findTrack(vehicleId, orgId, q)

  if (!result) throw new NotFoundError('Vehicle not found')

  // Best-effort, and always present in the response.
  //
  // The three states are kept distinct on purpose. `null` means nobody asked;
  // `timedOut` means someone asked and PostGIS ran past its budget. Collapsing
  // those into one empty value would let a client render "this unit visited no
  // zones" for a query that never actually ran.
  const timeline = q.zones
    ? await findZoneTimeline(
        vehicleId, orgId,
        from ?? new Date(result.firstAt ?? to.getTime()),
        to,
      )
    : undefined

  return {
    ...result,
    zones:
      timeline === undefined ? null
      : timeline === null    ? { timedOut: true as const, bucketSec: null, visits: null }
      : {
          timedOut: false as const,
          // Sample spacing is part of the answer: a visit shorter than the
          // bucket can fall between two probes and never appear at all, and the
          // caller needs the number to know how much to trust a short one.
          bucketSec: timeline.bucketSec,
          visits: timeline.rows.map(v => ({
            zoneId:    v.zone_id,
            name:      v.zone_name,
            type:      v.zone_type,
            enteredAt: v.entered_at.getTime(),
            leftAt:    v.left_at.getTime(),
            samples:   Number(v.samples),
            // Most fences here are context rather than policy — 99 of 107 were
            // imported from Wialon and never switched on. Passing the live
            // path's own enforcement rule through means a backtrack cannot
            // imply a violation the map would not have raised.
            enforced:  v.enforced ?? false,
            // A null zone is a real, meaningful segment: the unit was outside
            // every fence the org has drawn. Named so no client has to guess.
            outside:   v.zone_id === null,
          })),
        },
  }
}

/**
 * Fleet-day boundaries for a `YYYY-MM-DD` string.
 *
 * Built by parsing with an explicit `+03:00` rather than by arithmetic on a
 * Date, the same way analytics.repository anchors its windows. `new Date('…')`
 * on a bare date reads UTC midnight, which is 03:00 EAT — so the first three
 * hours of every fleet day would land in the day before, and the error is
 * invisible on any day the unit happened not to work before 03:00.
 */
function fleetDayBounds(day: string) {
  // The arithmetic moved to lib/provider-time so the notification reader shares
  // it — a replay and the event list beside it must agree on what a day is.
  // The 400 stays here, because that is an HTTP decision.
  const bounds = sharedFleetDayBounds(day)
  if (!bounds) throw new BadRequestError(`Unparseable day '${day}'`)
  return bounds
}

/**
 * One unit's day, as a replayable path.
 *
 * ## What it is for, and why it is not `/track` with more options
 *
 * `/track` draws the recent line under a clicked vehicle. This answers "show me
 * what this machine did on the 27th", which wants different columns (heading
 * and speed, so a marker can point and a readout can move), a different window
 * (a Kenyan calendar day, not an arbitrary span), and a different budget.
 *
 * ## Simplification is reported, not silent
 *
 * `rawPoints` and `points` are both returned. A caller that draws 431 points
 * where 850 fixes were read is entitled to know that, and the ratio is the only
 * way to tell "this unit barely moved" from "the simplifier ate the shape".
 * Setting `toleranceM=0` and `dwellRadiusM=0` returns every positioned fix,
 * which is what makes the claim checkable rather than a promise.
 */
export async function getVehiclePlayback(
  vehicleId: string, orgId: string, q: PlaybackQuery,
) {
  const day = q.day ?? fleetDayKey().toISOString().slice(0, 10)
  const { from, to } = fleetDayBounds(day)

  // A day that has not started yet is a mistake worth naming. A day PART way
  // through is not — it returns what has happened so far, which is what an
  // operator watching today's work wants.
  if (from.getTime() > Date.now()) {
    throw new BadRequestError(`Fleet day ${day} has not started yet`)
  }

  const raw = await findPlaybackFixes(vehicleId, orgId, from, to)
  if (!raw) throw new NotFoundError('Vehicle not found')

  const points = simplifyPath(raw.points, {
    toleranceM:   q.toleranceM,
    dwellRadiusM: q.dwellRadiusM,
  })

  /**
   * What happened, against RAW points rather than simplified ones.
   *
   * Dwell collapse exists to delete exactly the fixes a stop is made of, so
   * deriving stops from `points` would find almost none of them — the one
   * ordering mistake available here. See playback-events.
   */
  const { events, truncatedEvents } = await buildPlaybackEvents(vehicleId, from, to, raw.points)

  // Distance over the SIMPLIFIED path, deliberately. It is the length of the
  // line the client will actually draw, so a reader comparing the figure to the
  // route in front of them is comparing like with like. The raw path is longer
  // by whatever GPS noise a stationary unit accumulated, which is not travel.
  let metres = 0
  for (let i = 1; i < points.length; i++) {
    if (points[i].gapBefore) continue   // no evidence of a path across a silence
    metres += metresBetween(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng)
  }

  return {
    vehicleId,
    day,
    from: from.getTime(),
    to:   to.getTime(),
    /** Positioned fixes read from the window, before any thinning. */
    fixes: raw.fixes,
    /** Points after dwell collapse + Douglas-Peucker — what the client draws. */
    points,
    rawPoints: raw.points.length,
    simplify: { toleranceM: q.toleranceM, dwellRadiusM: q.dwellRadiusM },
    /**
     * The scan cap was hit, so the day is cut at its LATE end — see the note on
     * ordering in findPlaybackFixes. Measured 2026-08-28, this affects 5 of 336
     * units on a normal day.
     */
    truncated: raw.truncated,
    firstAt: points[0]?.t ?? null,
    lastAt:  points[points.length - 1]?.t ?? null,
    distanceM: Math.round(metres),
    /** Stretches the unit reported nothing for, which the line must break on. */
    gaps: points.filter(p => p.gapBefore).length,
    /**
     * Stops, drains, refills, zone crossings and speeding runs, in time order.
     * Positions are deliberately absent — every one is placed on the track by
     * its timestamp, because not one of the sources records a coordinate.
     */
    events,
    /** The day held more than the cap; the least severe were dropped. */
    truncatedEvents,
  }
}

/**
 * One unit's day of chartable readings — see daySeriesQuerySchema.
 *
 * `complete` is true for a day that has ended: its rows will not change, so the
 * caller may keep them for good. Today's are a running total, and `since` lets
 * the caller fetch only what arrived after its last row.
 */
/** `db`: the report pool (lib/report-db) when a Fuel Report asks; the live pool otherwise. */
export async function getVehicleDaySeries(vehicleId: string, orgId: string, q: DaySeriesQuery, db: typeof prisma = prisma) {
  const day = q.day ?? fleetDayKey().toISOString().slice(0, 10)
  const { from, to } = fleetDayBounds(day)
  if (from.getTime() > Date.now()) {
    throw new BadRequestError(`Fleet day ${day} has not started yet`)
  }
  const after = q.since != null && q.since >= from.getTime() ? new Date(q.since) : null

  const raw = await findDaySeries(vehicleId, orgId, from, to, after, db)
  if (!raw) throw new NotFoundError('Vehicle not found')

  // Where the org's limit depends on place (lib/speed-policy), the limit at
  // each reading, so the chart marks an overspeed by where it happened.
  // Absent for every other org: the unit's one limit is on the snapshot.
  await warmSpeedPolicy(orgId)
  let lim: number[] | undefined
  if (speedPolicyFor(orgId)) {
    const v = await db.vehicle.findUnique({ where: { id: vehicleId }, select: { vehicleType: true } })
    const type = v?.vehicleType ?? null
    // Each position asked once. A parked unit reports the same (5-dp) spot
    // hundreds of times a day, and this was the whole cost of the route on
    // Mufindi (27 Sep: 0.6–1.0 s of a 0.8–1.3 s response, against 10–23 ms
    // for the query itself).
    const byPlace = new Map<string, number>()
    lim = raw.cols.t.map((_, i) => {
      const lat = raw.cols.lat[i], lng = raw.cols.lng[i]
      const key = `${lat},${lng}`
      let kmh = byPlace.get(key)
      if (kmh === undefined) {
        kmh = overspeedLimitFor(type, { orgId, lat, lng })
        byPlace.set(key, kmh)
      }
      return kmh
    })
  }

  return {
    vehicleId,
    day,
    from: from.getTime(),
    to:   to.getTime(),
    since: after?.getTime() ?? null,
    complete: to.getTime() <= Date.now(),
    count: raw.cols.t.length,
    truncated: raw.truncated,
    ...raw.cols,
    ...(lim ? { lim } : {}),
  }
}

/** The long-window path — see getVehicleTrack. Same shape, sampled contents. */
async function buildSampledTrack(
  vehicleId: string, orgId: string, from: Date, to: Date, q: TrackQuery,
) {
  if (!(await vehicleExistsInOrg(vehicleId, orgId))) return null

  const sample = await findSampledFixes(vehicleId, from, to)
  if (sample === null) {
    throw new ServiceUnavailableError(
      'Track window too large to serve right now — narrow the window and retry',
    )
  }

  // Distance thinning still applies: a unit parked for a week fills every
  // bucket with the same coordinate, and those add nothing to a polyline.
  const points: TrackPoint[] = []
  for (const r of sample.rows) {
    const t = r.captured_at.getTime()
    const prev = points[points.length - 1]
    // `gap_before` must survive thinning — it belongs to the next point
    // actually drawn, exactly as in findTrack.
    if (prev && !r.gap_before && metresBetween(prev.lat, prev.lng, r.lat, r.lng) < q.minSpacingM) continue
    points.push({
      t, lat: r.lat, lng: r.lng,
      spd: r.speed_kmh, hdg: r.heading_deg, eng: r.engine_on,
      ...(r.gap_before ? { gapBefore: true as const } : {}),
    })
  }

  return {
    resolution: 'sampled' as const,
    /** Seconds of wall clock each sample stands for. */
    sampleBucketSec: sample.bucketSec,
    samples: sample.rows.length,
    points,
    // Deliberately absent rather than guessed: this path never read every fix
    // in the window, so it cannot say how many there were, and reporting the
    // sample count as `fixes` would be a lie a client would happily plot.
    fixes: null,
    truncated: false,
    firstAt: points[0]?.t ?? null,
    lastAt:  points[points.length - 1]?.t ?? null,
    // Engine state is a claim about the newest fix, which sampling may have
    // skipped over. Left null here rather than inferred from a sample.
    engineOffSinceMs: null,
    engineOffRunsPastWindow: false,
  }
}

interface SnapshotPosition { lat: number | null; lng: number | null; capturedAt: string | null }

/**
 * One open dispatch, as the trip card renders it.
 *
 * `from` is the yard rather than the vehicle's first fix of the run. Those are
 * different claims and the difference matters: telemetry retention is finite,
 * so on an older dispatch the earliest fix still held can be hours after the
 * unit actually left, and "where we first saw it" would then be presented as
 * "where it set off". Every dispatch leaves from a gate, so the gate is the
 * honest origin — and it is stated or measured, not assumed.
 *
 * ## Which gate
 *
 * The DISPATCH'S, falling back to the organisation's hub. The two are the same
 * thing for a fleet dispatching out of its own yard and are nothing like each
 * other otherwise: the live sales runs are Menengai trucks signed out at
 * Naitiri, a West Kenya Sugar factory. Measuring those from Menengai's hub
 * would put the origin ~250 km from where the wheels turned — and Menengai has
 * no hub recorded at all, so before the dispatch gate was consulted here those
 * runs had no origin, which meant no leg length, no percentage and no bar.
 *
 * It also fixes a quieter failure. With no yard, `fromYardM` is null, so
 * `atYard` is false, so the leg resolves to 'outbound' for a truck standing
 * still in the yard — and getFleetSnapshot's day filter keeps any run whose leg
 * is 'outbound'. A sales row the provider never closed therefore stayed on the
 * vehicle indefinitely, declaring 29 t on the bed of a parked truck. With a
 * real origin the same truck reads 'at-yard' and the filter drops it.
 */
function buildTrip(
  open: import('../dispatches/dispatch.repository.js').OpenTrip,
  hub: import('../../lib/dispatch-trip.js').Point | null,
  hubName: string | null,
  v: SnapshotPosition,
) {
  const current = v.lat != null && v.lng != null ? { lat: v.lat, lng: v.lng } : null
  const destination = open.destinationLat != null && open.destinationLng != null
    ? { lat: open.destinationLat, lng: open.destinationLng }
    : null

  const yard = open.originLat != null && open.originLng != null
    ? { lat: open.originLat, lng: open.originLng }
    : hub
  const yardName = open.originName ?? hubName

  const geo = tripGeometry({
    yard,
    destination,
    destinationSpreadM: open.destinationSpreadM,
    current,
    arrived: open.arrivedAt != null,
    // The vehicle's newest fix AT OR AFTER the dispatch clock, from the
    // dispatch lookup — not the snapshot's `capturedAt`, which is its newest
    // fix full stop and may predate the dispatch entirely. 20 of the 52 open
    // runs are on units that have not reported since they were raised.
    hasFixSinceDispatch: open.lastFixAt != null,
  })

  return {
    externalId:   open.externalId,
    driverName:   open.driverName,
    status:       open.status,
    // The two anchors travel with the trip so a client can re-derive the
    // position along it from a LIVE frame. The figures below are computed from
    // the snapshot's fix, which is up to a sweep old; the SSE stream then moves
    // the vehicle without re-sending the trip, and a bar that only advanced on
    // snapshot refresh would sit still while the truck visibly drove.
    yardLat:      yard?.lat ?? null,
    yardLng:      yard?.lng ?? null,
    yardName,
    destination:  open.destination,
    destinationLat: open.destinationLat,
    destinationLng: open.destinationLng,
    /** How well-founded the destination point is; 0 samples = not placed. */
    destinationSamples: open.destinationSamples,
    destinationSpreadM: open.destinationSpreadM,
    destinationSource:  open.destinationSource,
    /**
     * When the wheels turned, which for a sales run is when the guard signed
     * the unit out — `dispatches.dispatched_at` is written from `signOutTime`
     * and from nothing else (see webhooks/raifactorysuite-events' handleSale,
     * which refuses to store a run that has not been signed out at all).
     * So this is the ACTUAL departure, not the moment paperwork was raised.
     */
    departedAt:   open.dispatchedAt,
    departureIsSignOut: open.departureIsSignOut,
    serialNumber: open.serialNumber,
    arrivedAt:    open.arrivedAt,
    /**
     * Kilometres actually DRIVEN since local midnight. Deliberately alongside
     * `percent`, never instead of it: percent is a position along the round
     * trip and this is ground covered, and on real data they diverge wildly —
     * a unit that reached its destination yesterday reads 50% of the round
     * trip and 0 km today. Both are shown, each labelled for what it is,
     * because a card saying "27.8 km covered" beside a brief saying "0.2 km
     * today" is the operator's problem, not a rounding difference.
     */
    distanceTodayKm: open.distanceTodayM != null
      ? Math.round(open.distanceTodayM / 100) / 10
      : null,
    lastFixAt:    open.lastFixAt,
    dueBackAt:    open.dueBackAt,
    dueBackSource: open.dueBackSource,
    ...geo,
  }
}

/**
 * @param vehicleIds  NULL for the whole fleet, or the set this caller may see.
 *   Applied AFTER the warm cache on purpose: the cache is per-organisation and
 *   expensive to build (tens of seconds on this data), so it must stay shared
 *   between callers rather than being rebuilt per permission set. Filtering a
 *   few hundred rows afterwards costs nothing.
 */
export async function getFleetSnapshot(orgId: string, vehicleIds: Set<string> | null = null) {
  // Warmed cache — the snapshot is each client's first paint only; the live
  // SSE stream takes over immediately after (see fleet-snapshot.cache.ts).
  const cached = await getFleetSnapshotCached(orgId)
  const snapshot = Array.isArray(cached) && vehicleIds
    ? cached.filter((v) => vehicleIds.has((v as { vehicleId: string }).vehicleId))
    : cached

  // What each vehicle is out on. Warmed, so this adds no query to the request
  // path — see open-trips.cache.
  const { yard, yardName, byVehicle: openTrips } = await getOpenTripsCached(orgId)
  // Hoisted: the day boundary is the same for all 597 rows, and recomputing it
  // per vehicle would allocate a Date and format it six hundred times a request.
  const dayStart = fleetDayStartIso()

  // Decorate with assigned-geofence containment.
  //
  // This CANNOT come from the SSE stream alone. Wialon only emits a frame when
  // a unit's fix time advances, so a parked vehicle may not produce one for
  // hours — and a parked vehicle is exactly the one an operator opens the card
  // to inspect. Without this, its containment badge stayed blank indefinitely
  // while moving vehicles got one within seconds.
  //
  // Free to compute: assignedZoneStatus reads the poller's in-memory presence
  // and zone caches, so this adds no query to a request that is already served
  // from a warm cache. It is deliberately applied AFTER the cache rather than
  // inside it, so containment is current even when the cached rows are a sweep
  // interval old.
  // findFleetSnapshot returns a flat ARRAY of vehicle rows (the response
  // wrapper is what adds `data`), so map it directly.
  if (!Array.isArray(snapshot)) return snapshot
  return snapshot.map(v => {
    const zones = assignedZoneStatus(orgId, v.vehicleId)
    // Current moving/resting run. `lastMovedAt` is the fallback for a vehicle
    // parked since before this process started: it emits no frames, so it is
    // absent from the in-memory tracker, but its last moving ping in the
    // database IS the moment it stopped. Without this the card showed nothing
    // for exactly the vehicles that have been resting longest.
    const row = v as { lastMovedAt?: Date | string | null; capturedAt?: Date | string | null; engineOn?: boolean }
    const fixMs = row.capturedAt
      ? (typeof row.capturedAt === 'string' ? Date.parse(row.capturedAt) : row.capturedAt.getTime())
      : null
    const movement = movementState(v.vehicleId, row.lastMovedAt, fixMs)

    // Keep the row self-consistent. The in-memory tracker is fed by the live
    // frame pipeline and can be fresher than the snapshot's newest stored row
    // — most visibly right after ignition support shipped, when a vehicle that
    // has not moved since still carries a row written before ignition was
    // read. Without this the card says "Idling" beside an ENGINE tile reading
    // "off". Only the two states that are POSITIVE evidence of a running
    // engine correct the field; 'resting' leaves it alone, because it can mean
    // either "off" or "not reported".
    const engineOn = (movement?.state === 'idling' || movement?.state === 'moving')
      ? true
      : row.engineOn

    // The provider's own connection verdict. Attached here for the same reason
    // as `zones` above — an OFFLINE unit emits no frame by definition, so this
    // can never arrive through the telemetry stream, and inferring it from the
    // age of the newest ping is measurably wrong (see lib/connection-state).
    //
    // `null` when the poller has no current answer (this process polls no
    // provider, or the sweep has stalled). Clients then fall back to the
    // last-reported window rather than being told the fleet is offline.
    const conn = connectionStatus((v as { deviceId?: string | null }).deviceId)

    // The round trip this unit is on, if any.
    //
    // A dispatch is a there-and-back run from the yard, and the provider
    // records only the far end of it, so the geometry is assembled here from
    // three measured points: the yard, the destination (both from
    // sync:destinations) and the vehicle's own current fix.
    const open = openTrips.get(v.vehicleId)
    // `yard`/`yardName` here are the ORGANISATION's, and are only the fallback
    // — buildTrip prefers the gate the dispatch itself names.
    const built = open ? buildTrip(open, yard, yardName, v as SnapshotPosition) : null

    // Is this still the vehicle's CURRENT run?
    //
    // Today's dispatches always are. Yesterday's only count while the unit is
    // demonstrably still out on them — a run that crossed local midnight is
    // the truck's current trip in every sense except the calendar, and this
    // fleet's typical round trip is long enough (≈19 h to Nyaondo) that most
    // in-flight runs are in that state for part of the day. A yesterday row on
    // a unit sitting in the yard, or one that has not reported at all, is the
    // stale paperwork the day filter exists to remove.
    //
    // 'back' counts too, and that is not a loosening. A TRIP IS COMPLETED BY
    // THE SIGN-IN, not by the truck arriving: the guard signs it in, the
    // provider records a return, `actual_return_at` is set and the row leaves
    // the open set entirely — which is why a completed run never reaches this
    // line at all. So a row that is still open while its unit stands at the
    // gate is a run with the paperwork outstanding, and dropping it hid exactly
    // the state somebody needs to act on.
    //
    // It cannot readmit the stale paperwork above, because `tripGeometry` only
    // reaches 'back' through `arrived` — a unit that never left is 'at-yard'
    // and stays excluded.
    const trip = built && (
      built.departedAt >= dayStart ||
      built.leg === 'outbound' || built.leg === 'at-destination' ||
      built.leg === 'returning' || built.leg === 'back'
    ) ? built : null

    // Has the load come off?
    //
    // A trip is CLOSED by the sign-in, but the bed is emptied long before that
    // — a sales run tips its sugar at the customer and drives home with nothing
    // on it, and on this route the gap between the two is the whole return leg
    // plus however long the paperwork takes. Carrying the declared tonnage
    // until the sign-in would have every truck on the way back from Raiply
    // counted into the fleet's in-transit stock, which is a real figure on the
    // dashboard and would have been overstated by exactly the homebound half of
    // every run.
    //
    // THE EXIT FROM THE ZONE, NOT THE ENTRY. Arriving is not offloading: a
    // truck that has just rolled through the Raiply gate is standing in the
    // yard with its sugar still on, waiting its turn at the bay, and the
    // in-transit figure was writing that load off at the moment the wheels
    // crossed the line — up to an hour early on this route, and visible on the
    // vehicle card as "Empty" beside a unit nobody had unloaded yet.
    //
    // 'returning' and 'back' are exactly the pair that means "went in, and has
    // since come out": `tripGeometry` reaches neither except through `arrived`
    // — the first fix recorded INSIDE the arrival radius since the dispatch
    // clock, computed from history in dispatch.repository — and reaches them
    // only while the current fix is outside it. Entry alone is
    // 'at-destination', which is now a LADEN state.
    //
    // A unit that tips and then parks inside the perimeter overnight therefore
    // reads as laden until it pulls out. That is the honest answer: the only
    // evidence of the bags moving that this system has is the truck leaving
    // without them.
    //
    // Only a SALES run declares a weight at all, so this cannot empty a cane
    // truck, which is loaded in the other direction: out empty, home full.
    const delivered = trip != null
      && (trip.leg === 'returning' || trip.leg === 'back')
    const declared = trip && !delivered ? open : null

    return {
      ...v,
      zones,
      movement,
      engineOn,
      // The dispatch driver WINS over the vehicle assignment while a run is
      // open, and this is the only place that is decided.
      //
      // Assignments are derived from dispatch history (there is no assignment
      // endpoint), so they are a lagging summary of the same source: 502 of
      // SUKARI's 597 active vehicles have none at all and render "Unassigned",
      // and of the vehicles that do, 19 of the 52 currently out carry more than
      // one open assignment — the snapshot picks one of those arbitrarily, so
      // some showed a driver who is not the person on the run. The dispatch
      // names the driver who took the keys, for the trip being displayed.
      driver: open?.driverName ?? v.driver,
      driverSource: open ? 'dispatch' : (v.driver ? 'assignment' : null),
      // The declared load WINS over the telemetry channel, for the same reason
      // the dispatch driver does — and more decisively, because there is no
      // competing measurement at all. `cargo_weight_kg` is a load-cell channel
      // and nothing on this fleet fills it (wialon.adapter hardcodes it null),
      // so the Current Cargo card has read "Empty · 0 TONNES" for every real
      // vehicle since it was built. The sales office knows the tonnage; an open
      // SALES run is where the card can learn it.
      //
      // Read from `declared`, which is `open` narrowed twice — and each
      // narrowing is a different mistake this used to make.
      //
      // FIRST, by `trip`. `open` is any dispatch row still lacking a return;
      // `trip` is the one that survived the day filter below, i.e. the run the
      // vehicle is actually on. Sourcing the load from `open` meant a sales row
      // the provider never closed kept declaring its tonnage after its trip had
      // been dropped as stale — 29 t of sugar on the bed of a truck with no
      // journey next to it, which is precisely the state an operator reads as
      // "loaded and waiting".
      //
      // SECOND, by delivery. See `delivered` above: the sugar comes off at the
      // far end, hours before the guard closes the run.
      //
      // Falls through untouched for a cane run or an idle unit, so a fleet with
      // real load cells would keep using them — and a load cell outranks a
      // declaration in both directions, because it is the only one of the two
      // that is a measurement of what is on the bed right now.
      cargoWeightKg: declared?.cargoTonnes != null ? declared.cargoTonnes * 1000 : v.cargoWeightKg,
      cargoDesc:     declared?.cargoName ?? v.cargoDesc,
      /** 50 kg bags in the declared load — the unit the yard actually counts. */
      cargoBags:     declared?.cargoBags ?? null,
      trip,
      connectionOnline:    conn?.online    ?? null,
      connectionCheckedAt: conn?.checkedAt ?? null,
    }
  })
}

export async function getLatestPing(vehicleId: string, orgId: string) {
  const ping = await findLatest(vehicleId, orgId)
  if (ping === null && ping !== undefined) throw new NotFoundError('Vehicle not found')
  return ping
}

export async function getActiveAlerts(orgId: string) {
  return findActiveAlerts(orgId)
}

export async function getAlertHistoryCounts(orgId: string) {
  return findAlertHistoryCounts(orgId)
}

// The maintenance reads below serve from the warmed in-memory caches
// (maintenance.cache.ts) — the remote DB is never on the request path.

export async function getMaintenanceHistory(orgId: string, days?: number, to?: Date) {
  return getMaintenanceHistoryCached(orgId, days ?? 14, to)
}

export async function getVehicleServiceHistory(orgId: string, vehicleId: string) {
  const maint = await getOrgVehicleMaintenance(orgId)
  if (!maint.vehicleIds.includes(vehicleId)) throw new NotFoundError('Vehicle not found')
  return maint.services[vehicleId] ?? []
}

export async function getVehicleGarageVisits(orgId: string, vehicleId: string) {
  const maint = await getOrgVehicleMaintenance(orgId)
  if (!maint.vehicleIds.includes(vehicleId)) throw new NotFoundError('Vehicle not found')
  return maint.visits[vehicleId] ?? []
}
