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
