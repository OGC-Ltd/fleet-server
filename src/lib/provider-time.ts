/**
 * Timestamp parsing for provider payloads.
 *
 * RaiFactorySuite (and Wialon's REST surfaces) send local wall-clock timestamps
 * with NO timezone offset and nanosecond precision, e.g.
 *
 *     "2026-07-26T06:35:12.100337484"
 *
 * `new Date(...)` on that form is resolved against the HOST's timezone, which
 * makes the result depend on where the code runs: correct on a dev machine in
 * EAT, three hours late on the production box (UTC). That is exactly what put
 * the Live Feed three hours into the future.
 *
 * Both fleets operate in East Africa Time — Kenya (Sukari) and Tanzania
 * (Kasulu) are both UTC+3 with no DST — so an offsetless payload timestamp is
 * unambiguously EAT. Stamping it explicitly makes parsing deterministic
 * everywhere.
 */

/** East Africa Time. Kenya and Tanzania both observe UTC+3 year-round. */
export const PROVIDER_UTC_OFFSET = '+03:00'

/** Hours the fleet's wall clock runs ahead of UTC. EAT, and it has no DST. */
const FLEET_UTC_OFFSET_H = 3

/**
 * Midnight at the START of the fleet's current day, as an instant.
 *
 * "Dispatched today" has to mean today in Ndhiwa, not today in UTC: the two
 * diverge for the three hours after local midnight, which is exactly when a
 * night shift's runs would silently drop off the board. Computed by shifting
 * into local time, truncating the date, and shifting back — safe because EAT is
 * a fixed offset, so there is no DST discontinuity to land on.
 */
export function fleetDayStart(now: Date = new Date()): Date {
  const shifted = new Date(now.getTime() + FLEET_UTC_OFFSET_H * 3_600_000)
  const midnightLocal = Date.UTC(
    shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(),
  )
  return new Date(midnightLocal - FLEET_UTC_OFFSET_H * 3_600_000)
}

/**
 * The fleet day's own CALENDAR DATE, as UTC midnight — the value a `@db.Date`
 * column should hold.
 *
 * Not the same thing as `fleetDayStart`, and conflating them is an off-by-one
 * that shipped: `fleetDayStart` returns the INSTANT EAT-midnight falls on,
 * which in UTC is 21:00 the PREVIOUS evening. Taking that instant's UTC
 * calendar components therefore labels every fleet day with the day before it.
 *
 *     fleetDayStart('2026-08-13T20:50Z')  ->  2026-08-12T21:00Z
 *       ...whose UTC date is the 12th, but which opens EAT day the 13th
 *     fleetDayKey('2026-08-13T20:50Z')    ->  2026-08-13
 *
 * It went unnoticed because the labels were uniformly wrong — every row shifted
 * by one, so nothing disagreed with anything else. It surfaced only when the
 * stored rows were lined up against a recomputed day.
 *
 * Shifting back into EAT before reading the components is what makes it the
 * date a person in Ndhiwa would write on the sheet.
 */
export function fleetDayKey(now: Date = new Date()): Date {
  const eat = new Date(fleetDayStart(now).getTime() + FLEET_UTC_OFFSET_H * 3_600_000)
  return new Date(Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), eat.getUTCDate()))
}

const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/

/**
 * Parse a provider timestamp to a Date.
 *
 * - A value that already carries `Z` or an offset is trusted as-is.
 * - An offsetless value is read as EAT.
 * - Sub-millisecond digits are truncated (JS Dates hold milliseconds).
 *
 * Returns null for empty or unparseable input, so callers can decide whether
 * to fall back to the receive time rather than storing an Invalid Date.
 */
export function parseProviderTime(value: string | null | undefined): Date | null {
  if (!value) return null
  const raw = String(value).trim()
  if (!raw) return null

  // Nanosecond/microsecond precision → milliseconds.
  const trimmed = raw.replace(/(\.\d{3})\d+/, '$1')
  const stamped = HAS_ZONE.test(trimmed) ? trimmed : `${trimmed}${PROVIDER_UTC_OFFSET}`

  const d = new Date(stamped)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Parse, falling back to `now` when the provider sent nothing usable. */
export function parseProviderTimeOr(value: string | null | undefined, fallback = new Date()): Date {
  return parseProviderTime(value) ?? fallback
}
