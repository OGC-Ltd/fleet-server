import { describe, it, expect } from 'vitest'
import {
  assignmentAt, coversUntil, currentAssignmentWhere, dutySpan, isRun,
} from '../../src/modules/vehicles/driver-assignment.js'

const d = (iso: string) => new Date(iso)
const row = (id: string, assigned: string, unassigned: string | null, notes: string | null) =>
  ({ id, assignedAt: d(assigned), unassignedAt: unassigned ? d(unassigned) : null, notes })

describe('driver-assignment', () => {
  const roster = row('roster', '2026-10-21T08:00:00Z', null, 'Driver list 2026-10-21 (DRIVER LIST.xlsx)')

  it('the standing posting holds the truck when no run covers the moment', () => {
    expect(assignmentAt([roster], d('2026-10-29T12:00:00Z'))?.id).toBe('roster')
  })

  it('a run overrides the posting while it holds the truck, and hands back after', () => {
    const run = row('run', '2026-10-29T06:00:00Z', '2026-10-29T18:00:00Z', 'controltech:dispatch:1')
    expect(assignmentAt([roster, run], d('2026-10-29T12:00:00Z'))?.id).toBe('run')
    expect(assignmentAt([roster, run], d('2026-10-29T19:00:00Z'))?.id).toBe('roster')
  })

  it('an open run holds its truck however old it is: the next dispatch is what ends it', () => {
    const last = row('last', '2026-10-22T06:00:00Z', null, 'controltech:dispatch:2')
    expect(coversUntil(last)).toBeNull()
    expect(assignmentAt([roster, last], d('2026-11-20T06:00:00Z'))?.id).toBe('last')
  })

  it('duty ends at the sign-in even while the driver still holds the truck', () => {
    const held = { ...row('held', '2026-11-22T06:00:00Z', null, 'controltech:dispatch:5'), returnedAt: d('2026-11-22T18:00:00Z') }
    expect(dutySpan(held).unassignedAt).toEqual(d('2026-11-22T18:00:00Z'))
    expect(assignmentAt([held], d('2026-11-23T06:00:00Z'))?.id).toBe('held')
    expect(assignmentAt([dutySpan(held)], d('2026-11-23T06:00:00Z'))).toBeNull()
    // Closed by the next dispatch before any sign-in: that close stands.
    const cut = { ...row('cut', '2026-11-22T06:00:00Z', '2026-11-22T10:00:00Z', 'controltech:dispatch:6'), returnedAt: d('2026-11-22T18:00:00Z') }
    expect(dutySpan(cut).unassignedAt).toEqual(d('2026-11-22T10:00:00Z'))
    // No sign-in: unchanged.
    const roster2 = { ...roster, returnedAt: null }
    expect(dutySpan(roster2)).toBe(roster2)
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

  it('the query filter: open, or closing after now', () => {
    const now = d('2026-10-30T00:00:00Z')
    const w = currentAssignmentWhere(now)
    expect(w.assignedAt).toEqual({ lte: now })
    expect(w.OR).toEqual([{ unassignedAt: null }, { unassignedAt: { gt: now } }])
  })
})
