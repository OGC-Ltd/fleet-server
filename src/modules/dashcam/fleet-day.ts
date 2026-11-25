/**
 * Fleet days (Nairobi) for the dashcam capture, its cache and its readers.
 * Nairobi is UTC+3 all year, so a fleet day starts at 21:00 UTC the evening before.
 */

export const DAY = 86_400_000
const EAT = 3 * 3_600_000

/** A fleet day's [start, end) in ms, from "YYYY-MM-DD" (Nairobi). */
export function dayWindow(day: string): { from: number; to: number } {
  const from = Date.parse(`${day}T00:00:00Z`) - EAT
  return { from, to: from + DAY }
}

/** The fleet day (Nairobi) a time falls on. */
export function fleetDayOf(ms: number): string {
  return new Date(ms + EAT).toISOString().slice(0, 10)
}

/** The `n` fleet days before today's, oldest first (today itself is never complete). */
export function lastDays(n: number, now = Date.now()): string[] {
  const today = fleetDayOf(now)
  const out: string[] = []
  for (let i = n; i >= 1; i--) out.push(fleetDayOf(dayWindow(today).from - i * DAY + 12 * 3_600_000))
  return out
}

/** Every fleet day that [fromMs, toMs) touches, oldest first. */
export function daysBetween(fromMs: number, toMs: number): string[] {
  const out: string[] = []
  if (!(toMs > fromMs)) return out
  let day = fleetDayOf(fromMs)
  const last = fleetDayOf(toMs - 1)
  for (let guard = 0; guard < 400; guard++) {
    out.push(day)
    if (day === last) break
    day = fleetDayOf(dayWindow(day).to + 12 * 3_600_000)
  }
  return out
}
