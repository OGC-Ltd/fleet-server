/**
 * The sign-in screen's "units in transit" must mean what the dashboard means.
 *
 * Two surfaces, one phrase, and they were counting differently. The dashboard's
 * `isInTransit` (dash/src/lib/vehicleMap) is the definition:
 *
 *     connectionOnline === true  AND  engine on  AND  round(speed) >= 1
 *
 * The pulse approximated two of those three, and both approximations inflated
 * it: a five-minute freshness window standing in for the provider's connection
 * verdict, and `speed > 0` standing in for `round(speed) >= 1`.
 *
 * These pin the rule itself. The freshness window is gone entirely rather than
 * tightened — it answers a different question, and the measured disagreement
 * (28 of 224 units on the live Kasulu account, 25 of them units Wialon called
 * offline) is what that difference costs.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import { countPulse } from '../../src/modules/dashboard/dashboard.service.js'
import { noteConnection, resetConnectionState } from '../../src/lib/connection-state.js'
import type { PulseRow } from '../../src/modules/dashboard/dashboard.repository.js'

const row = (over: Partial<PulseRow> = {}): PulseRow => ({
  deviceId: 'dev-1', speedKmh: 40, engineOn: true, ...over,
})

beforeEach(() => resetConnectionState())

describe('countPulse', () => {
  it('counts a connected unit with its engine on and moving', () => {
    noteConnection('dev-1', true)
    expect(countPulse([row()])).toEqual({ total: 1, inTransit: 1 })
  })

  it('counts every active vehicle in the total, moving or not', () => {
    // `total` is the fleet, not the moving part of it — the share on the card
    // divides one by the other.
    noteConnection('dev-1', true)
    const out = countPulse([row(), row({ deviceId: 'dev-2', speedKmh: 0 })])
    expect(out.total).toBe(2)
    expect(out.inTransit).toBe(1)
  })

  it('does NOT count a unit the provider calls offline', () => {
    // The case the freshness window got wrong: 25 of 224 units on the live
    // account were posting recent frames while Wialon called them
    // disconnected. A queued frame is not a connection.
    noteConnection('dev-1', false)
    expect(countPulse([row()]).inTransit).toBe(0)
  })

  it('does NOT count a unit the provider has said nothing about', () => {
    // No verdict is not a yes. Where the poller is not running this makes the
    // whole platform read zero in transit — which is exactly what the
    // dashboard shows in that state, and the point is that they agree.
    expect(countPulse([row()]).inTransit).toBe(0)
  })

  it('does not count a connected unit with the engine off', () => {
    noteConnection('dev-1', true)
    expect(countPulse([row({ engineOn: false })]).inTransit).toBe(0)
    expect(countPulse([row({ engineOn: null })]).inTransit).toBe(0)
  })

  it('rounds the speed the way the card does before testing it', () => {
    noteConnection('dev-1', true)
    // 0.4 rounds to 0 — the old `speed > 0` counted this and the dashboard
    // never did.
    expect(countPulse([row({ speedKmh: 0.4 })]).inTransit).toBe(0)
    // 0.5 rounds to 1, and the classification must not contradict the number
    // printed beside it.
    expect(countPulse([row({ speedKmh: 0.5 })]).inTransit).toBe(1)
    expect(countPulse([row({ speedKmh: 1   })]).inTransit).toBe(1)
  })

  it('treats a missing speed as stationary', () => {
    noteConnection('dev-1', true)
    expect(countPulse([row({ speedKmh: null })]).inTransit).toBe(0)
  })

  it('handles a vehicle with no device id', () => {
    // Nothing to look a verdict up by, so nothing can assert it is connected.
    expect(countPulse([row({ deviceId: null })]).inTransit).toBe(0)
  })

  it('counts across organisations — it is a platform figure', () => {
    noteConnection('dev-1', true)
    noteConnection('dev-9', true)
    const out = countPulse([row(), row({ deviceId: 'dev-9' })])
    expect(out).toEqual({ total: 2, inTransit: 2 })
  })
})
