/**
 * Outbound side effects — mail and durable notifications — off the request
 * thread and onto BullMQ.
 *
 * ## What was blocking
 *
 * `sendMail` is awaited by the handler that triggered it. Its own docblock
 * explains why it is awaited rather than floated (a rejecting floating promise
 * takes the process down) and names the cost: "a request can wait on a slow
 * Mailtrap; the client's AbortController bounds that at 10s". That bound is
 * per recipient, and the repair notifier fans out over `REPAIR_NOTIFY_EMAILS`
 * in parallel, so a filed report can hold its HTTP connection open for the
 * full ten seconds against a provider that is simply slow. The technician who
 * pressed "File" watches a spinner for the duration of somebody else's SMTP.
 *
 * The durable notification write has a smaller version of the same problem:
 * `publishNotificationDurable` awaits an upsert through the Supabase pooler,
 * which the store's own comment measures at about a second.
 *
 * ## The objection this module had to answer
 *
 * The mailer's docblock already considered a queue and rejected it:
 *
 *     "Moving this onto a queue is the right eventual answer, but Redis is
 *      optional in this deployment and a queued mail that never sends because
 *      Redis is absent is worse than a slow request."
 *
 * That is correct and it is still true — REDIS_URL is unset on the production
 * box today, which is why the retention sweep, the fuel sync and the trip
 * builder all log "NOT started" at boot. Those three are SWEEPS: skipping a
 * cycle costs a delay. A mail is a one-shot obligation to a person, and
 * skipping it is silent data loss.
 *
 * So this module does not adopt the "no Redis, no job" shape its three
 * neighbours use. IT FALLS BACK TO SENDING INLINE. With Redis, the handler
 * returns as soon as the job is accepted and the worker does the waiting; with
 * no Redis, behaviour is exactly what it is today, down to the return value.
 * The same fallback catches an `add()` that throws — a Redis that is
 * configured but unreachable must not eat a password-reset mail.
 *
 * ## What the queue buys beyond latency
 *
 * A RETRY. `sendMail` gets exactly one attempt and converts a failure into a
 * logged `{ sent: false, reason: 'send-failed' }`; a blip at the provider is
 * an invite that never arrives and a person who cannot get into the system.
 * Queued, it is attempted three times over increasing delays before it is
 * given up on, and the failure lands in `removeOnFail` history rather than
 * only in a log line.
 *
 * ## "Queued" is not "sent", and callers must not conflate them
 *
 * The mailer's other rule — never show a tick for a mail that did not leave
 * the building — is what shapes the return type. `MailDispatch` adds a
 * `{ queued: true }` member rather than folding into `{ sent: true }`, so
 * every existing caller that reads `.sent` is a type error until somebody
 * decides what that screen should say. That is the point: the compiler
 * enumerates the places where a person is told something about their mail.
 */

import { DelayedError, Queue, UnrecoverableError, Worker, type Job } from 'bullmq'
import { getQueueRedis } from '../redis.js'
import { logger } from '../logger.js'
import { isMailAllowed, sendMail, type MailResult } from '../mailer/mailer.js'
import type { RenderedMail } from '../mailer/templates.js'
import {
  publishNotificationDurable,
  type PublishNotificationInput,
} from '../notifications/notification.store.js'

export const OUTBOUND_QUEUE = 'outbound'
const MAIL_JOB = 'outbound:mail'
const NOTIFICATION_JOB = 'outbound:notification'

/**
 * `{ queued: true }` means accepted for delivery, NOT delivered. `because` and
 * `retryAt` are set by `sendMailNow`, which only queues after the provider has
 * already said no once, so the screen can say why and roughly when.
 */
export type MailDispatch =
  | MailResult
  | { queued: true; because?: 'provider-quota' | 'send-failed'; retryAt?: string }

export type DispatchStatus = 'sent' | 'queued' | 'unconfigured' | 'send-failed' | 'not-allowed'

/**
 * Flatten a dispatch into the one word a screen can print.
 *
 * Exists so the fan-out sites below can fold N outcomes without each one
 * re-deriving the difference between "accepted by the queue" and "accepted by
 * the provider". They are different facts and both are honest; what would not
 * be honest is either of them being printed as the other.
 */
export function dispatchStatus(d: MailDispatch): DispatchStatus {
  if ('queued' in d) return 'queued'
  return d.sent ? 'sent' : d.reason
}

/** Did this reach something that will keep trying? Sent or queued, not failed. */
export function isAccepted(d: MailDispatch): boolean {
  const s = dispatchStatus(d)
  return s === 'sent' || s === 'queued'
}

interface MailPayload {
  to: string
  toName: string | null
  mail: RenderedMail
}

/** `at` is a Date and Redis holds JSON, so it crosses as an ISO string. */
interface NotificationPayload extends Omit<PublishNotificationInput, 'at'> {
  at: string
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

let queue: Queue | null = null

/**
 * The queue, or null when there is no Redis to hold it.
 *
 * Lazily built rather than created at boot, because the publishers are reached
 * from request handlers that must work whether or not `startOutboundWorker`
 * ever ran — a CLI, a one-shot script, a test.
 */
function getQueue(): Queue | null {
  const connection = getQueueRedis()
  if (!connection) return null
  queue ??= new Queue(OUTBOUND_QUEUE, { connection })
  return queue
}

const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 30_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 200 },
}

/**
 * Mail a person needs in order to get in, or to know their account changed.
 * These go first whenever the queue has more mail than the provider will take
 * (BullMQ: a lower number is a higher priority).
 */
const ACCOUNT_MAIL = new Set(['invite', 'password-reset', 'password-changed'])
const mailPriority = (category: string) => (ACCOUNT_MAIL.has(category) ? 1 : 10)

/**
 * How long a mail may wait out a provider quota before it is given up on.
 * An invite link lasts longer than this; a repair notice two days late is
 * noise.
 */
const MAX_DEFER_MS = 48 * 3_600_000

/**
 * Hand a rendered mail to the queue, or send it inline if there is none.
 *
 * The mail is rendered by the CALLER and travels whole. Everything that could
 * fail cheaply and locally — the recipient lookup, the self-assignment check,
 * the missing-address case — therefore still happens synchronously and still
 * reaches the caller as the same outcome it does today. Only the SMTP call
 * moves. That keeps the job self-contained (the worker touches no database)
 * and keeps every "we did not even try, and here is why" answer immediate.
 */
export async function enqueueMail(
  to: string,
  toName: string | null | undefined,
  mail: RenderedMail,
): Promise<MailDispatch> {
  // Refused before it can take a place in the queue; sendMail says why.
  const q = getQueue()
  if (!q || !isMailAllowed(mail.category)) return sendMail(to, toName, mail)

  const payload: MailPayload = { to, toName: toName ?? null, mail }
  try {
    await q.add(MAIL_JOB, payload, { ...JOB_OPTIONS, priority: mailPriority(mail.category) })
    logger.debug({ template: mail.category, to }, 'mail: queued')
    return { queued: true }
  } catch (err) {
    // Configured but unreachable. Falling through to an inline send is the
    // whole reason this is not a bare `add`.
    logger.warn({ err, template: mail.category, to }, 'mail: queue unavailable — sending inline')
    return sendMail(to, toName, mail)
  }
}

/**
 * Send now, and queue only what the provider would not take.
 *
 * For mail an administrator is standing in front of: an invite or a reset
 * link. Queuing it first meant the screen could only ever say "queued", and a
 * quota-held invite said that for an hour with nobody told why (operator,
 * 2026-10-28). One inline attempt (bounded at 10 s by the client) gives the
 * real answer in the common case; a refusal still lands in the queue with its
 * retries, and the caller learns which kind of refusal it was.
 */
export async function sendMailNow(
  to: string,
  toName: string | null | undefined,
  mail: RenderedMail,
): Promise<MailDispatch> {
  const now = Date.now()
  // The worker already knows the provider is closed; another refused login
  // would only burn time and tell us the same thing.
  const result = now < throttledUntil
    ? { sent: false as const, reason: 'send-failed' as const, retryAfterMs: throttledUntil - now }
    : await sendMail(to, toName, mail)
  if (result.sent || result.reason !== 'send-failed') return result

  const q = getQueue()
  if (!q) return result
  const payload: MailPayload = { to, toName: toName ?? null, mail }
  const delay = result.retryAfterMs ?? JOB_OPTIONS.backoff.delay
  try {
    await q.add(MAIL_JOB, payload, { ...JOB_OPTIONS, priority: mailPriority(mail.category), delay })
  } catch (err) {
    logger.warn({ err, template: mail.category, to }, 'mail: queue unavailable after a failed send')
    return result
  }
  if (result.retryAfterMs != null) throttledUntil = Math.max(throttledUntil, now + result.retryAfterMs)
  return {
    queued: true,
    because: result.retryAfterMs != null ? 'provider-quota' : 'send-failed',
    retryAt: new Date(now + delay).toISOString(),
  }
}

/**
 * Record a notification durably, off the thread.
 *
 * NOT a replacement for `publishNotification`, which emits to the live feed and
 * already detaches its own write. This is for the callers that awaited
 * `publishNotificationDurable` from inside a request: the row and the cache
 * entry are what moves, and the SSE frame is emitted by the worker exactly as
 * before — within a second, and not while the caller's connection is open.
 *
 * Returns whether it was queued. It cannot return `published`, because whether
 * this was an exact republish is decided by the dedupe at write time. Callers
 * that report a deduped count — the fuel sync's "published: 0, deduped: 6" —
 * must keep using the durable form, and do.
 */
export async function enqueueNotification(input: PublishNotificationInput): Promise<{ queued: boolean }> {
  const q = getQueue()
  if (!q) {
    await publishNotificationDurable(input)
    return { queued: false }
  }

  const payload: NotificationPayload = { ...input, at: input.at.toISOString() }
  try {
    // The feed id is already the unique key in Postgres and the dedupe key in
    // the store. Reusing it as the job id makes a double publish collapse in
    // Redis too, rather than being written twice and deduped twice.
    // BullMQ refuses a custom id containing ':' (its own key separator), and
    // every refusal fell through to the inline write.
    await q.add(NOTIFICATION_JOB, payload, { ...JOB_OPTIONS, jobId: `n-${input.id.replaceAll(':', '-')}` })
    return { queued: true }
  } catch (err) {
    logger.warn({ err, feedId: input.id }, 'notification: queue unavailable — writing inline')
    await publishNotificationDurable(input)
    return { queued: false }
  }
}

// ---------------------------------------------------------------------------
// Subscribing
// ---------------------------------------------------------------------------

let worker: Worker | null = null

/**
 * Until when the provider has said it will take no mail (its daily quota).
 * Every mail job that comes up before then waits without trying: each try is
 * another refused login, and three of them used to drop the mail for good.
 */
let throttledUntil = 0

/**
 * Put a mail job back until the provider will take it, WITHOUT spending one of
 * its attempts. Account mail comes due a minute ahead of everything else, so
 * when the quota returns the invites are the first through it.
 */
async function deferMail(job: Job, token: string | undefined, until: number): Promise<never> {
  if (Date.now() - job.timestamp > MAX_DEFER_MS) {
    throw new UnrecoverableError(`mail held past ${MAX_DEFER_MS / 3_600_000} h by the provider's quota`)
  }
  const { mail } = job.data as MailPayload
  const at = until + (ACCOUNT_MAIL.has(mail.category) ? 0 : 60_000)
  await job.moveToDelayed(at, token)
  throw new DelayedError()
}

export interface OutboundHandle { stop: () => Promise<void> }

/**
 * Start the consumer.
 *
 * No Redis means no worker and, deliberately, no warning about a degraded
 * service: without Redis the publishers above never queued anything in the
 * first place, so there is nothing unprocessed and nothing to warn about. That
 * is the difference between this and its three neighbours, whose "NOT started"
 * line is a real statement that work will not happen.
 */
export async function startOutboundWorker(): Promise<OutboundHandle> {
  const connection = getQueueRedis()
  if (!connection) {
    logger.info('No REDIS_URL — outbound mail and notifications are sent inline on the request thread')
    return { stop: async () => {} }
  }

  worker = new Worker(OUTBOUND_QUEUE, async (job: Job, token?: string) => {
    if (job.name === MAIL_JOB) {
      const { to, toName, mail } = job.data as MailPayload
      if (Date.now() < throttledUntil) return deferMail(job, token, throttledUntil)
      const result = await sendMail(to, toName, mail)
      // The provider said "not now" (quota spent): wait it out, all mail with it.
      if (!result.sent && result.retryAfterMs != null) {
        throttledUntil = Math.max(throttledUntil, Date.now() + result.retryAfterMs)
        logger.warn({ until: new Date(throttledUntil).toISOString(), template: mail.category, to },
          'mail: provider quota reached — holding mail until it resets')
        return deferMail(job, token, throttledUntil)
      }
      // sendMail cannot reject, so a failure has to be re-raised to reach
      // BullMQ's retry. `unconfigured` is NOT re-raised: no token is
      // configured, retrying changes nothing, and three attempts apiece would
      // turn a dormant mailer into a queue full of guaranteed failures.
      if (!result.sent && result.reason === 'send-failed') {
        throw new Error(`mail send failed: ${mail.category} to ${to}`)
      }
      return result
    }

    if (job.name === NOTIFICATION_JOB) {
      const payload = job.data as NotificationPayload
      return publishNotificationDurable({ ...payload, at: new Date(payload.at) })
    }

    return undefined
  }, {
    connection,
    // Mail is I/O against a third party and the jobs are independent, so a
    // handful at a time is both safe and the point — a slow provider must not
    // serialise a fan-out to six recipients.
    concurrency: 5,
  })

  worker.on('failed', (job, err) => {
    const final = err instanceof UnrecoverableError || (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1)
    const log = final ? logger.error.bind(logger) : logger.warn.bind(logger)
    log({ err, jobId: job?.id, name: job?.name, attempt: job?.attemptsMade, final },
      final ? 'Outbound job failed - giving up' : 'Outbound job failed - will retry')
  })

  logger.info({ queue: OUTBOUND_QUEUE }, 'Outbound worker started - mail and notifications are off the request thread')

  return {
    async stop() {
      await worker?.close()
      await queue?.close()
      worker = null
      queue = null
    },
  }
}
