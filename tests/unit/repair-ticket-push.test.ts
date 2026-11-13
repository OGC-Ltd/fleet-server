/**
 * A repair ticket number reaches the operator, Head of Security and Assistant
 * Head of Security as a push notification, not mail (operator, 2026-10-27).
 *
 * Since 2026-11-14 "the operator and the security heads" are the holders of
 * notification:push_tickets, a right in IAM that starts on those roles; the
 * holder lookup itself is lib/authz/holders, mocked here by right.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  user:         { findMany: vi.fn(), findUnique: vi.fn() },
  vehicle:      { findUnique: vi.fn() },
  organisation: { findUnique: vi.fn() },
}))
const out = vi.hoisted(() => ({
  enqueueMail:         vi.fn(async () => ({ queued: true })),
  enqueueNotification: vi.fn(async () => undefined),
  isAccepted:          vi.fn(() => true),
}))
const ACCOUNTS: Record<string, string> = { 'op@x.co': 'op-1', 'hos@x.co': 'hos-1' }
const push = vi.hoisted(() => ({
  sendToUsers:    vi.fn(async () => undefined),
  usersForEmails: vi.fn(async (emails: string[]) => ({ ids: [] as string[], unmatched: emails })),
}))
/** Who holds each right in the organisation. */
const HOLDERS = vi.hoisted(() => ({ byRight: {} as Record<string, Array<{ id: string; email: string | null; fullName: string | null }>> }))
const holdersOf = vi.hoisted(() => vi.fn(async (_org: string, rights: readonly string[]) =>
  rights.flatMap((r) => HOLDERS.byRight[r] ?? [])))

vi.mock('../../src/lib/prisma.js', () => ({ prisma: prismaMock }))
vi.mock('../../src/lib/queues/outbound.js', () => out)
vi.mock('../../src/modules/notifications/notifications.service.js', () => ({ pushService: push }))
vi.mock('../../src/lib/authz/holders.js', () => ({ holdersOf }))

import { notifyWorkflow, TICKET_PUSH } from '../../src/modules/repairs/repairs.workflow.notify.js'
import { ROLE_DEFINITIONS } from '../../src/lib/permissions.js'

const ref = { itemId: 'job-1', orgId: 'org-1', vehicleId: 'v1', plate: 'KDA 001A', ticketNo: 'RT-2026-00077', label: 'Brakes', stage: 'Awaiting assessment' }
const OP  = { id: 'op-1',  email: 'op@x.co',  fullName: 'Op' }
const HOS = { id: 'hos-1', email: 'hos@x.co', fullName: 'Hos' }

beforeEach(() => {
  vi.clearAllMocks()
  push.usersForEmails.mockImplementation(async (emails: string[]) => ({
    ids: emails.map((e) => ACCOUNTS[e]).filter((x): x is string => !!x),
    unmatched: emails.filter((e) => !ACCOUNTS[e]),
  }))
  HOLDERS.byRight = {
    'notification:push_tickets':      [OP, HOS],
    'notification:push_control_room': [OP, HOS],
  }
})

describe('a new repair ticket', () => {
  it('is pushed to the holders of notification:push_tickets, and mailed to nobody', async () => {
    const res = await notifyWorkflow(ref, {
      key: 'ticket', severity: 'info', headline: 'Repair ticket issued',
      text: 'ticket RT-2026-00077 issued: physical inspection', audience: [], push: TICKET_PUSH,
    })

    expect(TICKET_PUSH).toEqual(['notification:push_tickets'])
    expect(holdersOf).toHaveBeenCalledWith('org-1', ['notification:push_tickets'], expect.objectContaining({ vehicleId: 'v1' }))
    expect(push.sendToUsers).toHaveBeenCalledWith(['op-1', 'hos-1'], expect.objectContaining({
      title: 'Repair ticket issued',
      body:  expect.stringContaining('RT-2026-00077'),
    }))
    expect(out.enqueueMail).not.toHaveBeenCalled()
    expect(res.to).toEqual([])
    // The feed line stays.
    expect(out.enqueueNotification).toHaveBeenCalledTimes(1)
  })

  it('starts notification:push_tickets on the operator and both security heads', () => {
    const roles = ROLE_DEFINITIONS.filter((r) => r.permissions.includes('notification:push_tickets')).map((r) => r.slug).sort()
    expect(roles).toEqual(['asst_head_of_security', 'head_of_security', 'operator'])
  })
})

describe('whoever took the action', () => {
  it('is left out of the push, and named on the feed line', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ email: 'OP@x.co' })
    // Nobody here takes jobs (they are never mailed whatever the audience).
    const res = await notifyWorkflow(ref, {
      key: 'booked', severity: 'info', headline: 'Unit booked', text: 'booked',
      audience: ['control_room'], push: TICKET_PUSH, actorId: 'op-1',
    })

    // One push for the audience and the push right together: hos-1 once.
    expect(push.sendToUsers).toHaveBeenCalledTimes(1)
    expect(push.sendToUsers).toHaveBeenCalledWith(['hos-1'], expect.anything())
    expect(res.to).toEqual(['hos@x.co'])
    expect(res.accepted).toEqual(['hos@x.co'])
    expect(out.enqueueMail).not.toHaveBeenCalled()
    expect(out.enqueueNotification).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'op-1' }))
  })
})
