/**
 * The report worker process: `pm2 start dist/src/report-worker.js --name
 * report-worker` (the deploy workflow does it). Runs the Logbook's queued
 * builds and its PDFs and workbooks — see modules/usage-review/usage-review.worker.
 *
 * Its database pool is small: a build reads a vehicle, the organisation's
 * fences and, only when Wialon cannot be reached, its telemetry. Set before
 * anything reads the environment, which is why the rest is imported after.
 */

process.env['DB_POOL_MAX'] ??= '4'

const { logger } = await import('./lib/logger.js')
const { connectDB, disconnectDB } = await import('./lib/prisma.js')
const { disconnectRedis } = await import('./lib/redis.js')
const { closeReportQueues } = await import('./lib/queues/usage-review.js')
const { startReportWorker } = await import('./modules/usage-review/usage-review.worker.js')

await connectDB()
const worker = await startReportWorker()

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  logger.info({ signal }, 'Report worker stopping')
  await worker.stop().catch((err) => logger.warn({ err }, 'Report worker shutdown failed'))
  await closeReportQueues().catch(() => {})
  await disconnectRedis().catch(() => {})
  await disconnectDB().catch(() => {})
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('unhandledRejection', (reason) => logger.error({ reason }, 'Report worker: unhandled rejection'))
