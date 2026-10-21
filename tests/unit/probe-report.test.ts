/**
 * Probe and sensor health.
 *
 * The distinction this pins is the reason the feature exists: a fuel channel
 * that produces nothing can be a broken probe OR a Wialon record nobody
 * finished, and those want different people. Measured on production
 * 2026-08-20 — 12 DIED, 31 SILENT, and 25 units carrying a sensor named
 * "2.Main Tank Fuel Level Qty ()" with an empty tank size and no calibration
 * table. Those 25 reported no level and no fault, so every rule on the fleet
 * called them healthy.
 */

import { describe, it, expect } from 'vitest'
import { classifyChannel, classifyGps, isTrackerSilent } from '../../src/modules/fuel/probe-report.service.js'

const DEAD_FROM = new Date('2026-08-19T12:00:00Z')
const INSIDE    = new Date('2026-08-20T09:00:00Z')
const BEFORE    = new Date('2026-08-14T09:00:00Z')

describe('channel states', () => {
  it('is REPORTING when seen inside the dead window', () => {
    expect(classifyChannel(INSIDE, 42, DEAD_FROM, true).state).toBe('REPORTING')
  })

  it('is NOT_REPORTING when it was alive but has gone quiet', () => {
    // The state the live grid cannot express: it renders a dash here and a dash
    // for a unit that never had the channel, and they are different faults.
    const c = classifyChannel(BEFORE, null, DEAD_FROM, true)
    expect(c.state).toBe('NOT_REPORTING')
    expect(c.lastSeenAt).toBe(BEFORE)
  })

  it('is NOT_FITTED when it has never been seen', () => {
    expect(classifyChannel(null, null, DEAD_FROM, true).state).toBe('NOT_FITTED')
  })

  it('refuses to judge a unit with too little telemetry', () => {
    // UNKNOWN outranks everything: calling a barely-reporting unit NOT_FITTED
    // would put it on a workshop list for having no data rather than no probe.
    expect(classifyChannel(null,   null, DEAD_FROM, false).state).toBe('UNKNOWN')
    expect(classifyChannel(INSIDE, 42,   DEAD_FROM, false).state).toBe('UNKNOWN')
  })

  it('carries the last value through, so the report can show what it read', () => {
    expect(classifyChannel(INSIDE, 16678, DEAD_FROM, true).lastValue).toBe(16678)
  })
})

describe("GPS, judged with the provider's clocks", () => {
  // KBL 126W, 2026-10-21: a faulty GPS on a tracker still talking. A message
  // without a fix makes no row, so our rows alone called it NOT_FITTED or
  // nothing at all.
  const talkingNoFix = { lastMessageAt: INSIDE, lastFixAt: BEFORE }

  it('is REPORTING when a fix landed inside the window', () => {
    expect(classifyGps(INSIDE, talkingNoFix, DEAD_FROM, true).state).toBe('REPORTING')
  })

  it('is NOT_REPORTING when the tracker talks but has not fixed in the window', () => {
    const c = classifyGps(null, talkingNoFix, DEAD_FROM, true)
    expect(c.state).toBe('NOT_REPORTING')
    expect(c.lastSeenAt).toBe(BEFORE)
  })

  it('believes the provider even on a unit with too few rows to judge', () => {
    // A dead GPS is exactly what starves the unit of rows.
    expect(classifyGps(null, talkingNoFix, DEAD_FROM, false).state).toBe('NOT_REPORTING')
    expect(classifyGps(null, { lastMessageAt: INSIDE, lastFixAt: null }, DEAD_FROM, false).state).toBe('NOT_REPORTING')
  })

  it('falls back to the rows when the provider has no clock for the unit', () => {
    expect(classifyGps(null, null, DEAD_FROM, true).state).toBe('NOT_FITTED')
  })
})

describe('tracker silence', () => {
  it('is silent with no row and no message inside the window', () => {
    expect(isTrackerSilent(false, { lastMessageAt: BEFORE, lastFixAt: BEFORE }, DEAD_FROM)).toBe(true)
    expect(isTrackerSilent(false, null, DEAD_FROM)).toBe(true)
  })

  it('is not silent while the provider still hears messages', () => {
    expect(isTrackerSilent(false, { lastMessageAt: INSIDE, lastFixAt: BEFORE }, DEAD_FROM)).toBe(false)
  })

  it('is not silent with rows inside the window', () => {
    expect(isTrackerSilent(true, null, DEAD_FROM)).toBe(false)
  })
})
