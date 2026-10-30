import { describe, it, expect } from 'vitest'
import {
  assignmentAt, coversUntil, currentAssignmentWhere, isRun, RUN_OPEN_MAX_MS,
} from '../../src/modules/vehicles/driver-assignment.js'

const d = (iso: string) => new Date(iso)
const row = (id: string, assigned: string, unassigned: string | null, notes: string | null) =>
  ({ id, assignedAt: d(assigned), unassignedAt: unassigned ? d(unassigned) : null, notes })

describe('driver-assignment', () => {
  const roster = row('roster', '2026-10-21T08:00:00Z', null, 'Driver list 2026-10-21 (DRIVER LIST.xlsx)')

  it('the standing posting holds the truck when no run covers the moment', () => {
    expect(assignmentAt([roster], d('2026-10-29T12:00:00Z'))?.id).toBe('roster')
  })

  it('a run overrides the posting while it runs, and hands back after', () => {
    const run = row('run', '2026-10-29T06:00:00Z', '2026-10-29T18:00:00Z', 'controltech:dispatch:1')
    expect(assignmentAt([roster, run], d('2026-10-29T12:00:00Z'))?.id).toBe('run')
    expect(assignmentAt([roster, run], d('2026-10-29T19:00:00Z'))?.id).toBe('roster')
  })

  it('a run with no return stops covering after RUN_OPEN_MAX_MS (SUKARI, 698 runs over a week old)', () => {
    const stale = row('stale', '2026-10-01T06:00:00Z', null, 'controltech:dispatch:2')
    expect(coversUntil(stale)?.getTime()).toBe(d('2026-10-01T06:00:00Z').getTime() + RUN_OPEN_MAX_MS)
    expect(assignmentAt([stale], d('2026-10-02T06:00:00Z'))?.id).toBe('stale')
    expect(assignmentAt([stale], d('2026-10-29T06:00:00Z'))).toBeNull()
  })

  it('the newest open run wins over older open runs naming other drivers', () => {
    const older = row('older', '2026-10-28T20:00:00Z', null, 'controltech:dispatch:3')
    const newer = row('newer', '2026-10-29T05:00:00Z', null, 'controltech:dispatch:4')
    expect(assignmentAt([newer, older], d('2026-10-29T09:00:00Z'))?.id).toBe('newer')
  })

  it('a posting with no notes never expires', () => {
    const manual = row('manual', '2026-01-01T00:00:00Z', null, null)
    expect(isRun(manual.notes)).toBe(false)
    expect(assignmentAt([manual], d('2026-10-29T00:00:00Z'))?.id).toBe('manual')
  })

  it('nothing before the first assignment', () => {
    expect(assignmentAt([roster], d('2026-10-20T00:00:00Z'))).toBeNull()
  })

  it('the query filter keeps NULL-notes postings (NOT startsWith alone drops them)', () => {
    const now = d('2026-10-30T00:00:00Z')
    const w = currentAssignmentWhere(now)
    expect(w.assignedAt).toEqual({ lte: now })
    expect(w.OR).toContainEqual({ unassignedAt: null, notes: null })
    expect(w.OR).toContainEqual({ unassignedAt: null, assignedAt: { gte: new Date(now.getTime() - RUN_OPEN_MAX_MS) } })
  })
})
