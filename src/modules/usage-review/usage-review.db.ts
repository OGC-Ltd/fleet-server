/**
 * The database side of a usage review: our own telemetry table, read when
 * Wialon cannot be reached (see usage-review.service for why it is not read
 * first). It keeps TELEMETRY_RETENTION_DAYS (30 by default) and stores no
 * odometer, so these days are measured on the GPS track.
 *
 * A day counts as held when its rows leave no silence longer than
 * MAX_SILENCE_MS anywhere in it, edges included: a parked unit still reports
 * every ~15 minutes, so three hours of nothing is a hole in our copy. Days that
 * are not held are flagged as incomplete in the review.
 */

import { prisma } from '../../lib/prisma.js'
import { dayStartMs, daysBetween, eatDay, type ReviewMessage } from './usage-review.compute.js'

export const MAX_SILENCE_MS = 3 * 3_600_000
/** A day this young may still be arriving; it is never trusted from the table alone. */
const SETTLE_MS = 30 * 60_000
const BATCH = 50_000

export async function loadDbHistory(vehicleId: string, fromMs: number, toMs: number): Promise<ReviewMessage[]> {
  const out: ReviewMessage[] = []
  let cursor = new Date(fromMs)
  const end = new Date(toMs)
  for (;;) {
    const rows = await prisma.vehicleTelemetry.findMany({
      where: { vehicleId, capturedAt: { gte: cursor, lt: end } },
      orderBy: { capturedAt: 'asc' },
      take: BATCH,
      select: { capturedAt: true, lat: true, lng: true, speedKmh: true, headingDeg: true, engineOn: true, ignitionKnown: true },
    })
    for (const r of rows) {
      out.push({
        t: Math.floor(r.capturedAt.getTime() / 1000),
        lat: r.lat, lng: r.lng, speed: r.speedKmh ?? 0, course: r.headingDeg,
        odoM: null,
        // engineOn alone is "moved" on a unit with no ignition line; only a
        // measured state is an ignition reading.
        ign: r.ignitionKnown === true ? r.engineOn : null,
        src: 'db',
      })
    }
    if (rows.length < BATCH) break
    cursor = new Date(rows[rows.length - 1]!.capturedAt.getTime() + 1)
  }
  return out
}

/** The period's days our table holds completely. */
export function heldDays(msgs: ReviewMessage[], from: string, to: string, now = Date.now()): Set<string> {
  const byDay = new Map<string, number[]>()
  for (const m of msgs) {
    const d = eatDay(m.t * 1000)
    let xs = byDay.get(d)
    if (!xs) byDay.set(d, xs = [])
    xs.push(m.t * 1000)
  }
  const held = new Set<string>()
  for (const day of daysBetween(from, to)) {
    const ts = byDay.get(day)
    if (!ts?.length) continue
    const start = dayStartMs(day)
    const end = Math.min(start + 86_400_000, now - SETTLE_MS)
    if (end <= start) continue
    let prev = start, ok = true
    for (const t of ts) { if (t - prev > MAX_SILENCE_MS) { ok = false; break } prev = t }
    if (ok && end - prev > MAX_SILENCE_MS) ok = false
    if (ok) held.add(day)
  }
  return held
}
