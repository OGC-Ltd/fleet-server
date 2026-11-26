/**
 * The VSS worker process (`node dist/src/vss-worker.js`, the `vss-worker`
 * compose service). The only process that searches VSS on a schedule:
 *
 *  · every 5 minutes, every organisation's dashcam day, one organisation at
 *    a time, into dashcam_alarms and the Redis day cache (lib/queues/vss-sync);
 *  · each night, the last few days again for late uploads and late alarm
 *    types (lib/queues/dashcam-capture, moved here from the API server);
 *  · at start and hourly, every past day of the last 13 that was missed or
 *    cut short, oldest first, while VSS still holds it (lib/queues/vss-backfill).
 *
 * Reports are the report worker's (src/report-worker.ts); this one only keeps
 * the dashcam cache and tables up to date.
 *
 * The API server's Alarms page and reports read what this writes
 * (modules/dashcam/dashcam-store). VSS allows one search every 10 s for the
 * whole account, and the pacing lives in one process, so ONE vss-worker only.
 * It shares the cache volume's VSS session file with the server, so neither
 * logs in again for the other.
 *
 * Its database pool is small: a capture writes a few hundred rows at a time.
 * Set before anything reads the environment, which is why the rest is imported after.
 */

process.env['DB_POOL_MAX'] ??= '4'

const { logger } = await import('./lib/logger.js')
const { env } = await import('./config/env.js')
const { connectDB, disconnectDB } = await import('./lib/prisma.js')
const { disconnectRedis } = await import('./lib/redis.js')
const { startVssSync } = await import('./lib/queues/vss-sync.js')
const { startDashcamCapture } = await import('./lib/queues/dashcam-capture.js')
const { startVssBackfill } = await import('./lib/queues/vss-backfill.js')
const { vssAvailable } = await import('./providers/vss/index.js')
const { flushTelemetry } = await import('./lib/tracing.js')

await connectDB()
const handles: Array<{ stop: () => Promise<void> }> = []
if (!vssAvailable()) {
  logger.warn('VSS is not configured (VSS_BASE_URL/USERNAME/PASSWORD) — VSS worker idle')
} else if (env.VSS_SYNC === 'off') {
  logger.warn('VSS_SYNC=off — VSS worker idle: no sync, no nightly capture, no back-fill')
} else {
  handles.push(await startVssSync())
  handles.push(await startDashcamCapture())
  handles.push(await startVssBackfill())
}

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  logger.info({ signal }, 'VSS worker stopping')
  for (const h of handles) await h.stop().catch((err) => logger.warn({ err }, 'VSS worker: a queue did not stop cleanly'))
  await disconnectRedis().catch(() => {})
  await disconnectDB().catch(() => {})
  await flushTelemetry()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('unhandledRejection', (reason) => logger.error({ reason }, 'VSS worker: unhandled rejection'))
// Nothing else keeps an idle worker alive: stay up so the container does not restart-loop.
if (!handles.length) setInterval(() => {}, 1 << 30)
