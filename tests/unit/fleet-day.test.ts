/**
 * "Dispatched today" has to mean today in Ndhiwa, not today in UTC.
 *
 * The fleet runs on EAT (UTC+3), so the two calendars disagree for the three
 * hours after local midnight — precisely when a night shift's runs would drop
 * off the Active Trip board if the boundary were taken from UTC.
 */

import { describe, it, expect } from 'vitest'
import { fleetDayStart } from '../../src/lib/provider-time.js'

describe('fleetDayStart', () => {
  it('is 21:00 UTC the previous day — local midnight', () => {
    const start = fleetDayStart(new Date('2026-08-03T09:00:00Z'))   // 12:00 EAT
    expect(start.toISOString()).toBe('2026-08-02T21:00:00.000Z')
  })

  it('keeps the small hours of the local morning on the SAME day', () => {
    // 00:30 EAT on the 3rd is still 21:30 UTC on the 2nd. A run raised then is
    // today's, and a UTC boundary would have called it yesterday's.
    const start = fleetDayStart(new Date('2026-08-02T21:30:00Z'))
    expect(start.toISOString()).toBe('2026-08-02T21:00:00.000Z')
  })

  it('rolls over at local midnight, not at UTC midnight', () => {
    const beforeLocalMidnight = fleetDayStart(new Date('2026-08-02T20:59:00Z')) // 23:59 EAT 2nd
    const afterLocalMidnight  = fleetDayStart(new Date('2026-08-02T21:01:00Z')) // 00:01 EAT 3rd
    expect(beforeLocalMidnight.toISOString()).toBe('2026-08-01T21:00:00.000Z')
    expect(afterLocalMidnight.toISOString()).toBe('2026-08-02T21:00:00.000Z')

    // …and UTC midnight is a non-event.
    const beforeUtcMidnight = fleetDayStart(new Date('2026-08-02T23:59:00Z'))
    const afterUtcMidnight  = fleetDayStart(new Date('2026-08-03T00:01:00Z'))
    expect(beforeUtcMidnight.toISOString()).toBe(afterUtcMidnight.toISOString())
  })

  it('does not depend on the SERVER\'s timezone', () => {
    // The box runs UTC and a developer's machine does not. Both must agree,
    // which is why this shifts explicitly rather than using getHours().
    const start = fleetDayStart(new Date('2026-08-03T09:00:00Z'))
    expect(start.getTime() % 3_600_000).toBe(0)
    expect(start.toISOString().endsWith('T21:00:00.000Z')).toBe(true)
  })
})
