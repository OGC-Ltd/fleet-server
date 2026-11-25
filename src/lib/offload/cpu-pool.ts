/**
 * A small pool of worker threads for CPU-bound work that would otherwise hold
 * the event loop: drawing report PDFs above all (a 60,000-row geofence PDF is
 * ~10 s of synchronous pdfkit work, and every other request waited behind it).
 *
 * What it guarantees:
 *  - at most `size` tasks run at once, each in its own thread;
 *  - at most `maxQueue` wait behind them; one more is refused at once
 *    (PoolBusyError, a 503 with Retry-After) rather than queued without end;
 *  - a task has a deadline counted from when it was asked for: one still
 *    queued is dropped, one running has its thread terminated (pdfkit's
 *    drawing cannot be interrupted any other way) and the thread is replaced;
 *  - an AbortSignal (the client went away) does the same, at once;
 *  - a thread that dies (out of memory on an absurd input) fails only its task.
 *
 * Threads start on first use and stop after `idleMs` without work, so an idle
 * API holds no extra memory. The tasks themselves are in ./cpu-tasks.ts.
 */

import { Worker } from 'node:worker_threads'
import { availableParallelism } from 'node:os'
import { ServiceUnavailableError } from '../../core/errors/errors.js'
import { runTask, type TaskKind, type TaskInput, type TaskOutput, TaskError } from './cpu-tasks.js'

/** Every thread is busy and the queue is full: try again shortly. */
export class PoolBusyError extends ServiceUnavailableError {
  readonly retryAfterS: number
  constructor(retryAfterS = 5) {
    super('The server is busy drawing other reports; try again in a few seconds')
    this.retryAfterS = retryAfterS
  }
}

/** The task ran past its deadline and was stopped. */
export class TaskTimeoutError extends ServiceUnavailableError {
  constructor(ms: number) {
    super(`The report took longer than ${Math.round(ms / 1000)} s to draw and was stopped; ask for a shorter period or fewer units`)
  }
}

/** The caller gave up (the client disconnected): nothing to answer. */
export class TaskAbortedError extends Error {
  constructor() {
    super('The task was cancelled')
    this.name = 'AbortError'
  }
}

export interface PoolOptions {
  /** Threads at most. */
  size: number
  /** Tasks waiting at most, beyond those running. */
  maxQueue: number
  /** Default deadline per task, from when it is asked for. */
  timeoutMs: number
  /** A thread with no work for this long is stopped. */
  idleMs?: number
  /** Heap cap per thread (MB): an absurd report kills its thread, not the API. */
  maxOldGenerationSizeMb?: number
  /** Run tasks on the calling thread instead (tests; REPORT_OFFLOAD=off). */
  inline?: boolean
}

export interface RunOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /** Called when the task leaves the queue and starts on a thread. */
  onStart?: () => void
}

interface Job {
  id: number
  kind: TaskKind
  input: unknown
  transfer: ArrayBuffer[]
  deadline: number
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  onStart?: () => void
  cleanup: () => void
  thread?: Thread
  settled: boolean
}

interface Thread {
  worker: Worker
  job: Job | null
  idleTimer: NodeJS.Timeout | null
}

/** The worker entry, as built (dist/…/cpu.worker.js) or as source under tsx/vitest. */
function workerEntry(): { url: URL; execArgv: string[] } {
  const self = import.meta.url
  if (self.endsWith('.ts')) return { url: new URL('./cpu.worker.ts', self), execArgv: ['--import', 'tsx'] }
  return { url: new URL('./cpu.worker.js', self), execArgv: [] }
}

/** A view the receiving side may own outright: copied if it shares its memory. */
export function ownedBytes(b: Uint8Array): Uint8Array {
  return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && b.buffer instanceof ArrayBuffer ? b : new Uint8Array(b)
}

export class CpuPool {
  private readonly o: Required<Omit<PoolOptions, 'inline'>> & { inline: boolean }
  private readonly threads = new Set<Thread>()
  private readonly queue: Job[] = []
  private nextId = 1
  private closed = false

  constructor(o: PoolOptions) {
    this.o = { idleMs: 60_000, maxOldGenerationSizeMb: 768, inline: false, ...o, size: Math.max(1, Math.floor(o.size)) }
  }

  stats() {
    let running = 0
    for (const t of this.threads) if (t.job) running++
    return { threads: this.threads.size, running, queued: this.queue.length, size: this.o.size, maxQueue: this.o.maxQueue }
  }

  run<K extends TaskKind>(kind: K, input: TaskInput<K>, opts: RunOptions = {}): Promise<TaskOutput<K>> {
    if (this.closed) return Promise.reject(new ServiceUnavailableError('The server is shutting down'))
    if (opts.signal?.aborted) return Promise.reject(new TaskAbortedError())
    const timeoutMs = opts.timeoutMs ?? this.o.timeoutMs
    if (this.o.inline) return this.runInline(kind, input, opts, timeoutMs)

    const running = this.stats().running
    if (running >= this.o.size && this.queue.length >= this.o.maxQueue) return Promise.reject(new PoolBusyError())

    return new Promise<TaskOutput<K>>((resolve, reject) => {
      const job: Job = {
        id: this.nextId++, kind, input, transfer: transferList(input), deadline: Date.now() + timeoutMs,
        resolve: resolve as (v: unknown) => void, reject, onStart: opts.onStart, settled: false, cleanup: () => {},
      }
      const timer = setTimeout(() => this.fail(job, new TaskTimeoutError(timeoutMs)), timeoutMs)
      timer.unref()
      const onAbort = () => this.fail(job, new TaskAbortedError())
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      job.cleanup = () => { clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort) }
      this.queue.push(job)
      this.pump()
    })
  }

  /** Stops every thread; queued and running tasks fail. */
  async close(): Promise<void> {
    this.closed = true
    for (const j of this.queue.splice(0)) this.settle(j, () => j.reject(new ServiceUnavailableError('The server is shutting down')))
    await Promise.all([...this.threads].map((t) => {
      if (t.job) this.settle(t.job, () => t.job!.reject(new ServiceUnavailableError('The server is shutting down')))
      return this.stop(t)
    }))
  }

  private async runInline<K extends TaskKind>(kind: K, input: TaskInput<K>, opts: RunOptions, timeoutMs: number): Promise<TaskOutput<K>> {
    opts.onStart?.()
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new TaskTimeoutError(timeoutMs)), timeoutMs); timer.unref() })
    try {
      return await Promise.race([runTask(kind, input), deadline])
    } finally {
      clearTimeout(timer)
    }
  }

  private pump(): void {
    while (this.queue.length) {
      const thread = this.freeThread()
      if (!thread) return
      const job = this.queue.shift()!
      this.dispatch(thread, job)
    }
  }

  private freeThread(): Thread | null {
    for (const t of this.threads) if (!t.job) return t
    if (this.threads.size >= this.o.size) return null
    return this.spawn()
  }

  private spawn(): Thread {
    const { url, execArgv } = workerEntry()
    const worker = new Worker(url, {
      execArgv,
      resourceLimits: { maxOldGenerationSizeMb: this.o.maxOldGenerationSizeMb },
    })
    const t: Thread = { worker, job: null, idleTimer: null }
    worker.unref()
    worker.on('message', (m: { id: number; ok: boolean; result?: unknown; error?: { name: string; message: string; status?: number; issues?: unknown } }) => {
      const job = t.job
      if (!job || job.id !== m.id) return
      t.job = null
      if (m.ok) this.settle(job, () => job.resolve(m.result))
      else this.settle(job, () => job.reject(TaskError.from(m.error!)))
      this.idle(t)
      this.pump()
    })
    const lost = (err: Error) => {
      this.threads.delete(t)
      if (t.idleTimer) clearTimeout(t.idleTimer)
      const job = t.job
      t.job = null
      if (job) {
        const oom = /ERR_WORKER_OUT_OF_MEMORY/.test(String((err as { code?: string }).code ?? err.message))
        this.settle(job, () => job.reject(oom
          ? new TaskError('The report is too large to draw; ask for a shorter period or fewer units', 413)
          : err))
      }
      this.pump()
    }
    worker.on('error', lost)
    worker.on('exit', (code) => { if (this.threads.has(t)) lost(new Error(`Worker thread exited (${code})`)) })
    this.threads.add(t)
    return t
  }

  private dispatch(t: Thread, job: Job): void {
    if (t.idleTimer) { clearTimeout(t.idleTimer); t.idleTimer = null }
    t.job = job
    job.thread = t
    job.onStart?.()
    t.worker.postMessage({ id: job.id, kind: job.kind, input: job.input }, job.transfer)
    job.input = null
  }

  private idle(t: Thread): void {
    if (t.idleTimer) clearTimeout(t.idleTimer)
    t.idleTimer = setTimeout(() => { if (!t.job) void this.stop(t) }, this.o.idleMs)
    t.idleTimer.unref()
  }

  private async stop(t: Thread): Promise<void> {
    this.threads.delete(t)
    if (t.idleTimer) clearTimeout(t.idleTimer)
    await t.worker.terminate().catch(() => {})
  }

  /** A queued task leaves the queue; a running one takes its thread with it. */
  private fail(job: Job, err: Error): void {
    if (job.settled) return
    const i = this.queue.indexOf(job)
    if (i >= 0) this.queue.splice(i, 1)
    const t = job.thread
    this.settle(job, () => job.reject(err))
    if (t && t.job === job) {
      t.job = null
      void this.stop(t).then(() => this.pump())
    }
  }

  private settle(job: Job, f: () => void): void {
    if (job.settled) return
    job.settled = true
    job.cleanup()
    f()
  }
}

/** The ArrayBuffers in an input that can be moved, not copied, to the thread. */
function transferList(input: unknown): ArrayBuffer[] {
  if (!input || typeof input !== 'object') return []
  const out: ArrayBuffer[] = []
  for (const v of Object.values(input as Record<string, unknown>)) {
    if (v instanceof Uint8Array && v.byteOffset === 0 && v.byteLength === v.buffer.byteLength && v.buffer instanceof ArrayBuffer) out.push(v.buffer)
  }
  return out
}

/** The CPU count the pool may use, leaving one core to the event loop. */
export function defaultThreads(): number {
  return Math.max(1, Math.min(2, availableParallelism() - 1))
}
