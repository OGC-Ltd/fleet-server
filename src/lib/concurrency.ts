/**
 * Tiny bounded-concurrency queue for fire-and-forget async work.
 *
 * Used by the alerts/sim-events workers so that a burst of state changes
 * across many vehicles in one poll cycle can't open unbounded DB connections
 * at once — they queue behind a small limit instead, leaving headroom in the
 * pg pool for interactive API/SSE traffic.
 */
export function createLimiter(concurrency: number) {
  let active = 0
  const queue: Array<() => void> = []

  function runNext(): void {
    if (active >= concurrency || queue.length === 0) return
    active++
    const next = queue.shift()!
    next()
  }

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn().then(resolve, reject).finally(() => {
          active--
          runNext()
        })
      })
      runNext()
    })
  }
}
