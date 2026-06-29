import { z } from 'zod'

const coordinatePair = z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)])

export const createGeofenceSchema = z.discriminatedUnion('type', [
  z.object({
    type:      z.literal('CIRCLE'),
    name:      z.string().min(1).max(120),
    mode:      z.enum(['ALLOWLIST', 'BLOCKLIST']).default('ALLOWLIST'),
    centerLat: z.number().min(-90).max(90),
    centerLng: z.number().min(-180).max(180),
    radiusM:   z.number().int().min(10).max(100_000),
  }),
  z.object({
    type:          z.literal('POLYGON'),
    name:          z.string().min(1).max(120),
    mode:          z.enum(['ALLOWLIST', 'BLOCKLIST']).default('ALLOWLIST'),
    polygonCoords: z.array(coordinatePair).min(3),
  }),
])

export const updateGeofenceSchema = z.object({
  name:          z.string().min(1).max(120).optional(),
  mode:          z.enum(['ALLOWLIST', 'BLOCKLIST']).optional(),
  centerLat:     z.number().min(-90).max(90).optional(),
  centerLng:     z.number().min(-180).max(180).optional(),
  radiusM:       z.number().int().min(10).max(100_000).optional(),
  polygonCoords: z.array(coordinatePair).min(3).optional(),
  isActive:      z.boolean().optional(),
})

export const geofenceListQuerySchema = z.object({
  cursor:   z.string().optional(),
  limit:    z.coerce.number().int().min(1).max(100).default(20),
  isActive: z.enum(['true', 'false']).transform(v => v === 'true').optional(),
})

export const assignVehicleSchema = z.object({ vehicleId: z.string().cuid() })

export type CreateGeofence    = z.infer<typeof createGeofenceSchema>
export type UpdateGeofence    = z.infer<typeof updateGeofenceSchema>
export type GeofenceListQuery = z.infer<typeof geofenceListQuerySchema>
