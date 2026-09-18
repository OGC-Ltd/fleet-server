/**
 * "Escalate if unresolved after X days" — the rule, pinned.
 *
 * These thresholds are measured in DAYS, which means a mistake in them is
 * invisible for a week and then either escalates the whole fleet at once or
 * escalates nothing at all. Neither failure shows up in a staging click-through,
 * so the clocks are exercised here against fixed instants instead.
 */

import { describe, it, expect } from 'vitest'
import {
  escalationDue, escalationsDue, escalationsOf, lastEscalation, escalationPhrase,
  type EscalatableItem, type EscalationEvent,
} from '../../src/modules/repairs/repairs.escalation.js'

const DAY = 86_400_000
const NOW = new Date('2026-09-19T08:05:00.000Z')
const ago = (d: number) => new Date(NOW.getTime() - d * DAY)
/** `expected_resolution_at` is a DATE: midnight UTC on the day named. */
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const POLICY = { now: NOW, staleDays: 3, overdueDays: 2, repeatDays: 3 }

const item = (o: Partial<EscalatableItem> = {}): EscalatableItem => ({
  id: 'item-1',
  stage: 'spare_outsourced',
  createdAt: ago(1),
  stageChangedAt: ago(1),
  expectedResolutionAt: null,
  resolvedAt: null,
  stageHistory: [],
  ...o,
})

const escalation = (o: Partial<EscalationEvent> = {}): EscalationEvent => ({
  kind: 'escalation',
  reason: 'stalled',
  level: 1,
  at: ago(1).toISOString(),
  days: 3,
  ...o,
})

describe('a job that is doing fine', () => {
  it('is not escalated for moving yesterday', () => {
    expect(escalationDue(item(), POLICY)).toBeNull()
  })

  it('is not escalated on the day its own estimate names', () => {
    // The technician said the 19th. The 19th is not late until it has ended.
    expect(escalationDue(item({ expectedResolutionAt: day('2026-09-19') }), POLICY)).toBeNull()
  })

  it('is not escalated the day after either — that is the grace', () => {
    expect(escalationDue(item({ expectedResolutionAt: day('2026-09-18') }), POLICY)).toBeNull()
  })
})

describe('a job nobody has touched', () => {
  it('escalates once it has been still for the stale window', () => {
    const e = escalationDue(item({ stageChangedAt: ago(3) }), POLICY)
    expect(e?.reason).toBe('stalled')
    expect(e?.level).toBe(1)
    expect(e?.days).toBe(3)
  })

  it('measures from when it was FILED when it has never moved', () => {
    const e = escalationDue(item({ createdAt: ago(9), stageChangedAt: null }), POLICY)
    expect(e?.reason).toBe('stalled')
    expect(e?.days).toBe(9)
  })
})

describe('a job past the date its technician gave', () => {
  it('escalates once the grace after that day has run out', () => {
    // Estimate 2026-09-15: late from the 16th, escalating on the 18th.
    const e = escalationDue(item({ expectedResolutionAt: day('2026-09-15'), stageChangedAt: ago(1) }), POLICY)
    expect(e?.reason).toBe('overdue')
    expect(e?.days).toBe(3)
  })

  it('outranks stalled when it is both', () => {
    const e = escalationDue(
      item({ expectedResolutionAt: day('2026-09-10'), stageChangedAt: ago(8) }),
      POLICY,
    )
    // Both clocks have run out; the one naming a date somebody chose wins.
    expect(e?.reason).toBe('overdue')
  })
})

describe('a job that has left the loop', () => {
  it('is never escalated once it is signed off, however old', () => {
    const closed = item({ resolvedAt: ago(1), stageChangedAt: ago(40), stage: 'fixed' })
    expect(escalationDue(closed, POLICY)).toBeNull()
  })
})

describe('escalation repeats, but not every morning', () => {
  it('stays quiet inside the repeat window', () => {
    const e = escalationDue(
      item({ stageChangedAt: ago(9), stageHistory: [escalation({ at: ago(1).toISOString() })] }),
      POLICY,
    )
    expect(e).toBeNull()
  })

  it('comes back a level higher once the window has passed', () => {
    const e = escalationDue(
      item({ stageChangedAt: ago(9), stageHistory: [escalation({ at: ago(3).toISOString() })] }),
      POLICY,
    )
    expect(e?.level).toBe(2)
  })

  it('counts levels across every prior escalation on the trail', () => {
    const history = [
      { stage: 'spare_outsourced', at: ago(12).toISOString(), by: 'u1' },
      escalation({ at: ago(9).toISOString(), level: 1 }),
      escalation({ at: ago(6).toISOString(), level: 2 }),
      escalation({ at: ago(3).toISOString(), level: 3 }),
    ]
    const e = escalationDue(item({ stageChangedAt: ago(12), stageHistory: history }), POLICY)
    expect(e?.level).toBe(4)
  })
})

describe('reading a trail', () => {
  it('finds the escalations among the stage moves, and ignores anything else', () => {
    const history = [
      { stage: 'fixing', at: ago(5).toISOString(), by: 'u1' },
      escalation({ at: ago(4).toISOString() }),
      { stage: 'spare_outsourced', at: ago(3).toISOString(), by: 'u1' },
      escalation({ at: ago(2).toISOString(), level: 2 }),
    ]
    expect(escalationsOf(history)).toHaveLength(2)
    expect(lastEscalation(history)?.level).toBe(2)
  })

  it('survives a column holding something that is not a list', () => {
    expect(escalationsOf(null)).toEqual([])
    expect(escalationsOf('corrupted')).toEqual([])
    expect(lastEscalation(undefined)).toBeNull()
  })
})

describe('a batch', () => {
  it('reports the worst first, so a truncated message keeps what matters', () => {
    const due = escalationsDue([
      item({ id: 'a', stageChangedAt: ago(4) }),
      item({ id: 'b', stageChangedAt: ago(20) }),
      item({ id: 'c', stageChangedAt: ago(20), stageHistory: [escalation({ at: ago(4).toISOString(), level: 2 })] }),
      item({ id: 'd', stageChangedAt: ago(1) }),          // fine
      item({ id: 'e', resolvedAt: ago(1), stageChangedAt: ago(30) }), // closed
    ], POLICY)

    expect(due.map(x => x.item.id)).toEqual(['c', 'b', 'a'])
    expect(due[0]!.event.level).toBe(3)
  })
})

describe('the words it uses', () => {
  it('names the date for overdue and the silence for stalled', () => {
    expect(escalationPhrase(escalation({ reason: 'overdue', days: 3 }))).toBe('3 days past the expected date')
    expect(escalationPhrase(escalation({ reason: 'stalled', days: 1 }))).toBe('no movement for 1 day')
  })
})
