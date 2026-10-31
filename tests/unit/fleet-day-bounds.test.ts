import { describe, it, expect } from 'vitest'
import { fleetDayBounds } from '../../src/modules/trips/trip-report.service.js'

describe('fleetDayBounds', () => {
  it('runs midnight to midnight in Nairobi (UTC+3)', () => {
    const { from, to } = fleetDayBounds('2026-10-28')
    expect(from.toISOString()).toBe('2026-10-27T21:00:00.000Z')
    expect(to.toISOString()).toBe('2026-10-28T21:00:00.000Z')
  })
  it('refuses anything that is not a date, or a day still to come', () => {
    for (const day of ['28-10-2026', '2026-13-01', 'today', '']) expect(() => fleetDayBounds(day), day).toThrow(/YYYY-MM-DD/)
    expect(() => fleetDayBounds('2999-01-01')).toThrow(/future/)
  })
})
