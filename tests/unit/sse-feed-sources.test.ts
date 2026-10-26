import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Response } from 'express'
import { emitDashboardFeed, registerDashboardClient } from '../../src/lib/sse.js'

const fakeRes = () => ({ write: vi.fn(), end: vi.fn(), writableLength: 0 }) as unknown as Response & { write: ReturnType<typeof vi.fn> }
const written = (res: { write: ReturnType<typeof vi.fn> }) => res.write.mock.calls.map((c) => String(c[0])).join('')

afterEach(() => { vi.useRealTimers() })

describe('feed sources on the dashboard stream', () => {
  it('sends a technician only repair notices on their units, and everyone else the lot', () => {
    vi.useFakeTimers()
    const tech  = fakeRes()
    const ops   = fakeRes()
    const offTech = registerDashboardClient('org-f', tech, { vehicleIds: new Set(['v1']), feedSources: new Set(['repair']) })
    const offOps  = registerDashboardClient('org-f', ops)

    emitDashboardFeed('org-f', { id: 'a', source: 'zone',   vehicleId: 'v1', text: 'entered yard' })
    emitDashboardFeed('org-f', { id: 'b', source: 'repair', vehicleId: 'v1', text: 'job opened' })
    emitDashboardFeed('org-f', { id: 'c', source: 'repair', vehicleId: 'v2', text: 'other unit' })
    vi.advanceTimersByTime(200)

    expect(written(tech)).toContain('"id":"b"')
    expect(written(tech)).not.toContain('"id":"a"')
    expect(written(tech)).not.toContain('"id":"c"')
    for (const id of ['a', 'b', 'c']) expect(written(ops)).toContain(`"id":"${id}"`)
    offTech(); offOps()
  })
})
