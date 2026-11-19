/**
 * FactorySuite's rule for its webhooks: "the same event can arrive more than
 * once: keep what you have handled and ignore a repeat".
 *
 * Both of its webhooks (FACTORY_SUITE_HOOK and WORK_PLANNER_HOOK) post to
 * /webhook/rai, so an event ticked on both arrives twice. On 19 Nov 2026,
 * fuelplan.decided and fuelplan.released for WP-261120-FAC each came twice,
 * 0.16 s apart, the first plan events ever delivered here.
 *
 * Only the events that START work are checked (work plan and workshop events:
 * a cache clear, a page refresh and a re-read of FactorySuite). Everything
 * FactorySuite sends that is stored is upserted on its own id already.
 *
 * A repeat is the same event name with the same data. occurredAt is left out
 * on purpose: nothing says two webhooks stamp one event alike. Held for
 * REPEAT_TTL_MS, in memory: long enough for the two webhooks and a quick
 * retry; a genuinely new event with identical data inside it is caught by the
 * 5-minute work plan watch and the workshop reconcile anyway. A restart
 * forgets, and a repeat then costs one more refresh.
 */

import { createHash } from 'crypto'

export const REPEAT_TTL_MS = 10 * 60_000
const MAX_KEPT = 5_000

/** The data as JSON with its keys sorted, so key order never makes two copies differ. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/** What makes two deliveries the same event. */
export function deliveryKey(event: string, data: unknown): string {
  return createHash('sha256').update(`${event}|${stable(data)}`).digest('hex')
}

// Key → when it stops counting as seen. Every entry gets the same TTL and is
// re-inserted when refreshed, so the Map's order is expiry order.
const seen = new Map<string, number>()

/** True the first time a delivery is seen in REPEAT_TTL_MS, false for a repeat. */
export function firstDelivery(key: string, now = Date.now()): boolean {
  for (const [k, until] of seen) {
    if (until > now) break
    seen.delete(k)
  }
  if ((seen.get(key) ?? 0) > now) return false
  seen.delete(key)
  seen.set(key, now + REPEAT_TTL_MS)
  if (seen.size > MAX_KEPT) {
    const oldest = seen.keys().next().value
    if (oldest !== undefined) seen.delete(oldest)
  }
  return true
}

/** Tests only: start with nothing seen. */
export function forgetDeliveries(): void {
  seen.clear()
}

const shapesLogged = new Set<string>()

/**
 * The keys an event's data carries (names only, never values), once per event
 * name and process: what the payload holds before anything is built on it.
 */
export function newShape(event: string, data: unknown): string[] | null {
  if (shapesLogged.has(event)) return null
  shapesLogged.add(event)
  return data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).sort() : []
}
