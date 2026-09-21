/**
 * "This job has already been closed" — said about a job that was open.
 *
 * Two independent defects produced that sentence, and between them they made
 * assigning a triage fail for anybody working across sites while reporting a
 * cause that had nothing to do with it.
 *
 * 1. The repository asked whether the assignee's HOME ORGANISATION COLUMN
 *    matched, while the picker in front of it, and the authorization check
 *    beside it, both use the roster's rule: home organisation OR a live
 *    membership. So a technician with a membership was offered, authorised,
 *    and then refused.
 *
 * 2. The controller threw `result.reason` away and re-derived the answer from
 *    `itemExists`. An `invalid_assignee` also returns a null item, and the job
 *    is open and therefore exists — so the one branch left was "closed".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const txMock = vi.hoisted(() => ({
  repairReportItem: { findFirst: vi.fn(), updateMany: vi.fn() },
  user: { findFirst: vi.fn() },
}))
const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(txMock)),
  repairReportItem: { findFirst: vi.fn() },
  user: { findUnique: vi.fn() },
}))
vi.mock('../../src/lib/prisma.js', () => ({ prisma: prismaMock }))
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { assignItem } from '../../src/modules/repairs/repairs.repository.js'

const OPEN_ITEM = { id: 'i1', assignedToId: null, stageHistory: [], assignedAt: null, assignedById: null }

beforeEach(() => {
  txMock.repairReportItem.findFirst.mockReset().mockResolvedValue(OPEN_ITEM)
  txMock.repairReportItem.updateMany.mockReset().mockResolvedValue({ count: 1 })
  txMock.user.findFirst.mockReset().mockResolvedValue({ id: 'u2' })
  prismaMock.user.findUnique.mockReset().mockResolvedValue({ fullName: 'Ada' })
})

describe('who counts as being in the organisation', () => {
  it('accepts a technician reachable by MEMBERSHIP, not only by employer', async () => {
    await assignItem('i1', 'org-1', 'u1', { technicianId: 'u2' })

    const where = txMock.user.findFirst.mock.calls[0]![0].where
    // The exact predicate the roster uses. Asserted as a shape rather than a
    // behaviour because the bug was a MISSING arm, and a mock that resolves a
    // user would pass whatever was asked.
    expect(where.OR).toEqual([
      { organisationId: 'org-1' },
      { memberships: { some: { organisationId: 'org-1', revokedAt: null } } },
    ])
  })

  it('does not offer a deleted account', async () => {
    const where = (await assignItem('i1', 'org-1', 'u1', { technicianId: 'u2' }),
      txMock.user.findFirst.mock.calls[0]![0].where)
    expect(where.deletedAt).toBeNull()
  })

  it('still refuses somebody outside the organisation entirely', async () => {
    txMock.user.findFirst.mockResolvedValue(null)
    const result = await assignItem('i1', 'org-1', 'u1', { technicianId: 'stranger' })
    expect(result).toEqual({ item: null, reason: 'invalid_assignee' })
  })

  it('looks nobody up when the assignment is being REVOKED', async () => {
    // null means unassign. There is no assignee to validate, and validating
    // `null` would refuse every revocation.
    await assignItem('i1', 'org-1', 'u1', { technicianId: null })
    expect(txMock.user.findFirst).not.toHaveBeenCalled()
  })

  it('reports a genuinely closed job as closed', async () => {
    // The `resolvedAt: null` filter is what makes this branch mean "closed",
    // and it must keep meaning that — the fix is about telling the two apart,
    // not about suppressing one of them.
    txMock.repairReportItem.findFirst.mockResolvedValue(null)
    const result = await assignItem('i1', 'org-1', 'u1', { technicianId: 'u2' })
    expect(result).toEqual({ item: null, reason: 'closed' })
  })
})
