/**
 * Reject fixes the vehicle could not physically have reached.
 *
 * ## Why
 *
 * The live stream carries positions that are simply wrong. Measured over 24 h
 * on SUKARI (214,925 consecutive-fix pairs): 0.91% imply a speed above
 * 120 km/h, 1,282 of them imply over 300 km/h, and the 99.9th percentile is
 * 2,141 km/h. Inside the windows where a vehicle is leaving the yard the rate
 * is **5.15%** — five times higher, which is what multipath around sheds and a
 * weighbridge looks like.
 *
 * The decisive detail: **no fix in the fleet ever REPORTS a speed above
 * 120 km/h.** The device does not claim to be moving that fast. So it is the
 * position that is wrong, not the speed, and a position that is wrong by a
 * kilometre is enough to announce a departure that never happened. Three of
 * these were caught red-handed in the departure replay — 1,121 m in 2 s,
 * 763 m in 2 s, 2,025 m in 314 s.
 *
 * `trip-builder` already guards distance with a flat 5 km teleport ceiling.
 * That works for summing a trip's mileage, where the only question is whether
 * to add a leg. It is the wrong shape here: a stale fix an hour old is
 * legitimately far away, and a fresh one 900 m out is not. Expressing the test
 * as an implied SPEED scales with the gap and answers the question actually
 * being asked — could the vehicle have got there?
 *
 * State is per vehicle and in memory, like the rest of the tracking helpers.
 * The first fix for a vehicle is always accepted: there is nothing to measure
 * it against, and rejecting it would strand the vehicle permanently.
 */

import { haversineM } from './dispatch-trip.js'

/**
 * Fastest anything in this fleet could be moving. Loaded cane trucks and
 * haulmasters top out far below it — the highest speed ever recorded on a trip
 * is 59 km/h — so this is a generous ceiling that only implausible POSITIONS
 * can breach, not a speed limit.
 */
export const PLAUSIBLE_KMH = 120

interface Accepted { lat: number; lng: number; at: number }

/** vehicleId → the last fix we believed. */
const lastAccepted = new Map<string, Accepted>()

export interface FixCandidate {
  vehicleId: string
  lat:       number
  lng:       number
  /** Milliseconds since epoch of the fix's capture time. */
  atMs:      number
}

/**
 * True when the fix is believable, and remembers it as the new reference.
 * False when reaching it from the last accepted fix would have required
 * exceeding `PLAUSIBLE_KMH` — in which case the reference is left alone, so a
 * single bad position cannot drag the baseline with it.
 *
 * Out-of-order and duplicate frames (`atMs` at or before the reference) are
 * accepted without a speed test but do NOT become the reference: devices buffer
 * through coverage gaps and dump a backlog, and re-ordering that here would be
 * a different job from deciding whether a position is possible.
 */
export function isPlausibleFix(fix: FixCandidate): boolean {
  const prev = lastAccepted.get(fix.vehicleId)
  if (!prev) {
    lastAccepted.set(fix.vehicleId, { lat: fix.lat, lng: fix.lng, at: fix.atMs })
    return true
  }

  const dtMs = fix.atMs - prev.at
  if (dtMs <= 0) return true

  const metres = haversineM({ lat: prev.lat, lng: prev.lng }, { lat: fix.lat, lng: fix.lng })
  const impliedKmh = (metres / (dtMs / 1000)) * 3.6
  if (impliedKmh > PLAUSIBLE_KMH) return false

  lastAccepted.set(fix.vehicleId, { lat: fix.lat, lng: fix.lng, at: fix.atMs })
  return true
}

/** Forget per-vehicle state. Tests only. */
export function resetFixPlausibility(): void {
  lastAccepted.clear()
}
