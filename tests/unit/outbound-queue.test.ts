/**
 * Mail and notifications off the request thread — and the guarantee that
 * moving them there cannot lose one.
 *
 * The objection lib/mailer's docblock raises against queueing is the thing
 * most of these tests are about: "a queued mail that never sends because Redis
 * is absent is worse than a slow request". REDIS_URL is unset on the
 * production box today, so the no-Redis path is not a fallback for an outage —
 * it is the CURRENT behaviour, and it has to be indistinguishable from what
 * shipped before the queue existed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendMailMock = vi.hoisted(() => vi.fn())
vi.mock('../../src/lib/mailer/mailer.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/mailer/mailer.js')>()),
  sendMail: sendMailMock,
}))

const publishDurableMock = vi.hoisted(() => vi.fn())
vi.mock('../../src/lib/notifications/notification.store.js', () => ({
  publishNotificationDurable: publishDurableMock,
}))

const redisMock = vi.hoisted(() => ({ getQueueRedis: vi.fn() }))
vi.mock('../../src/lib/redis.js', () => redisMock)

const addMock = vi.hoisted(() => vi.fn())
/** The processor the worker was constructed with, so it can be driven here. */
const processorRef = vi.hoisted(() => ({ current: null as ((job: unknown) => Promise<unknown>) | null }))
vi.mock('bullmq', () => ({
  DelayedError: class DelayedError extends Error {},
  UnrecoverableError: class UnrecoverableError extends Error {},
  Queue: class { add = addMock; close = vi.fn() },
  Worker: class {
    constructor(_name: string, processor: (job: unknown) => Promise<unknown>) {
      processorRef.current = processor
    }
    on = vi.fn()
    close = vi.fn()
  },
}))

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const MAIL = { subject: 'Reset your password', text: 'link', html: '<p>link</p>', category: 'password-reset' as const }

/** The module holds a lazily-built Queue, so each test gets a fresh import. */
async function load() {
  vi.resetModules()
  return import('../../src/lib/queues/outbound.js')
}

beforeEach(() => {
  sendMailMock.mockReset().mockResolvedValue({ sent: true })
  publishDurableMock.mockReset().mockResolvedValue({ item: {}, published: true })
  addMock.mockReset().mockResolvedValue({ id: 'job-1' })
  redisMock.getQueueRedis.mockReset().mockReturnValue(null)
})

describe('with no Redis — the production box today', () => {
  it('sends the mail inline, and says sent rather than queued', async () => {
    const { enqueueMail } = await load()
    await expect(enqueueMail('a@b.c', 'Ada', MAIL)).resolves.toEqual({ sent: true })
    expect(sendMailMock).toHaveBeenCalledWith('a@b.c', 'Ada', MAIL)
    expect(addMock).not.toHaveBeenCalled()
  })

  it('passes a failure through unchanged, so nothing downstream sees a new shape', async () => {
    sendMailMock.mockResolvedValue({ sent: false, reason: 'unconfigured' })
    const { enqueueMail } = await load()
    await expect(enqueueMail('a@b.c', null, MAIL)).resolves.toEqual({ sent: false, reason: 'unconfigured' })
  })

  it('writes the notification inline', async () => {
    const { enqueueNotification } = await load()
    const at = new Date('2026-09-21T08:00:00Z')
    await expect(enqueueNotification({ orgId: 'o', id: 'n1', source: 'repair', severity: 'info', text: 't', at }))
      .resolves.toEqual({ queued: false })
    expect(publishDurableMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'n1', at }))
  })
})

describe('with Redis', () => {
  beforeEach(() => redisMock.getQueueRedis.mockReturnValue({}))

  it('queues the mail and does not wait on SMTP', async () => {
    const { enqueueMail } = await load()
    await expect(enqueueMail('a@b.c', 'Ada', MAIL)).resolves.toEqual({ queued: true })
    expect(sendMailMock).not.toHaveBeenCalled()
    const [name, payload, opts] = addMock.mock.calls[0]!
    expect(name).toBe('outbound:mail')
    expect(payload).toEqual({ to: 'a@b.c', toName: 'Ada', mail: MAIL })
    // A retry is the second reason this change is worth making: today a blip
    // at the provider is an invite that never arrives.
    expect(opts.attempts).toBe(3)
    expect(opts.backoff).toEqual({ type: 'exponential', delay: 30_000 })
  })

  it('carries the mail whole, so the worker needs no database', async () => {
    const { enqueueMail } = await load()
    await enqueueMail('a@b.c', 'Ada', MAIL)
    expect(addMock.mock.calls[0]![1].mail).toEqual(MAIL)
  })

  it('sends INLINE when Redis is configured but the add fails', async () => {
    // Configured-but-unreachable is the case that would silently eat a
    // password reset if this were a bare `add`.
    addMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const { enqueueMail } = await load()
    await expect(enqueueMail('a@b.c', null, MAIL)).resolves.toEqual({ sent: true })
    expect(sendMailMock).toHaveBeenCalledOnce()
  })

  it('keys the notification job on the feed id, so a double publish collapses', async () => {
    const { enqueueNotification } = await load()
    await enqueueNotification({
      orgId: 'o', id: 'repair-digest-o-2026-09-21', source: 'repair', severity: 'info',
      text: 't', at: new Date('2026-09-21T08:00:00Z'),
    })
    expect(addMock.mock.calls[0]![2].jobId).toBe('n-repair-digest-o-2026-09-21')
  })

  it('crosses the date as an ISO string, because Redis holds JSON', async () => {
    const { enqueueNotification } = await load()
    const at = new Date('2026-09-21T08:00:00Z')
    await enqueueNotification({ orgId: 'o', id: 'n1', source: 'repair', severity: 'info', text: 't', at })
    expect(addMock.mock.calls[0]![1].at).toBe('2026-09-21T08:00:00.000Z')
    expect(publishDurableMock).not.toHaveBeenCalled()
  })

  it('writes the notification inline when the add fails', async () => {
    addMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const { enqueueNotification } = await load()
    await expect(enqueueNotification({
      orgId: 'o', id: 'n1', source: 'repair', severity: 'info', text: 't', at: new Date(),
    })).resolves.toEqual({ queued: false })
    expect(publishDurableMock).toHaveBeenCalledOnce()
  })
})

describe('queued is not sent', () => {
  it('reports each outcome as its own word', async () => {
    const { dispatchStatus } = await load()
    expect(dispatchStatus({ queued: true })).toBe('queued')
    expect(dispatchStatus({ sent: true })).toBe('sent')
    expect(dispatchStatus({ sent: false, reason: 'unconfigured' })).toBe('unconfigured')
    expect(dispatchStatus({ sent: false, reason: 'send-failed' })).toBe('send-failed')
  })

  it('counts sent and queued as accepted, and nothing else', async () => {
    const { isAccepted } = await load()
    expect(isAccepted({ sent: true })).toBe(true)
    expect(isAccepted({ queued: true })).toBe(true)
    // A dormant mailer has not accepted anything and never will — the admin
    // screen has to be able to tell that apart from a mail in flight.
    expect(isAccepted({ sent: false, reason: 'unconfigured' })).toBe(false)
    expect(isAccepted({ sent: false, reason: 'send-failed' })).toBe(false)
  })
})

describe('the worker, once a job reaches it', () => {
  beforeEach(() => {
    redisMock.getQueueRedis.mockReturnValue({})
    processorRef.current = null
  })

  async function processor() {
    const { startOutboundWorker } = await load()
    await startOutboundWorker()
    if (!processorRef.current) throw new Error('worker was not constructed')
    return processorRef.current
  }

  it('re-raises a send failure, because sendMail cannot reject and BullMQ retries on a throw', async () => {
    // sendMail's contract is that it resolves `{ sent: false }` rather than
    // throwing — which is exactly what a queue must NOT see, or every failure
    // would be recorded as a success and never retried.
    sendMailMock.mockResolvedValue({ sent: false, reason: 'send-failed' })
    const run = await processor()
    await expect(run({ name: 'outbound:mail', data: { to: 'a@b.c', toName: null, mail: MAIL } }))
      .rejects.toThrow(/mail send failed/)
  })

  it('does NOT retry an unconfigured mailer', async () => {
    // No token is set, so three attempts apiece would fill the queue with
    // guaranteed failures. The box carries no MAILTRAP keys today, which makes
    // this the common case rather than an edge one.
    sendMailMock.mockResolvedValue({ sent: false, reason: 'unconfigured' })
    const run = await processor()
    await expect(run({ name: 'outbound:mail', data: { to: 'a@b.c', toName: null, mail: MAIL } }))
      .resolves.toEqual({ sent: false, reason: 'unconfigured' })
  })

  it('revives the notification date before writing it', async () => {
    const run = await processor()
    await run({ name: 'outbound:notification', data: {
      orgId: 'o', id: 'n1', source: 'repair', severity: 'info', text: 't',
      at: '2026-09-21T08:00:00.000Z',
    } })
    const written = publishDurableMock.mock.calls[0]![0]
    expect(written.at).toBeInstanceOf(Date)
    expect(written.at.toISOString()).toBe('2026-09-21T08:00:00.000Z')
  })

  it('starts no worker without Redis, and queues nothing either', async () => {
    redisMock.getQueueRedis.mockReturnValue(null)
    const { startOutboundWorker } = await load()
    await startOutboundWorker()
    expect(processorRef.current).toBeNull()
  })
})

describe("when the provider's quota is spent", () => {
  beforeEach(() => redisMock.getQueueRedis.mockReturnValue({}))

  const job = (category: string, timestamp = Date.now()) => ({
    name: 'outbound:mail', timestamp, moveToDelayed: vi.fn(),
    data: { to: 'a@b.c', toName: null, mail: { ...MAIL, category } },
  })

  async function worker() {
    const m = await load()
    await m.startOutboundWorker()
    return processorRef.current! as (job: unknown, token?: string) => Promise<unknown>
  }

  it('queues account mail at the top priority', async () => {
    const { enqueueMail } = await load()
    await enqueueMail('a@b.c', null, { ...MAIL, category: 'invite' })
    await enqueueMail('a@b.c', null, { ...MAIL, category: 'password-changed' })
    expect(addMock.mock.calls.map((c) => c[2].priority)).toEqual([1, 1])
  })

  it('never queues a template that may not send', async () => {
    const { enqueueMail } = await load()
    sendMailMock.mockResolvedValueOnce({ sent: false, reason: 'not-allowed' })
    const out = await enqueueMail('a@b.c', null, { ...MAIL, category: 'repair-workflow' })
    expect(addMock).not.toHaveBeenCalled()
    expect(out).toEqual({ sent: false, reason: 'not-allowed' })
  })

  it('holds the mail until the quota resets instead of spending its attempts', async () => {
    sendMailMock.mockResolvedValue({ sent: false, reason: 'send-failed', retryAfterMs: 3_600_000 })
    const run = await worker()
    const invite = job('invite')
    const before = Date.now()
    await expect(run(invite, 'tok')).rejects.toThrow()
    expect(invite.moveToDelayed).toHaveBeenCalledOnce()
    const [at, token] = invite.moveToDelayed.mock.calls[0]!
    expect(at).toBeGreaterThanOrEqual(before + 3_600_000)
    expect(token).toBe('tok')

    // The next job waits too, without another refused login, and comes due
    // after the invite.
    const notice = job('repair-workflow')
    await expect(run(notice, 'tok')).rejects.toThrow()
    expect(sendMailMock).toHaveBeenCalledOnce()
    expect(notice.moveToDelayed.mock.calls[0]![0]).toBeGreaterThan(at)
  })

  it('gives up on a mail held for more than two days', async () => {
    sendMailMock.mockResolvedValue({ sent: false, reason: 'send-failed', retryAfterMs: 60_000 })
    const run = await worker()
    const old = job('repair-workflow', Date.now() - 49 * 3_600_000)
    await expect(run(old)).rejects.toThrow(/quota/)
    expect(old.moveToDelayed).not.toHaveBeenCalled()
  })
})
