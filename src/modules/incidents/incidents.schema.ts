import { z } from 'zod'

/**
 * `from` and `to` are REQUIRED on every endpoint here.
 *
 * Everywhere else in this API a missing date range means "everything", which is
 * fine for a fuel theft list that is dozens of rows. These tables collect one
 * row per speeding episode across ~1,500 units: an unbounded org-wide scan is
 * the exact request to make impossible, not to serve slowly. The service also
 * clamps the span — see MAX_SPAN_DAYS.
 */
const rangeBase = z.object({
  from: z.coerce.date(),
  to:   z.coerce.date(),
})

/**
 * The glance list: one row per unit, aggregated over the window.
 *
 * `sort` is a server concern, not a client one. Sorting the page the client
 * happens to be holding would order fifty of six hundred units and present it
 * as "the worst offenders", which is worse than not offering the control.
 */
export const summaryQuerySchema = rangeBase.extend({
  /** Faults only — comma-separated `kind` values. */
  kind:     z.string().optional(),
  minCount: z.coerce.number().int().min(1).optional(),
  sort:     z.enum(['count', 'peak', 'duration', 'recent']).default('count'),
  /** Offset for the aggregate list — see the note in the repository. */
  cursor:   z.string().optional(),
  limit:    z.coerce.number().int().min(1).max(200).default(50),
})

/**
 * The per-unit detail table. `vehicleId` is required: this endpoint exists to
 * answer "every case for THIS unit", and without it the query degenerates into
 * an unpaginated org-wide dump of raw incidents.
 */
export const listQuerySchema = rangeBase.extend({
  vehicleId: z.string().cuid(),
  kind:      z.string().optional(),
  cursor:    z.string().optional(),
  limit:     z.coerce.number().int().min(1).max(200).default(50),
})

/** The analysis block, over the same window as the table beneath it. */
export const insightsQuerySchema = rangeBase

export type SummaryQuery  = z.infer<typeof summaryQuerySchema>
export type ListQuery     = z.infer<typeof listQuerySchema>
export type InsightsQuery = z.infer<typeof insightsQuerySchema>
