/**
 * RaiFactorySuite reconcile poller — the pull half of a push-first integration.
 *
 * ## Why polling at all, when alerts are pushed?
 *
 * Because the push is not reliable and the provider knows it: their sender
 * retries a delivery a handful of times and then DROPS the event permanently.
 * Any window in which we are restarting, or in which our signature check and
 * their signing convention disagree, is a window of alerts that no longer
 * exist anywhere on our side. Until this loop existed the only recovery was a
 * human noticing and running `npm run sync:alerts` by hand.
 *
 * So: the webhook keeps the feed current, and this keeps it CORRECT. Both
 * paths converge because persistence is idempotent on the provider's own ids
 * (`provider_alerts.externalId`, and the `controltech:dispatch:<id>` marker on
 * assignment rows), so overlapping with live webhook traffic never duplicates.
 *
 * ## It is not a telemetry provider
 *
 * RaiFactorySuite exposes no coordinates, so this deliberately does NOT
 * implement `TelemetryProvider` and does not go through lib/poller.ts. It runs
 * on its own `startPollLoop` instance — separate guard, separate watchdog,
 * separate cadence — so it can never stall the Wialon telemetry cycle and the
 * Wialon cycle can never skip its tick.
 *
 * ## Cadence
 *
 * Minutes, not seconds (RAIFACTORYSUITE_POLL_MS, default 5 min). This is a
 * safety net over a push channel, and `/dispatches` returns up to 1000 rows
 * with no pagination — hammering it buys nothing.
 */

import { logger } from '../../lib/logger.js'
import { env } from '../../config/env.js'
import { startPollLoop, type PollLoopHandle } from '../../lib/poll-loop.js'
import { RaiFactorySuiteClient } from './raifactorysuite.client.js'
import { ingestAlerts } from '../../modules/webhooks/raifactorysuite-alerts.service.js'
import { handleDispatch } from '../../modules/webhooks/raifactorysuite-events.service.js'

/**
 * How many alerts to re-read each pass. Only genuinely new ones are written or
 * emitted, so this is a lookback window, not a page size: it needs to cover
 * the longest plausible outage at the provider's alert rate (~250 alerts have
 * accumulated in total), not the whole history.
 */
const ALERT_WINDOW = 200

/** Dispatch window. The endpoint caps at 1000 and ignores offset entirely. */
const DISPATCH_WINDOW = 500

export interface ReconcilerHandle {
  stop: () => void
}

class RaiFactorySuiteReconciler {
  private readonly client = new RaiFactorySuiteClient()

  /**
   * The first pass runs SILENT.
   *
   * If the webhook has been failing (which is the situation this loop exists
   * for), the first reconcile can create hundreds of rows at once. Emitting
   * those would flood the Live Feed with a wall of backlog and — now that
   * provider alerts reach Web Push — wake every subscribed device. After the
   * first pass the DB is caught up, so anything new is genuinely new and worth
   * announcing.
   */
  private primed = false

  /** Consecutive failed runs, for backing off the log noise when they're down. */
  private consecutiveFailures = 0

  get isConfigured(): boolean {
    return this.client.isConfigured
  }

  async runCycle(): Promise<void> {
    const t0 = Date.now()
    let alertsCreated = 0
    let dispatchesSeen = 0
    let failed = false

    // Alerts and dispatches are reconciled independently: one endpoint
    // changing shape or timing out must not cost us the other.
    try {
      const alerts = await this.client.listAlerts(ALERT_WINDOW)
      if (alerts.length > 0) {
        const result = await ingestAlerts(alerts, 'backfill', this.primed)
        alertsCreated = result.created
        if (!this.primed && result.created > 0) {
          logger.info(
            { created: result.created },
            'RaiFactorySuite reconcile: first pass stored a backlog silently (feed not flooded)',
          )
        }
      }
    } catch (err) {
      failed = true
      this.logFailure('alerts', err)
    }

    try {
      const dispatches = await this.client.listDispatches(DISPATCH_WINDOW)
      // This used to pass narrate:false unconditionally, on the reasoning that
      // the window is re-read every cycle and the `dispatch.created` webhook is
      // the one thing that sees each dispatch exactly once. The webhook is not
      // arriving: measured 2026-08-03, SUKARI had 1,813 dispatches on record
      // and NOT ONE feed item of alertType DISPATCH, ever. Every dispatch in
      // the system came through this reconciler, silently, so the Live Feed
      // never mentioned the single most operationally significant event the
      // provider reports.
      //
      // Narrating here is now safe because publishNotification dedupes on
      // feedId plus a content fingerprint (see notifications/notification.store)
      // — the same dispatch re-offered on the next cycle reaches nothing: no
      // SSE frame, no row, no cache write. That mechanism did not exist when
      // this was written.
      //
      // `primed` still gates the FIRST pass, exactly as the alerts path does:
      // the window is a day wide, so a restart would otherwise replay a day of
      // dispatches into the feed as though they had all just happened.
      for (const d of dispatches) {
        if (await handleDispatch(d, { narrate: this.primed, source: 'reconciler' })) dispatchesSeen++
      }
    } catch (err) {
      failed = true
      this.logFailure('dispatches', err)
    }

    if (failed) {
      this.consecutiveFailures++
    } else {
      if (this.consecutiveFailures > 0) {
        logger.info({ after: this.consecutiveFailures }, 'RaiFactorySuite reconcile recovered')
      }
      this.consecutiveFailures = 0
      this.primed = true
    }

    logger.info(
      { durationMs: Date.now() - t0, alertsCreated, dispatchesSeen, primed: this.primed },
      'RaiFactorySuite reconcile complete',
    )
  }

  /**
   * A provider outage is usually minutes long and would otherwise produce an
   * error line every cycle for its whole duration. Log the first few loudly,
   * then drop to debug until it recovers.
   */
  private logFailure(what: string, err: unknown): void {
    if (this.consecutiveFailures < 3) logger.error({ err, what }, 'RaiFactorySuite reconcile failed')
    else logger.debug({ err, what, consecutiveFailures: this.consecutiveFailures }, 'RaiFactorySuite reconcile still failing')
  }
}

/**
 * Start the reconcile loop. Returns a no-op handle when it should stay
 * dormant — no API key, or explicitly disabled — so callers never branch.
 */
export function startRaiFactorySuiteReconciler(): ReconcilerHandle {
  if (!env.RAIFACTORYSUITE_POLL_ENABLED) {
    logger.warn('RAIFACTORYSUITE_POLL_ENABLED=false — reconcile poller NOT started (webhook-only instance)')
    return { stop: () => {} }
  }

  const reconciler = new RaiFactorySuiteReconciler()
  if (!reconciler.isConfigured) {
    logger.warn('No RaiFactorySuite API key configured — reconcile poller NOT started; alerts depend entirely on the webhook')
    return { stop: () => {} }
  }

  const loop: PollLoopHandle = startPollLoop({
    name:       'raifactorysuite:reconcile',
    intervalMs: env.RAIFACTORYSUITE_POLL_MS,
    // Boot is the busiest moment for the connection pool (cache warmers, the
    // feed seed, the first telemetry cycle). The provider backlog is minutes
    // old already; a few more seconds costs nothing.
    startDelayMs: 15_000,
    run:        () => reconciler.runCycle(),
  })

  return { stop: () => loop.stop() }
}
