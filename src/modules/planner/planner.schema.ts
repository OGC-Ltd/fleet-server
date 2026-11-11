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

export const stopUpdateSchema = z.object({
  outcome: z.enum(['FULL', 'PARTLY', 'REJECTED']).nullable().optional(),
  remarks: z.string().max(500).optional(),
  /** "Mark for today": the fleet day the stop is due, or null to clear it. */
  dueDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
})

export const customerListQuerySchema = z.object({
  q: z.string().max(80).optional(),
})

export type PreviewSheet = z.infer<typeof previewSheetSchema>
export type SaveSheet    = z.infer<typeof saveSheetSchema>
export type PlanListQuery = z.infer<typeof planListQuerySchema>
export type StopUpdate   = z.infer<typeof stopUpdateSchema>
