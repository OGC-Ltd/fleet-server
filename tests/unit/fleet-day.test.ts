/**
 * "Dispatched today" has to mean today in Ndhiwa, not today in UTC.
 *
 * The fleet runs on EAT (UTC+3), so the two calendars disagree for the three
 * hours after local midnight — precisely when a night shift's runs would drop
 * off the Active Trip board if the boundary were taken from UTC.
 */

import { describe, it, expect } from 'vitest'
import { fleetDayStart, fleetDayKey } from '../../src/lib/provider-time.js'

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

/**
 * `fleetDayKey` had NO tests until 2026-08-28, and it is the half of the pair
 * whose off-by-one actually shipped: `fleetDayStart` returns the INSTANT EAT
 * midnight falls on, which in UTC is 21:00 the previous evening, so labelling a
 * day from that instant's UTC date names the day before it. It went unnoticed
 * because every row was shifted uniformly and nothing disagreed with anything
 * else.
 *
 * Every case below is one where taking `fleetDayStart`'s calendar components
 * would give the wrong answer.
 */
describe('fleetDayKey', () => {
  it('names the day the fleet is IN, not the UTC date the day opened on', () => {
    // Midday EAT on the 3rd. fleetDayStart is 2026-08-02T21:00Z, whose UTC date
    // is the 2nd — the exact trap this function exists to avoid.
    expect(fleetDayKey(new Date('2026-08-03T09:00:00Z')).toISOString())
      .toBe('2026-08-03T00:00:00.000Z')
  })

  it('holds the label steady across UTC midnight', () => {
    // 23:59 and 00:01 UTC are 02:59 and 03:01 EAT — the same working morning,
    // and a naive ::date would split them across two labels.
    expect(fleetDayKey(new Date('2026-08-02T23:59:00Z')).toISOString())
      .toBe(fleetDayKey(new Date('2026-08-03T00:01:00Z')).toISOString())
  })

  it('rolls at 21:00 UTC, where the fleet day actually turns', () => {
    expect(fleetDayKey(new Date('2026-08-02T20:59:00Z')).toISOString())
      .toBe('2026-08-02T00:00:00.000Z')
    expect(fleetDayKey(new Date('2026-08-02T21:01:00Z')).toISOString())
      .toBe('2026-08-03T00:00:00.000Z')
  })

  it('returns UTC midnight, which is what a @db.Date column stores', () => {
    const key = fleetDayKey(new Date('2026-08-03T09:00:00Z'))
    expect(key.getUTCHours()).toBe(0)
    expect(key.getUTCMinutes()).toBe(0)
    expect(key.getUTCSeconds()).toBe(0)
    expect(key.getUTCMilliseconds()).toBe(0)
  })

  it('is exactly one day ahead of itself across the boundary', () => {
    // The pair has to stay consistent: a key and the start of the same day must
    // describe the same 24 hours, or a rollup and its label drift apart.
    const at = new Date('2026-08-03T09:00:00Z')
    const start = fleetDayStart(at)
    expect(fleetDayKey(at).getTime() - start.getTime()).toBe(3 * 3_600_000)
  })
})
