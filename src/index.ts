import { env } from './config/env.js'
import { createApp } from './app.js'
import { connectDB, disconnectDB } from './lib/prisma.js'
import { logger } from './lib/logger.js'
import { startPoller } from './lib/poller.js'
import { startDbFollower } from './lib/db-follower.js'
import { startTelemetryWorker }     from './lib/workers/telemetry.worker.js'
import { startNotificationWorker }  from './lib/workers/notification.worker.js'
import { startAlertsWorker }        from './lib/workers/alerts.worker.js'
import { startSimEventsWorker }     from './lib/workers/sim-events.worker.js'
import { stopPushDispatcher }       from './lib/push-dispatcher.js'
import { startCacheWarmer } from './lib/warm-cache.js'
import { warmRoadRoutes } from './lib/road-routes.js'
import { startAiInsightWarmer } from './modules/dashboard/ai-insight.js'
import { seedFeedFromStoredAlerts } from './modules/webhooks/controltech-alerts.service.js'
import { WialonLiveAdapter } from './providers/wialon/wialon.adapter.js'
import { staticRoutePairs } from './providers/controltech/controltech.simulator.js'

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
  // The live-feed buffer is in-memory, so a restart would blank the Operations
  // feed even though the alerts are stored. Replay the most recent ones so the
  // panel is populated for the first client that connects.
  void seedFeedFromStoredAlerts().catch((err) =>
    logger.warn({ err }, 'Could not seed the live feed from stored alerts'))
  // API-only mode (POLL_ENABLED=false): serve reads off the DB without running
  // the sim — see config/env.ts.
  // Live positions for KASULU come from Wialon. Sukari's provider (Controltech)
  // exposes no coordinates, so this is currently the platform's only source of
  // real GPS — see docs/LIVE_INTEGRATION.md.
  const poller = env.POLL_ENABLED
    ? startPoller(new WialonLiveAdapter())
    : { stop: () => {}, flush: async () => {} }
  if (!env.POLL_ENABLED) logger.warn('POLL_ENABLED=false — telemetry poller/sim NOT started (API-only instance)')
  // API-only instances re-emit live positions + feed off the shared DB
  // (read-only) so a dev dashboard still gets a live map — see lib/db-follower.
  const stopDbFollower = !env.POLL_ENABLED && env.FOLLOW_DB ? startDbFollower() : () => {}

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received')
    poller.stop()
    // Freeze the simulation exactly where it is so the next start resumes it.
    await poller.flush().catch((err) => logger.warn({ err }, 'Simulation flush failed on shutdown'))
    stopDbFollower()
    stopTelemetryWorker()
    stopNotificationWorker()
    stopAlertsWorker()
    stopSimEventsWorker()
    stopCacheWarmer()
    stopAiInsightWarmer()
    await stopPushDispatcher().catch((err) => logger.warn({ err }, 'Push worker thread shutdown failed'))
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
