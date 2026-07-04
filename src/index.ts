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
  const poller                 = startPoller()

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received')
    poller.stop()
    // Freeze the simulation exactly where it is so the next start resumes it.
    await poller.flush().catch((err) => logger.warn({ err }, 'Simulation flush failed on shutdown'))
    stopTelemetryWorker()
    stopNotificationWorker()
    stopAlertsWorker()
    stopSimEventsWorker()
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
