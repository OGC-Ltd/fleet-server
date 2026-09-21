import { env } from './config/env.js'
import { createApp } from './app.js'
import { connectDB, disconnectDB } from './lib/prisma.js'
import { logger } from './lib/logger.js'
import { startPoller } from './lib/poller.js'
import { startDbFollower } from './lib/db-follower.js'
import { startTelemetryWorker }     from './lib/workers/telemetry.worker.js'
import { startNotificationWorker }  from './lib/workers/notification.worker.js'
import { startAlertsWorker }        from './lib/workers/alerts.worker.js'
import { startSpeedingWorker }      from './lib/workers/speeding.worker.js'
import { startSensorFaultsWorker }  from './lib/workers/sensor-faults.worker.js'
import { startSimEventsWorker }     from './lib/workers/sim-events.worker.js'
import { stopPushDispatcher }       from './lib/push-dispatcher.js'
import { startCacheWarmer } from './lib/warm-cache.js'
import { warmRoadRoutes } from './lib/road-routes.js'
import { startAiInsightWarmer } from './modules/dashboard/ai-insight.js'
import { WialonLiveAdapter } from './providers/wialon/wialon.adapter.js'
import { startRaiFactorySuiteReconciler } from './providers/raifactorysuite/raifactorysuite.reconciler.js'
import { startRetentionSweep } from './lib/queues/retention.js'
import { startFuelSync } from './lib/queues/fuel-events.js'
import { startTripBuild } from './lib/queues/trips.js'
import { startOutboundWorker } from './lib/queues/outbound.js'
import { disconnectRedis } from './lib/redis.js'
import { staticRoutePairs } from './providers/raifactorysuite/raifactorysuite.simulator.js'

async function main() {
  await connectDB()

  const app = createApp()

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Fleet Server started')
  })

  // Start event-bus workers before the poller so no events are missed
  const stopTelemetryWorker    = startTelemetryWorker()
  const stopNotificationWorker = startNotificationWorker()
  const stopAlertsWorker       = startAlertsWorker()
  const stopSpeedingWorker     = startSpeedingWorker()
  const stopSensorFaultsWorker = startSensorFaultsWorker()
  const stopSimEventsWorker    = startSimEventsWorker()
  // Keep the analytics/maintenance read caches hot so those pages never wait
  // on the remote database (each pooler round trip costs ~1s) — see
  // lib/warm-cache.ts.
  const stopCacheWarmer = startCacheWarmer()
  // Pre-resolve the fleet's road polylines (one-time per pair, disk-cached) so
  // vehicles follow real roads from the first tick — see lib/road-routes.ts.
  void warmRoadRoutes(staticRoutePairs())
  // Hourly AI operations brief per org (dashboard/ai-insight.ts) — generated
  // in the background so the endpoint always answers from memory.
  const stopAiInsightWarmer = startAiInsightWarmer()
  // (The live feed used to be seeded here into a shared in-memory ring. Each
  // SSE client now replays its OWN org's history from the durable store on
  // connect — see lib/sse.ts's replayDashboardFeed — so there is nothing to
  // pre-warm, and a restart no longer blanks anyone's Operations panel.)
  // ── provider ingestion ──────────────────────────────────────────────────
  // Two INDEPENDENT loops, each with its own guard, watchdog and cadence (see
  // lib/poll-loop.ts). Neither can skip the other's tick, and a stall in one
  // provider is visible in the logs as that provider's loop, not the other's.
  //
  // API-only mode (POLL_ENABLED=false): serve reads off the DB without running
  // the telemetry poller — see config/env.ts.
  //
  // Live positions for KASULU come from Wialon. Sukari's provider
  // (RaiFactorySuite) exposes no coordinates, so Wialon is currently the
  // platform's only source of real GPS — see docs/LIVE_INTEGRATION.md.
  const poller = env.POLL_ENABLED
    ? startPoller(new WialonLiveAdapter())
    : { stop: () => {}, flush: async () => {} }
  if (!env.POLL_ENABLED) logger.warn('POLL_ENABLED=false — telemetry poller/sim NOT started (API-only instance)')

  // RaiFactorySuite's alerts and dispatches arrive by WEBHOOK; this loop is the
  // reconcile safety net for the deliveries their sender retries a few times
  // and then drops. Independent of POLL_ENABLED: an API-only instance still
  // wants its operations feed to be complete, and the writes are idempotent.
  const raiFactorySuite = startRaiFactorySuiteReconciler()

  // Notification retention — a BullMQ repeatable job that deletes items past
  // NOTIFICATION_RETENTION_DAYS. No-op without REDIS_URL, which is the current
  // production state: the t3.micro is already swapping, so Redis only arrives
  // after the instance is resized. Until then notifications persist to
  // Postgres and accumulate — see lib/queues/retention.ts.
  const retention = await startRetentionSweep()

  // Fuel fillings and drains from Wialon's reports onto the Live Feed. This
  // one has to run IN-PROCESS: the notification read path serves its first
  // page from the Redis cache, and the equivalent CLI (`npm run sync:fuel`)
  // cannot write that cache, so its items were durable but invisible.
  // Also no-op without REDIS_URL — see lib/queues/fuel-events.ts.
  const fuelSync = await startFuelSync()
  // Completed dispatches → measured trips. Nothing else writes that table
  // since the simulator was retired — see lib/queues/trips.
  const tripBuild = await startTripBuild()
  // Mail and durable notifications, off the request thread. Unlike the three
  // above this one is NOT conditional on Redis in its effect: with no
  // REDIS_URL the publishers send inline exactly as they did before, so a
  // password reset still leaves the building. See lib/queues/outbound.
  const outbound = await startOutboundWorker()
  // API-only instances re-emit live positions + feed off the shared DB
  // (read-only) so a dev dashboard still gets a live map — see lib/db-follower.
  const stopDbFollower = !env.POLL_ENABLED && env.FOLLOW_DB ? startDbFollower() : () => {}

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received')
    poller.stop()
    raiFactorySuite.stop()
    await retention.stop().catch((err) => logger.warn({ err }, 'Retention sweep shutdown failed'))
    await fuelSync.stop().catch((err) => logger.warn({ err }, 'Fuel sync shutdown failed'))
    await tripBuild.stop().catch((err) => logger.warn({ err }, 'Trip build shutdown failed'))
    // Before disconnectRedis below, so in-flight mail is finished rather than
    // having its connection pulled out from under it.
    await outbound.stop().catch((err) => logger.warn({ err }, 'Outbound worker shutdown failed'))
    // Freeze the simulation exactly where it is so the next start resumes it.
    await poller.flush().catch((err) => logger.warn({ err }, 'Simulation flush failed on shutdown'))
    stopDbFollower()
    stopTelemetryWorker()
    stopNotificationWorker()
    stopAlertsWorker()
    stopSpeedingWorker()
    stopSensorFaultsWorker()
    stopSimEventsWorker()
    stopCacheWarmer()
    stopAiInsightWarmer()
    await stopPushDispatcher().catch((err) => logger.warn({ err }, 'Push worker thread shutdown failed'))
    await disconnectRedis().catch((err) => logger.warn({ err }, 'Redis disconnect failed'))
    server.close(async () => {
      await disconnectDB()
      logger.info('Graceful shutdown complete')
      process.exit(0)
    })

    setTimeout(() => process.exit(1), 10_000)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — shutting down')
    void shutdown('uncaughtException')
  })

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled promise rejection — shutting down')
    void shutdown('unhandledRejection')
  })
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start server')
  process.exit(1)
})
