/**
 * How a heavy report is answered without holding the API.
 *
 * `sendReport` draws a file through the CPU pool (./cpu-pool.ts) and answers it:
 *
 *  - Inline (the default, what every page does today): the request waits for
 *    the file. If the client goes away first, the drawing is cancelled.
 *  - Asynchronously, when the request carries `Prefer: respond-async`
 *    (RFC 7240): 202 Accepted at once, with `Location` naming the job; the
 *    client polls GET …/reports/jobs/:jobId until `status` is `done`, then
 *    fetches `fileUrl`. With `Prefer: respond-async, wait=N` the server waits
 *    up to N seconds first and answers the file itself if it is ready by then,
 *    so a small report still comes back in one round trip.
 *
 * Jobs live in this process's memory (one API container), for JOB_TTL_MS after
 * they finish, and only their owner (same user, same organisation) can read them.
 * When every thread is busy and the queue is full the answer is 503 with
 * Retry-After, never an unbounded wait.
 *
 * `reportGate` caps the database-heavy report routes the same way: so many at
 * once, so many waiting, and a request whose client has gone is never started.
 */

import { randomUUID } from 'node:crypto'
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { ZodError } from 'zod'
import { env } from '../../config/env.js'
import { logger } from '../logger.js'
import { NotFoundError, ServiceUnavailableError } from '../../core/errors/errors.js'
import { AppError } from '../../core/errors/AppError.js'
import { CpuPool, PoolBusyError, TaskAbortedError, defaultThreads } from './cpu-pool.js'
import { TaskError } from './cpu-tasks.js'

// ── the pool ─────────────────────────────────────────────────────────────────

let pool: CpuPool | null = null
/** The process's report pool, made on first use from REPORT_RENDER_* settings. */
export function reportPool(): CpuPool {
  pool ??= new CpuPool({
    size: env.REPORT_RENDER_THREADS ?? defaultThreads(),
    maxQueue: env.REPORT_RENDER_QUEUE_MAX,
    timeoutMs: env.REPORT_RENDER_TIMEOUT_MS,
    maxOldGenerationSizeMb: env.REPORT_RENDER_THREAD_MB,
    inline: env.REPORT_OFFLOAD === 'off',
  })
  return pool
}
/** Tests: replace the pool (or drop it, to be made again from the settings). */
export function setReportPool(p: CpuPool | null): void { pool = p }
export async function closeReportPool(): Promise<void> { await pool?.close(); pool = null }

// ── the jobs ─────────────────────────────────────────────────────────────────

export interface ReportFile { bytes: Buffer; name: string; type: string }

type JobStatus = 'queued' | 'running' | 'done' | 'failed'
interface Job {
  id: string
  orgId: string
  userId: string | null
  status: JobStatus
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  file: ReportFile | null
  error: { status: number; message: string } | null
  done: Promise<void>
}

const JOB_TTL_MS = 15 * 60_000
const JOBS_MAX_BYTES = 256 * 1024 * 1024
const jobs = new Map<string, Job>()

/** Finished jobs past their time go; then the oldest finished until the files fit. */
function sweep(now = Date.now()): void {
  let bytes = 0
  for (const [id, j] of jobs) {
    if (j.finishedAt != null && now - j.finishedAt > JOB_TTL_MS) jobs.delete(id)
    else bytes += j.file?.bytes.length ?? 0
  }
  if (bytes <= JOBS_MAX_BYTES) return
  for (const [id, j] of [...jobs].filter(([, j]) => j.finishedAt != null).sort((a, b) => a[1].finishedAt! - b[1].finishedAt!)) {
    if (bytes <= JOBS_MAX_BYTES) break
    bytes -= j.file?.bytes.length ?? 0
    jobs.delete(id)
  }
}
setInterval(() => sweep(), 60_000).unref()

/** Tests. */
export function clearReportJobs(): void { jobs.clear() }

/** `Prefer: respond-async[, wait=N]` → null, or the seconds to wait before answering 202. */
export function preferAsync(req: Request): number | null {
  const prefer = String(req.headers['prefer'] ?? '').toLowerCase()
  if (!/(^|[,;\s])respond-async([,;\s]|$)/.test(prefer)) return null
  const wait = /(?:^|[,;\s])wait=(\d+)/.exec(prefer)
  return wait ? Math.min(60, Number(wait[1])) : 0
}

const failure = (err: unknown): { status: number; message: string } => {
  if (err instanceof AppError) return { status: err.statusCode, message: err.message }
  if (err instanceof TaskError) return { status: err.status, message: err.status >= 500 ? 'The report could not be drawn' : err.message }
  if (err instanceof ZodError) return { status: 400, message: 'Validation failed' }
  return { status: 500, message: 'The report could not be drawn' }
}

/** An operational error with the task's status, for errorHandler. */
class TaskHttpError extends AppError {}

/** What a task's failure becomes on the way to errorHandler. */
function asHttpError(err: unknown): unknown {
  if (err instanceof TaskError) {
    if (err.status === 400 && err.issues) return new ZodError(err.issues)
    const e = failure(err)
    return new TaskHttpError(e.message, e.status)
  }
  return err
}

function sendFile(res: Response, f: ReportFile): void {
  res.setHeader('Content-Type', f.type)
  res.setHeader('Content-Disposition',
    `attachment; filename="${f.name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`)
  res.setHeader('Content-Length', String(f.bytes.length))
  res.setHeader('Cache-Control', 'no-store')
  res.end(f.bytes)
}

const jobUrl = (req: Request, id: string) => `${req.baseUrl}/reports/jobs/${id}`

function describe(req: Request, j: Job) {
  const stats = reportPool().stats()
  return {
    jobId: j.id,
    status: j.status,
    createdAt: new Date(j.createdAt).toISOString(),
    startedAt: j.startedAt ? new Date(j.startedAt).toISOString() : null,
    finishedAt: j.finishedAt ? new Date(j.finishedAt).toISOString() : null,
    statusUrl: jobUrl(req, j.id),
    fileUrl: j.status === 'done' ? `${jobUrl(req, j.id)}/file` : null,
    name: j.file?.name ?? null,
    bytes: j.file?.bytes.length ?? null,
    error: j.error?.message ?? null,
    ...(j.status === 'queued' ? { queued: stats.queued } : {}),
  }
}

/**
 * Makes a report file and answers it: inline, cancelled if the client leaves;
 * or, on `Prefer: respond-async`, as a job (see the top of this file).
 * `make` gets the signal to pass to the pool and an `onStart` for its status.
 */
export async function sendReport(
  req: Request, res: Response, next: NextFunction,
  make: (o: { signal: AbortSignal; onStart: () => void }) => Promise<ReportFile>,
): Promise<void> {
  const wait = preferAsync(req)
  if (wait == null) {
    // Inline: the client leaving cancels the drawing.
    const ac = new AbortController()
    const onClose = () => { if (!res.writableEnded) ac.abort() }
    res.on('close', onClose)
    try {
      sendFile(res, await make({ signal: ac.signal, onStart: () => {} }))
    } catch (err) {
      if (err instanceof TaskAbortedError) {
        logger.info({ path: req.originalUrl }, 'Report cancelled: the client went away')
        return
      }
      if (err instanceof PoolBusyError) res.setHeader('Retry-After', String(err.retryAfterS))
      next(asHttpError(err))
    } finally {
      res.off('close', onClose)
    }
    return
  }

  // Asynchronous: the job outlives the request, so its signal is its own.
  const stats = reportPool().stats()
  if (stats.running >= stats.size && stats.queued >= stats.maxQueue) {
    res.setHeader('Retry-After', '5')
    return next(new PoolBusyError())
  }
  sweep()
  const j: Job = {
    id: randomUUID(), orgId: String(req.params['orgId'] ?? ''), userId: req.user?.id ?? null,
    status: 'queued', createdAt: Date.now(), startedAt: null, finishedAt: null, file: null, error: null,
    done: Promise.resolve(),
  }
  jobs.set(j.id, j)
  j.done = make({ signal: new AbortController().signal, onStart: () => { j.status = 'running'; j.startedAt = Date.now() } })
    .then((file) => { j.file = file; j.status = 'done' })
    .catch((err) => {
      j.error = failure(err)
      j.status = 'failed'
      if (j.error.status >= 500) logger.warn({ err, jobId: j.id, path: req.originalUrl }, 'Report job failed')
    })
    .finally(() => { j.finishedAt = Date.now() })

  if (wait > 0) {
    let timer: NodeJS.Timeout | undefined
    await Promise.race([j.done, new Promise<void>((r) => { timer = setTimeout(r, wait * 1000) })])
    clearTimeout(timer)
    if (j.status === 'done' && j.file) {
      jobs.delete(j.id)
      return sendFile(res, j.file)
    }
    if (j.status === 'failed') {
      jobs.delete(j.id)
      res.status(j.error!.status).json({ statusCode: j.error!.status, status: 'error', message: j.error!.message })
      return
    }
  }
  res.status(202).setHeader('Location', jobUrl(req, j.id)).setHeader('Retry-After', '2')
  res.json({ statusCode: 202, status: 'success', data: describe(req, j) })
}

/** The job, if it is this caller's. */
function ownJob(req: Request): Job {
  const j = jobs.get(String(req.params['jobId']))
  if (!j || j.orgId !== String(req.params['orgId']) || j.userId !== (req.user?.id ?? null)) throw new NotFoundError('No such report job')
  return j
}

/** GET …/reports/jobs/:jobId — where the job is. */
export const getReportJob: RequestHandler = (req, res, next) => {
  try {
    const j = ownJob(req)
    if (j.status === 'queued' || j.status === 'running') res.setHeader('Retry-After', '2')
    res.json({ statusCode: 200, status: 'success', data: describe(req, j) })
  } catch (err) { next(err) }
}

/** GET …/reports/jobs/:jobId/file — the finished file (202 while it is not ready). */
export const getReportJobFile: RequestHandler = (req, res, next) => {
  try {
    const j = ownJob(req)
    if (j.status === 'done' && j.file) return sendFile(res, j.file)
    if (j.status === 'failed') {
      res.status(j.error!.status).json({ statusCode: j.error!.status, status: 'error', message: j.error!.message })
      return
    }
    res.status(202).setHeader('Retry-After', '2').json({ statusCode: 202, status: 'success', data: describe(req, j) })
  } catch (err) { next(err) }
}

// ── the gate for database-heavy report routes ────────────────────────────────

/**
 * At most `active` of the gated routes run at once and `queued` wait; a waiter
 * whose client leaves is dropped, one that waits past `waitMs` gets 503.
 * Their work is mostly Postgres (bounded by statement_timeout), so the gate
 * protects the connection pool and the event loop from a wave of reports.
 */
export function createReportGate(o: { active: number; queued: number; waitMs: number }): RequestHandler & { stats: () => { active: number; queued: number } } {
  let active = 0
  const waiting: Array<{ go: () => void; cancel: () => void }> = []
  const release = () => {
    active--
    const n = waiting.shift()
    if (n) n.go()
  }
  const gate = ((req: Request, res: Response, next: NextFunction) => {
    let released = false
    const enter = () => {
      active++
      res.once('close', () => { if (!released) { released = true; release() } })
      next()
    }
    if (active < o.active) return enter()
    if (waiting.length >= o.queued) {
      res.setHeader('Retry-After', '5')
      return next(new PoolBusyError())
    }
    const entry = {
      go: () => { cleanup(); enter() },
      cancel: () => {
        cleanup()
        const i = waiting.indexOf(entry)
        if (i >= 0) waiting.splice(i, 1)
      },
    }
    const timer = setTimeout(() => {
      entry.cancel()
      res.setHeader('Retry-After', '5')
      next(new ServiceUnavailableError('Too many reports are being made at once; try again shortly'))
    }, o.waitMs)
    timer.unref()
    const onClose = () => entry.cancel()
    res.once('close', onClose)
    function cleanup() { clearTimeout(timer); res.off('close', onClose) }
    waiting.push(entry)
  }) as RequestHandler & { stats: () => { active: number; queued: number } }
  gate.stats = () => ({ active, queued: waiting.length })
  return gate
}

let gate: ReturnType<typeof createReportGate> | null = null
/** The process's gate for database-heavy report routes, from REPORT_DATA_* settings. */
export const reportGate: RequestHandler = (req, res, next) => {
  gate ??= createReportGate({ active: env.REPORT_DATA_CONCURRENCY, queued: env.REPORT_DATA_QUEUE_MAX, waitMs: env.REPORT_DATA_WAIT_MS })
  return gate(req, res, next)
}
