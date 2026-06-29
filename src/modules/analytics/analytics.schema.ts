import { z } from 'zod'

export const analyticsRangeSchema = z.object({
  from: z.coerce.date(),
  to:   z.coerce.date(),
})

export const speedingQuerySchema = analyticsRangeSchema.extend({
  thresholdKmh: z.coerce.number().int().min(1).default(80),
})

export type AnalyticsRange  = z.infer<typeof analyticsRangeSchema>
export type SpeedingQuery   = z.infer<typeof speedingQuerySchema>
