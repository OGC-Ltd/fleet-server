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
import { handleDispatch, handleSale } from '../../modules/webhooks/raifactorysuite-events.service.js'
import { FACTORIES } from '../../modules/webhooks/factory-map.js'

/**
 * How many alerts to re-read each pass. Only genuinely new ones are written or
 * emitted, so this is a lookback window, not a page size: it needs to cover
 * the longest plausible outage at the provider's alert rate (~250 alerts have
 * accumulated in total), not the whole history.
 */
const ALERT_WINDOW = 200

/**
 * Dispatch window. The endpoint caps at 1000 and ignores offset entirely, so
 * this is the ONLY lookback there is — a run that falls out of it can never
 * receive its closure, and stays open in our copy for ever.
 *
 * 500 was about four days at this fleet's ~130 dispatches a day, and the tail
 * showed: measured 2026-08-05, we held 193 dispatches open while the provider
 * held 171, and six of the difference were runs it had already COMPLETED or
 * CANCELLED days earlier. They sat in "out now" indefinitely because nothing
 * ever re-read them. All six were inside the provider's 1000 rows.
 *
 * So take the whole window the endpoint allows. It is one request either way.
 */
const DISPATCH_WINDOW = 1000

/**
 * Sales window, per factory.
 *
 * Asked per factory rather than once, because `/sales` requires a KNOWN
 * factoryCode — an unrecognised one is a hard error, not an empty list — and
 * because the unfiltered call is not documented to stay unfiltered. Two
 * requests every five minutes against a table that held five rows on the day
 * this was written.
 *
 * Sized like the dispatch window rather than measured: sales are new at Naitiri
 * (five rows total on 2026-09-09, four of them test traffic) so there is no
 * daily rate to size against yet. Revisit once the site has run a real week —
 * if this window ever stops covering the gap between two reconcile passes, a
 * run that closes inside it loses its return line permanently.
 */
const SALES_WINDOW = 500

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
    let salesSeen = 0
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

    // Sales, per factory. Independent of the two above for the same reason
    // they are independent of each other: one endpoint failing must not cost
    // the others.
    //
    // `primed` gates narration exactly as it does for dispatches — a restart
    // re-reads the whole window, and without it every sales run in it would be
    // replayed into the feed as though it had just happened. Unlike the
    // dispatch path, though, a re-offered sales run can legitimately produce a
    // NEW line: handleSale narrates on transitions, so the pass that first sees
    // a `returnTime` says so even though the run itself is old news.
    for (const factoryCode of Object.keys(FACTORIES)) {
      try {
        const sales = await this.client.listSales(factoryCode, SALES_WINDOW)
        for (const s of sales) {
          if (await handleSale(s, { narrate: this.primed, source: 'reconciler' })) salesSeen++
        }
      } catch (err) {
        failed = true
        this.logFailure(`sales:${factoryCode}`, err)
      }
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
      { durationMs: Date.now() - t0, alertsCreated, dispatchesSeen, salesSeen, primed: this.primed },
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
