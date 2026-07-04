/**
 * Push worker THREAD (not an event-bus subscriber like the others in this
 * directory) — runs web-push's VAPID JWT signing + payload encryption, and
 * the actual HTTPS delivery, on a separate OS thread via node:worker_threads.
 *
 * Why this one is a real thread and the others aren't: web-push does
 * synchronous CPU-bound crypto (ECDSA signing, ECDH + AES-GCM encryption) on
 * whatever thread calls it, in addition to the network request. Everything
 * else "worker"-shaped in this codebase (alerts.worker, sim-events.worker,
 * telemetry.worker, notification.worker) is pure async I/O — moving those to
 * a thread wouldn't make the network round-trips any faster. This one
 * genuinely benefits from being off the main thread that serves HTTP/SSE.
 *
 * Talks to push-dispatcher.ts (main thread) over postMessage: receives a
 * {id, subscription, payload, ttl} job, sends it, replies with {id, ok, ...}.
 */

import { parentPort, workerData } from 'node:worker_threads'
import webpush from 'web-push'

interface VapidWorkerData {
  publicKey:  string
  privateKey: string
  subject:    string
}

interface SendJob {
  id: string
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } }
  payload: string
  ttl: number
}

interface SendResult {
  id: string
  ok: boolean
  stale?: boolean
  errorMessage?: string
}

const { publicKey, privateKey, subject } = workerData as VapidWorkerData
webpush.setVapidDetails(subject, publicKey, privateKey)

if (!parentPort) throw new Error('push.worker-thread must be run as a worker_thread')

parentPort.on('message', (job: SendJob) => {
  void (async () => {
    try {
      await webpush.sendNotification(
        { endpoint: job.subscription.endpoint, keys: job.subscription.keys },
        job.payload,
        { TTL: job.ttl },
      )
      const result: SendResult = { id: job.id, ok: true }
      parentPort!.postMessage(result)
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode
      const result: SendResult = {
        id: job.id,
        ok: false,
        stale: status === 410 || status === 404,
        errorMessage: err instanceof Error ? err.message : String(err),
      }
      parentPort!.postMessage(result)
    }
  })()
})
