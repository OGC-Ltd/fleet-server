/**
 * The fleet day a `?date=` query resolves to.
 *
 * These pin a one-millisecond boundary that emptied every past day on the FSL
 * table: mileage, engine hours, engine burn and the closing fuel level all came
 * back null, because `asOf` landed on midnight at the END of the requested day
 * and `getFleetTankState` derives its own window from `fleetDayStart(asOf)`.
 */

import { describe, it, expect } from 'vitest'
import { asOfFromQuery } from '../../src/modules/fuel/fuel.controller.js'
import { fleetDayStart, fleetDayKey } from '../../src/lib/provider-time.js'

/** A day long past, so `asOf` is never clamped to `now`. */
const DAY = '2026-08-13'
/** Midnight EAT opening the 13th = 21:00 UTC on the 12th. */
const DAY_START = Date.parse('2026-08-12T21:00:00.000Z')

describe('asOfFromQuery', () => {
  it('lands inside the requested day, not on the next one', () => {
    const asOf = asOfFromQuery(DAY)
    // The whole bug in one assertion: the service re-derives the day from this
    // instant, so it has to belong to the day that was asked for.
    expect(fleetDayStart(asOf).getTime()).toBe(DAY_START)
  })

  it('gives the service a full day to measure, not a zero-width window', () => {
    const asOf = asOfFromQuery(DAY)
    const width = asOf.getTime() - fleetDayStart(asOf).getTime()
    // Was 0, which is why every figure derived from the day's readings — the
    // closing level, mileage, engine seconds, both burns — came back null.
    expect(width).toBe(86_400_000 - 1)
  })

  it('reaches the last instant of the day, so the close is a real close', () => {
    // The closing level medianises the final CLOSE_WINDOW_MINUTES. Stopping
    // short of midnight would quietly measure the close of the evening.
    expect(asOfFromQuery(DAY).toISOString()).toBe('2026-08-13T20:59:59.999Z')
  })

  it("does not let one day's window bleed into the next", () => {
    // Adjacent days must not overlap: one day's Current IS the next day's
    // Initial, and a shared instant would double-count a reading into both.
    const first  = asOfFromQuery('2026-08-12')
    const second = asOfFromQuery(DAY)
    expect(first.getTime()).toBeLessThan(fleetDayStart(second).getTime())
    expect(fleetDayStart(second).getTime() - first.getTime()).toBe(1)
  })

  it('clamps today to now, because a day in progress has no end', () => {
    const before = Date.now()
    // The fleet day's OWN calendar date, which is not the UTC one for the three
    // hours after EAT midnight — the same divergence the day boundary exists
    // for. `fleetDayStart` returns the instant of EAT midnight; shifting it
    // back into EAT renders that day's date.
    const eat = new Date(fleetDayStart(new Date(before)).getTime() + 3 * 3_600_000)
    const y = eat.getUTCFullYear()
    const m = String(eat.getUTCMonth() + 1).padStart(2, '0')
    const d = String(eat.getUTCDate()).padStart(2, '0')
    const asOf = asOfFromQuery(`${y}-${m}-${d}`)
    // Pinning today to its midnight would freeze the live column.
    expect(asOf.getTime()).toBeGreaterThanOrEqual(before)
    expect(asOf.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('files a fleet day under the date a person would write on the sheet', () => {
    // The off-by-one that mislabelled all 4,650 stored trend rows. fleetDayStart
    // returns the INSTANT EAT-midnight falls on, which in UTC is 21:00 the
    // previous evening — so its UTC calendar components are the day BEFORE the
    // one it opens. The whole fleet day below is EAT the 13th.
    const start = fleetDayStart(new Date('2026-08-13T20:50:00Z'))
    expect(start.toISOString()).toBe('2026-08-12T21:00:00.000Z')
    expect(start.getUTCDate()).toBe(12)                          // the trap
    expect(fleetDayKey(new Date('2026-08-13T20:50:00Z')).toISOString())
      .toBe('2026-08-13T00:00:00.000Z')                          // the answer
  })

  it('gives every instant inside one fleet day the same key', () => {
    // Including the three hours after UTC midnight, which is where EAT and UTC
    // dates disagree and where a naive conversion flips to the wrong day.
    const key = '2026-08-13T00:00:00.000Z'
    for (const t of [
      '2026-08-12T21:00:00.000Z',   // EAT midnight, the day's first instant
      '2026-08-12T23:30:00.000Z',   // before UTC midnight, still EAT the 13th
      '2026-08-13T00:30:00.000Z',   // after UTC midnight, still EAT the 13th
      '2026-08-13T20:59:59.999Z',   // the day's last instant
    ]) {
      expect(fleetDayKey(new Date(t)).toISOString()).toBe(key)
    }
    // ...and the next instant belongs to the next day, not this one.
    expect(fleetDayKey(new Date('2026-08-13T21:00:00.000Z')).toISOString())
      .toBe('2026-08-14T00:00:00.000Z')
  })

  it('keeps the prior-slosh window clear of the day it is computing', () => {
    // Second-order effect of the same bug: getFleetTankState gathers prior run
    // slosh with `day < dayStart`. Under the old labels the current day's own
    // row compared as 00:00Z against a 21:00Z bound and was pulled into its own
    // "prior" window. Correct labels sort it after the bound.
    const asOf     = asOfFromQuery(DAY)
    const dayStart = fleetDayStart(asOf)
    expect(fleetDayKey(asOf).getTime()).toBeGreaterThan(dayStart.getTime())
    // The PREVIOUS fleet day still falls inside the window.
    const prev = fleetDayKey(new Date(dayStart.getTime() - 1))
    expect(prev.getTime()).toBeLessThan(dayStart.getTime())
  })

  it('falls back to now on a missing or malformed date', () => {
    // This drives a table; a bad query string must not blank it.
    for (const bad of [undefined, null, '', 'yesterday', '2026-8-13', 42]) {
      const asOf = asOfFromQuery(bad)
      expect(Math.abs(asOf.getTime() - Date.now())).toBeLessThan(5_000)
    }
  })
})
