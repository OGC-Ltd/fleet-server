import { prisma } from '../../lib/prisma.js'
import { emitTelemetry } from '../../lib/sse.js'
import { isInsideFence } from '../../lib/geofence.js'
import { emitViolation } from '../../lib/sse.js'
import type { TelemetryPayload } from './ingest.schema.js'
import type { FenceGeometry } from '../../lib/geofence.js'
import { NotFoundError } from '../../core/errors/errors.js'

export async function processTelemetry(orgId: string, dto: TelemetryPayload) {
  // 1. Resolve vehicle — must belong to the authenticated org
  const vehicle = await prisma.vehicle.findFirst({
    where: { deviceId: dto.deviceId, organisationId: orgId },
    select: { id: true, organisationId: true },
  })
  if (!vehicle) throw new NotFoundError(`Device ${dto.deviceId} not registered in this organisation`)

  // 2. Resolve active driver (point-in-time)
  const assignment = await prisma.vehicleAssignment.findFirst({
    where: { vehicleId: vehicle.id, unassignedAt: null },
    select: { userId: true },
  })

  // 3. Upsert telemetry row (@@unique on deviceId+capturedAt makes this idempotent)
  const ping = await prisma.vehicleTelemetry.upsert({
    where: { deviceId_capturedAt: { deviceId: dto.deviceId, capturedAt: dto.capturedAt } },
    create: {
      vehicleId:     vehicle.id,
      deviceId:      dto.deviceId,
      driverId:      assignment?.userId ?? null,
      capturedAt:    dto.capturedAt,
      lat:           dto.lat,
      lng:           dto.lng,
      altitudeM:     dto.altitudeM,
      headingDeg:    dto.headingDeg,
      accuracyM:     dto.accuracyM,
      speedKmh:      dto.speedKmh,
      engineOn:      dto.engineOn ?? false,
      fuelLevelMl:   dto.fuelLevelMl,
      fuelUsedMl:    dto.fuelUsedMl,
      cargoWeightKg: dto.cargoWeightKg,
    },
    update: {},   // on conflict do nothing — first write wins
    select: { id: true, vehicleId: true, capturedAt: true, speedKmh: true,
              engineOn: true, fuelLevelMl: true, lat: true, lng: true },
  })

  // 4. Store raw payload separately (no relation — intentional to avoid eager load)
  if (dto.rawPayload) {
    await prisma.vehicleTelemetryRaw.upsert({
      where: { telemetryId: ping.id },
      create: { telemetryId: ping.id, payload: dto.rawPayload as object },
      update: {},
    })
  }

  // 5. Broadcast to SSE clients immediately
  emitTelemetry(orgId, vehicle.id, {
    id:          ping.id.toString(),
    vehicleId:   ping.vehicleId,
    capturedAt:  ping.capturedAt,
    speedKmh:    ping.speedKmh,
    engineOn:    ping.engineOn,
    fuelLevelMl: ping.fuelLevelMl,
    lat:         ping.lat,
    lng:         ping.lng,
  })

  // 6. Geofence evaluation — async fire-and-forget (never blocks ingest response)
  if (dto.lat != null && dto.lng != null) {
    evaluateGeofences(orgId, vehicle.id, assignment?.userId ?? null, ping.id, dto.lat, dto.lng, dto.speedKmh ?? null).catch(() => undefined)
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
    where: { vehicleId },
    include: {
      geofence: {
        select: {
          id: true, type: true, mode: true,
          centerLat: true, centerLng: true, radiusM: true, polygonCoords: true,
          organisationId: true,
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
