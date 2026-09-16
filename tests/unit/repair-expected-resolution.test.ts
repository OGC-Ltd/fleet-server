/**
 * When a technician says the unit will be back, and what the API refuses.
 *
 * ## Why this field is validated at all, rather than just stored
 *
 * `needs_spare` is the one outcome that hands the job to somebody else and
 * then waits. Everything downstream of it — the Repairs tab's overdue sort,
 * the red pill on a slipped job, the line in the handlers' email — is built on
 * this date being both PRESENT and PLAUSIBLE. A missing one leaves a job that
 * cannot be chased; a mistyped one ("2036") leaves a job that will never look
 * overdue and so will never be chased either. The second failure is the
 * quieter of the two and is the reason the upper bound exists.
 *
 * The rules live in three places on purpose — this zod schema, a Postgres
 * CHECK, and the dashboard's own predicate. This file covers the zod half,
 * which is the one that produces a message naming the field.
 *
 * Dates here are built relative to `now` rather than hardcoded, because two of
 * the rules are "not in the past" and "not more than a year out" — a fixture
 * with a literal date in it passes until that date arrives and then fails for
 * a reason nobody will connect to this file.
 */

import { describe, it, expect } from 'vitest'
import { createRepairReportSchema } from '../../src/modules/repairs/repairs.schema.js'

/** `YYYY-MM-DD`, N days from today, in UTC — the frame the server stores in. */
const dayFromNow = (n: number): string =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

const item = (over: Record<string, unknown> = {}) => ({
  targetKind: 'probe',
  vehicleId:  'veh_0000000000000000000',
  outcome:    'needs_spare',
  sparePart:  'Gill LS-5 float sender',
  expectedResolutionAt: dayFromNow(14),
  ...over,
})

const parse = (over: Record<string, unknown> = {}) =>
  createRepairReportSchema.safeParse({ items: [item(over)] })

/** The field a failure was reported against — the whole point of validating here. */
const failedOn = (r: ReturnType<typeof parse>): string[] =>
  r.success ? [] : r.error.issues.map((i) => i.path.join('.'))

describe('a part on order must say when', () => {
  it('accepts a report that names the part and the date', () => {
    const r = parse()
    expect(r.success).toBe(true)
  })

  it('refuses needs_spare with no date, and names the field', () => {
    const r = parse({ expectedResolutionAt: undefined })
    expect(r.success).toBe(false)
    expect(failedOn(r)).toContain('items.0.expectedResolutionAt')
  })

  /*
   * The two outcomes that do NOT wait on anybody. Demanding a date from a
   * technician who fixed the unit on the spot would be the form inventing
   * work, and the CHECK constraint is deliberately silent about them too.
   */
  it('does not demand one from an outcome that is not waiting on a supplier', () => {
    expect(parse({ outcome: 'fixing', sparePart: undefined, expectedResolutionAt: undefined }).success).toBe(true)
    expect(parse({
      outcome: 'cannot_fix', sparePart: undefined, expectedResolutionAt: undefined,
      problemNote: 'Loom damaged behind the dash.',
    }).success).toBe(true)
  })

  /*
   * ...but it ALLOWS one there. A technician mid-repair who knows the job runs
   * to Thursday is telling the truth, and the contract is wider than the form
   * that currently feeds it. If this ever starts failing, something has
   * narrowed the API to match a UI decision, which is the wrong direction.
   */
  it('allows one on an outcome that did not have to give it', () => {
    const r = parse({ outcome: 'fixing', sparePart: undefined, expectedResolutionAt: dayFromNow(3) })
    expect(r.success).toBe(true)
  })
})

describe('the date has to be a date, and a possible one', () => {
  it('parses to midnight UTC, so no timezone can move it a day', () => {
    const r = createRepairReportSchema.safeParse({
      items: [item({ expectedResolutionAt: dayFromNow(30) })],
    })
    expect(r.success).toBe(true)
    const d = r.success ? r.data.items[0]!.expectedResolutionAt! : null
    expect(d?.toISOString()).toBe(`${dayFromNow(30)}T00:00:00.000Z`)
  })

  it('refuses a date that has already passed', () => {
    const r = parse({ expectedResolutionAt: dayFromNow(-1) })
    expect(r.success).toBe(false)
    expect(failedOn(r)).toContain('items.0.expectedResolutionAt')
  })

  /*
   * Today is NOT in the past. A part collected this afternoon is a real
   * answer, and rejecting it would push the technician to type tomorrow — a
   * date they do not mean, entered to get past a form.
   */
  it('accepts today', () => {
    expect(parse({ expectedResolutionAt: dayFromNow(0) }).success).toBe(true)
  })

  /*
   * The typo filter. A slipped digit in the year produces a job that is never
   * overdue and therefore never chased, which fails silently — the worst way
   * for this feature to fail.
   */
  it('refuses a date more than a year out', () => {
    const r = parse({ expectedResolutionAt: dayFromNow(400) })
    expect(r.success).toBe(false)
    expect(failedOn(r)).toContain('items.0.expectedResolutionAt')
  })

  it('accepts a long but believable wait', () => {
    expect(parse({ expectedResolutionAt: dayFromNow(120) }).success).toBe(true)
  })

  it('refuses text that is not a calendar day at all', () => {
    for (const bad of ['next Tuesday', '25/09/2026', '2026-9-5', '', '2026-09-25T10:00:00Z']) {
      expect(parse({ expectedResolutionAt: bad }).success, bad).toBe(false)
    }
  })

  /*
   * `2026-02-31` matches the shape and is not a day. Date's constructor rolls
   * it forward to 3 March rather than rejecting it, so the regex alone would
   * have stored a date the technician never chose.
   */
  it('refuses a well-shaped date that does not exist', () => {
    const r = parse({ expectedResolutionAt: '2026-02-31' })
    const rolled = r.success ? r.data.items[0]!.expectedResolutionAt!.toISOString().slice(0, 10) : null
    expect(rolled, 'February 31st was silently rolled into March').not.toBe('2026-03-03')
  })
})
