import { env } from './config/env.js'
import { createApp } from './app.js'
import { connectDB, disconnectDB } from './lib/prisma.js'
import { logger } from './lib/logger.js'

async function main() {
  await connectDB()

  const app = createApp()

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Fleet Server started')
  })

  // ── Graceful shutdown ───────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received')
    server.close(async () => {
      await disconnectDB()
      logger.info('Graceful shutdown complete')
      process.exit(0)
    })
    // Force exit if shutdown takes too long
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
