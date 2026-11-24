/**
 * One run of an expensive read for every caller that asks the same question
 * at about the same time.
 *
 * Why: "distance covered today" for every active unit of an organisation is
 * asked by three warm caches — analytics distance, fleet state and machine
 * operations — each on its own 60 s refresh. They ask with the same units and
 * the same start of day, and on 2026-11-24 pg_stat_activity showed three copies
 * of that statement starting in the same second, each 30-73 s on SUKARI's 644
 * units. The day's figures for the probe report and fleet state are the same
 * story. The cache dedupes per CACHE KEY; this dedupes per QUESTION, across
 * caches.
 *
 * A caller arriving while a run is in flight gets that run's promise; one
 * arriving within `ttlMs` after it settled gets its result. A rejection is
 * never kept, so a failure does not stick. `ttlMs` stays under the warm-cache
 * refresh interval, so each sweep still reads figures no older than it did.
 */

interface Entry<T> { p: Promise<T>; settledAt: number | null }

export interface SharedQueryOptions {
  /** How long a settled result is handed out again. */
  ttlMs: number
  /** Entries kept at most; the oldest goes first. */
  maxEntries?: number
}

export function sharedQuery<A extends unknown[], T>(
  keyOf: (...args: A) => string,
  run: (...args: A) => Promise<T>,
  { ttlMs, maxEntries = 64 }: SharedQueryOptions,
): ((...args: A) => Promise<T>) & { clear(): void } {
  const entries = new Map<string, Entry<T>>()

  const call = (...args: A): Promise<T> => {
    const key = keyOf(...args)
    const now = Date.now()
    const hit = entries.get(key)
    if (hit && (hit.settledAt == null || now - hit.settledAt < ttlMs)) return hit.p
    if (hit) entries.delete(key)

    const entry: Entry<T> = { p: run(...args), settledAt: null }
    entries.set(key, entry)
    entry.p.then(
      () => { entry.settledAt = Date.now() },
      () => { if (entries.get(key) === entry) entries.delete(key) },
    )
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value!)
    return entry.p
  }

  return Object.assign(call, { clear: () => entries.clear() })
}
