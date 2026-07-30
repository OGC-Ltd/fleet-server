import { z } from 'zod'

export const telemetryListQuerySchema = z.object({
  cursor: z.coerce.bigint().optional(),
  limit:  z.coerce.number().int().min(1).max(500).default(100),
  from:   z.coerce.date().optional(),
  to:     z.coerce.date().optional(),
})

export type TelemetryListQuery = z.infer<typeof telemetryListQuerySchema>

/**
 * Query for the map's breadcrumb track.
 *
 * Separate from the telemetry list because the two want opposite things. The
 * list is a paged record with every sensor field; the track is a polyline and
 * needs three columns over a whole time window. Serving it from the list meant
 * the map pulled 16 fields × 500 rows (177 KB) to draw lat/lng pairs, AND the
 * 500-row cap silently truncated a requested 12 h window to ~5.5 h on an active
 * vehicle — so the client's "no movement in the last 12 h" label was a claim it
 * had no evidence for.
 */
export const trackQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to:   z.coerce.date().optional(),
  /** Server-side thinning. Units report on a timer, not on movement, so a
   *  parked machine emits hundreds of fixes at one spot; dropping those here
   *  keeps the payload proportional to distance travelled, not to dwell time. */
  minSpacingM: z.coerce.number().min(0).max(1000).default(15),
})

export type TrackQuery = z.infer<typeof trackQuerySchema>
