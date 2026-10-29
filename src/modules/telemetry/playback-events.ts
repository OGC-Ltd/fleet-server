/**
 * What HAPPENED during a replayed day, alongside where the unit was.
 *
 * The track answers "where"; on its own it cannot say why a machine sat still
 * for forty minutes, or that the level dropped 20 L while it did. These are the
 * events that go on the scrubber and the timeline beside it.
 *
 * ## Everything is placed by TIME, not by coordinates
 *
 * Not one of the sources carries a position. `fuel_fillings.location` and
 * `fuel_thefts.initial_location` are free text; `notifications` has no lat/lng
 * column at all. So an event's place on the map is interpolated from the track
 * being drawn, which is better than a second position would be: the pin lands
 * ON the line, and there is no way for the two to disagree about where the unit
 * was.
 *
 * ## Two of them are DERIVED, because the tables for them are empty
 *
 * `vehicle_alerts` has never held a row — measured 2026-08-29, zero, ever —
 * and the Wialon adapter hardcodes `overspeeding: false`, so no speed event has
 * ever been recorded for this fleet by any pipeline. Stops have no table
 * either. Both are computed here from the fixes the playback already reads,
 * which costs one pass over an array that is in memory anyway.
 */

import { prisma } from '../../lib/prisma.js'
import { overspeedLimitFor } from '../../lib/derived-alerts.js'
import { warmSpeedPolicy, speedPolicyFor } from '../../lib/speed-policy.js'
import type { PlaybackPoint } from './telemetry.repository.js'
import { STATIONARY_KMH } from '../../lib/simplify-path.js'

export type PlaybackEventKind =
  | 'stop' | 'speeding' | 'refill' | 'theft' | 'zone' | 'dispatch' | 'fault' | 'other'

export interface PlaybackEvent {
  /** When it happened, ms. Always inside the requested day. */
  t: number
  /** End of a span — a stop, a speeding run. Absent for an instant. */
  endT?: number
  kind: PlaybackEventKind
  severity: 'info' | 'warning' | 'critical'
  /** Short enough for a timeline row. */
  label: string
  /** The number or wording behind it, where there is one. */
  detail?: string
  /**
   * Millilitres moved, for a refill or a drain. UNSIGNED — the direction is the
   * kind, and carrying it twice invites the two to disagree.
   *
   * A number as well as `detail`, because the two are read in different places
   * and want different things. The timeline shows the full sentence, including
   * what our own probe saw where it differs from the provider's claim; the map
   * pin has room for about five characters over a route and shows the figure
   * alone. One raw number lets a client format for either without parsing the
   * other's prose.
   */
  ml?: number
}

/**
 * A stop shorter than this is not worth a pin.
 *
 * Measured on three days of the live fleet: the naive rule (any fix at or below
 * the stationary threshold, preceded by one above it) gives a MEDIAN of 13
 * stops per vehicle-day, a p95 of 158 and a worst case of 802 — and the busiest
 * unit alone produced 592. A track carrying 592 pins is not a timeline, it is a
 * texture. Three minutes is the point where a stop means something an operator
 * would ask about: a queue, a load, a break.
 */
const MIN_STOP_MS = 3 * 60_000

/**
 * Above this, a fix counts as speeding.
 *
 * There is no per-vehicle limit to compare against — `vehicles` has no speed
 * limit column, and nothing has ever written a speed alert. So this is a
 * threshold, not a rule, and it is stated here rather than buried: measured
 * over 24 hours the fleet's moving fixes run p50 11 km/h, p95 41, p99 63, max
 * 124, and 17 of 274 reporting units exceeded 80. It is mostly agricultural
 * plant; 80 picks out the road trucks doing something unusual rather than
 * flagging a tractor for being a tractor.
 */
export const SPEEDING_KMH = 80

/**
 * The limit a REPLAY judges against.
 *
 * The 80 above was a measured choice made when nothing else in the system
 * asserted a limit. Now `overspeedLimitFor` is the one authority — it is what
 * the live flag, the feed sentence and the incident ledger all read — and
 * playback is per-vehicle, so the type is in hand. The constant stays as the
 * fallback for a replay of a unit whose type is unknown.
 */
export const playbackLimitFor = (vehicleType: string | null): number =>
  overspeedLimitFor(vehicleType) || SPEEDING_KMH

/**
 * A speeding run has to last this long to be reported.
 *
 * One fix over the line is as likely to be GPS noise as a driver — the same
 * doppler jitter that puts a parked unit at 3 km/h puts a moving one 20 over.
 * Two consecutive fixes at a 28 s median cadence is about a minute of it.
 */
const MIN_SPEEDING_FIXES = 2

/**
 * Hard cap on what one day may return.
 *
 * The worst measured vehicle-day carried 154 notifications; add fillings (max
 * 83), thefts (max 75) and derived stops and the tail is real. The cap keeps a
 * pathological unit from turning a playback response into a payload nobody
 * asked for — and it drops the LEAST severe first, so what survives is what an
 * operator would have looked at.
 */
const MAX_EVENTS = 300

const SEVERITY_RANK: Record<PlaybackEvent['severity'], number> = {
  critical: 0, warning: 1, info: 2,
}

/** Millilitres as a figure a person reads. */
const litres = (ml: number | null | undefined) =>
  ml == null ? null : `${(ml / 1000).toFixed(1)} L`

/**
 * Stops, from the unimplified fixes.
 *
 * Deliberately the RAW points rather than the simplified ones: dwell collapse
 * exists to remove exactly these, so measuring stops after it would find almost
 * none. A null speed is not a stop — `speedKmh` is fully populated today, and a
 * null arriving later must not invent a stop the machine never made.
 */
export function deriveStops(points: PlaybackPoint[]): PlaybackEvent[] {
  const out: PlaybackEvent[] = []
  let runStart: number | null = null
  let runEnd = 0

  const flush = () => {
    if (runStart == null) return
    /**
     * The span between the first and last fix AT REST, never out to the moving
     * fixes either side. The unit really stopped somewhere in the gap before
     * the first and moved off somewhere after the last, so this understates by
     * up to a cadence at each end — deliberately. An operator told "30 min"
     * about a 31-minute stop is unharmed; one told "31" about a stop we watched
     * for 30 has been given a number nobody measured.
     */
    const ms = runEnd - runStart
    if (ms >= MIN_STOP_MS) {
      out.push({
        t: runStart, endT: runEnd, kind: 'stop', severity: 'info',
        label: 'Stopped', detail: humanDuration(ms),
      })
    }
    runStart = null
  }

  for (const p of points) {
    const stationary = p.spd != null && p.spd <= STATIONARY_KMH
    // A reporting silence ends the run it was in. The unit may have driven the
    // whole way through it, and a "stop" spanning a gap is a claim about time
    // nothing was recorded for.
    if (p.gapBefore) flush()
    if (stationary) {
      if (runStart == null) runStart = p.t
      runEnd = p.t
    } else {
      flush()
    }
  }
  flush()
  return out
}

/** Speeding runs, same shape and the same reason for using raw fixes. */
export function deriveSpeeding(
  points: PlaybackPoint[],
  limitKmh: number | ((p: PlaybackPoint) => number) = SPEEDING_KMH,
): PlaybackEvent[] {
  // A function where the limit depends on place (lib/speed-policy)
  const limitAt = typeof limitKmh === 'function' ? limitKmh : () => limitKmh
  const out: PlaybackEvent[] = []
  let start: number | null = null
  let end = 0
  let n = 0
  let peak = 0
  let lim = 0

  const flush = () => {
    if (start != null && n >= MIN_SPEEDING_FIXES) {
      out.push({
        t: start, endT: end, kind: 'speeding', severity: 'warning',
        label: 'Over speed', detail: `peak ${Math.round(peak)} km/h, limit ${lim} km/h`,
      })
    }
    start = null; n = 0; peak = 0; lim = 0
  }

  for (const p of points) {
    if (p.gapBefore) flush()
    const limit = limitAt(p)
    if (p.spd != null && p.spd > limit) {
      if (start == null) start = p.t
      end = p.t
      n += 1
      if (p.spd > peak) { peak = p.spd; lim = limit }
    } else {
      flush()
    }
  }
  flush()
  return out
}

/** "42 min", "3 h 10 min" — the same phrasing the client uses for a gap. */
function humanDuration(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

/**
 * The recorded events for one vehicle-day: fuel fillings, fuel thefts, and the
 * notification feed, which is where zone crossings, dispatches and sensor
 * faults actually live for this fleet.
 */
async function readLoggedEvents(vehicleId: string, from: Date, to: Date): Promise<PlaybackEvent[]> {
  const [fillings, thefts, notes] = await Promise.all([
    prisma.fuelFilling.findMany({
      where: { vehicleId, filledAt: { gte: from, lt: to } },
      select: { filledAt: true, filledMl: true, observedRiseMl: true, verdict: true },
      orderBy: { filledAt: 'asc' },
    }),
    prisma.fuelTheft.findMany({
      where: { vehicleId, beganAt: { gte: from, lt: to } },
      select: { beganAt: true, detectedAt: true, stolenMl: true, cleanDropMl: true, verdict: true, verdictReason: true },
      orderBy: { beganAt: 'asc' },
    }),
    prisma.notification.findMany({
      where: { vehicleId, occurredAt: { gte: from, lt: to } },
      select: { occurredAt: true, alertType: true, severity: true, text: true },
      orderBy: { occurredAt: 'asc' },
    }),
  ])

  const out: PlaybackEvent[] = []

  for (const f of fillings) {
    out.push({
      t: f.filledAt.getTime(),
      kind: 'refill',
      severity: 'info',
      label: 'Refuelled',
      // The provider's claim and what our own probe saw, when they differ — the
      // pair is the whole point of keeping both columns, so a reader is never
      // shown one without being able to see the other.
      detail: [litres(f.filledMl), f.observedRiseMl != null && f.observedRiseMl !== f.filledMl
        ? `probe saw ${litres(f.observedRiseMl)}` : null].filter(Boolean).join(' · ') || undefined,
      ml: f.filledMl ?? undefined,
    })
  }

  for (const th of thefts) {
    // Only a drain our telemetry actually watched earns the harder wording; the
    // rest are relayed claims. Same bar the incident window applies.
    const confirmed = th.verdictReason === 'level-stayed-down' || th.verdictReason === 'level-recovered'
    out.push({
      t: (th.beganAt ?? th.detectedAt).getTime(),
      endT: th.detectedAt && th.beganAt && th.detectedAt > th.beganAt ? th.detectedAt.getTime() : undefined,
      kind: 'theft',
      severity: confirmed ? 'critical' : 'warning',
      label: confirmed ? 'Fuel drain' : 'Fuel drain (unconfirmed)',
      detail: litres(th.cleanDropMl ?? th.stolenMl) ?? undefined,
      ml: th.cleanDropMl ?? th.stolenMl ?? undefined,
    })
  }

  for (const n of notes) {
    // A refuel's feed line ("KTCC 453L refuelled 120 L at …") announces the
    // ledger row read above, which already sits on the track with its volume.
    // Kept, it was a second refill with no `ml`, and the map read its litres
    // out of the text — taking the plate's "453L" for the volume (issue #47).
    if (n.alertType === 'fuelFilling') continue
    out.push({
      t: n.occurredAt.getTime(),
      kind: kindOfNotification(n.alertType),
      severity: n.severity === 'critical' ? 'critical' : n.severity === 'warning' ? 'warning' : 'info',
      label: labelOfNotification(n.alertType),
      detail: n.text,
    })
  }

  return out
}

/**
 * The alert types actually present, measured over seven days — anything not
 * listed falls to 'other' rather than being guessed at.
 *
 * ZONE_EXIT and ZONE_ENTRY dominate (8,211 and 8,176), then MOVEMENT_ENTRY,
 * DISPATCH and fuelFilling. Note there is no speed type in the whole
 * distribution, which is why speeding is derived above.
 */
function kindOfNotification(type: string | null): PlaybackEventKind {
  switch (type) {
    case 'ZONE_ENTRY': case 'ZONE_EXIT': case 'GEOFENCE_BREACH': return 'zone'
    case 'DISPATCH':                                             return 'dispatch'
    case 'fuelFilling':                                          return 'refill'
    case 'fuelInconsistency':                                    return 'theft'
    case 'fuelSensorFault':                                      return 'fault'
    default:                                                     return 'other'
  }
}

function labelOfNotification(type: string | null): string {
  switch (type) {
    case 'ZONE_ENTRY':      return 'Entered zone'
    case 'ZONE_EXIT':       return 'Left zone'
    case 'GEOFENCE_BREACH': return 'Geofence breach'
    case 'MOVEMENT_ENTRY':  return 'Started moving'
    case 'MOVEMENT_EXIT':   return 'Stopped moving'
    case 'DISPATCH':        return 'Dispatched'
    case 'fuelFilling':     return 'Refuelled'
    case 'fuelInconsistency': return 'Fuel drain'
    case 'fuelSensorFault': return 'Fuel probe fault'
    default:                return type ?? 'Event'
  }
}

/**
 * Everything that happened, ordered, capped, ready for the scrubber.
 *
 * The cap drops by severity and not by time, so a day trimmed to 300 keeps its
 * drains and loses its zone crossings — the opposite of what "newest 300" would
 * have done on a fleet where zone events outnumber everything else 20 to 1.
 */
export async function buildPlaybackEvents(
  vehicleId: string, from: Date, to: Date, points: PlaybackPoint[],
): Promise<{ events: PlaybackEvent[]; truncatedEvents: boolean }> {
  // The unit's own limit, so a replay judges by the same number the live flag,
  // the feed and the incident ledger use. One extra lookup on a user-initiated
  // action — playback already queries for its logged events — rather than a
  // fourth hardcoded 80 drifting away from OVERSPEED_LIMIT_BY_TYPE.
  const [logged, vehicle] = await Promise.all([
    readLoggedEvents(vehicleId, from, to),
    prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { vehicleType: true, organisationId: true } }),
  ])
  const type = vehicle?.vehicleType ?? null
  const orgId = vehicle?.organisationId ?? null
  if (orgId) await warmSpeedPolicy(orgId)
  // Per fix where the org's limit depends on place, else one number.
  const limitKmh = orgId && speedPolicyFor(orgId)
    ? (p: PlaybackPoint) => overspeedLimitFor(type, { orgId, lat: p.lat, lng: p.lng })
    : playbackLimitFor(type)
  const all = [...logged, ...deriveStops(points), ...deriveSpeeding(points, limitKmh)]

  const truncatedEvents = all.length > MAX_EVENTS
  const kept = truncatedEvents
    ? [...all].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.t - b.t)
        .slice(0, MAX_EVENTS)
    : all

  kept.sort((a, b) => a.t - b.t)
  return { events: kept, truncatedEvents }
}
