/**
 * work_plans_changed is the only thing that updates the map's Work plans
 * layer (the map does not poll), so it must reach every map in the org,
 * including one scoped to a few units, and only that org.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Response } from 'express'
import { emitDashboardWorkPlansChanged, emitDashboardRepairChanged, registerDashboardClient } from '../../src/lib/sse.js'

const fakeRes = () => ({ write: vi.fn(), end: vi.fn(), writableLength: 0 }) as unknown as Response & { write: ReturnType<typeof vi.fn> }
const written = (res: { write: ReturnType<typeof vi.fn> }) => res.write.mock.calls.map((c) => String(c[0])).join('')

afterEach(() => { vi.useRealTimers() })

describe('work_plans_changed on the dashboard stream', () => {
  it('reaches scoped and unscoped clients in the org, and no other org', () => {
    vi.useFakeTimers()
    const scoped = fakeRes()
    const full   = fakeRes()
    const other  = fakeRes()
    const offs = [
      registerDashboardClient('org-k', scoped, { vehicleIds: new Set(['v1']) }),
      registerDashboardClient('org-k', full),
      registerDashboardClient('org-x', other),
    ]

    emitDashboardWorkPlansChanged('org-k', { event: 'fuelplan.decided', planCode: 'WP-1', status: 'APPROVED' })
    vi.advanceTimersByTime(200)

    expect(written(scoped)).toContain('event: work_plans_changed')
    expect(written(full)).toContain('event: work_plans_changed')
    expect(written(other)).not.toContain('work_plans_changed')
    offs.forEach((off) => off())
  })

  it('leaves other org-wide events withheld from a scoped client, as before', () => {
    vi.useFakeTimers()
    const scoped = fakeRes()
    const off = registerDashboardClient('org-r', scoped, { vehicleIds: new Set(['v1']) })
    emitDashboardRepairChanged('org-r')
    vi.advanceTimersByTime(200)
    expect(written(scoped)).not.toContain('repair_changed')
    off()
  })
})
