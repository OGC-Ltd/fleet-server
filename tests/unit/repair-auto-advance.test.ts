/**
 * The one stage transition a date is allowed to make on its own.
 *
 * A job filed as "needs a spare part" sits on `spare_outsourced` carrying the
 * technician's fix date. On that day the work starts, and making somebody open
 * the Repairs tab to press "Fixing" is asking them to hand-copy a fact the row
 * already holds — the kind of bookkeeping that stops happening precisely on the
 * jobs nobody is opening the tab for.
 *
 * Everything here is about the EDGES of that, because the middle is obvious.
 * What must never happen is a date asserting something only a person can:
 * `fixed` and `failed` are claims somebody stands behind.
 *
 * Dates are built relative to a fixed `now` rather than hardcoded, so no
 * assertion here changes meaning as the calendar moves.
 */

import { describe, it, expect } from 'vitest'
import {
  isAutoAdvanced, withEffectiveStage, withEffectiveStages, stageFilter,
  AUTO_FROM, AUTO_TO,
} from '../../src/modules/repairs/effective-stage.js'

/** Mid-month so ±N never crosses a month or year boundary. */
const NOW = new Date('2026-09-16T11:30:00.000Z')

/** Midnight UTC, N days from NOW — the frame the DATE column stores in. */
const day = (n: number) => new Date(Date.UTC(2026, 8, 16 + n))

const item = (over: Record<string, unknown> = {}) => ({
  stage:                AUTO_FROM,
  resolvedAt:           null,
  expectedResolutionAt: day(3),
  stageHistory:         [{ stage: AUTO_FROM, at: '2026-09-14T08:00:00.000Z', by: 'u1' }],
  ...over,
}) as Parameters<typeof withEffectiveStage>[0]

describe('waiting on a part', () => {
  it('stays put while the fix date is still ahead', () => {
    expect(isAutoAdvanced(item({ expectedResolutionAt: day(3) }), NOW)).toBe(false)
  })

  /*
   * ON the date, not the day after. The technician said the part lands that
   * day; the job is under way that day. An off-by-one here would be invisible
   * and would make every job read a day behind its own plan.
   */
  it('moves to fixing ON the fix date', () => {
    expect(isAutoAdvanced(item({ expectedResolutionAt: day(0) }), NOW)).toBe(true)
  })

  it('has moved once the date is behind it', () => {
    expect(isAutoAdvanced(item({ expectedResolutionAt: day(-5) }), NOW)).toBe(true)
  })

  /*
   * `spare_outsourced` is also reachable by hand from the stage buttons, and
   * that path carries no date. Silence is not a deadline: a job parked there
   * with nothing promised must sit until a person moves it.
   */
  it('never moves a job that named no date', () => {
    expect(isAutoAdvanced(item({ expectedResolutionAt: null }), NOW)).toBe(false)
  })
})

describe('what a date may never assert', () => {
  /*
   * The load-bearing negative. Advancing a signed-off job would walk a closed
   * one back onto the ladder — and Postgres forbids the result anyway
   * (resolved ⇒ stage IN (fixed, failed)), so this would put the API and the
   * database into disagreement about a row that is finished.
   */
  it('leaves a signed-off job alone, however old its fix date', () => {
    const closed = item({
      stage: 'fixed', resolvedAt: new Date('2026-09-14T00:00:00Z'),
      expectedResolutionAt: day(-30),
    })
    expect(isAutoAdvanced(closed, NOW)).toBe(false)
    expect(withEffectiveStage(closed, NOW).stage).toBe('fixed')
  })

  it('leaves an unsuccessful sign-off alone too', () => {
    const failed = item({
      stage: 'failed', resolvedAt: new Date('2026-09-14T00:00:00Z'),
      expectedResolutionAt: day(-30),
    })
    expect(withEffectiveStage(failed, NOW).stage).toBe('failed')
  })

  /*
   * An OPEN job at 'failed' is the `cannot_fix` seed — this technician could
   * not fix it and it waits for somebody with more kit. It is not "being
   * fixed", and a date must not claim otherwise.
   */
  it('does not drag an open failed job onto fixing', () => {
    expect(isAutoAdvanced(item({ stage: 'failed', expectedResolutionAt: day(-2) }), NOW)).toBe(false)
  })

  it('does not touch a job somebody already moved to fixing', () => {
    const f = item({ stage: AUTO_TO, expectedResolutionAt: day(-2) })
    expect(withEffectiveStage(f, NOW)).toBe(f)   // same object, untouched
  })
})

describe('what the tracking line is handed', () => {
  it('returns the row untouched when nothing is due', () => {
    const i = item({ expectedResolutionAt: day(5) })
    expect(withEffectiveStage(i, NOW)).toBe(i)
  })

  it('records the step so the rung is not drawn dateless', () => {
    const moved = withEffectiveStage(item({ expectedResolutionAt: day(-2) }), NOW)
    expect(moved.stage).toBe(AUTO_TO)

    const history = moved.stageHistory as Array<Record<string, unknown>>
    const last = history.at(-1)!
    expect(last['stage']).toBe(AUTO_TO)
    // The date the step HAPPENED is the fix date, not today — the job has been
    // under way since then, and "stuck for three weeks" is read off this.
    expect(last['at']).toBe(day(-2).toISOString())
    expect(moved.stageChangedAt).toEqual(day(-2))
  })

  /*
   * Nobody pressed anything, so the entry must not name a person. A history
   * row with a `by` on it is a claim that somebody took an action.
   */
  it('attributes the step to nobody, and marks it automatic', () => {
    const moved = withEffectiveStage(item({ expectedResolutionAt: day(-1) }), NOW)
    const last = (moved.stageHistory as Array<Record<string, unknown>>).at(-1)!
    expect(last['by']).toBeNull()
    expect(last['auto']).toBe(true)
  })

  it('keeps the earlier history rather than replacing it', () => {
    const moved = withEffectiveStage(item({ expectedResolutionAt: day(-1) }), NOW)
    const history = moved.stageHistory as Array<Record<string, unknown>>
    expect(history).toHaveLength(2)
    expect(history[0]!['stage']).toBe(AUTO_FROM)
  })

  it('maps a list without disturbing the ones that are not due', () => {
    const due    = item({ expectedResolutionAt: day(-1) })
    const notYet = item({ expectedResolutionAt: day(+1) })
    const [a, b] = withEffectiveStages([due, notYet], NOW)
    expect(a!.stage).toBe(AUTO_TO)
    expect(b).toBe(notYet)
  })
})

describe('the ?stage= filter follows what is displayed', () => {
  /*
   * Without translation the tab lies in both directions: "Fixing" would hide
   * the jobs that got there by date — the ones nobody was watching, which are
   * exactly the ones worth listing — and "Spare outsourced" would list jobs
   * the same screen is drawing as Fixing.
   */
  it('counts the date-advanced jobs as fixing', () => {
    const f = stageFilter(AUTO_TO, NOW) as { OR: Array<Record<string, unknown>> }
    expect(f['OR']).toHaveLength(2)
    expect(f['OR'][0]).toEqual({ stage: AUTO_TO })
    expect(f['OR'][1]).toMatchObject({ stage: AUTO_FROM, resolvedAt: null })
  })

  it('leaves them OUT of spare outsourced', () => {
    const f = stageFilter(AUTO_FROM, NOW) as Record<string, unknown>
    expect(f['stage']).toBe(AUTO_FROM)
    // Either no date at all, or one still ahead of today.
    expect(f['OR']).toEqual([
      { expectedResolutionAt: null },
      { expectedResolutionAt: { gt: new Date(Date.UTC(2026, 8, 16)) } },
    ])
  })

  it('passes every other stage straight through', () => {
    expect(stageFilter('fixed', NOW)).toEqual({ stage: 'fixed' })
    expect(stageFilter('failed', NOW)).toEqual({ stage: 'failed' })
    expect(stageFilter('pending', NOW)).toEqual({ stage: 'pending' })
  })
})
