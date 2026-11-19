/**
 * The work plan webhook (WORK_PLANNER_HOOK, registered 2026-11-14).
 *
 * FactorySuite's second webhook posts the fuelplan.* events to the same
 * receiver as the first, signed with its OWN secret, and was registered as
 * /webhooks/rai. These pin: either secret is accepted, a plan event reaches
 * workPlansChanged and nothing else, and workPlansChanged tells only the org
 * whose factory the plan belongs to.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'

vi.mock('../../src/config/env.js', async (orig) => {
  const real = await orig<typeof import('../../src/config/env.js')>()
  return {
    ...real,
    env: { ...real.env, FACTORY_SUITE_HOOK: 'alerts-secret', CONTROLTECH_WEBHOOK_SECRET: '', WORK_PLANNER_HOOK: 'plans-secret' },
  }
})
vi.mock('../../src/lib/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: { organisation: { findMany: vi.fn(async () => [{ id: 'org-kasulu' }]) } },
}))
vi.mock('../../src/lib/sse.js', () => ({ emitDashboardWorkPlansChanged: vi.fn() }))
vi.mock('../../src/modules/webhooks/raifactorysuite-events.service.js', () => ({
  handleDispatch: vi.fn().mockResolvedValue(true),
  handleMovement: vi.fn().mockResolvedValue(true),
  handleSale:     vi.fn().mockResolvedValue(true),
}))
vi.mock('../../src/modules/webhooks/raifactorysuite-alerts.service.js', () => ({
  ingestAlerts: vi.fn().mockResolvedValue({ created: 0 }),
}))
vi.mock('../../src/modules/webhooks/wialon-notifications.service.js', () => ({
  ingestWialonNotifications: vi.fn().mockResolvedValue({ created: 0 }),
}))

import { webhookAuth, webhookSourceOf } from '../../src/middleware/webhookAuth.js'
import { providerWebhook } from '../../src/modules/webhooks/webhooks.controller.js'
import { deliveryKey, firstDelivery, forgetDeliveries, REPEAT_TTL_MS } from '../../src/modules/webhooks/delivery-repeats.js'
import { workPlansChanged } from '../../src/modules/planner/work-plans.service.js'
import { emitDashboardWorkPlansChanged } from '../../src/lib/sse.js'
import { prisma } from '../../src/lib/prisma.js'
import { handleDispatch } from '../../src/modules/webhooks/raifactorysuite-events.service.js'
import { ingestAlerts } from '../../src/modules/webhooks/raifactorysuite-alerts.service.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

const BODY = {
  event: 'fuelplan.decided',
  occurredAt: '2026-11-14T10:00:00Z',
  data: { id: 'p1', planCode: 'WP-261115-ROA-1', factoryCode: 'MUFINDI PAPER MILLS', status: 'APPROVED' },
}

function signed(secret: string, body = BODY) {
  const raw = Buffer.from(JSON.stringify(body))
  return { headers: { 'x-signature': createHmac('sha256', secret).update(raw).digest('hex') }, rawBody: raw, body }
}

const runAuth = (req: any) => new Promise<unknown>((resolve) => webhookAuth(req, {} as any, resolve))

describe('webhookAuth with two FactorySuite webhooks', () => {
  it('accepts a delivery signed with either webhook secret', async () => {
    expect(await runAuth(signed('alerts-secret'))).toBeUndefined()
    expect(await runAuth(signed('plans-secret'))).toBeUndefined()
  })

  it('rejects a signature made with any other secret', async () => {
    expect(await runAuth(signed('not-a-secret'))).toBeInstanceOf(Error)
  })

  it('accepts either secret sent verbatim', async () => {
    expect(await runAuth({ headers: { 'x-webhook-secret': 'plans-secret' }, rawBody: Buffer.alloc(0) })).toBeUndefined()
    expect(await runAuth({ headers: { 'x-webhook-secret': 'nope' }, rawBody: Buffer.alloc(0) })).toBeInstanceOf(Error)
  })

  it('tags each delivery with the webhook whose secret it carried', async () => {
    const plans = signed('plans-secret'), alerts = signed('alerts-secret')
    await runAuth(plans); await runAuth(alerts)
    expect(webhookSourceOf(plans)).toBe('work_planner')
    expect(webhookSourceOf(alerts)).toBe('factory_suite')
    const verbatim: any = { headers: { authorization: 'Bearer plans-secret' }, rawBody: Buffer.alloc(0) }
    await runAuth(verbatim)
    expect(webhookSourceOf(verbatim)).toBe('work_planner')
  })
})

function reply() {
  const res: any = {}
  res.status = vi.fn(() => res)
  res.json = vi.fn(() => res)
  return res
}

describe('providerWebhook routes plan events', () => {
  beforeEach(() => { vi.clearAllMocks(); forgetDeliveries() })

  it('refreshes once when both webhooks deliver the same plan event', async () => {
    // 19 Nov 2026: fuelplan.decided for WP-261120-FAC came twice, 0.16 s apart.
    const first = reply(), second = reply()
    await providerWebhook({ body: BODY } as any, first, (e?: unknown) => { throw e })
    await providerWebhook({ body: { ...BODY, occurredAt: '2026-11-14T10:00:00.160Z' } } as any, second, (e?: unknown) => { throw e })
    expect(first.json.mock.calls[0][0].data).toMatchObject({ workPlans: 1, repeats: 0 })
    expect(second.json.mock.calls[0][0].data).toMatchObject({ workPlans: 0, repeats: 1, ignored: 0 })
    expect(emitDashboardWorkPlansChanged).toHaveBeenCalledTimes(1)
  })

  it('still refreshes for the same plan once its data has changed', async () => {
    await providerWebhook({ body: BODY } as any, reply(), (e?: unknown) => { throw e })
    await providerWebhook({ body: { ...BODY, event: 'fuelplan.released' } } as any, reply(), (e?: unknown) => { throw e })
    await providerWebhook({ body: { ...BODY, data: { ...BODY.data, status: 'REJECTED' } } } as any, reply(), (e?: unknown) => { throw e })
    expect(emitDashboardWorkPlansChanged).toHaveBeenCalledTimes(3)
  })

  it('replies before telling the open pages', async () => {
    const res = reply()
    await providerWebhook({ body: BODY } as any, res, (e?: unknown) => { throw e })
    const replied = res.json.mock.invocationCallOrder[0]
    const told = (emitDashboardWorkPlansChanged as any).mock.invocationCallOrder[0]
    expect(replied).toBeLessThan(told)
  })

  it('keeps the reply when telling the pages fails afterwards', async () => {
    ;(prisma.organisation.findMany as any).mockRejectedValueOnce(new Error('db down'))
    const res = reply()
    const next = vi.fn()
    await providerWebhook({ body: BODY } as any, res, next)
    expect(res.json).toHaveBeenCalledTimes(1)
    expect(next).not.toHaveBeenCalled()
  })

  it('sends fuelplan.* to the work plans, never to dispatches or alerts', async () => {
    for (const event of ['fuelplan.decided', 'fuelplan.change.requested', 'fuelplan.change.decided', 'fuelplan.released']) {
      const res = reply()
      await providerWebhook({ body: { ...BODY, event } } as any, res, (e?: unknown) => { throw e })
      expect(res.json.mock.calls[0][0].data).toMatchObject({ workPlans: 1, ignored: 0, dispatches: 0, alerts: 0 })
    }
    expect(emitDashboardWorkPlansChanged).toHaveBeenCalledTimes(4)
    expect(handleDispatch).not.toHaveBeenCalled()
    expect(ingestAlerts).not.toHaveBeenCalled()
  })

  it('acknowledges the field events it does not map yet', async () => {
    const res = reply()
    await providerWebhook({ body: { event: 'sighting.recorded', data: { id: 's1' } } } as any, res, (e?: unknown) => { throw e })
    expect(res.json.mock.calls[0][0].data).toMatchObject({ workPlans: 0, ignored: 1 })
    expect(emitDashboardWorkPlansChanged).not.toHaveBeenCalled()
  })
})

describe('workPlansChanged', () => {
  beforeEach(() => vi.clearAllMocks())

  it("tells the plan's org, with the plan's code and status", async () => {
    expect(await workPlansChanged('fuelplan.decided', BODY.data)).toBe(1)
    expect((prisma.organisation.findMany as any).mock.calls[0][0].where).toEqual({ code: { in: ['KASULU'] } })
    expect(emitDashboardWorkPlansChanged).toHaveBeenCalledWith('org-kasulu', {
      event: 'fuelplan.decided', planCode: 'WP-261115-ROA-1', status: 'APPROVED',
    })
  })

  it('tells nobody about a factory with no org here', async () => {
    expect(await workPlansChanged('fuelplan.decided', { factoryCode: 'SANDBOX' })).toBe(0)
    expect(prisma.organisation.findMany).not.toHaveBeenCalled()
    expect(emitDashboardWorkPlansChanged).not.toHaveBeenCalled()
  })

  it('reads the factory off a nested plan, and tells every work plan org when none is named', async () => {
    expect(await workPlansChanged('fuelplan.released', { plan: { factoryCode: 'MUFINDI PAPER MILLS' } })).toBe(1)
    expect(await workPlansChanged('fuelplan.released', { id: 'x' })).toBe(1)
    expect((prisma.organisation.findMany as any).mock.calls[1][0].where).toEqual({ code: { in: ['KASULU'] } })
  })
})

describe('delivery repeats', () => {
  beforeEach(() => forgetDeliveries())

  it('is the same event whatever order the data keys come in', () => {
    expect(deliveryKey('fuelplan.decided', { a: 1, b: { c: 2, d: [1, 2] } }))
      .toBe(deliveryKey('fuelplan.decided', { b: { d: [1, 2], c: 2 }, a: 1 }))
    expect(deliveryKey('fuelplan.decided', { a: 1 })).not.toBe(deliveryKey('fuelplan.released', { a: 1 }))
    expect(deliveryKey('fuelplan.decided', { d: [1, 2] })).not.toBe(deliveryKey('fuelplan.decided', { d: [2, 1] }))
  })

  it('counts a delivery as new again once REPEAT_TTL_MS has passed', () => {
    const key = deliveryKey('fuel.issue.completed', { id: 'i1' })
    expect(firstDelivery(key, 0)).toBe(true)
    expect(firstDelivery(key, REPEAT_TTL_MS - 1)).toBe(false)
    expect(firstDelivery(key, REPEAT_TTL_MS + 1)).toBe(true)
  })
})
