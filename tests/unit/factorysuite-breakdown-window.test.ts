import { describe, expect, it } from 'vitest'
import { breakdownWindow } from '../../src/modules/repairs/factorysuite-workshop.runner.js'

const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1

describe('breakdownWindow', () => {
  it('stays within FactorySuite\'s 31 days, both ends counted (400 on 2026-11-18 at 32)', () => {
    const w = breakdownWindow(Date.parse('2026-11-18T04:38:00Z'))
    expect(w).toEqual({ from: '2026-10-20', to: '2026-11-19' })
    expect(days(w.from, w.to)).toBe(31)
  })

  it('is 31 days at any hour of the day', () => {
    for (const at of ['2026-11-18T00:00:00Z', '2026-11-18T23:59:59Z', '2026-12-31T21:00:00Z', '2027-03-01T12:00:00Z']) {
      const w = breakdownWindow(Date.parse(at))
      expect(days(w.from, w.to)).toBe(31)
    }
  })
})
