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
  /** Faults only — one exact message (the record's detail), e.g. 'Fuel probe: Status Error'.
   *  One value, not a list: messages carry commas of their own. */
  detail:   z.string().trim().min(1).max(300).optional(),
  minCount: z.coerce.number().int().min(1).optional(),
  /** Plate or name, matched anywhere — the tab's search box. Filtered here,
   *  not on the page the client holds, so a unit past the first fifty is found. */
  q:        z.string().trim().max(64).optional(),
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
  /** Faults only — one exact message, as on the summary. */
  detail:    z.string().trim().min(1).max(300).optional(),
  cursor:    z.string().optional(),
  limit:     z.coerce.number().int().min(1).max(200).default(50),
})

/** The analysis block, over the same window as the table beneath it. */
export const insightsQuerySchema = rangeBase

/** The messages found in a window, for the Wialon view's error-type list (operator, 2026-11-27). */
export const detailsQuerySchema = rangeBase.extend({
  kind: z.string().optional(),
})

export type SummaryQuery  = z.infer<typeof summaryQuerySchema>
export type DetailsQuery  = z.infer<typeof detailsQuerySchema>
export type ListQuery     = z.infer<typeof listQuerySchema>
export type InsightsQuery = z.infer<typeof insightsQuerySchema>
