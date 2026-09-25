/**
 * Overspeeding as an EPISODE, not a flag.
 *
 * ## Why this exists beside derive-alerts
 *
 * `deriveAlertFlags` answers "is this unit over the limit on this frame", and
 * `syncFrameAlerts` turns that into a `vehicle_alerts` row that is opened on the
 * way up and closed the instant the unit slows. That pair is exactly right for
 * the map, the live feed and SSE — and it is useless as a record. The alert row
 * carries the speed at the moment it opened and nothing else: no peak, no
 * duration, no distance, no driver. "How many times did KTCC 853B speed last
 * month, for how long, and how fast" has no answer in it.
 *
 * So this module watches the same frames and writes ONE row per completed
 * episode, on the falling edge, into `speeding_incidents`.
 *
 * ## The limit comes from one place
 *
 * `overspeedLimitFor` — the same function `deriveAlertFlags` calls. There must
 * not be a second threshold anywhere in this feature, or the ledger and the feed
 * will disagree about what happened and nobody will be able to say which is
 * right. For the same reason an episode is only written once it has reached
 * `OVERSPEED_MIN_FRAMES`: below that the flag never fired, no alert was raised,
 * and a report row would describe an event the rest of the system never saw.
 *
 * ## Nothing here touches the database
 *
 * The poll loop runs every 2 s across ~1,500 units. Per frame this costs one Map
 * lookup and a few arithmetic ops; the write is handed to a worker over the
 * event bus, the same way `alerts:sync` and `simEvents:persist` already are.
 *
 * ## Duplication with `overCount` is deliberate
 *
 * `derive-alerts` keeps its own consecutive-frame counter and DELETES it the
 * instant the vehicle drops under the limit — which is precisely the moment this
 * module still needs the episode in order to write it. The two cannot be merged.
 */

import { env } from '../config/env.js'
import { eventBus } from './event-bus.js'
import { overspeedLimitFor } from './derived-alerts.js'
import { zoneLimitAt, type LimitSource, type ZoneLimit } from './speed-policy.js'
import type { VehicleTelemetryFrame } from '../providers/telemetry-provider.js'

export interface EpisodeContext {
  orgId:       string
  vehicleId:   string
  vehicleType: string | null
  driverId:    string | null
  driverName:  string | null
}

/** The payload published on close and written by speeding.worker. */
export interface ClosedEpisode {
  orgId:        string
  vehicleId:    string
  vehicleType:  string | null
  driverId:     string | null
  driverName:   string | null
  startedAt:    Date
  endedAt:      Date
  durationSec:  number
  peakKmh:      number
  avgKmh:       number
  limitKmh:     number
  limitSource:  LimitSource
  overByKmh:    number
  frames:       number
  distanceM:    number | null
  startLat:     number | null
  startLng:     number | null
  peakLat:      number | null
  peakLng:      number | null
  endLat:       number | null
  endLng:       number | null
  closedBy:     'falling-edge' | 'timeout' | 'shutdown'
  gapped:       boolean
}

interface Episode {
  ctx:         EpisodeContext
  limitKmh:    number
  limitSource: LimitSource
  startedAtMs: number
  lastOverMs:  number
  peakKmh:     number
  peakLat:     number | null
  peakLng:     number | null
  sumKmh:      number
  frames:      number
  startLat:    number | null
  startLng:    number | null
  lastLat:     number | null
  lastLng:     number | null
  endLat:      number | null
  endLng:      number | null
  distanceM:   number
  /** A fix was missing coordinates, or the gap was too long to measure across. */
  gapped:      boolean
}

/** vehicleId → the episode currently open for it. */
const open = new Map<string, Episode>()

const R_EARTH_M = 6_371_000
function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180
  const dLat = (bLat - aLat) * rad
  const dLng = (bLng - aLng) * rad
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * R_EARTH_M * Math.asin(Math.sqrt(h))
}

/**
 * Is this limit the vehicle TYPE's, or the fleet default?
 *
 * Recorded per incident because the report has to be able to say which policy
 * was applied, and because OVERSPEED_LIMIT_BY_TYPE is a deploy-time string that
 * somebody will change.
 */
function limitSourceFor(vehicleType: string | null, limit: number, zone: ZoneLimit | null): LimitSource {
  if (zone) return zone.source
  return vehicleType && limit !== env.OVERSPEED_LIMIT_KMH ? 'type' : 'fleet'
}

function finish(ep: Episode, closedBy: ClosedEpisode['closedBy']): ClosedEpisode | null {
  // Below the debounce the flag never fired, so no alert was raised and this
  // episode must not appear in a report either — the two counts have to match.
  if (ep.frames < env.OVERSPEED_MIN_FRAMES) return null

  const durationSec = Math.max(0, Math.round((ep.lastOverMs - ep.startedAtMs) / 1000))
  return {
    orgId:       ep.ctx.orgId,
    vehicleId:   ep.ctx.vehicleId,
    vehicleType: ep.ctx.vehicleType,
    driverId:    ep.ctx.driverId,
    driverName:  ep.ctx.driverName,
    startedAt:   new Date(ep.startedAtMs),
    endedAt:     new Date(ep.lastOverMs),
    durationSec,
    peakKmh:     ep.peakKmh,
    avgKmh:      Math.round((ep.sumKmh / ep.frames) * 10) / 10,
    limitKmh:    ep.limitKmh,
    limitSource: ep.limitSource,
    overByKmh:   Math.round((ep.peakKmh - ep.limitKmh) * 10) / 10,
    frames:      ep.frames,
    // A distance measured across a missing fix or a twenty-minute hole is
    // fiction. Null renders as "—", which is the honest answer.
    distanceM:   ep.gapped ? null : Math.round(ep.distanceM),
    startLat:    ep.startLat,
    startLng:    ep.startLng,
    peakLat:     ep.peakLat,
    peakLng:     ep.peakLng,
    endLat:      ep.endLat,
    endLng:      ep.endLng,
    closedBy,
    gapped:      ep.gapped,
  }
}

function publish(closed: ClosedEpisode | null): void {
  if (closed) eventBus.publish('speeding:closed', closed)
}

/**
 * Feed one frame in. Call once per frame, after deriveAlertFlags.
 *
 * Returns the episode it closed, if any — the return value exists for the tests;
 * the production path is the event bus.
 */
export function noteSpeedFrame(frame: VehicleTelemetryFrame, ctx: EpisodeContext): ClosedEpisode | null {
  if (!env.INCIDENT_CAPTURE_ENABLED) return null

  const speed = frame.speedKmh
  const atMs  = frame.capturedAt.getTime()
  const zone  = zoneLimitAt(ctx.orgId, frame.lat, frame.lng)
  const limit = zone?.kmh ?? overspeedLimitFor(ctx.vehicleType)
  const ep    = open.get(ctx.vehicleId)

  // A frame with no speed reading says nothing either way: it must not extend
  // an episode (it is not evidence of speeding) and must not end one (it is not
  // evidence of slowing). The stale sweep is what closes an episode that stops
  // receiving usable frames.
  if (speed == null || !Number.isFinite(speed)) return null

  if (speed > limit) {
    if (!ep) {
      open.set(ctx.vehicleId, {
        ctx,
        limitKmh:    limit,
        limitSource: limitSourceFor(ctx.vehicleType, limit, zone),
        // The FIRST over-limit frame. The debounce decides whether the episode
        // is real; it does not decide when it began.
        startedAtMs: atMs,
        lastOverMs:  atMs,
        peakKmh:     speed,
        peakLat:     frame.lat,
        peakLng:     frame.lng,
        sumKmh:      speed,
        frames:      1,
        startLat:    frame.lat,
        startLng:    frame.lng,
        lastLat:     frame.lat,
        lastLng:     frame.lng,
        endLat:      frame.lat,
        endLng:      frame.lng,
        distanceM:   0,
        gapped:      frame.lat == null || frame.lng == null,
      })
      return null
    }

    // Extend. The driver can change mid-episode (a handover at a gate); the one
    // in hand at the START is the one who was driving when it began.
    if (atMs - ep.lastOverMs > env.EPISODE_MAX_GAP_MS) {
      // The unit was gone longer than the stale bound and came back still
      // speeding. Distance across that hole is unmeasurable.
      ep.gapped = true
    } else if (ep.lastLat != null && ep.lastLng != null && frame.lat != null && frame.lng != null) {
      ep.distanceM += haversineM(ep.lastLat, ep.lastLng, frame.lat, frame.lng)
    } else {
      ep.gapped = true
    }

    ep.frames += 1
    ep.sumKmh += speed
    ep.lastOverMs = atMs
    ep.lastLat = frame.lat
    ep.lastLng = frame.lng
    ep.endLat = frame.lat
    ep.endLng = frame.lng
    if (speed > ep.peakKmh) {
      ep.peakKmh = speed
      ep.peakLat = frame.lat
      ep.peakLng = frame.lng
    }
    return null
  }

  // Falling edge — under the limit on a frame that carried a real speed.
  if (!ep) return null
  open.delete(ctx.vehicleId)
  const closed = finish(ep, 'falling-edge')
  publish(closed)
  return closed
}

/**
 * Close episodes whose unit has gone quiet.
 *
 * A vehicle that stops reporting while over the limit never produces a falling
 * edge, so without this its episode would stay open forever and leak an entry.
 * Called once at the END of a poll cycle, and it iterates only units currently
 * speeding — single digits on these fleets.
 */
export function sweepStaleEpisodes(nowMs = Date.now()): ClosedEpisode[] {
  const out: ClosedEpisode[] = []
  for (const [vehicleId, ep] of open) {
    if (nowMs - ep.lastOverMs <= env.EPISODE_MAX_GAP_MS) continue
    open.delete(vehicleId)
    const closed = finish(ep, 'timeout')
    if (closed) { publish(closed); out.push(closed) }
  }
  return out
}

/**
 * Close everything at its real last over-limit frame, for shutdown.
 *
 * Deliberately NOT `endedAt = now`: that would claim the driver was speeding
 * right up to the moment the process died. On an unclean kill the episode is
 * simply lost and the next over-limit frame starts a new one — worst case one
 * long episode is reported as two shorter ones, which is the same bounded
 * failure `overCount` already has.
 */
export function flushEpisodes(): ClosedEpisode[] {
  const out: ClosedEpisode[] = []
  for (const [vehicleId, ep] of open) {
    open.delete(vehicleId)
    const closed = finish(ep, 'shutdown')
    if (closed) { publish(closed); out.push(closed) }
  }
  return out
}

/** Test seam. */
export function resetEpisodeState(vehicleId?: string): void {
  if (vehicleId) open.delete(vehicleId)
  else open.clear()
}

/** Test/telemetry seam — how many units are mid-episode right now. */
export function openEpisodeCount(): number {
  return open.size
}
