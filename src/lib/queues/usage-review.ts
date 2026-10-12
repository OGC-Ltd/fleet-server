/**
 * The Logbook's report queues: builds, and the PDFs and workbooks rendered
 * from them. The API process only adds jobs and reads their state; the
 * `report-worker` process (src/report-worker.ts) runs them, so a busy hour of
 * reports never stalls the live map (2026-10-10: one two-month build held the
 * API's event loop for about a second, and 300 of them queued two at a time
 * for over an hour).
 *
 * The worker says it is alive every few seconds. When it has not (stopped,
 * crashed, not yet deployed) the API builds in its own process as it always
 * did, so a missing worker costs speed, never the report.
 */

import { Queue } from 'bullmq'
import { env } from '../../config/env.js'
import { getQueueRedis, isRedisConfigured } from '../redis.js'

export const REVIEW_QUEUE = 'usage-review'
export const RENDER_QUEUE = 'usage-review-render'
const ALIVE_KEY = 'report-worker:alive'
const ALIVE_TTL_MS = 30_000
export const ALIVE_EVERY_MS = 10_000

let reviewQ: Queue | null = null
let renderQ: Queue | null = null

export function reviewQueue(): Queue | null {
  const connection = getQueueRedis()
  if (!connection) return null
  reviewQ ??= new Queue(REVIEW_QUEUE, { connection })
  return reviewQ
}

export function renderQueue(): Queue | null {
  const connection = getQueueRedis()
  if (!connection) return null
  renderQ ??= new Queue(RENDER_QUEUE, { connection })
  return renderQ
}

/** The worker's side: "still here", good for ALIVE_TTL_MS. */
export async function sayAlive(): Promise<void> {
  await getQueueRedis()?.set(ALIVE_KEY, String(process.pid), 'PX', ALIVE_TTL_MS)
}

export async function sayGone(): Promise<void> {
  await getQueueRedis()?.del(ALIVE_KEY)
}

let aliveAt = 0
let alive = false

/**
 * Whether reports go to the worker: enabled, Redis there, and the worker
 * heard from lately. Asked at most every 5 s.
 */
export async function useReportWorker(): Promise<boolean> {
  if (!env.REPORT_WORKER_ENABLED || !isRedisConfigured()) return false
  if (Date.now() - aliveAt < 5_000) return alive
  aliveAt = Date.now()
  try {
    alive = (await getQueueRedis()?.exists(ALIVE_KEY)) === 1
  } catch {
    alive = false
  }
  return alive
}

export async function closeReportQueues(): Promise<void> {
  await Promise.allSettled([reviewQ?.close(), renderQ?.close()])
  reviewQ = null
  renderQ = null
}
