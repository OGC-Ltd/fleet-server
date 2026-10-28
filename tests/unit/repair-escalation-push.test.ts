/**
 * A repair escalation reaches its list by Web Push, never by mail
 * (operator, 2026-10-28).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const out = vi.hoisted(() => ({
  enqueueMail:         vi.fn(async () => ({ queued: true })),
  enqueueNotification: vi.fn(async () => undefined),
}))
const push = vi.hoisted(() => ({ sendToUsers: vi.fn(async () => undefined), usersForEmails: vi.fn() }))

vi.mock('../../src/lib/queues/outbound.js', () => out)
vi.mock('../../src/lib/notifications/notification.store.js', () => ({ publishNotificationDurable: vi.fn() }))
vi.mock('../../src/modules/notifications/notifications.service.js', () => ({ pushService: push }))
vi.mock('../../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { reportEscalation } from '../../src/modules/repairs/repairs.notify.js'

const ref = { itemId: 'job-1', orgId: 'org-1', plate: 'KDA 001A', label: 'Fuel probe' }

beforeEach(() => {
  vi.clearAllMocks()
  push.usersForEmails.mockResolvedValue({ ids: ['u-a'], unmatched: ['nobody@x.co'] })
})

describe('a repair escalation', () => {
  it('is pushed to the accounts behind the escalation list, mailed to nobody, and kept on the feed', async () => {
    await reportEscalation(ref, { level: 2, at: '2026-10-28T08:00:00Z', reason: 'overdue' } as never, ['a@x.co', 'nobody@x.co'])

    expect(push.usersForEmails).toHaveBeenCalledWith(['a@x.co', 'nobody@x.co'])
    expect(push.sendToUsers).toHaveBeenCalledWith(['u-a'], expect.objectContaining({
      title: 'Escalation (level 2): KDA 001A',
      tag:   'repair-escalation-job-1-2',
    }))
    expect(out.enqueueMail).not.toHaveBeenCalled()
    expect(out.enqueueNotification).toHaveBeenCalledWith(expect.objectContaining({ alertType: 'repair_escalated', severity: 'critical' }))
  })
})
