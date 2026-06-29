import { z } from 'zod'

export const telemetryListQuerySchema = z.object({
  cursor: z.coerce.bigint().optional(),
  limit:  z.coerce.number().int().min(1).max(500).default(100),
  from:   z.coerce.date().optional(),
  to:     z.coerce.date().optional(),
})

export type TelemetryListQuery = z.infer<typeof telemetryListQuerySchema>
