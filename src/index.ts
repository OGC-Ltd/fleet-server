import { env } from './config/env.js'
import { createApp } from './app.js'
import { connectDB, disconnectDB } from './lib/prisma.js'
import { logger } from './lib/logger.js'
import { startPoller } from './lib/poller.js'
import { startTelemetryWorker }     from './lib/workers/telemetry.worker.js'
import { startNotificationWorker }  from './lib/workers/notification.worker.js'
import { startAlertsWorker }        from './lib/workers/alerts.worker.js'
import { startSimEventsWorker }     from './lib/workers/sim-events.worker.js'
import { stopPushDispatcher }       from './lib/push-dispatcher.js'
import { startCacheWarmer } from './lib/warm-cache.js'
import { warmRoadRoutes } from './lib/road-routes.js'
import { startAiInsightWarmer } from './modules/dashboard/ai-insight.js'
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
  // API-only mode (POLL_ENABLED=false): serve reads off the DB without running
  // the sim — see config/env.ts.
  const poller = env.POLL_ENABLED
    ? startPoller()
    : { stop: () => {}, flush: async () => {} }
  if (!env.POLL_ENABLED) logger.warn('POLL_ENABLED=false — telemetry poller/sim NOT started (API-only instance)')

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received')
    poller.stop()
    // Freeze the simulation exactly where it is so the next start resumes it.
    await poller.flush().catch((err) => logger.warn({ err }, 'Simulation flush failed on shutdown'))
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
