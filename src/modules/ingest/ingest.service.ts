import { prisma } from '../../lib/prisma.js'
import { emitTelemetry } from '../../lib/sse.js'
import { isInsideFence } from '../../lib/geofence.js'
import { emitViolation } from '../../lib/sse.js'
import { createLimiter } from '../../lib/concurrency.js'
import { logger } from '../../lib/logger.js'
import type { TelemetryPayload } from './ingest.schema.js'
import type { FenceGeometry } from '../../lib/geofence.js'
import { NotFoundError } from '../../core/errors/errors.js'

// Bounds the fire-and-forget raw-payload writes below so a burst of frames
// can't pile up unbounded connections against the pool.
const rawPayloadLimit = createLimiter(4)

/**
 * The three ignition-provenance columns for one frame.
 *
 * `ignitionSource` is DERIVED here rather than accepted from the caller, and
 * only ever SENSOR or NONE. The enum carries METER and VOLTAGE because both
 * were candidate routes; both were then measured and rejected — the counter
 * ticks every ~5 minutes against ~26 s fixes, and voltage is read live and
 * never persisted, so 0 of 200,000 payloads carry it. Letting a caller name a
 * source we cannot honour would put a value in the column that no measurement
 * stands behind.
 */
export function ignitionColumns(dto: TelemetryPayload): {
  ignitionKnown: boolean
  ignitionSource: 'SENSOR' | 'NONE'
  engineHoursMeter: number | null
} {
  const known = dto.ignitionKnown
    ?? Boolean((dto.rawPayload as { ignition_known?: boolean } | undefined)?.ignition_known)
  const meter = dto.engineHoursMeter
    ?? (dto.rawPayload as { engine_hours?: number } | undefined)?.engine_hours
  return {
    ignitionKnown:    known,
    ignitionSource:   known ? 'SENSOR' : 'NONE',
    engineHoursMeter: typeof meter === 'number' && Number.isFinite(meter) ? meter : null,
  }
}

export async function processTelemetry(
  orgId: string,
  dto: TelemetryPayload,
  // Pre-resolved vehicleId/driverId, supplied by the poller from its 5-min
  // device cache. Trusted internal callers (the poller) skip 2 DB round-trips
  // this way; the public /ingest HTTP endpoint (external devices, a different
  // trust boundary) omits this and falls back to the full lookup + org check.
  resolved?: { vehicleId: string; driverId: string | null },
) {
  let vehicleId: string
  let driverId: string | null

  if (resolved) {
    vehicleId = resolved.vehicleId
    driverId  = resolved.driverId
  } else {
    // 1. Resolve vehicle — must belong to the authenticated org
    const vehicle = await prisma.vehicle.findFirst({
      where: { deviceId: dto.deviceId, organisationId: orgId },
      select: { id: true },
    })
    if (!vehicle) throw new NotFoundError(`Device ${dto.deviceId} not registered in this organisation`)
    vehicleId = vehicle.id

    // 2. Resolve active driver (point-in-time)
    const assignment = await prisma.vehicleAssignment.findFirst({
      where: { vehicleId, unassignedAt: null },
      select: { userId: true },
    })
    driverId = assignment?.userId ?? null
  }

  // 3. Upsert telemetry row (@@unique on deviceId+capturedAt makes this idempotent)
  const ping = await prisma.vehicleTelemetry.upsert({
    where: { deviceId_capturedAt: { deviceId: dto.deviceId, capturedAt: dto.capturedAt } },
    create: {
      vehicleId,
      deviceId:      dto.deviceId,
      driverId,
      capturedAt:    dto.capturedAt,
      lat:           dto.lat,
      lng:           dto.lng,
      altitudeM:     dto.altitudeM,
      headingDeg:    dto.headingDeg,
      accuracyM:     dto.accuracyM,
      speedKmh:      dto.speedKmh,
      engineOn:      dto.engineOn ?? false,
      // Ignition provenance, persisted per fix.
      //
      // These columns were added and backfilled on 2026-08-26 but never wired
      // to ingest, so they became a seven-day island of history that would have
      // aged out with retention: measured 2026-08-27, ~95% populated three to
      // seven days back and 0% on the most recent day.
      //
      // `ignitionKnown` falls back to the raw payload because that is where the
      // Wialon adapter has always stamped it, and it is the same expression the
      // backfill read — so a row written today and a row filled in from history
      // mean the same thing. The explicit DTO field is preferred over it: the
      // raw payload is documented as diagnostic and written fire-and-forget,
      // which is not a foundation for a column a theft verdict rests on.
      ...ignitionColumns(dto),
      fuelLevelMl:   dto.fuelLevelMl,
      fuelUsedMl:    dto.fuelUsedMl,
      cargoWeightKg: dto.cargoWeightKg,
    },
    update: {},   // on conflict do nothing — first write wins
    select: { id: true, vehicleId: true, capturedAt: true, speedKmh: true,
              engineOn: true, fuelLevelMl: true, lat: true, lng: true },
  })

  // 4. Broadcast to SSE clients immediately — doesn't wait on the raw-payload
  //    write below, which nothing downstream needs synchronously.
  emitTelemetry(orgId, vehicleId, {
    id:          ping.id.toString(),
    vehicleId:   ping.vehicleId,
    capturedAt:  ping.capturedAt,
    speedKmh:    ping.speedKmh,
    engineOn:    ping.engineOn,
    fuelLevelMl: ping.fuelLevelMl,
    lat:         ping.lat,
    lng:         ping.lng,
  })

  // 5. Store raw payload separately (no relation — intentional to avoid eager
  //    load) — fire-and-forget, bounded by rawPayloadLimit, same pattern as
  //    the geofence evaluation below. It's diagnostic data; nothing in the
  //    request/SSE path depends on it having landed yet.
  if (dto.rawPayload) {
    void rawPayloadLimit(() =>
      prisma.vehicleTelemetryRaw.upsert({
        where: { telemetryId: ping.id },
        create: { telemetryId: ping.id, payload: dto.rawPayload as object },
        update: {},
      }),
    ).catch(err => logger.warn({ err, deviceId: dto.deviceId }, 'raw telemetry payload write failed'))
  }

  // 6. Geofence evaluation — async fire-and-forget (never blocks ingest response)
  if (dto.lat != null && dto.lng != null) {
    evaluateGeofences(orgId, vehicleId, driverId, ping.id, dto.lat, dto.lng, dto.speedKmh ?? null).catch(() => undefined)
  }

  return ping.id
}

async function evaluateGeofences(
  orgId: string,
  vehicleId: string,
  driverId: string | null,
  pingId: bigint,
  lat: number,
  lng: number,
  speedKmh: number | null,
) {
  const fences = await prisma.vehicleGeofence.findMany({
    // Only ENFORCED fences are evaluated. Definitions imported from the
    // provider land inactive, so syncing zones can never silently start
    // raising violations across the fleet.
    where: { vehicleId, geofence: { isActive: true } },
    include: {
      geofence: {
        select: {
          id: true, type: true, mode: true,
          centerLat: true, centerLng: true, radiusM: true, polygonCoords: true,
          widthM: true, organisationId: true,
        },
      },
    },
  })

  for (const vg of fences) {
    const fence = vg.geofence
    if (!fence.organisationId || fence.organisationId !== orgId) continue

    let geometry: FenceGeometry
    if (fence.type === 'CIRCLE') {
      if (fence.centerLat == null || fence.centerLng == null || fence.radiusM == null) continue
      geometry = { type: 'CIRCLE', centerLat: fence.centerLat, centerLng: fence.centerLng, radiusM: fence.radiusM }
    } else if (fence.type === 'LINE') {
      // Corridor — polygonCoords holds the centre-line, widthM its width.
      if (!fence.polygonCoords || fence.widthM == null) continue
      geometry = { type: 'LINE', pathCoords: fence.polygonCoords as [number, number][], widthM: fence.widthM }
    } else {
      if (!fence.polygonCoords) continue
      geometry = { type: 'POLYGON', polygonCoords: fence.polygonCoords as [number, number][] }
    }

    const inside = isInsideFence(lat, lng, geometry)
    const isViolation =
      (fence.mode === 'ALLOWLIST' && !inside) ||
      (fence.mode === 'BLOCKLIST' && inside)

    if (!isViolation) continue

    // Check for an open (unresolved) violation to avoid spam-inserting
    const existing = await prisma.geofenceViolation.findFirst({
      where: { vehicleId, geofenceId: fence.id, resolvedAt: null },
    })
    if (existing) continue

    const violation = await prisma.geofenceViolation.create({
      data: {
        vehicleId, geofenceId: fence.id, driverId,
        occurredAt: new Date(), lat, lng,
        speedKmh: speedKmh ?? undefined,
        notifiedAt: new Date(),
      },
    })

    emitViolation(orgId, vehicleId, {
      violationId: violation.id,
      geofenceId:  fence.id,
      vehicleId,
      occurredAt:  violation.occurredAt,
      lat, lng,
    })
  }
}
