import { z } from 'zod'

export const analyticsRangeSchema = z.object({
  from: z.coerce.date(),
  to:   z.coerce.date(),
})

export const speedingQuerySchema = analyticsRangeSchema.extend({
  thresholdKmh: z.coerce.number().int().min(1).default(80),
})

// Deliveries dashboard: a trailing window of `days` (default 30), optionally
// ending at `to` instead of now.
export const deliveriesQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  to:   z.coerce.date().optional(),
})

export type AnalyticsRange  = z.infer<typeof analyticsRangeSchema>
export type SpeedingQuery   = z.infer<typeof speedingQuerySchema>
export type DeliveriesQuery = z.infer<typeof deliveriesQuerySchema>
