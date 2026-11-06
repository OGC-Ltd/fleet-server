import { describe, expect, it } from 'vitest'
import { userLoginReportQuerySchema } from '../../src/modules/users/user.schema.js'

describe('user login report query', () => {
  it('accepts a valid inclusive date range and applies pagination defaults', () => {
    expect(userLoginReportQuerySchema.parse({ from: '2026-10-01', to: '2026-10-07' })).toEqual({
      from: '2026-10-01',
      to: '2026-10-07',
      page: 1,
      limit: 50,
    })
  })

  it('rejects invalid calendar dates and reversed ranges', () => {
    expect(userLoginReportQuerySchema.safeParse({ from: '2026-02-30', to: '2026-03-01' }).success).toBe(false)
    expect(userLoginReportQuerySchema.safeParse({ from: '2026-10-08', to: '2026-10-07' }).success).toBe(false)
  })

  it('rejects dates after the current Nairobi day', () => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date())
    const today = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
    const next = new Date(`${today.year}-${today.month}-${today.day}T00:00:00Z`)
    next.setUTCDate(next.getUTCDate() + 1)
    const tomorrow = next.toISOString().slice(0, 10)
    expect(userLoginReportQuerySchema.safeParse({ from: tomorrow, to: tomorrow }).success).toBe(false)
  })
})
