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
  /**
   * Attach the zone-visit timeline (see findZoneTimeline).
   *
   * Opt-in because it is a second query that probes PostGIS once per distinct
   * coordinate, and most callers of this route are drawing a line and do not
   * want to pay for it.
   *
   * NOT `z.coerce.boolean()`: that is `Boolean(value)`, so the string "false"
   * arrives as true and the expensive path runs for every caller trying to
   * turn it off.
   */
  zones: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
})

export type TrackQuery = z.infer<typeof trackQuerySchema>

/**
 * Longest window a track may span, in days.
 *
 * Anything longer is refused rather than silently clamped: a caller asking for
 * a year and getting a month back, labelled as a month, is a caller drawing
 * conclusions from a window it did not request.
 */
export const TRACK_MAX_WINDOW_DAYS = 30

/**
 * Window beyond which the track switches from every-fix fidelity to bucketed
 * sampling. See findTrack — 48 h is where the measurements turn.
 */
export const TRACK_FULL_FIDELITY_HOURS = 48
