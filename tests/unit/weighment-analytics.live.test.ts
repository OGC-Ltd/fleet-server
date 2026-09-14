/**
 * The window, run over the tickets production actually holds.
 *
 * The sibling test pins the RULES with three-row fixtures. This one runs the
 * same aggregation over every ticket in the live table (1,482 of them, pulled
 * read-only on 2026-09-14) and asserts the shape of the answer against figures
 * measured independently in SQL on the box:
 *
 *     day         tickets  lorries   net t  centres
 *     2026-09-08      415      329    4017        4
 *     2026-09-09      463      333    4529        4
 *     2026-09-10      415      311    3819        4
 *     2026-09-11      107       86    1238        4
 *     2026-09-12       55       41     495        3
 *     2026-09-13       27       25     232        1
 *
 * Six fleet days, and the boundary is the reason it is six rather than seven.
 * `token_at` is UTC and a fleet day is UTC+03:00, so the first ticket we hold —
 * 21:02 UTC on the 7th — is 00:02 on the 8th at the bridge, which is the 00:02
 * opening the schema already documents. Grouping the other way round invents a
 * seventh day out of the last three hours of the 7th. This test caught exactly
 * that, in the SQL rather than in the service.
 *
 * The point is not to re-test the rules. It is that a 30-day window over this
 * table is six days of data and twenty-four of nothing, and the endpoint has to
 * say so rather than draw three idle weeks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/modules/weighments/weighment.repository.js', () => ({
  findRange:         vi.fn(),
  findCapturedRange: vi.fn(),
}))

import { findRange, findCapturedRange } from '../../src/modules/weighments/weighment.repository.js'
import { getWeighmentAnalytics } from '../../src/modules/weighments/weighment.analytics.js'
import raw from '../fixtures/weighment-window.json' with { type: 'json' }

/** The fixture is JSON, so its timestamps are strings; the repository hands
 *  the service Date objects. Revived here rather than in the service, because
 *  the service must keep taking what Prisma gives it. */
const rows = (raw as Record<string, unknown>[]).map((r) => ({
  ...r,
  tokenAt: new Date(r.tokenAt as string),
  grossAt: r.grossAt ? new Date(r.grossAt as string) : null,
  tareAt:  r.tareAt  ? new Date(r.tareAt  as string) : null,
}))

const ORG = 'org_01'

beforeEach(() => {
  vi.mocked(findRange).mockResolvedValue(rows as never)
  vi.mocked(findCapturedRange).mockResolvedValue({
    first: rows[0]!.tokenAt,
    last:  rows[rows.length - 1]!.tokenAt,
  } as never)
})

const EXPECTED = [
  { day: '2026-09-08', tickets: 415, lorries: 329, netT: 4017 },
  { day: '2026-09-09', tickets: 463, lorries: 333, netT: 4529 },
  { day: '2026-09-10', tickets: 415, lorries: 311, netT: 3819 },
  { day: '2026-09-11', tickets: 107, lorries:  86, netT: 1238 },
  { day: '2026-09-12', tickets:  55, lorries:  41, netT:  495 },
  { day: '2026-09-13', tickets:  27, lorries:  25, netT:  232 },
]

describe('over the live table', () => {
  it('agrees with the database, day for day', async () => {
    const res = await getWeighmentAnalytics(ORG, { days: 7, to: '2026-09-13' })
    // The 7th falls OUTSIDE the captured span, not inside it as a quiet day:
    // the span's first day is the fleet day of the first ticket, and that
    // ticket's fleet day is the 8th. So the 7th is a gap, and carries nulls.
    expect(res.days.find((d) => d.day === '2026-09-07')!.captured).toBe(false)
    expect(res.days.find((d) => d.day === '2026-09-07')!.tickets).toBeNull()
    for (const want of EXPECTED) {
      const got = res.days.find((d) => d.day === want.day)!
      expect(got.captured, want.day).toBe(true)
      expect(got.tickets, want.day).toBe(want.tickets)
      expect(got.lorries, want.day).toBe(want.lorries)
      expect(Math.round((got.netKg ?? 0) / 1000), want.day).toBe(want.netT)
    }
  })

  it('holds 6 of a 30-day window and does not pretend otherwise', async () => {
    const res = await getWeighmentAnalytics(ORG, { days: 30, to: '2026-09-13' })
    expect(res.days).toHaveLength(30)
    expect(res.capturedDays).toBe(6)
    expect(res.captured).toEqual({ first: '2026-09-08', last: '2026-09-13' })
    // The other 24 carry nulls. If this ever becomes 0, the card starts
    // drawing most of a month of an idle factory.
    const dark = res.days.filter((d) => !d.captured)
    expect(dark).toHaveLength(24)
    expect(dark.every((d) => d.tickets === null && d.netKg === null)).toBe(true)
    // Every captured day worked; there is no quiet day inside this span.
    expect(res.totals.activeDays).toBe(6)
  })

  it('counts a lorry once across the week', async () => {
    const res = await getWeighmentAnalytics(ORG, { days: 7, to: '2026-09-13' })
    const summed = EXPECTED.reduce((s, d) => s + d.lorries, 0)
    // 1,125 lorry-days against far fewer machines: the same contractors come
    // back. Summing the day column to get a fleet size is the bug this proves
    // the totals do not have.
    expect(summed).toBe(1_125)
    expect(res.totals.lorries).toBeLessThan(summed)
    expect(res.totals.tickets).toBe(rows.length)
  })

  it('reports a turnaround that a lorry could actually have had', async () => {
    const res = await getWeighmentAnalytics(ORG, { days: 7, to: '2026-09-13' })
    const p50 = res.totals.turnaroundP50Ms!
    const p90 = res.totals.turnaroundP90Ms!
    expect(p50).toBeGreaterThan(0)
    expect(p90).toBeGreaterThanOrEqual(p50)
    // A sanity floor and ceiling rather than a fixed number: this is measured
    // data and it will move. Anything outside a minute-to-a-day band means the
    // stamps are being subtracted wrongly, not that the fleet got slower.
    expect(p50).toBeGreaterThan(60_000)
    expect(p50).toBeLessThan(86_400_000)
    expect(res.totals.ticketsTimed).toBeLessThanOrEqual(res.totals.tickets)
  })

  it('finds the four bridges and puts the factory at the top', async () => {
    const res = await getWeighmentAnalytics(ORG, { days: 7, to: '2026-09-13' })
    expect(res.centres.length).toBe(4)
    expect(res.centres.map((c) => c.code).sort()).toEqual([101, 102, 103, 104])
    // Sorted heaviest first, and every bridge's activeDays is inside the week.
    for (const c of res.centres) {
      expect(c.activeDays).toBeGreaterThan(0)
      expect(c.activeDays).toBeLessThanOrEqual(6)
    }
    expect(res.centres[0]!.netKg).toBeGreaterThanOrEqual(res.centres[3]!.netKg)
  })
})
