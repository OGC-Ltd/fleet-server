import { prisma } from '../../lib/prisma.js'
import { Prisma } from '../../../generated/prisma/client.js'
import { ALERT_SOURCE } from '../../lib/alerts.js'
import { getSimFleetVehicleIds } from '../../lib/sim-fleet.js'
import type { TelemetryListQuery } from './telemetry.schema.js'

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
export async function findFleetSnapshot(orgId: string) {
  // Scope the map to the live-simulation fleet (org-aware — see lib/sim-fleet).
  const simFleetIds = await getSimFleetVehicleIds()
  const vehicles = await prisma.vehicle.findMany({
    where: { organisationId: orgId, id: { in: simFleetIds } },
    select: {
      id: true,
      name: true,
      registrationPlate: true,
      vehicleType: true,
      tankCapacityLitres: true,
      assignments: {
        where: { unassignedAt: null },
        select: { user: { select: { fullName: true, driverRatingScore: true } } },
        take: 1,
      },
    },
    orderBy: { name: 'asc' },
  })

  const vehicleIds = vehicles.map(v => v.id)
  if (vehicleIds.length === 0) return []

  // Latest NEW-CODE ping per vehicle in ONE query. Filtering to pings whose raw
  // payload carries `_sim.leg` means the snapshot ignores any competing writer's
  // old-format telemetry on the shared DB — the dashboard reflects only this
  // server's simulation (correct positions + journey legs).
  //
  // LATERAL per vehicle (not DISTINCT ON over the whole table): each vehicle
  // walks its (vehicle_id, captured_at) index newest-first and stops at the
  // first new-code ping — normally the very first row, since this server
  // writes `_sim.leg` on every ping it persists. The old DISTINCT ON form
  // joined + JSON-filtered every telemetry row ever recorded and took ~40s
  // on the remote pooler, growing with table size.
  interface PingRow {
    vehicle_id: string
    lat: number | null; lng: number | null; heading_deg: number | null
    speed_kmh: number | null; engine_on: boolean
    fuel_level_ml: number | null; fuel_used_ml: number | null; cargo_weight_kg: number | null
    cargo_desc: string | null
    captured_at: Date; leg: unknown
    odometer_km: number | null; maintenance: unknown; phase: string | null
  }
  const pings = await prisma.$queryRaw<PingRow[]>`
    SELECT p.* FROM unnest(ARRAY[${Prisma.join(vehicleIds)}]::text[]) AS v(id)
    CROSS JOIN LATERAL (
      SELECT
        t.vehicle_id,
        t.lat, t.lng, t.heading_deg, t.speed_kmh, t.engine_on,
        t.fuel_level_ml, t.fuel_used_ml, t.cargo_weight_kg, t.captured_at,
        r.payload->'_sim'->'leg' AS leg,
        r.payload->'_sim'->>'cargoDesc' AS cargo_desc,
        (r.payload->>'odometer_km')::float AS odometer_km,
        r.payload->'_sim'->'maintenance' AS maintenance,
        r.payload->'_sim'->>'phase' AS phase
      FROM vehicle_telemetries t
      JOIN vehicle_telemetry_raws r ON r.telemetry_id = t.id
      WHERE t.vehicle_id = v.id
        AND r.payload->'_sim'->'leg' IS NOT NULL
      ORDER BY t.captured_at DESC
      LIMIT 1
    ) p
  `
  const pingByVehicle = new Map(pings.map(p => [p.vehicle_id, p]))

  return vehicles.map((v) => {
      const ping            = pingByVehicle.get(v.id)
      const fuelLevelMl     = ping?.fuel_level_ml ?? null
      const tankCapacityMl  = (v.tankCapacityLitres ?? 200) * 1000
      const lowFuel         = fuelLevelMl != null && fuelLevelMl < tankCapacityMl * 0.20
      const fuelLevelPct    = fuelLevelMl != null
        ? Math.round((fuelLevelMl / tankCapacityMl) * 100)
        : null
      const maintenance = ping?.maintenance as
        { nextServiceOdoKm: number; inMaintenance: boolean; maintenanceEndsAtMs: number | null; resetOdoKm: number; garageLat: number | null; garageLng: number | null } | null | undefined

      return {
        vehicleId:      v.id,
        plate:          v.registrationPlate,
        name:           v.name,
        vehicleType:    v.vehicleType,
        driver:             v.assignments[0]?.user.fullName          ?? null,
        driverRatingScore:  v.assignments[0]?.user.driverRatingScore ?? null,
        lat:            ping?.lat          ?? null,
        lng:            ping?.lng          ?? null,
        headingDeg:     ping?.heading_deg  ?? null,
        speedKmh:       ping?.speed_kmh    ?? null,
        engineOn:       ping?.engine_on    ?? false,
        fuelLevelMl,
        fuelUsedMl:     ping?.fuel_used_ml ?? null,
        cargoWeightKg:  ping?.cargo_weight_kg ?? null,
        cargoDesc:      ping?.cargo_desc ?? null,
        capturedAt:     ping?.captured_at?.toISOString() ?? null,
        lowFuel,
        fuelLevelPct,
        leg:            ping?.leg ?? null,
        odometerKm:          ping?.odometer_km ?? null,
        nextServiceOdoKm:    maintenance?.nextServiceOdoKm ?? null,
        inMaintenance:       maintenance?.inMaintenance ?? false,
        maintenanceEndsAtMs: maintenance?.maintenanceEndsAtMs ?? null,
        maintenanceResetOdoKm: maintenance?.resetOdoKm ?? 0,
        garageLat:      maintenance?.garageLat ?? null,
        garageLng:      maintenance?.garageLng ?? null,
        phase:          ping?.phase ?? null,
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
