import { z } from 'zod'

/**
 * Query for one weighbridge day.
 *
 * `day` is a plain string, not `z.coerce.date()`. Coercion reads a bare date
 * as UTC midnight, which is 03:00 in Ndhiwa, so every ticket weighed in the
 * first three hours of a shift — and these bridges open before dawn, the
 * earliest measured at 00:02 — would be filed under the previous day. It is
 * resolved against `fleetDayBounds` in the service, where the offset lives.
 */
export const weighmentQuerySchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'day must be YYYY-MM-DD').optional(),
  /**
   * Which bridge. Absent means all four, which is what the stats always
   * describe regardless of this — see the service.
   */
  centre: z.coerce.number().int().optional(),
  /** Free text over token, plate and driver. Applied server-side so it
   *  searches the whole day rather than the rows already on screen. */
  q: z.string().trim().max(64).optional(),
})

export type WeighmentQuery = z.infer<typeof weighmentQuerySchema>
