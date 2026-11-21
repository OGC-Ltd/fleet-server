/**
 * Auto Workshop for a technician (operator, 2026-11-21): only the cards of
 * their ControlTech jobs that went on to the workshop, no booked-and-released
 * history and no workshop-wide figures.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const flagged = vi.hoisted(() => ({ on: true }))
vi.mock('../../src/lib/authz/subject.js', () => ({ flaggedOnlyIn: vi.fn(async () => flagged.on) }))
vi.mock('../../src/modules/repairs/factorysuite-workshop.sync.js', () => ({
  searchParts: vi.fn(), vehicleJobCards: vi.fn(),
  workshopBoard: vi.fn(async () => ({
    open: [
      { id: 'c1', vehicleId: 'v1', repairItem: { queue: 'controltech' } },
      { id: 'c2', vehicleId: 'v1', repairItem: { queue: 'workshop' } },
      { id: 'c3', vehicleId: 'v2', repairItem: { queue: 'controltech' } },
      { id: 'c4', vehicleId: 'v1', repairItem: null },
      { id: 'c5', vehicleId: 'v1', repairItem: { queue: 'workshop', workshopTechnicianId: 'u1' } },
      { id: 'c6', vehicleId: 'v1', repairItem: { queue: 'workshop', assignedToId: 'u1', assignmentStatus: 'accepted' } },
      { id: 'c7', vehicleId: 'v1', repairItem: { queue: 'workshop', assignedToId: 'u1', assignmentStatus: 'declined' } },
    ],
    moves: [{ vehicle: { id: 'v1' } }],
    summary: { cards: 40 },
  })),
}))

const { board } = await import('../../src/modules/repairs/factorysuite-workshop.controller.js')

async function read(vehicleIds: Set<string> | null) {
  const json = vi.fn()
  const res = { status: vi.fn(() => res), json } as never
  const next = vi.fn()
  await (board as (q: unknown, r: unknown, n: unknown) => Promise<void>)(
    { params: { orgId: 'o1' }, query: {}, authz: { userId: 'u1', orgId: 'o1', isPlatform: false, vehicleIds } }, res, next)
  expect(next).not.toHaveBeenCalled()
  return (json.mock.calls[0]![0] as { data: { open: { id: string }[]; moves: unknown[]; summary: unknown } }).data
}

describe('the Auto Workshop board for a technician', () => {
  beforeEach(() => { flagged.on = true })

  it("shows only their ControlTech and My jobs cards, with no history or figures", async () => {
    const out = await read(new Set(['v1']))
    expect(out.open.map((c) => c.id)).toEqual(['c1', 'c5', 'c6'])
    expect(out.moves).toEqual([])
    expect(out.summary).toBeNull()
  })

  it('leaves a vehicle-scoped non-technician as before', async () => {
    flagged.on = false
    const out = await read(new Set(['v1']))
    expect(out.open.map((c) => c.id)).toEqual(['c1', 'c2', 'c4', 'c5', 'c6', 'c7'])
    expect(out.moves).toHaveLength(1)
    expect(out.summary).toEqual({ cards: 40 })
  })
})
