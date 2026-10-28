/**
 * A repair ticket number reaches the operator, Head of Security and Assistant
 * Head of Security as a push notification, not mail (operator, 2026-10-27).
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

vi.mock('../../src/lib/prisma.js', () => ({ prisma: prismaMock }))
vi.mock('../../src/lib/queues/outbound.js', () => out)
vi.mock('../../src/modules/notifications/notifications.service.js', () => ({ pushService: push }))

import { notifyWorkflow, TICKET_PUSH_ROLES } from '../../src/modules/repairs/repairs.workflow.notify.js'

const ref = { itemId: 'job-1', orgId: 'org-1', vehicleId: 'v1', plate: 'KDA 001A', ticketNo: 'RT-2026-00077', label: 'Brakes', stage: 'Awaiting assessment' }

beforeEach(() => {
  vi.clearAllMocks()
  push.usersForEmails.mockImplementation(async (emails: string[]) => ({
    ids: emails.map((e) => ACCOUNTS[e]).filter((x): x is string => !!x),
    unmatched: emails.filter((e) => !ACCOUNTS[e]),
  }))
  prismaMock.user.findMany.mockResolvedValue([
    { id: 'op-1',  email: 'op@x.co',  memberships: [{ allVehicles: true, vehicleScopes: [] }] },
    { id: 'hos-1', email: 'hos@x.co', memberships: [] },
  ])
})

describe('a new repair ticket', () => {
  it('is pushed to the operator and both security heads, and mailed to nobody', async () => {
    const res = await notifyWorkflow(ref, {
      key: 'ticket', severity: 'info', headline: 'Repair ticket issued',
      text: 'ticket RT-2026-00077 issued: physical inspection', audience: [], push: TICKET_PUSH_ROLES,
    })

    expect(TICKET_PUSH_ROLES).toEqual(['operator', 'head_of_security', 'asst_head_of_security'])
    const slugs = prismaMock.user.findMany.mock.calls.map((c) => c[0].where.userRoles.some.role.slug)
    expect(slugs).toContainEqual({ in: [...TICKET_PUSH_ROLES] })
    expect(push.sendToUsers).toHaveBeenCalledWith(['op-1', 'hos-1'], expect.objectContaining({
      title: 'Repair ticket issued',
      body:  expect.stringContaining('RT-2026-00077'),
    }))
    expect(out.enqueueMail).not.toHaveBeenCalled()
    expect(res.to).toEqual([])
    // The feed line stays.
    expect(out.enqueueNotification).toHaveBeenCalledTimes(1)
  })
})

describe('whoever took the action', () => {
  it('is left out of the push, and named on the feed line', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ email: 'OP@x.co' })
    // Nobody here is a technician (they are never mailed whatever the audience).
    const holders = await prismaMock.user.findMany()
    prismaMock.user.findMany.mockReset()
    prismaMock.user.findMany.mockImplementation(async (q) => (q.where.userRoles.some.role.slug === 'technician' ? [] : holders))
    const res = await notifyWorkflow(ref, {
      key: 'booked', severity: 'info', headline: 'Unit booked', text: 'booked',
      audience: ['control_room'], push: ['operator'], actorId: 'op-1',
    })

    // One push for the audience and the push roles together: hos-1 once.
    expect(push.sendToUsers).toHaveBeenCalledTimes(1)
    expect(push.sendToUsers).toHaveBeenCalledWith(['hos-1'], expect.anything())
    expect(res.to).toEqual(['hos@x.co'])
    expect(res.accepted).toEqual(['hos@x.co'])
    expect(out.enqueueMail).not.toHaveBeenCalled()
    expect(out.enqueueNotification).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'op-1' }))
  })
})
