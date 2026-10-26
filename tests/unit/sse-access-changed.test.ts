import { describe, expect, it, vi } from 'vitest'
import type { Response } from 'express'
import { emitAccessChanged, registerDashboardClient } from '../../src/lib/sse.js'

const fakeRes = () => ({ write: vi.fn(), end: vi.fn() }) as unknown as Response & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }

describe('emitAccessChanged', () => {
  it("tells only that user's dashboards, then closes them so they reconnect on the new access", () => {
    const mine = fakeRes()
    const mineElsewhere = fakeRes()
    const theirs = fakeRes()
    registerDashboardClient('org-a', mine, { userId: 'u1' })
    registerDashboardClient('org-b', mineElsewhere, { userId: 'u1' })
    const offTheirs = registerDashboardClient('org-a', theirs, { userId: 'u2' })

    expect(emitAccessChanged('u1')).toBe(2)

    for (const res of [mine, mineElsewhere]) {
      expect(String(res.write.mock.calls[0]?.[0])).toContain('event: access_changed')
      expect(res.end).toHaveBeenCalledOnce()
    }
    expect(theirs.write).not.toHaveBeenCalled()
    expect(theirs.end).not.toHaveBeenCalled()
    expect(emitAccessChanged('u1')).toBe(0)
    offTheirs()
  })
})
