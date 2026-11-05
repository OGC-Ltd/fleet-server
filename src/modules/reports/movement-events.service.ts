/**
 * The events an operator can pick onto the Movements report (operator, 5 Nov
 * 2026): free-wheeling, harsh cornering, harsh stops, harsh acceleration, and
 * stops over 10 minutes "outside geofences and established routes".
 *
 *   Harsh acceleration, braking  provider_alerts, from the trackers
 *   Harsh cornering              provider_alerts (kept silent, harsh-driving.worker) and the cameras' Harsh turn
 *   Free-wheeling                the cameras, alarm 38, which needs a CAN-bus link to the camera
 *   Long stops                   the stored telemetry, every fence and corridor left out
 *
 * The cameras are read only when one of their events is picked: that search is
 * the slow part, and when it fails the rest of the answer still arrives, a note
 * saying what is missing.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { cachedPlace, reverseGeocode } from '../../lib/geocode.js'
import { loadOrgZones, zoneCategoriesAt } from '../../lib/zone-presence.js'
import { getAlarms, type DashcamIncident } from '../dashcam/dashcam.service.js'
import { MOVING_KMH } from './movement-report.service.js'

export const EVENT_KINDS = ['freewheel', 'cornering', 'braking', 'acceleration', 'stop'] as const
export type EventKind = typeof EVENT_KINDS[number]

export interface MovementEvent {
  vehicleId: string
  plate: string
  kind: EventKind
  at: number
  lat: number | null
  lng: number | null
  place: string | null
  speedKmh: number | null
  source: 'tracker' | 'camera'
  /** A long stop: how long it stood in the window. */
  minutes?: number
  /** Already standing when the window opened: it began before `at`. */
  before?: boolean
  /** Still standing when the window closed. */
  ongoing?: boolean
}

/** A stand at least this long is listed. */
export const LONG_STOP_MS = 10 * 60_000
/** A reading this far from where it stood, after a tracker gap, is the unit gone: it did not read moving because it did not report. */
export const MOVED_AWAY_M = 500
/** The same unit's same event from the tracker and the camera within this is one event. */
const SAME_EVENT_MS = 60_000
/** The cameras answer for the last 7 days only (dashcam.service MAX_DAYS). */
const CAMERA_DAYS = 7
const CAMERA_CODES: Partial<Record<EventKind, Set<number>>> = {
  freewheel: new Set([38]),
  cornering: new Set([71, 214]),   // (Tracker) harsh cornering, Harsh turn
}
const ALERT_KIND: Record<string, EventKind> = { HARSH_ACCELERATION: 'acceleration', HARSH_BRAKING: 'braking', HARSH_CORNERING: 'cornering' }
const MAX_PLACE_LOOKUPS = 15
const PLACE_LOOKUP_WAIT_MS = 8_000
const VEHICLES_A_READ = 40

export interface Reading { t: number; lat: number; lng: number; speedKmh: number | null }
export interface LongStop { at: number; lat: number; lng: number; minutes: number; before: boolean; ongoing: boolean }

const rad = (d: number) => (d * Math.PI) / 180
const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h))
}

/**
 * A unit's stands of at least LONG_STOP_MS in [from, to], from its readings in
 * that window, sorted. A stand ends at the reading that moves, or at the last
 * one seen before a reading MOVED_AWAY_M off. Pure.
 */
export function longStops(readings: Reading[], { from, to }: { from: number; to: number }): LongStop[] {
  const out: LongStop[] = []
  let stand: { t: number; lat: number; lng: number; last: number; first: boolean } | null = null
  const close = (end: number, ongoing: boolean) => {
    if (stand && end - stand.t >= LONG_STOP_MS) {
      out.push({ at: stand.t, lat: stand.lat, lng: stand.lng, minutes: Math.round((end - stand.t) / 60_000), before: stand.first, ongoing })
    }
    stand = null
  }
  readings.forEach((r, i) => {
    if (r.t < from || r.t > to) return
    const moving = (r.speedKmh ?? 0) > MOVING_KMH
    if (stand && moving) close(r.t, false)
    else if (stand && metres(stand, r) > MOVED_AWAY_M) close(stand.last, false)
    if (moving) return
    if (stand) stand.last = r.t
    else stand = { t: r.t, lat: r.lat, lng: r.lng, last: r.t, first: i === 0 }
  })
  close(to, true)
  return out
}

/** One event where the tracker and the camera both reported it: the tracker's stands. Pure. */
export function oneOfEach(events: MovementEvent[]): MovementEvent[] {
  const kept: MovementEvent[] = []
  const sorted = [...events].sort((a, b) => a.at - b.at || (a.source === 'tracker' ? -1 : 1))
  for (const e of sorted) {
    const twin = kept.find(k => k.vehicleId === e.vehicleId && k.kind === e.kind && k.source !== e.source && Math.abs(k.at - e.at) <= SAME_EVENT_MS)
    if (!twin) { kept.push(e); continue }
    if (e.source === 'tracker') kept[kept.indexOf(twin)] = e
  }
  return kept
}

/** The camera alarms of the kinds picked, in the window. Pure. */
export function cameraEvents(incidents: DashcamIncident[], kinds: Set<EventKind>, { from, to }: { from: number; to: number }): MovementEvent[] {
  const out: MovementEvent[] = []
  for (const a of incidents) {
    const kind = (Object.keys(CAMERA_CODES) as EventKind[]).find(k => kinds.has(k) && CAMERA_CODES[k]!.has(a.code))
    const at = a.occurredAt ? Date.parse(a.occurredAt) : NaN
    if (!kind || !(at >= from && at <= to)) continue
    out.push({ vehicleId: a.vehicleId, plate: a.plate, kind, at, lat: a.lat, lng: a.lng, place: null, speedKmh: a.speed, source: 'camera' })
  }
  return out
}

async function trackerEvents(orgId: string, kinds: Set<EventKind>, plates: Map<string, string>, from: number, to: number): Promise<MovementEvent[]> {
  const types = Object.keys(ALERT_KIND).filter(t => kinds.has(ALERT_KIND[t]!))
  if (!types.length) return []
  const rows = await prisma.providerAlert.findMany({
    where: { organisationId: orgId, type: { in: types }, vehicleId: { in: [...plates.keys()] }, createdAt: { gte: new Date(from), lte: new Date(to) } },
    select: { vehicleId: true, type: true, createdAt: true, raw: true },
  })
  return rows.map((r) => {
    const raw = (r.raw ?? {}) as { lat?: number | null; lng?: number | null; speedKmh?: number | null }
    return { vehicleId: r.vehicleId!, plate: plates.get(r.vehicleId!) ?? '', kind: ALERT_KIND[r.type]!, at: r.createdAt.getTime(),
      lat: raw.lat ?? null, lng: raw.lng ?? null, place: null, speedKmh: raw.speedKmh ?? null, source: 'tracker' as const }
  })
}

/** Each unit's stops over 10 minutes away from every fence and corridor. */
async function stopEvents(orgId: string, plates: Map<string, string>, from: number, to: number): Promise<MovementEvent[]> {
  await loadOrgZones(orgId)
  const ids = [...plates.keys()]
  const out: MovementEvent[] = []
  for (let i = 0; i < ids.length; i += VEHICLES_A_READ) {
    const part = ids.slice(i, i + VEHICLES_A_READ)
    const rows = await prisma.$queryRaw<Array<{ vehicle_id: string; lat: number; lng: number; speed_kmh: number | null; captured_at: Date }>>`
      SELECT vehicle_id, lat, lng, speed_kmh, captured_at
        FROM vehicle_telemetries
       WHERE vehicle_id = ANY(${part}::text[]) AND captured_at >= ${new Date(from)} AND captured_at <= ${new Date(to)}
         AND lat IS NOT NULL AND lng IS NOT NULL
       ORDER BY vehicle_id, captured_at`
    const byUnit = new Map<string, Reading[]>()
    for (const r of rows) {
      const list = byUnit.get(r.vehicle_id) ?? []
      list.push({ t: r.captured_at.getTime(), lat: r.lat, lng: r.lng, speedKmh: r.speed_kmh })
      byUnit.set(r.vehicle_id, list)
    }
    for (const [vehicleId, readings] of byUnit) {
      for (const s of longStops(readings, { from, to })) {
        const inFence = zoneCategoriesAt(orgId, s.lat, s.lng)
        if (inFence && inFence.size > 0) continue
        out.push({ vehicleId, plate: plates.get(vehicleId) ?? '', kind: 'stop', at: s.at, lat: s.lat, lng: s.lng, place: null, speedKmh: 0,
          source: 'tracker', minutes: s.minutes, ...(s.before ? { before: true } : {}), ...(s.ongoing ? { ongoing: true } : {}) })
      }
    }
  }
  return out
}

/** Names the places it knows at once and looks up a few more; the rest read as coordinates. */
async function namePlaces(events: MovementEvent[]) {
  const located = events.filter(e => e.lat != null && e.lng != null)
  for (const e of located) e.place = cachedPlace(e.lat!, e.lng!)
  const miss = located.filter(e => !e.place).slice(0, MAX_PLACE_LOOKUPS)
  if (miss.length) {
    await Promise.race([
      Promise.all(miss.map(async (e) => { e.place = await reverseGeocode(e.lat!, e.lng!).catch(() => null) })),
      new Promise(resolve => setTimeout(resolve, PLACE_LOOKUP_WAIT_MS).unref?.()),
    ])
  }
  for (const e of located) if (!e.place) e.place = `${e.lat!.toFixed(5)}, ${e.lng!.toFixed(5)}`
}

/** The events picked, in time order, for the units `scope` may see. */
export async function getMovementEvents(
  orgId: string,
  { from, to, kinds }: { from: number; to: number; kinds: EventKind[] },
  scope: Set<string> | null = null,
  now = Date.now(),
): Promise<{ events: MovementEvent[]; notes: string[] }> {
  const picked = new Set(kinds)
  const vehicles = await prisma.vehicle.findMany({ where: { organisationId: orgId }, select: { id: true, registrationPlate: true } })
  const plates = new Map(vehicles.filter(v => !scope || scope.has(v.id)).map(v => [v.id, v.registrationPlate]))
  const notes: string[] = []
  const events: MovementEvent[] = await trackerEvents(orgId, picked, plates, from, to)

  if (picked.has('stop')) events.push(...await stopEvents(orgId, plates, from, to))

  if (kinds.some(k => CAMERA_CODES[k])) {
    if (from < now - CAMERA_DAYS * 86_400_000) {
      notes.push(`The cameras keep their alarms for ${CAMERA_DAYS} days, so this window has no camera events.`)
    } else {
      try {
        const answer = await getAlarms(orgId, scope, new Date(from).toISOString())
        events.push(...cameraEvents(answer.incidents, picked, { from, to }).filter(e => plates.has(e.vehicleId)))
        if (answer.partial || answer.stale) notes.push('The camera server gave only part of its alarms, so camera events may be missing.')
      } catch (err) {
        logger.warn({ err, orgId }, 'movement events: dashcam alarms failed')
        notes.push('The camera server could not be reached, so camera events are not included.')
      }
    }
  }

  const list = oneOfEach(events)
  await namePlaces(list)
  return { events: list, notes }
}
