import { z } from 'zod'
import { ZONE_CATEGORIES } from '../../lib/zone-taxonomy.js'

// [lng, lat] — the order polygonCoords is stored and read in (lib/geofence,
// the GeoJSON projection, the Wialon sync). This used to validate [lat, lng],
// which only passed because Kenya's longitudes are under 90.
const coordinatePair = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])

// What a fence is FOR, chosen when it is drawn. It decides the colour the map
// draws it in when no colour is given, and how the live feed treats arriving
// there (lib/zone-taxonomy). Omitted, the name decides, as for Wialon zones.
const purpose = z.enum(ZONE_CATEGORIES)
// #rrggbb. Overrides the purpose's colour on the map, nothing else.
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'A colour is #rrggbb')

const common = {
  name:    z.string().trim().min(1).max(120),
  mode:    z.enum(['ALLOWLIST', 'BLOCKLIST']).default('ALLOWLIST'),
  purpose: purpose.optional(),
  color:   color.optional(),
}

export const createGeofenceSchema = z.discriminatedUnion('type', [
  z.object({
    type:      z.literal('CIRCLE'),
    ...common,
    centerLat: z.number().min(-90).max(90),
    centerLng: z.number().min(-180).max(180),
    radiusM:   z.number().int().min(10).max(100_000),
  }),
  z.object({
    type:          z.literal('POLYGON'),
    ...common,
    polygonCoords: z.array(coordinatePair).min(3),
  }),
  // A corridor: the centre-line and its full width, as Wialon models a road.
  z.object({
    type:          z.literal('LINE'),
    ...common,
    polygonCoords: z.array(coordinatePair).min(2),
    widthM:        z.number().min(2).max(2_000),
  }),
])

/**
 * A change to a fence. The shape is sent whole — `type` with every field that
 * type needs — or not at all; the refinement below says which are missing, so
 * a half-sent shape cannot leave a circle with a polygon's ring.
 */
export const updateGeofenceSchema = z.object({
  name:          z.string().trim().min(1).max(120).optional(),
  mode:          z.enum(['ALLOWLIST', 'BLOCKLIST']).optional(),
  purpose:       purpose.nullable().optional(),
  color:         color.nullable().optional(),
  type:          z.enum(['CIRCLE', 'POLYGON', 'LINE']).optional(),
  centerLat:     z.number().min(-90).max(90).optional(),
  centerLng:     z.number().min(-180).max(180).optional(),
  radiusM:       z.number().int().min(10).max(100_000).optional(),
  polygonCoords: z.array(coordinatePair).min(2).optional(),
  widthM:        z.number().min(2).max(2_000).optional(),
  isActive:      z.boolean().optional(),
}).superRefine((b, ctx) => {
  const need = (keys: Array<keyof typeof b>) => {
    for (const k of keys) if (b[k] === undefined) ctx.addIssue({ code: 'custom', path: [k], message: `A ${b.type} needs ${String(k)}` })
  }
  const geometry = ['centerLat', 'centerLng', 'radiusM', 'polygonCoords', 'widthM'] as const
  if (!b.type) {
    for (const k of geometry) if (b[k] !== undefined) ctx.addIssue({ code: 'custom', path: ['type'], message: 'Send type with the shape' })
    return
  }
  if (b.type === 'CIRCLE') need(['centerLat', 'centerLng', 'radiusM'])
  if (b.type === 'POLYGON') {
    need(['polygonCoords'])
    if (b.polygonCoords && b.polygonCoords.length < 3) ctx.addIssue({ code: 'custom', path: ['polygonCoords'], message: 'A polygon needs 3 corners' })
  }
  if (b.type === 'LINE') need(['polygonCoords', 'widthM'])
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
