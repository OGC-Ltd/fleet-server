/**
 * The two derived event kinds, which exist because their tables do not.
 *
 * `vehicle_alerts` has never held a row and the Wialon adapter hardcodes
 * `overspeeding: false`, so nothing has ever recorded a speed event for this
 * fleet; stops have no table at all. Both are computed from the fixes, and the
 * risk in computing them is volume — the naive stop rule produced 592 pins on
 * one real day. These tests pin the thresholds that make the output readable
 * and the boundaries that keep it honest.
 */

import { describe, it, expect } from 'vitest'
import { deriveStops, deriveSpeeding, SPEEDING_KMH } from '../../src/modules/telemetry/playback-events.js'
import type { PlaybackPoint } from '../../src/modules/telemetry/telemetry.repository.js'

const T0 = Date.parse('2026-08-28T06:00:00.000Z')
const MIN = 60_000

/** A fix `atMin` minutes into the day, at `spd` km/h. */
const fix = (atMin: number, spd: number | null, extra: Partial<PlaybackPoint> = {}): PlaybackPoint => ({
  t: T0 + atMin * MIN,
  lat: -0.28, lng: 34.75,
  spd, hdg: 90, eng: (spd ?? 0) > 0,
  ...extra,
})

/**
 * A run of fixes at one speed, spanning `fromMin` to `toMin` INCLUSIVE at
 * roughly the fleet's measured 28 s median cadence.
 *
 * Inclusive by construction, and that matters: stepping `m += 28/60` until it
 * passes the end leaves the last fix short of it by up to a cadence, so a run
 * written as 5→8 measured 2.93 minutes and a three-minute assertion failed
 * against code that was doing exactly the right thing.
 */
const run = (fromMin: number, toMin: number, spd: number | null): PlaybackPoint[] => {
  const steps = Math.max(1, Math.round(((toMin - fromMin) * 60) / 28))
  const out: PlaybackPoint[] = []
  for (let i = 0; i <= steps; i++) out.push(fix(fromMin + ((toMin - fromMin) * i) / steps, spd))
  return out
}

describe('stops', () => {
  it('reports a long stop with its duration', () => {
    const pts = [...run(0, 5, 30), ...run(5, 35, 0), ...run(35, 40, 30)]
    const stops = deriveStops(pts)

    expect(stops).toHaveLength(1)
    expect(stops[0].kind).toBe('stop')
    expect(stops[0].detail).toBe('30 min')
    expect(stops[0].endT! - stops[0].t).toBeCloseTo(30 * MIN, -3)
  })

  /**
   * The threshold, which is the whole reason this is not a pin per stopped fix.
   * Measured: the naive rule gives a median of 13 stops a vehicle-day, a p95 of
   * 158 and 592 on the busiest unit.
   */
  it('ignores a stop shorter than three minutes', () => {
    expect(deriveStops([...run(0, 5, 30), ...run(5, 7, 0), ...run(7, 12, 30)])).toHaveLength(0)
  })

  it('keeps a stop of exactly three minutes', () => {
    const stops = deriveStops([...run(0, 5, 30), ...run(5, 8, 0), ...run(8, 12, 30)])
    expect(stops).toHaveLength(1)
  })

  /**
   * A stop is measured between the first and last fix at rest — never out to
   * the moving fixes either side of it.
   *
   * The unit actually stopped somewhere in the gap before its first stationary
   * fix and moved off somewhere after its last, so the true stop is up to a
   * cadence longer at each end. Reporting the observed span UNDERSTATES it by
   * design: an operator reading "30 min" against a stop that was really 31 is
   * unharmed, and one reading "31" for a stop we only watched for 30 has been
   * told something nobody measured.
   */
  it('measures only the part it watched', () => {
    const stops = deriveStops([...run(0, 10, 30), ...run(10, 40, 0), ...run(40, 50, 30)])
    expect(stops[0].t).toBe(T0 + 10 * MIN)
    expect(stops[0].endT).toBe(T0 + 40 * MIN)
    expect(stops[0].detail).toBe('30 min')
  })

  it('counts a crawl as travel, not as a stop', () => {
    // 4 km/h is above STATIONARY_KMH. A machine working slowly is working.
    expect(deriveStops(run(0, 40, 4))).toHaveLength(0)
  })

  it('never treats an unknown speed as stopped', () => {
    // speedKmh is 100% populated today; a null arriving later must not invent a
    // half-hour stop the machine never made.
    expect(deriveStops(run(0, 40, null))).toHaveLength(0)
  })

  it('does not run a stop across a reporting silence', () => {
    // Stopped, then an hour of nothing, then stopped again. Reporting one
    // 90-minute stop would be a claim about time nothing was recorded for — the
    // unit may have driven the whole way through it.
    const pts = [
      ...run(0, 30, 0),
      ...run(90, 120, 0).map((p, i) => (i === 0 ? { ...p, gapBefore: true as const } : p)),
    ]
    const stops = deriveStops(pts)
    expect(stops).toHaveLength(2)
    expect(stops[0].endT! - stops[0].t).toBeLessThan(45 * MIN)
  })

  it('closes an open stop at the end of the day', () => {
    // A unit that parks at 17:00 and is still there at midnight has stopped;
    // the run simply has no fix above the threshold to end it.
    const stops = deriveStops([...run(0, 5, 30), ...run(5, 60, 0)])
    expect(stops).toHaveLength(1)
    expect(stops[0].detail).toBe('55 min')
  })

  it('says hours and minutes once a stop passes an hour', () => {
    const stops = deriveStops([...run(0, 2, 30), ...run(2, 132, 0)])
    expect(stops[0].detail).toBe('2 h 10 min')
  })

  it('returns nothing for an empty day', () => {
    expect(deriveStops([])).toEqual([])
  })
})

describe('speeding', () => {
  it('reports a run above the threshold with its peak', () => {
    const pts = [...run(0, 5, 40), fix(6, 95), fix(6.5, 110), fix(7, 88), ...run(8, 10, 40)]
    const fast = deriveSpeeding(pts)

    expect(fast).toHaveLength(1)
    expect(fast[0].kind).toBe('speeding')
    expect(fast[0].severity).toBe('warning')
    expect(fast[0].detail).toBe('peak 110 km/h, limit 80 km/h')
  })

  /**
   * One fix over the line is as likely to be doppler noise as a driver — the
   * same jitter that reads 3 km/h on a parked unit reads 20 over on a moving
   * one. Two consecutive fixes is about a minute at the measured cadence.
   */
  it('ignores a single fix over the line', () => {
    expect(deriveSpeeding([...run(0, 5, 40), fix(6, 120), ...run(7, 10, 40)])).toHaveLength(0)
  })

  it('does not flag the fleet\'s ordinary working speeds', () => {
    // Measured over 24 h: p50 11 km/h, p95 41, p99 63. A day spent at any of
    // those is a normal day.
    for (const kmh of [11, 41, 63, SPEEDING_KMH]) {
      expect(deriveSpeeding(run(0, 60, kmh))).toHaveLength(0)
    }
  })

  it('splits two runs separated by a return to normal speed', () => {
    const pts = [
      fix(1, 95), fix(1.5, 96),
      ...run(2, 20, 30),
      fix(21, 92), fix(21.5, 94),
    ]
    expect(deriveSpeeding(pts)).toHaveLength(2)
  })

  it('does not run a speeding span across a silence', () => {
    const pts = [
      fix(1, 95), fix(1.5, 96),
      { ...fix(90, 97), gapBefore: true as const }, fix(90.5, 98),
    ]
    const fast = deriveSpeeding(pts)
    expect(fast).toHaveLength(2)
    expect(fast[0].endT! - fast[0].t).toBeLessThan(MIN)
  })

  it('honours a caller-supplied threshold', () => {
    // The 80 default is a threshold, not a rule — there is no per-vehicle speed
    // limit anywhere in the schema to derive one from.
    expect(deriveSpeeding(run(0, 10, 50))).toHaveLength(0)
    expect(deriveSpeeding(run(0, 10, 50), 40).length).toBeGreaterThan(0)
  })

  it('never treats an unknown speed as speeding', () => {
    expect(deriveSpeeding(run(0, 40, null))).toHaveLength(0)
  })
})
