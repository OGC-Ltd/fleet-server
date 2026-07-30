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

/**
 * Land-use category, derived from the zone name.
 *
 * The estate's zones came from Wialon, which stores a name and nothing else —
 * there is no class column to read. The names are consistent enough to key off
 * (the surveyor's own convention, mirrored in ESTATE AREAS TO BE PLANTED), and
 * the category exists purely to pick a colour: an unrecognised name falls back
 * to `other` and still draws. This is presentation, never enforcement.
 */
export type ZoneCategory =
  | 'farm' | 'nursery' | 'commercial' | 'rainfed' | 'factory'
  | 'logistics' | 'facility' | 'wetland' | 'water' | 'drain' | 'road'
  | 'sample' | 'other'

export function categorise(name: string): ZoneCategory {
  const n = name.toLowerCase()
  if (n.startsWith('ves'))                          return 'sample'
  if (n.includes('farm') || n.includes('ha area'))  return 'farm'
  if (n.includes('nursery'))                        return 'nursery'
  if (n.includes('commercial'))                     return 'commercial'
  if (n.includes('rainfed') || n.includes('rain fed')) return 'rainfed'
  if (n.includes('factory site'))                   return 'factory'
  if (n.includes('logistic'))                       return 'logistics'
  if (n.includes('swamp') || n.includes('wet'))     return 'wetland'
  if (n.includes('river'))                          return 'water'
  if (n.includes('drain'))                          return 'drain'
  if (n.includes('road') || n.includes('haulage'))  return 'road'
  if (n.includes('workshop') || n.includes('residence') || n.includes('dispensary')
    || n.includes('lab') || n.includes('reservoir') || n.includes('camp')) return 'facility'
  return 'other'
}

const R = 6_371_000
const rad = (d: number) => (d * Math.PI) / 180

/** Shoelace on a local equirectangular projection — hectares. */
function ringAreaHa(pts: Array<[number, number]>): number {
  if (pts.length < 3) return 0
  const lat0 = rad(pts.reduce((s, p) => s + p[1], 0) / pts.length)
  const xy = pts.map(([lng, lat]) => [rad(lng) * Math.cos(lat0) * R, rad(lat) * R] as const)
  let a = 0
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i]!
    const [x2, y2] = xy[(i + 1) % xy.length]!
    a += x1 * y2 - x2 * y1
  }
  return Math.abs(a / 2) / 10_000
}

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

