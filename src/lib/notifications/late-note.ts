/**
 * "Reported N hours late" — a sentence for a feed line that reaches the feed
 * long after the event it describes.
 *
 * A feed item is stamped with when it HAPPENED, so a late one sorts under
 * newer lines and nothing about it says it is late. Measured 8–22 Oct: stage-one
 * parked-theft calls up to 48 h late (trackers uploading a backlog), adjudicated
 * SIPHON up to 20 h late (a drain Wialon offered only on a later re-read). An
 * operator reading "lost 40 L" at 09:00 under a 03:00 stamp needs to be told
 * it was found at 09:00, not left to think it sat unnoticed for six hours.
 */

/** Minutes or hours, for a sentence. */
export function lateSpan(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 90) return m === 1 ? '1 minute' : `${m} minutes`
  const h = m / 60
  return `${h < 10 ? h.toFixed(1) : Math.round(h)} hours`
}

/**
 * The sentence, or '' when the line is on time. `onTimeMs` is how late this
 * kind of line normally is by design — an adjudicated drain waits out its
 * settle window — so only lateness beyond it is worth saying.
 */
export function lateNote(happenedAt: Date, now: Date, onTimeMs: number, why: string): string {
  const late = now.getTime() - happenedAt.getTime()
  if (late <= onTimeMs) return ''
  return ` Reported ${lateSpan(late)} after it happened: ${why}.`
}
