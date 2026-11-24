/**
 * The weighbridge window's `to`, as the analytics screen sends it.
 *
 * The screen hands every card one `to`; for a picked month that is noon on its
 * last day with the zone attached. This endpoint alone took only YYYY-MM-DD
 * and answered 400, so the weighbridge card went blank (2026-11-24).
 */
import { describe, it, expect } from 'vitest'
import { weighmentAnalyticsQuerySchema as schema } from '../../src/modules/weighments/weighment.schema.js'

describe('weighmentAnalyticsQuerySchema.to', () => {
  it('takes a bare fleet day as before', () => {
    expect(schema.parse({ to: '2026-10-31' }).to).toBe('2026-10-31')
  })

  it('files a zoned instant under the fleet day it falls in', () => {
    expect(schema.parse({ days: '31', to: '2026-10-31T12:00:00+03:00' })).toEqual({ days: 31, to: '2026-10-31' })
  })

  it('reads a UTC instant in Nairobi, not in UTC', () => {
    // 22:30 UTC on the 30th is 01:30 on the 31st in Ndhiwa.
    expect(schema.parse({ to: '2026-10-30T22:30:00Z' }).to).toBe('2026-10-31')
  })

  it('still refuses an instant with no zone, and junk', () => {
    expect(schema.safeParse({ to: '2026-10-31T12:00:00' }).success).toBe(false)
    expect(schema.safeParse({ to: 'yesterday' }).success).toBe(false)
  })

  it('leaves `to` out when it is not sent', () => {
    expect(schema.parse({}).to).toBeUndefined()
  })
})
