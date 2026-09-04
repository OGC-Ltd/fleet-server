/**
 * Read-only live-event follower — for API-only instances (POLL_ENABLED=false).
 *
 * The deployment that runs the poller/sim persists every telemetry frame to
 * the shared DB, but its dashboard SSE events (positions + live feed) exist
 * only in THAT process — an API-only instance's /live stream stays silent, so
 * a local dev dashboard shows a frozen map and an empty feed.
 *
 * This follower tails the shared DB: every FOLLOW_INTERVAL_MS it reads the
 * latest persisted ping per sim-fleet vehicle and re-emits the same dashboard
 * SSE events the poller's telemetry.worker would have (emitDashboardPosition +
 * deriveFeedEvents). It performs ZERO writes — no alerts:sync, no
 * simEvents:persist, no notifications — so it can never fight the writer the
 * way a second sim would (see config/env.ts's POLL_ENABLED note).
 *
 * Known gap: engineTempC/oilLevelPct aren't persisted with the frame (they
 * live only in the poller's in-process pipeline), so followed positions carry
 * null there and the dashboard shows "—" for those two vitals.
 */

import { prisma } from './prisma.js'
import { Prisma } from '../../generated/prisma/client.js'
import { logger } from './logger.js'
import { emitDashboardPosition } from './sse.js'
import { deriveFeedEvents } from './feed-events.js'
import type { DashboardPositionPayload } from './workers/telemetry.worker.js'

const FOLLOW_INTERVAL_MS = 30_000        // matches the writer's poll cadence
const META_TTL_MS        = 5 * 60_000    // same staleness budget as the poller's device cache

interface VehicleMeta {
  orgId:          string
  vehicleName:    string
  plate:          string
  tankCapacityMl: number
  /**
   * The capacity Wialon actually states, in litres, or null when it states
   * none. Distinct from `tankCapacityMl` above, which falls back to 200 L so
   * the low-fuel alert always has a denominator.
   *
   * That fallback must not reach the screen. A percentage computed against an
   * assumed 200 L tank is a made-up number wearing a real one's clothes, and
   * 356 of 822 vehicles have no stated capacity at all. Blank is the honest
   * rendering for those, so this stays nullable all the way to the client.
   *
   * Source is Wialon and only Wialon: the operators encode the tank size in the
   * fuel sensor's NAME, e.g. "2.Main Tank Fuel Level Qty (95L)", and
   * `prisma/sync-wialon.ts` reads it with `tankCapacityOf`. Nothing here
   * derives, infers or defaults it.
   */
  tankCapacityL:  number | null
  driverName:     string | null
  vehicleType:    string | null
}

let metaCache    = new Map<string, VehicleMeta>()   // vehicleId → meta
let metaLoadedAt = 0

async function getMeta(): Promise<Map<string, VehicleMeta>> {
  if (Date.now() - metaLoadedAt < META_TTL_MS && metaCache.size > 0) return metaCache
  const rows = await prisma.vehicle.findMany({
    where: { isActive: true },
    select: {
      id: true,
      organisationId: true,
      name: true,
      registrationPlate: true,
      tankCapacityLitres: true,
      vehicleType:        true,
      assignments: {
        where: { unassignedAt: null },
        select: { user: { select: { fullName: true } } },
        take: 1,
      },
    },
  })
  metaCache = new Map(rows.map(r => [r.id, {
    orgId:          r.organisationId,
    vehicleName:    r.name,
    plate:          r.registrationPlate,
    tankCapacityMl: (r.tankCapacityLitres ?? 200) * 1000,
    tankCapacityL:  r.tankCapacityLitres ?? null,
    driverName:     r.assignments[0]?.user.fullName ?? null,
    vehicleType:    r.vehicleType ?? null,
  }]))
  metaLoadedAt = Date.now()
  return metaCache
}

interface FollowRow {
  vehicle_id: string
  device_id:  string
  captured_at: Date
  lat: number | null; lng: number | null; heading_deg: number | null
  speed_kmh: number | null; engine_on: boolean
  fuel_level_ml: number | null; cargo_weight_kg: number | null
  cargo_desc: string | null
  phase: string | null
  leg: DashboardPositionPayload['leg']
  maintenance: { nextServiceOdoKm: number; inMaintenance: boolean; maintenanceEndsAtMs: number | null; resetOdoKm: number; garageLat: number | null; garageLng: number | null } | null
  odometer_km: number | null
  flags: Partial<DashboardPositionPayload['flags']> | null
  door_status: string | null
}

// vehicleId → capturedAt ms of the last frame we re-emitted, so an unchanged
// row (writer down, vehicle parked overnight) isn't re-broadcast every cycle.
const lastSeenAt = new Map<string, number>()

let isRunning = false

async function runOneCycle(): Promise<void> {
  if (isRunning) return
  isRunning = true
  const t0 = Date.now()
  try {
    const meta = await getMeta()
    const vehicleIds = [...meta.keys()]
    if (vehicleIds.length === 0) return

    // Latest new-code ping per vehicle — same LATERAL shape as the fleet
    // snapshot query (telemetry.repository.ts), which stays fast because each
    // vehicle walks its (vehicle_id, captured_at) index newest-first.
    const rows = await prisma.$queryRaw<FollowRow[]>`
      SELECT p.* FROM unnest(ARRAY[${Prisma.join(vehicleIds)}]::text[]) AS v(id)
      CROSS JOIN LATERAL (
        SELECT
          t.vehicle_id, t.device_id, t.captured_at,
          t.lat, t.lng, t.heading_deg, t.speed_kmh, t.engine_on,
          t.fuel_level_ml, t.cargo_weight_kg,
          -- _sim.* are legacy simulator extras; live RaiFactorySuite pings
          -- return NULL here and the dashboard degrades gracefully.
          r.payload->'_sim'->'leg'        AS leg,
          r.payload->'_sim'->>'cargoDesc' AS cargo_desc,
          r.payload->'_sim'->>'phase'     AS phase,
          r.payload->'_sim'->'maintenance' AS maintenance,
          (r.payload->>'odometer_km')::float AS odometer_km,
          r.payload->'flags'              AS flags,
          r.payload->>'doorStatus'        AS door_status
        FROM vehicle_telemetries t
        JOIN vehicle_telemetry_raws r ON r.telemetry_id = t.id
        WHERE t.vehicle_id = v.id
        ORDER BY t.captured_at DESC
        LIMIT 1
      ) p
    `

    let emitted = 0
    for (const row of rows) {
      const m = meta.get(row.vehicle_id)
      if (!m) continue
      const capturedMs = row.captured_at.getTime()
      if ((lastSeenAt.get(row.vehicle_id) ?? 0) >= capturedMs) continue
      lastSeenAt.set(row.vehicle_id, capturedMs)

      const flags: DashboardPositionPayload['flags'] = {
        overspeeding:        row.flags?.overspeeding        ?? false,
        fuelInconsistency:   row.flags?.fuelInconsistency   ?? false,
        doorOpenWhileMoving: row.flags?.doorOpenWhileMoving ?? false,
        lowFuel:             row.flags?.lowFuel             ?? false,
        outsideGeofence:     row.flags?.outsideGeofence     ?? false,
        lowBattery:          row.flags?.lowBattery          ?? false,
        highEngineTemp:      row.flags?.highEngineTemp      ?? false,
        lowOil:              row.flags?.lowOil              ?? false,
      }

      const payload: DashboardPositionPayload = {
        vehicleId:    row.vehicle_id,
        vehicleName:  m.vehicleName,
        plate:        m.plate,
        deviceId:     row.device_id,
        capturedAt:   row.captured_at.toISOString(),
        lat:          row.lat,
        lng:          row.lng,
        headingDeg:   row.heading_deg,
        speedKmh:     row.speed_kmh,
        engineOn:     row.engine_on,
        fuelLevelMl:  row.fuel_level_ml,
        // No `tankCapacityL` on the wire here on purpose. It is static per
        // vehicle, the fleet snapshot already carries it, and the dashboard
        // holds it across live updates (`existing.tankCapacityL`) — so a live
        // frame has nothing to add and the payload type stays put.
        //
        // Null unless Wialon stated a capacity. This used to divide by the
        // 200 L fallback, so every unprovisioned vehicle showed a confident
        // percentage of a tank size nobody had measured.
        fuelLevelPct: row.fuel_level_ml != null && m.tankCapacityL
          ? Math.round((row.fuel_level_ml / (m.tankCapacityL * 1000)) * 100)
          : null,
        cargoWeightKg: row.cargo_weight_kg,
        cargoDesc:    row.cargo_desc,
        doorStatus:   row.door_status ?? undefined,
        engineTempC:  null,   // not persisted — see module doc
        oilLevelPct:  null,
        leg:          row.leg,
        odometerKm:          row.odometer_km,
        nextServiceOdoKm:    row.maintenance?.nextServiceOdoKm ?? null,
        inMaintenance:       row.maintenance?.inMaintenance ?? false,
        maintenanceEndsAtMs: row.maintenance?.maintenanceEndsAtMs ?? null,
        maintenanceResetOdoKm: row.maintenance?.resetOdoKm ?? 0,
        garageLat:    row.maintenance?.garageLat ?? null,
        garageLng:    row.maintenance?.garageLng ?? null,
        phase:        row.phase,
        flags,
      }

      emitDashboardPosition(m.orgId, payload)
      deriveFeedEvents(m.orgId, {
        vehicleId:     row.vehicle_id,
        plate:         m.plate,
        driverName:    m.driverName,
        capturedAt:    payload.capturedAt,
        lat:           payload.lat,
        lng:           payload.lng,
        speedKmh:      payload.speedKmh,
        cargoWeightKg: payload.cargoWeightKg,
        cargoDesc:     payload.cargoDesc,
        vehicleType:   m.vehicleType,
        phase:         payload.phase ?? null,
        leg:           payload.leg ?? null,
        flags,
      })
      emitted++
    }

    logger.debug({ durationMs: Date.now() - t0, vehicles: rows.length, emitted }, 'DB-follower cycle complete')
  } catch (err) {
    logger.warn({ err }, 'DB-follower cycle failed — will retry next interval')
  } finally {
    isRunning = false
  }
}

export function startDbFollower(): () => void {
  logger.info({ intervalMs: FOLLOW_INTERVAL_MS }, 'DB follower starting (read-only live positions + feed off the shared DB)')
  void runOneCycle()
  const timer = setInterval(() => void runOneCycle(), FOLLOW_INTERVAL_MS)
  return () => {
    clearInterval(timer)
    logger.info('DB follower stopped')
  }
}
