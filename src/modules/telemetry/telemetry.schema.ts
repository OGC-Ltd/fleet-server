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

/**
 * Query for route PLAYBACK: one whole fleet day of one unit, with the motion
 * channels a moving marker needs.
 *
 * A separate route from `/track` rather than more options on it, for three
 * reasons that all point the same way. `/track` answers "draw the recent line"
 * and is called on every vehicle click — it must stay cheap, and its contract
 * is depended on by the live map. Playback answers "replay this day" and wants
 * heading and speed per point, which the map has no use for and would pay for
 * on every click. And the two disagree about the window: `/track` takes an
 * arbitrary from/to, playback takes a DAY, because a day is the unit an
 * operator actually asks about and anchoring it here means the client cannot
 * get the Kenyan day boundary subtly wrong.
 */
export const playbackQuerySchema = z.object({
  /**
   * Fleet day, `YYYY-MM-DD`, in Africa/Nairobi. Defaults to today.
   *
   * A plain string rather than `z.coerce.date()`: coercion reads a bare date as
   * UTC midnight, which is 03:00 EAT, so the first three hours of every fleet
   * day would be attributed to the day before. The value is resolved against
   * `fleetDayStart` in the service, where the offset lives.
   */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'day must be YYYY-MM-DD').optional(),
  /**
   * Douglas-Peucker corridor, metres.
   *
   * 0 turns shape simplification OFF — every fix that survives the dwell pass
   * is returned. That is the reason this is exposed at all: it is how a caller
   * asks "what did the simplifier remove", and the answer is only usable if
   * zero really keeps everything. Set `dwellRadiusM=0` as well for the raw
   * positioned track.
   */
  toleranceM: z.coerce.number().min(0).max(100).default(5),
  /** Radius within which a STOPPED unit's repeat fixes collapse. */
  dwellRadiusM: z.coerce.number().min(0).max(500).default(15),
})

export type PlaybackQuery = z.infer<typeof playbackQuerySchema>

/**
 * Fixes read for one playback day before truncation.
 *
 * Four times TRACK_SCAN_CAP, and sized from the data rather than doubled by
 * feel. Over one fleet day, measured 2026-08-28: p50 850 fixes, p90 2,896,
 * p99 6,603, max 15,210 — 5 of 336 units clear 5,000. 20,000 covers the
 * busiest unit in the fleet with room, and is read once per playback request
 * rather than once per vehicle click.
 */
export const PLAYBACK_SCAN_CAP = 20_000
