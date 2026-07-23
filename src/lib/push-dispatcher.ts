/**
 * Main-thread handle to the push worker thread (see workers/push.worker-thread.ts).
 * Hands off web-push sends to a dedicated OS thread so its synchronous VAPID
 * crypto never competes with the event loop serving HTTP/SSE.
 *
 * One worker thread today, not a pool — current push-subscriber volume is
 * small, so a single thread already fully isolates the crypto from the main
 * thread. If volume grows, round-robining sends across N of these is a
 * mechanical change (this class doesn't assume there's only one caller).
 *
 * dev (tsx) vs prod (tsc) path resolution: under `tsx watch`, this module's
 * own import.meta.url ends in `.ts` and there's no compiled sibling on disk —
 * only push.worker-thread.ts exists. We load that file directly and register
 * tsx's loader in the worker via `--import tsx` so IT can also load .ts. Under
 * compiled prod (`node dist/...`), import.meta.url ends in `.js`, the compiled
 * sibling is what's on disk, and no special loader is needed.
 */

import { Worker } from 'node:worker_threads'
import { logger } from './logger.js'

export interface PushSendJob {
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } }
  payload: string
  ttl: number
}

export interface PushSendResult {
  ok: boolean
  stale?: boolean
  errorMessage?: string
}

interface VapidConfig {
  publicKey:  string
  privateKey: string
  subject:    string
}

const isTsRuntime = import.meta.url.endsWith('.ts')
const WORKER_FILE  = isTsRuntime ? './workers/push.worker-thread.ts' : './workers/push.worker-thread.js'

class PushDispatcher {
  private worker: Worker | null = null
  private readonly pending = new Map<string, { resolve: (r: PushSendResult) => void; reject: (e: unknown) => void }>()
  private seq = 0

  constructor(private readonly vapid: VapidConfig) {}

  private ensureWorker(): Worker {
    if (this.worker) return this.worker

    const worker = new Worker(new URL(WORKER_FILE, import.meta.url), {
      workerData: this.vapid,
      ...(isTsRuntime ? { execArgv: ['--import', 'tsx'] } : {}),
    })

    worker.on('message', (result: PushSendResult & { id: string }) => {
      const p = this.pending.get(result.id)
      if (!p) return
      this.pending.delete(result.id)
      p.resolve(result)
    })

    worker.on('error', (err) => {
      logger.error({ err }, 'push worker thread crashed')
      this.worker = null
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    })

    worker.on('exit', (code) => {
      if (code !== 0) logger.warn({ code }, 'push worker thread exited unexpectedly')
      this.worker = null
    })

    this.worker = worker
    return worker
  }

  send(job: PushSendJob): Promise<PushSendResult> {
    const worker = this.ensureWorker()
    const id = String(++this.seq)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.postMessage({ id, ...job })
    })
  }

  async stop(): Promise<void> {
    if (!this.worker) return
    await this.worker.terminate()
    this.worker = null
  }
}

let dispatcher: PushDispatcher | null = null

/** Create the dispatcher (and its worker thread, spawned on first send). Call once at startup. */
export function initPushDispatcher(vapid: VapidConfig): void {
  dispatcher = new PushDispatcher(vapid)
}

export function getPushDispatcher(): PushDispatcher | null {
  return dispatcher
}

export async function stopPushDispatcher(): Promise<void> {
  await dispatcher?.stop()
  dispatcher = null
}
