import { z } from 'zod'
import { fleetDayKey } from '../../lib/provider-time.js'

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

/**
 * Query for a WINDOW of weighbridge days.
 *
 * `days` is bounded at 90 for the same reason the analytics screen's own
 * filter is: it is the ceiling the range read in the repository is sized
 * against, and an unbounded `days` would turn one indexed scan into a promise
 * about how much of the table a caller may ask for at once.
 *
 * `to` is the last fleet day INCLUSIVE — the day an operator would name if
 * asked what the window ends on. The service turns that into the half-open
 * instant range the index wants; doing it the other way round would put the
 * off-by-one in every caller instead of in one place.
 *
 * Both are plain strings for the reason `day` above is: coercion reads a bare
 * date as UTC midnight, which is 03:00 in Ndhiwa, and these bridges open
 * before dawn.
 *
 * `to` also takes an instant that carries its zone, and files it under the
 * fleet day it falls in. The analytics screen sends every card the same `to`,
 * and for a picked month that is noon on its last day ("2026-10-31T12:00:00
 * +03:00"), which every sibling endpoint reads with `z.coerce.date()`. This one
 * alone answered 400, so the weighbridge card went blank whenever a past month
 * was chosen (seen 2026-11-24).
 */
export const weighmentAnalyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional(),
  to:   z.preprocess(toFleetDay, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD')).optional(),
  /** One bridge rather than all of them. Absent means the whole operation,
   *  which is what the per-centre breakdown always describes regardless. */
  centre: z.coerce.number().int().optional(),
})

export type WeighmentAnalyticsQuery = z.infer<typeof weighmentAnalyticsQuerySchema>

const ZONED_INSTANT = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/

/** A zoned instant becomes the fleet day it falls in; anything else is left
 *  for the YYYY-MM-DD check to accept or refuse. An instant WITHOUT a zone is
 *  refused rather than guessed at: it would be read in the server's zone. */
function toFleetDay(v: unknown): unknown {
  if (typeof v !== 'string' || !ZONED_INSTANT.test(v)) return v
  const at = new Date(v)
  return Number.isNaN(at.getTime()) ? v : fleetDayKey(at).toISOString().slice(0, 10)
}
