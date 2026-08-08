import { findPings, findTrack, findLatest, findActiveAlerts, findAlertHistoryCounts } from './telemetry.repository.js'
import { getMaintenanceHistoryCached, getOrgVehicleMaintenance } from './maintenance.cache.js'
import { getFleetSnapshotCached } from './fleet-snapshot.cache.js'
import type { TelemetryListQuery, TrackQuery } from './telemetry.schema.js'
import { NotFoundError } from '../../core/errors/errors.js'
import { assignedZoneStatus } from '../../lib/zone-presence.js'
import { movementState } from '../../lib/movement-state.js'
import { connectionStatus } from '../../lib/connection-state.js'
import { getOpenTripsCached } from '../dispatches/open-trips.cache.js'
import { tripGeometry } from '../../lib/dispatch-trip.js'
import { fleetDayStart } from '../../lib/provider-time.js'

/** Fleet-local midnight as an ISO string, so it compares against `departedAt`
 *  (which is already an ISO instant) without re-parsing per vehicle. */
const fleetDayStartIso = () => fleetDayStart().toISOString()

export async function listPings(vehicleId: string, orgId: string, q: TelemetryListQuery) {
  const result = await findPings(vehicleId, orgId, q)
  if (!result) throw new NotFoundError('Vehicle not found')
  return result
}

export async function getVehicleTrack(vehicleId: string, orgId: string, q: TrackQuery) {
  const result = await findTrack(vehicleId, orgId, q)
  if (!result) throw new NotFoundError('Vehicle not found')
  return result
}

interface SnapshotPosition { lat: number | null; lng: number | null; capturedAt: string | null }

/**
 * One open dispatch, as the trip card renders it.
 *
 * `from` is the yard rather than the vehicle's first fix of the run. Those are
 * different claims and the difference matters: telemetry retention is finite,
 * so on an older dispatch the earliest fix still held can be hours after the
 * unit actually left, and "where we first saw it" would then be presented as
 * "where it set off". Every dispatch leaves from the plant, so the plant is the
 * honest origin — and it is measured, not assumed (see sync-destinations).
 */
function buildTrip(
  open: import('../dispatches/dispatch.repository.js').OpenTrip,
  yard: import('../../lib/dispatch-trip.js').Point | null,
  yardName: string | null,
  v: SnapshotPosition,
) {
  const current = v.lat != null && v.lng != null ? { lat: v.lat, lng: v.lng } : null
  const destination = open.destinationLat != null && open.destinationLng != null
    ? { lat: open.destinationLat, lng: open.destinationLng }
    : null

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
    departedAt:   open.dispatchedAt,
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

export async function getFleetSnapshot(orgId: string) {
  // Warmed cache — the snapshot is each client's first paint only; the live
  // SSE stream takes over immediately after (see fleet-snapshot.cache.ts).
  const snapshot = await getFleetSnapshotCached(orgId)

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
    const trip = built && (
      built.departedAt >= dayStart ||
      built.leg === 'outbound' || built.leg === 'at-destination' || built.leg === 'returning'
    ) ? built : null

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
