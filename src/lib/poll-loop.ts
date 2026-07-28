/**
 * Per-instance polling loop — the scheduling primitive every provider loop is
 * built on (telemetry poller, raifactorysuite reconcile).
 *
 * ## Why this exists
 *
 * The in-flight guard and watchdog used to be module-level state inside
 * poller.ts. That was fine while exactly one provider was polled, but running
 * a second one would have made both share a single `isPolling` flag: a slow
 * Wialon cycle would silently skip the raifactorysuite tick, logging only
 * "previous cycle still running" with no hint that a DIFFERENT loop was the
 * one starved. Each loop therefore owns its guard, its watchdog and its
 * timings, and nothing in this file is shared between instances.
 *
 * ## Guarantees
 *
 *  • Never overlaps itself. A tick that arrives while the previous run is
 *    still going is dropped (not queued) — a backlog of stale telemetry
 *    fetches is worth nothing.
 *  • Never wedges permanently. A run that outlives `timeoutMs` is ABANDONED:
 *    the guard is re-armed so the next tick proceeds, because the failure this
 *    protects against (a pooler dropping a pg connection mid-cycle, which
 *    leaves the promise pending forever) otherwise stalls the loop while the
 *    process stays alive, so pm2 never restarts it.
 *  • Never blocks the caller. `start()` kicks off the first run and returns.
 *  • Timers are unref'd, so a pending tick can't hold the process open after
 *    stop().
 */

import { logger } from './logger.js'

export interface PollLoopOptions {
  /** Identifies this loop in logs. Must be unique per loop. */
  name: string
  /** Milliseconds between ticks. */
  intervalMs: number
  /** The work. Rejections are logged and swallowed — a loop never dies. */
  run: () => Promise<void>
  /** Abandon a run that exceeds this and re-arm the guard. Default 5 min. */
  timeoutMs?: number
  /**
   * Delay before the FIRST run. Two loops starting in the same tick of the
   * event loop would otherwise contend for the connection pool on every
   * coinciding cycle; staggering them costs nothing and keeps interactive
   * API/SSE requests responsive at boot.
   */
  startDelayMs?: number
  /** Log every completed run at info. Off by default — chatty loops opt out. */
  quiet?: boolean
}

export interface PollLoopHandle {
  stop: () => void
  /** True while a run is in flight — exposed for health checks and tests. */
  isRunning: () => boolean
  /** Epoch ms the last run COMPLETED (0 until the first one does). */
  lastRunAt: () => number
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000

export function startPollLoop(opts: PollLoopOptions): PollLoopHandle {
  const { name, intervalMs, run, timeoutMs = DEFAULT_TIMEOUT_MS, startDelayMs = 0, quiet = true } = opts

  // Instance state — deliberately closure-local. Two loops share nothing.
  let inFlight  = false
  let lastRunAt = 0
  let stopped   = false

  async function tick(): Promise<void> {
    if (stopped) return
    if (inFlight) {
      logger.warn({ loop: name }, 'Previous run still in flight — skipping this tick')
      return
    }
    inFlight = true
    const t0 = Date.now()

    const attempt = run().then(
      () => 'settled' as const,
      (err) => {
        logger.error({ err, loop: name }, 'Poll run failed')
        return 'settled' as const
      },
    )

    let watchdogTimer!: NodeJS.Timeout
    const watchdog = new Promise<'timeout'>((resolve) => {
      watchdogTimer = setTimeout(() => resolve('timeout'), timeoutMs)
      watchdogTimer.unref()
    })

    const outcome = await Promise.race([attempt, watchdog])
    clearTimeout(watchdogTimer)

    if (outcome === 'timeout') {
      logger.error({ loop: name, timeoutMs }, 'Poll run exceeded its watchdog — abandoning it and re-arming the loop')
      // If the abandoned run ever settles, this log line is its only remaining
      // continuation: it can no longer touch `inFlight`, which this call has
      // already reset and a later run may own by then.
      void attempt.then(() =>
        logger.warn({ loop: name, durationMs: Date.now() - t0 }, 'Abandoned poll run eventually settled'))
    } else if (!quiet) {
      logger.info({ loop: name, durationMs: Date.now() - t0 }, 'Poll run complete')
    }

    lastRunAt = Date.now()
    inFlight  = false
  }

  logger.info({ loop: name, intervalMs, startDelayMs }, 'Poll loop starting')

  const startTimer = setTimeout(() => void tick(), startDelayMs)
  startTimer.unref()
  const timer = setInterval(() => void tick(), intervalMs)

  return {
    stop() {
      stopped = true
      clearTimeout(startTimer)
      clearInterval(timer)
      logger.info({ loop: name }, 'Poll loop stopped')
    },
    isRunning: () => inFlight,
    lastRunAt: () => lastRunAt,
  }
}
