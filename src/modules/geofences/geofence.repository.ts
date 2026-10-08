import { prisma } from '../../lib/prisma.js'
import type { CreateGeofence, UpdateGeofence, GeofenceListQuery } from './geofence.schema.js'

export async function create(orgId: string, createdById: string, dto: CreateGeofence) {
  return prisma.geofence.create({
    data: {
      organisationId: orgId,
      name:           dto.name,
      type:           dto.type,
      mode:           dto.mode ?? 'ALLOWLIST',
      centerLat:      dto.type === 'CIRCLE'  ? dto.centerLat  : undefined,
      centerLng:      dto.type === 'CIRCLE'  ? dto.centerLng  : undefined,
      radiusM:        dto.type === 'CIRCLE'  ? dto.radiusM    : undefined,
      polygonCoords:  dto.type === 'POLYGON' ? dto.polygonCoords : undefined,
    },
  })
}

export async function findAll(orgId: string, q: GeofenceListQuery) {
  const rows = await prisma.geofence.findMany({
    where: {
      organisationId: orgId,
      ...(q.isActive !== undefined ? { isActive: q.isActive } : {}),
      ...(q.cursor ? { id: { gt: q.cursor } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: q.limit + 1,
  })
  const hasNextPage = rows.length > q.limit
  if (hasNextPage) rows.pop()
  return { data: rows, cursor: hasNextPage ? (rows.at(-1)?.id ?? null) : null, hasNextPage }
}

export async function findById(id: string, orgId: string) {
  return prisma.geofence.findFirst({ where: { id, organisationId: orgId } })
}

// ---------------------------------------------------------------------------
// GeoJSON projection — for drawing zones as a map layer
// ---------------------------------------------------------------------------

// Category and area now live in lib/zone-taxonomy, so the notification layer
// can classify a zone by the SAME rule the overlay colours it by. Re-exported
// because `ZoneCategory` is part of this module's published shape.
export { categorise, type ZoneCategory } from '../../lib/zone-taxonomy.js'
import { categorise, ringAreaHa } from '../../lib/zone-taxonomy.js'

/**
 * Every zone in the org as a GeoJSON FeatureCollection, ready to draw.
 *
 * CIRCLE zones emit as a Point carrying `radiusM` rather than a synthesised
 * 64-gon: GeoJSON has no circle, and the client draws them with
 * google.maps.Circle, which is both exact and cheaper than a ring. The 67
 * VES sample points alone would otherwise add ~4,300 vertices to the payload.
 */
export async function findAllAsGeoJSON(orgId: string) {
  const rows = await prisma.geofence.findMany({
    where:   { organisationId: orgId },
    orderBy: { name: 'asc' },
  })

  const features = rows.map(g => {
    const coords = (Array.isArray(g.polygonCoords) ? g.polygonCoords : null) as Array<[number, number]> | null

    const properties = {
      id:       g.id,
      name:     g.name,
      category: categorise(g.name),
      fenceType: g.type,
      mode:     g.mode,
      isActive: g.isActive,
      widthM:   g.widthM,
      radiusM:  g.radiusM,
      areaHa:   g.type === 'POLYGON' && coords ? Math.round(ringAreaHa(coords)) : null,
      // Where the fence is kept. A provider's (Wialon) zone is rewritten by the
      // next sync, so the Logbook's fence tool shows it but edits only 'app'
      // fences — the ones drawn here, which no sync touches.
      source:   g.externalId ? 'provider' as const : 'app' as const,
    }

    if (g.type === 'CIRCLE') {
      return { type: 'Feature' as const, properties, geometry: { type: 'Point' as const, coordinates: [g.centerLng, g.centerLat] } }
    }
    if (g.type === 'POLYGON' && coords) {
      // GeoJSON requires the ring to close explicitly. Wialon already repeats
      // the first vertex on these, but a polygon built by hand through the API
      // may not — close it here rather than trusting the source.
      const ring = [...coords]
      const [fx, fy] = ring[0]!
      const [lx, ly] = ring[ring.length - 1]!
      if (fx !== lx || fy !== ly) ring.push([fx, fy])
      return { type: 'Feature' as const, properties, geometry: { type: 'Polygon' as const, coordinates: [ring] } }
    }
    return { type: 'Feature' as const, properties, geometry: { type: 'LineString' as const, coordinates: coords ?? [] } }
  })

  return { type: 'FeatureCollection' as const, features }
}

export async function update(id: string, orgId: string, dto: UpdateGeofence) {
  const fence = await prisma.geofence.findFirst({ where: { id, organisationId: orgId }, select: { id: true } })
  if (!fence) return null
  return prisma.geofence.update({ where: { id }, data: dto })
}

export async function remove(id: string, orgId: string) {
  const fence = await prisma.geofence.findFirst({ where: { id, organisationId: orgId }, select: { id: true } })
  if (!fence) return null
  return prisma.geofence.delete({ where: { id } })
}

export async function assignVehicle(geofenceId: string, orgId: string, vehicleId: string, assignedById: string) {
  const fence = await prisma.geofence.findFirst({ where: { id: geofenceId, organisationId: orgId }, select: { id: true } })
  if (!fence) return null
  return prisma.vehicleGeofence.upsert({
    where:  { vehicleId_geofenceId: { vehicleId, geofenceId } },
    create: { vehicleId, geofenceId, assignedById },
    update: {},
  })
}

export async function unassignVehicle(geofenceId: string, orgId: string, vehicleId: string) {
  const fence = await prisma.geofence.findFirst({ where: { id: geofenceId, organisationId: orgId }, select: { id: true } })
  if (!fence) return null
  return prisma.vehicleGeofence.deleteMany({ where: { vehicleId, geofenceId } })
}

export async function listVehicles(geofenceId: string, orgId: string) {
  const fence = await prisma.geofence.findFirst({ where: { id: geofenceId, organisationId: orgId }, select: { id: true } })
  if (!fence) return null
  return prisma.vehicleGeofence.findMany({
    where: { geofenceId },
    include: { vehicle: { select: { id: true, registrationPlate: true } } },
  })
}

export async function listViolations(geofenceId: string, orgId: string) {
  const fence = await prisma.geofence.findFirst({ where: { id: geofenceId, organisationId: orgId }, select: { id: true } })
  if (!fence) return null
  return prisma.geofenceViolation.findMany({
    where:   { geofenceId },
    orderBy: { occurredAt: 'desc' },
    take:    100,
  })
}

