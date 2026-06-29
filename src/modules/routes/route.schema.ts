import { z } from 'zod'

const waypointSchema = z.object({
  sequence: z.number().int().min(0),
  name:     z.string().max(120).optional(),
  lat:      z.number().min(-90).max(90),
  lng:      z.number().min(-180).max(180),
  radiusM:  z.number().int().min(10).max(5000).default(200),
})

export const createRouteSchema = z.object({
  name:            z.string().min(1).max(120),
  originName:      z.string().min(1).max(120),
  originLat:       z.number().min(-90).max(90),
  originLng:       z.number().min(-180).max(180),
  destinationName: z.string().min(1).max(120),
  destinationLat:  z.number().min(-90).max(90),
  destinationLng:  z.number().min(-180).max(180),
  distanceKm:      z.number().positive().optional(),
  waypoints:       z.array(waypointSchema).optional(),
})

export const updateRouteSchema = createRouteSchema.partial().extend({
  isActive: z.boolean().optional(),
})

export const routeListQuerySchema = z.object({
  cursor:   z.string().optional(),
  limit:    z.coerce.number().int().min(1).max(100).default(20),
  isActive: z.enum(['true', 'false']).transform(v => v === 'true').optional(),
})

export type CreateRoute     = z.infer<typeof createRouteSchema>
export type UpdateRoute     = z.infer<typeof updateRouteSchema>
export type RouteListQuery  = z.infer<typeof routeListQuerySchema>
