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
import { classifyChannel } from '../../src/modules/fuel/probe-report.service.js'

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
