/**
 * The report worker: runs the Logbook's queued builds and renders, in a
 * process of its own (src/report-worker.ts), so the API process that serves
 * the live map never spends its event loop on them.
 *
 * Builds run REPORT_BUILD_CONCURRENCY side by side: mostly waiting on Wialon,
 * each in its own session (usage-review.wialon). Renders run two at a time,
 * being CPU and nothing else. Every finished build and file goes to the store
 * (usage-review.saved), where the API process reads it.
 */

import { Worker, type Job } from 'bullmq'
import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { getQueueRedis } from '../../lib/redis.js'
import { ALIVE_EVERY_MS, RENDER_QUEUE, REVIEW_QUEUE, sayAlive, sayGone } from '../../lib/queues/usage-review.js'
import { flushStores } from './usage-review.store.js'
import { loadAllPoints, loadReview, reviewKey, saveFile, saveReview, sweepSaved } from './usage-review.saved.js'
import { buildReview, renderFile, setBuildSlots, type BuildProgress, type RenderOptions } from './usage-review.service.js'

interface BuildData { orgId: string; vehicleId: string; from: string; to: string }
interface RenderData extends BuildData { options: RenderOptions; name: string }

export async function processBuild(job: Job<BuildData>) {
  const { orgId, vehicleId, from, to } = job.data
  const t0 = Date.now()
  let last = 0
  const rv = await buildReview(orgId, vehicleId, from, to, (pr: BuildProgress) => {
    // Progress is a Redis write: not for every page of messages.
    const now = Date.now()
    if (now - last < 750 && pr.done !== pr.total) return
    last = now
    void job.updateProgress(pr).catch(() => {})
  })
  await saveReview(reviewKey(orgId, vehicleId, from, to), rv)
  logger.info({ vehicleId, from, to, messages: rv.quality.messages, fallback: rv.wialonError != null, ms: Date.now() - t0 }, 'Usage review built (worker)')
  return { builtAt: rv.builtAt, messages: rv.quality.messages }
}

export async function processRender(job: Job<RenderData>) {
  const { orgId, vehicleId, from, to, options, name } = job.data
  const key = reviewKey(orgId, vehicleId, from, to)
  const rv = await loadReview(key)
  if (!rv) throw new Error('The review is no longer held. Build it again and download once more.')
  const full = options.format === 'xlsx' ? { ...rv, points: await loadAllPoints(key) } : rv
  const buf = await renderFile(full, orgId, options)
  await saveFile(key, name, buf)
  return { bytes: buf.length }
}

/** Starts both workers, the heartbeat and the store's sweep. */
export async function startReportWorker(): Promise<{ stop: () => Promise<void> }> {
  const connection = getQueueRedis()
  if (!connection) throw new Error('REDIS_URL is not set: the report worker needs the queue')
  setBuildSlots(env.REPORT_BUILD_CONCURRENCY)

  const builds = new Worker<BuildData>(REVIEW_QUEUE, processBuild, { connection, concurrency: env.REPORT_BUILD_CONCURRENCY })
  const renders = new Worker<RenderData>(RENDER_QUEUE, processRender, { connection, concurrency: 2 })
  for (const [w, what] of [[builds, 'build'], [renders, 'render']] as const) {
    w.on('failed', (job, err) => logger.warn({ jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, `Report worker: ${what} failed`))
    w.on('error', (err) => logger.warn({ err: err.message }, `Report worker: ${what} queue error`))
  }

  await sayAlive()
  const beat = setInterval(() => void sayAlive().catch(() => {}), ALIVE_EVERY_MS)
  const sweep = async () => {
    try {
      const r = await sweepSaved()
      if (r.removed) logger.info(r, 'Report store swept')
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Report store sweep failed')
    }
  }
  void sweep()
  const sweeper = setInterval(() => void sweep(), 3_600_000)
  logger.info({ concurrency: env.REPORT_BUILD_CONCURRENCY }, 'Report worker started')

  return {
    stop: async () => {
      clearInterval(beat)
      clearInterval(sweeper)
      await sayGone().catch(() => {})
      // Running jobs are given up rather than awaited: pm2 allows a few
      // seconds, and BullMQ hands a stalled job to the next worker.
      await Promise.allSettled([builds.close(true), renders.close(true)])
      flushStores()
    },
  }
}
