/**
 * Repeat incidents on one unit.
 *
 * The operator asked to be told when a machine is flagged more than once, with
 * the count, the volumes and the running total. Two things are pinned here: the
 * arithmetic, and the vocabulary — a repeat is the loudest line the feed
 * produces, and it is exactly where "theft" would slip in on evidence that
 * cannot carry it.
 */

import { describe, it, expect } from 'vitest'
import { repeatClause, type IncidentHistory } from '../../src/modules/fuel/fuel-adjudication.service.js'

const history = (over: Partial<IncidentHistory> = {}): IncidentHistory => ({
  priorCount: 0, totalCount: 1, totalMl: 20_000, recentMl: [], siphonCount: 0, ...over,
})

describe('repeatClause', () => {
  it('says nothing on a first event', () => {
    // Six of the eleven flagged vehicles measured. "1st flagged event" teaches
    // the reader nothing and trains them to skip the tail of the line.
    expect(repeatClause(history(), false)).toBe('')
  })

  it('counts the unit, totals the volume, and quotes the earlier ones', () => {
    // Production, KCX 802S: six flagged events for 417.7 L inside 32 hours.
    const clause = repeatClause(history({
      priorCount: 5, totalCount: 6, totalMl: 417_700,
      recentMl: [122_800, 112_500, 92_700],
    }), false)
    expect(clause).toContain('6th flagged event on this unit in 30 days')
    expect(clause).toContain('417.7 L in total')
    expect(clause).toContain('before this: 122.8 L, 112.5 L, 92.7 L')
  })

  it('will not call a mixed record theft', () => {
    // The rule that has held since the LOSS verdict was removed. One siphon
    // among five rate findings does not make the total theft — that would rest
    // the strongest claim in the sentence on the weakest evidence in it.
    const mixed = history({ priorCount: 5, totalCount: 6, totalMl: 417_700, siphonCount: 1 })
    const clause = repeatClause(mixed, mixed.siphonCount === mixed.totalCount)
    expect(clause).toContain('flagged event')
    expect(clause).not.toMatch(/theft|stolen|loss|suspicious/i)
  })

  it('says possible theft only when every counted event was a siphon', () => {
    const all = history({ priorCount: 2, totalCount: 3, totalMl: 88_000, siphonCount: 3 })
    const clause = repeatClause(all, all.siphonCount === all.totalCount)
    expect(clause).toContain('3rd possible theft on this unit in 30 days')
    // Still qualified, never asserted.
    expect(clause).not.toMatch(/\bstolen\b|\btheft occurred\b/i)
  })

  it('uses the right ordinal past the teens', () => {
    expect(repeatClause(history({ totalCount: 2,  totalMl: 1_000 }), false)).toContain('2nd')
    expect(repeatClause(history({ totalCount: 3,  totalMl: 1_000 }), false)).toContain('3rd')
    expect(repeatClause(history({ totalCount: 11, totalMl: 1_000 }), false)).toContain('11th')
    expect(repeatClause(history({ totalCount: 21, totalMl: 1_000 }), false)).toContain('21st')
  })
})
