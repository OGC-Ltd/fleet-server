/**
 * Run each organisation's dashcam work in its own lane, several lanes at once
 * (VSS_ORG_CONCURRENCY), for the vss-worker's sync and back-fill.
 *
 * What overlaps is everything but the searches: the alarm-type lookups, the
 * database writes and the caching of one organisation while another's search
 * runs. The §3.24 searches themselves still go one at a time, 10 s apart, for
 * the whole VSS account (dashcam.service searchPaced): VSS refuses a second
 * search sooner than that whoever it is for, so lanes never search at once.
 */

/** `fn` over `items`, at most `limit` at a time; resolves when all are done. */
export async function inLanes<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++]!
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane))
}
