/**
 * The Alerts badge's counts, held for a minute per reach (alerts.service
 * alertSummary). Every signed-in page polls the badge, and most of them share
 * one reach (the administrators see every organisation), so without this each
 * poll would re-count the week for every one of them.
 *
 * Its own module, with nothing imported, so the fuel review can clear it after
 * a decision without loading the Alerts page's reads.
 */

export const SUMMARY_TTL_MS = 60_000
/** Distinct reaches held at once; past this the oldest go. */
const MAX_ENTRIES = 500

const entries = new Map<string, { at: number; value: unknown }>()

export function cachedSummary<T>(key: string, now = Date.now()): T | null {
  const hit = entries.get(key)
  if (!hit || now - hit.at > SUMMARY_TTL_MS) return null
  return hit.value as T
}

export function keepSummary(key: string, value: unknown, now = Date.now()): void {
  if (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest !== undefined) entries.delete(oldest)
  }
  entries.set(key, { at: now, value })
}

/** A decision changes what is open: every badge counts again on its next poll. */
export function forgetAlertSummaries(): void {
  entries.clear()
}
