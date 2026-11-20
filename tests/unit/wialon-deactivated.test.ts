import { describe, it, expect } from 'vitest'
import { wialonActivation, fleetUnits, missingFromWialon } from '../../src/modules/iam/wialon-deactivated.js'

describe('wialonActivation', () => {
  it('reads the activation flag, with the deactivation time as the date', () => {
    expect(wialonActivation({ act: 0, dactt: 1763600000 })).toEqual({ deactivated: true, since: new Date(1763600000 * 1000).toISOString() })
    expect(wialonActivation({ act: 0 })).toEqual({ deactivated: true, since: null })
    expect(wialonActivation({ act: 1, dactt: 1763600000 })).toEqual({ deactivated: false, since: null })
  })

  it('falls back to a deactivation time alone, and reads no flag and no time as active', () => {
    expect(wialonActivation({ dactt: 1763600000 }).deactivated).toBe(true)
    expect(wialonActivation({ dactt: 0 })).toEqual({ deactivated: false, since: null })
    expect(wialonActivation({})).toEqual({ deactivated: false, since: null })
  })
})

describe('fleetUnits', () => {
  it("takes the account's units through the fleet's name rule, as the sync does", () => {
    const units = [{ id: 1, nm: 'WKS - Naitiri - KDE 321Q' }, { id: 2, nm: 'WKS - Kabras - KDE 100A' }, { id: 3, nm: 'Sukari KCX 795S' }] as never
    expect(fleetUnits(units, { nameMask: /^\s*(west\s*sugar|wks)\b(?!\s*-\s*(kabras|nzoia)\b)/i }).map((u) => u.id)).toEqual([1])
    expect(fleetUnits(units, {}).map((u) => u.id)).toEqual([1, 2, 3])
  })
})

describe('missingFromWialon', () => {
  const v = (id: string, externalId: string | null) => ({ id, name: `Unit ${id}`, registrationPlate: `K${id}`, externalId })
  it("lists active units Wialon no longer returns, however they were linked; leaves those it still returns", () => {
    const got = missingFromWialon([v('a', 'wialon:11'), v('b', 'wialon:12'), v('c', 'fs:abc'), v('d', null), v('e', 'wialon:99')], new Set([11, 99]))
    expect(got).toEqual([
      { id: 'b', name: 'Unit b', plate: 'Kb', link: 'wialon' },
      { id: 'c', name: 'Unit c', plate: 'Kc', link: 'other' },
      { id: 'd', name: 'Unit d', plate: 'Kd', link: 'other' },
    ])
  })
})
