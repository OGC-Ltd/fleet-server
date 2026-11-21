import { describe, expect, it } from 'vitest'
import { expectedBackSchema } from '../../src/modules/repairs/repairs.workflow.schema.js'

describe('expectedBackSchema (when a unit is supposed to be back)', () => {
  it('takes a calendar day as UTC midnight', () => {
    const v = expectedBackSchema.parse({ expectedBack: '2026-11-24' })
    expect(v.expectedBack?.toISOString()).toBe('2026-11-24T00:00:00.000Z')
  })
  it('clears with null', () => expect(expectedBackSchema.parse({ expectedBack: null }).expectedBack).toBeNull())
  it('refuses a day that does not exist, or words', () => {
    expect(expectedBackSchema.safeParse({ expectedBack: '2026-02-31' }).success).toBe(false)
    expect(expectedBackSchema.safeParse({ expectedBack: 'next Tuesday' }).success).toBe(false)
  })
})
