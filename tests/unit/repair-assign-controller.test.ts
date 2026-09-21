/**
 * The sentence the operator actually reads when an assignment does not land.
 *
 * `invalid_assignee` and `closed` both come back with a null item, and the
 * controller used to distinguish them by asking whether the job existed. It
 * does exist — it is open, on the board, in front of the person clicking — so
 * every rejected assignee was reported as "This job has already been closed".
 *
 * The message named the wrong noun, the wrong verb and the wrong fix: nothing
 * was closed, nothing had been signed off, and reloading the page (the only
 * action that sentence suggests) brought back the same open job.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const svcMock = vi.hoisted(() => ({ assignItemToTechnician: vi.fn() }))
vi.mock('../../src/modules/repairs/repairs.service.js', () => svcMock)

const repoMock = vi.hoisted(() => ({ itemExists: vi.fn() }))
vi.mock('../../src/modules/repairs/repairs.repository.js', () => repoMock)

import { assignItem } from '../../src/modules/repairs/repairs.controller.js'

/** Drive the handler and return whatever reached `next`, or the body sent. */
async function call() {
  let sent: unknown
  const res = {
    status: () => res,
    json: (b: unknown) => { sent = b; return res },
  } as never
  let err: unknown
  await assignItem(
    { params: { orgId: 'org-1', itemId: 'i1' }, body: { technicianId: 'u2' }, user: { id: 'u1' } } as never,
    res,
    ((e: unknown) => { err = e }) as never,
  )
  return { err, sent }
}

beforeEach(() => {
  svcMock.assignItemToTechnician.mockReset()
  repoMock.itemExists.mockReset().mockResolvedValue(true)
})

describe('assignItem, when it cannot assign', () => {
  it('says the person cannot take the job — not that the job is closed', async () => {
    svcMock.assignItemToTechnician.mockResolvedValue({ item: null, reason: 'invalid_assignee' })
    const { err } = await call()
    expect((err as Error).message).toMatch(/not a member of this organisation/)
    expect((err as Error).message).not.toMatch(/closed/)
  })

  it('does not even ask whether the job exists in that case', async () => {
    // The question is irrelevant to the answer, and asking it is what produced
    // the wrong sentence.
    svcMock.assignItemToTechnician.mockResolvedValue({ item: null, reason: 'invalid_assignee' })
    await call()
    expect(repoMock.itemExists).not.toHaveBeenCalled()
  })

  it('still says closed when the job really is closed', async () => {
    svcMock.assignItemToTechnician.mockResolvedValue({ item: null, reason: 'closed' })
    repoMock.itemExists.mockResolvedValue(true)
    expect(((await call()).err as Error).message).toMatch(/already been closed/)
  })

  it('still says not found when there is no such job', async () => {
    svcMock.assignItemToTechnician.mockResolvedValue({ item: null, reason: 'closed' })
    repoMock.itemExists.mockResolvedValue(false)
    expect(((await call()).err as Error).message).toMatch(/not found/i)
  })

  it('passes a successful assignment through untouched', async () => {
    svcMock.assignItemToTechnician.mockResolvedValue({
      item: { id: 'i1' }, reason: 'ok', assignmentEmail: { queued: true },
    })
    const { err, sent } = await call()
    expect(err).toBeUndefined()
    expect(sent).toBeTruthy()
  })
})
