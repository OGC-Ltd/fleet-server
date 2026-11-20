import { describe, it, expect } from 'vitest'
import { isDeactivatedInWialon, deactivatedInWialon, MAX_DEACTIVATED_SHARE } from '../../src/providers/wialon/wialon.registry-sync.js'

describe('isDeactivatedInWialon', () => {
  it('reads act 0 as deactivated and act 1 as active, whatever the date', () => {
    expect(isDeactivatedInWialon({ act: 0, dactt: 1792156934 })).toBe(true)
    expect(isDeactivatedInWialon({ act: '0' })).toBe(true)
    expect(isDeactivatedInWialon({ act: 1, dactt: 1792156934 })).toBe(false)
  })
  it('falls back to a deactivation time; no status at all is active', () => {
    expect(isDeactivatedInWialon({ dactt: 1792156934 })).toBe(true)
    expect(isDeactivatedInWialon({ dactt: 0 })).toBe(false)
    expect(isDeactivatedInWialon({})).toBe(false)
    expect(isDeactivatedInWialon(undefined)).toBe(false)
  })
})

describe('deactivatedInWialon', () => {
  const units = Array.from({ length: 20 }, (_, i) => ({ id: i + 1 }))
  const off = (...ids: number[]) => new Map(ids.map(id => [id, { act: 0 }]))

  it("returns the fleet's deactivated units", () => {
    const r = deactivatedInWialon(units, off(3, 7, 99))   // 99 is another fleet's
    expect([...r.ids].sort((a, b) => a - b)).toEqual([3, 7])
    expect(r.refused).toBeNull()
  })

  it('hides none when over the share at once (a bad answer, not a fleet change)', () => {
    const r = deactivatedInWialon(units, off(1, 2, 3, 4, 5, 6))   // 6 of 20 = 30 %
    expect(r.ids.size).toBe(0)
    expect(r.refused).toMatch(/6 of 20/)
  })

  it('allows exactly the share, and the measured fleets sit well under it', () => {
    expect(deactivatedInWialon(units, off(1, 2, 3, 4, 5)).ids.size).toBe(5)   // 25 %
    expect(19 / 210).toBeLessThan(MAX_DEACTIVATED_SHARE)                     // Kasulu, 2026-11-20
  })

  it('a unit with no status read stays as it is', () => {
    expect(deactivatedInWialon(units, new Map()).ids.size).toBe(0)
  })
})
