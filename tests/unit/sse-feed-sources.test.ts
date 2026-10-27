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

  it('keeps a flag notice to the technician, off the rest of the feed', () => {
    vi.useFakeTimers()
    const tech = fakeRes()
    const ops  = fakeRes()
    const offTech = registerDashboardClient('org-g', tech, { vehicleIds: new Set(['v1']), feedSources: new Set(['repair', 'repair_flag']) })
    const offOps  = registerDashboardClient('org-g', ops)

    emitDashboardFeed('org-g', { id: 'f', source: 'repair_flag', vehicleId: 'v1', text: 'flagged' })
    emitDashboardFeed('org-g', { id: 'z', source: 'zone',        vehicleId: 'v1', text: 'entered yard' })
    vi.advanceTimersByTime(200)

    expect(written(tech)).toContain('"id":"f"')
    expect(written(ops)).not.toContain('"id":"f"')
    expect(written(ops)).toContain('"id":"z"')
    offTech(); offOps()
  })

  it('sends a ticket notice to the ticket roles only, never a technician', () => {
    vi.useFakeTimers()
    const tech = fakeRes()
    const desk = fakeRes()
    const other = fakeRes()
    const offs = [
      registerDashboardClient('org-t', tech, { vehicleIds: new Set(['v1']), feedSources: new Set(['repair', 'repair_flag']) }),
      registerDashboardClient('org-t', desk, { feedGrants: new Set(['repair_ticket']) }),
      registerDashboardClient('org-t', other),
    ]

    emitDashboardFeed('org-t', { id: 't', source: 'repair_ticket', vehicleId: 'v1', text: 'ticket RT-2026-00077' })
    emitDashboardFeed('org-t', { id: 'z', source: 'zone',          vehicleId: 'v1', text: 'entered yard' })
    vi.advanceTimersByTime(200)

    expect(written(desk)).toContain('"id":"t"')
    expect(written(desk)).toContain('"id":"z"')
    expect(written(tech)).not.toContain('"id":"t"')
    expect(written(other)).not.toContain('"id":"t"')
    expect(written(other)).toContain('"id":"z"')
    for (const off of offs) off()
  })
})
