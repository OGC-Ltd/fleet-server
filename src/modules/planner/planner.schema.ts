import { z } from 'zod'

/** An .xlsx, base64, as the page reads it from the file picker. ~2 MB of file. */
const fileSchema = z.object({
  fileName: z.string().max(200).default(''),
  data:     z.string().min(10).max(2_800_000),
})

export const previewSheetSchema = fileSchema

/** A calendar day, yyyy-mm-dd, that exists (2026-13-45 is refused, not a 500). */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), 'Not a calendar day')

const point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })

export const saveSheetSchema = fileSchema.extend({
  /** What the person corrected on the preview; the sheet's own values otherwise. */
  plate:      z.string().trim().min(1).max(40).optional(),
  vehicleId:  z.string().max(64).nullable().optional(),
  driverName: z.string().trim().max(120).optional(),
  planDate:   day.optional(),
  /** A point per customer code, for lines the sheet gave none (or a wrong one). */
  points:     z.record(z.string(), point).optional(),
  /** Per customer code: an existing geofence's id to use, or 'new' for a fresh circle. Left out, the server picks as the preview did. */
  fences:     z.record(z.string(), z.string().min(1).max(64)).optional(),
})

export const planListQuerySchema = z.object({
  from: day,
  to:   day,
})

/** The Live Map's Work plans switch: one day, today (EAT) by default. */
export const workPlansQuerySchema = z.object({
  day: day.optional(),
})

// The Fuel page's range: both days inclusive, at most 31 (FactorySuite's own limit).
export const factoryFuelQuerySchema = z.object({
  from: day,
  to: day,
}).refine(q => q.from <= q.to, { message: 'from must not be after to' })
  .refine(q => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 30, { message: 'At most 31 days' })

// The Fuel page machine panel's refills: one machine, over the page's range.
export const factoryFuelRefillsQuerySchema = z.object({
  from: day,
  to: day,
  machine: z.string().trim().min(1).max(64),
}).refine(q => q.from <= q.to, { message: 'from must not be after to' })
  .refine(q => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 30, { message: 'At most 31 days' })

export const stopUpdateSchema = z.object({
  outcome: z.enum(['FULL', 'PARTLY', 'REJECTED']).nullable().optional(),
  remarks: z.string().max(500).optional(),
  /** "Mark for today": the fleet day the stop is due, or null to clear it. */
  dueDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
})

/** A fence for a customer that has none, drawn as a circle where the person says. */
export const customerFenceSchema = z.object({
  name:    z.string().trim().min(1).max(200),
  lat:     z.number().min(-90).max(90),
  lng:     z.number().min(-180).max(180),
  radiusM: z.number().int().min(10).max(5_000).default(100),
})

export const customerListQuerySchema = z.object({
  q: z.string().max(80).optional(),
  /** "true": only customers tied to a geofence (Deliveries names its fenced points by them). */
  fenced: z.enum(['true', 'false']).optional(),
})

export type PreviewSheet = z.infer<typeof previewSheetSchema>
export type CustomerFence = z.infer<typeof customerFenceSchema>
export type SaveSheet    = z.infer<typeof saveSheetSchema>
export type PlanListQuery = z.infer<typeof planListQuerySchema>
export type StopUpdate   = z.infer<typeof stopUpdateSchema>
export type WorkPlansQuery = z.infer<typeof workPlansQuerySchema>
export type FactoryFuelQuery = z.infer<typeof factoryFuelQuerySchema>
export type FactoryFuelRefillsQuery = z.infer<typeof factoryFuelRefillsQuerySchema>
