import { describe, expect, it } from 'vitest'
import { GRAMMAR_RULES, tidyProse } from '../../src/lib/prose-grammar.js'

describe('tidyProse', () => {
  it('fixes spacing, sentence capitals and the final full stop', () => {
    expect(tidyProse('  the fleet is working steadily ,with 96 units online.most are in transit  '))
      .toBe('The fleet is working steadily, with 96 units online. Most are in transit.')
  })

  it('never splits times, decimals or names with digits in them', () => {
    const s = 'KTCB 295U flagged a fuel drain of 12.5 L at 09:12 on FARM#212.'
    expect(tidyProse(s)).toBe(s)
  })

  it('collapses doubled punctuation but keeps an ellipsis', () => {
    expect(tidyProse('3 units are out,, and 1 is back..')).toBe('3 units are out, and 1 is back.')
    expect(tidyProse('Still waiting...')).toBe('Still waiting...')
  })

  it('leaves abbreviations alone', () => {
    expect(tidyProse('Several areas, e.g. three farms, are busy.')).toBe('Several areas, e.g. three farms, are busy.')
  })

  it('does not change any word or figure', () => {
    const s = 'There is 1 fuel issue raised, none of which need investigating, and 3 overspeeding alerts.'
    expect(tidyProse(s)).toBe(s)
  })

  it('handles empty input', () => {
    expect(tidyProse('')).toBe('')
  })
})

describe('GRAMMAR_RULES', () => {
  it('tells the model to proofread without touching figures or names', () => {
    expect(GRAMMAR_RULES).toMatch(/proofread msg/)
    expect(GRAMMAR_RULES).toMatch(/NEVER change a figure/)
  })
})
