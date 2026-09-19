import { describe, expect, it } from 'vitest'
import { chooseTechnicianForTriage } from '../../src/modules/repairs/repairs.triage.js'

describe('repair triage assignment', () => {
  it('prefers the least-loaded technician when assigning an unclaimed item', () => {
    const users = [
      { id: 'u1', fullName: 'Alice' },
      { id: 'u2', fullName: 'Bob' },
      { id: 'u3', fullName: 'Carol' },
    ]

    const openItems = [
      { id: 'r1', assignedToId: 'u1' },
      { id: 'r2', assignedToId: 'u1' },
      { id: 'r3', assignedToId: 'u2' },
      { id: 'r4', assignedToId: null },
    ]

    expect(chooseTechnicianForTriage(users, openItems)).toBe('u3')
  })

  it('keeps a technician from being chosen when they are already assigned to the item', () => {
    const users = [
      { id: 'u1', fullName: 'Alice' },
      { id: 'u2', fullName: 'Bob' },
    ]

    const openItems = [
      { id: 'r1', assignedToId: 'u1' },
      { id: 'r2', assignedToId: 'u2' },
    ]

    expect(chooseTechnicianForTriage(users, openItems, 'u1')).toBe('u2')
  })
})
