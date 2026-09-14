/**
 * The weighbridge window, and the one thing it must never say.
 *
 * The provider's feed serves a rolling two days and cannot be backfilled, so
 * the table holds only the days the ingest was running for — seven at the time
 * of writing, against an analytics screen whose default window is thirty. The
 * failure these exist to prevent is the easy one: emitting `tickets: 0` for the
 * twenty-three days nobody was listening on, and drawing a factory that stood
 * idle for three weeks.
 *
 * The repository is mocked. What is under test is what the service SAYS about
 * a set of tickets — captured versus quiet, a median that is not a mean, and
 * totals that do not double-count a lorry — none of which is a SELECT.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/modules/weighments/weighment.repository.js', () => ({
  findRange:         vi.fn(),
  findCapturedRange: vi.fn(),
}))

import { findRange, findCapturedRange } from '../../src/modules/weighments/weighment.repository.js'
import { getWeighmentAnalytics } from '../../src/modules/weighments/weighment.analytics.js'

const ORG = 'org_01'

/** A fleet day's instant, at a given hour — Africa/Nairobi is +03:00 flat. */
const at = (day: string, hhmm = '09:00') =>
  new Date(`${day}T${hhmm}:00.000+03:00`)

/** One ticket, with only what a test cares about spelled out. Both stamps are
 *  present by default, an hour apart, so a turnaround exists unless a test
 *  deliberately removes one. */
function ticket(day: string, over: Record<string, unknown> = {}): never {
  return {
    tokenAt:      at(day),
    centerCode:   101,
    centerName:   'FACTORY',
    vehiclePlate: 'KTCC849B',
    netWeightKg:  10_000,
    grossAt:      at(day, '09:00'),
    tareAt:       at(day, '10:00'),
    ...over,
  } as never
}

const feed = (rows: unknown[], captured: { first: Date; last: Date } | null) => {
  vi.mocked(findRange).mockResolvedValue(rows as never)
  vi.mocked(findCapturedRange).mockResolvedValue(captured as never)
}

const dayOf = (res: Awaited<ReturnType<typeof getWeighmentAnalytics>>, key: string) =>
  res.days.find((d) => d.day === key)!

beforeEach(() => vi.clearAllMocks())

describe('the window itself', () => {
  it('returns one point per day asked for, oldest first', async () => {
    feed([], null)
    const res = await getWeighmentAnalytics(ORG, { days: 5, to: '2026-09-13' })
    expect(res.days.map((d) => d.day)).toEqual([
      '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13',
    ])
    expect(res.from).toBe('2026-09-09')
    expect(res.to).toBe('2026-09-13')
  })

  it('reads the range as fleet days, not UTC ones', async () => {
    // A ticket at 01:30 local on the 10th is 22:30 UTC on the 9th. These
    // bridges open before dawn — the earliest measured is 00:02 — so a UTC
    // boundary would file the first three hours of every shift under
    // yesterday.
    feed([ticket('2026-09-10', { tokenAt: at('2026-09-10', '01:30') })],
         { first: at('2026-09-10'), last: at('2026-09-10') })
    const res = await getWeighmentAnalytics(ORG, { days: 3, to: '2026-09-10' })
    expect(dayOf(res, '2026-09-10').tickets).toBe(1)
    expect(dayOf(res, '2026-09-09').tickets).toBeNull()
  })
})

describe('a day we did not capture is not a day with no cane', () => {
  it('nulls every measure outside the captured span', async () => {
    feed([ticket('2026-09-12')],
         { first: at('2026-09-12'), last: at('2026-09-12') })
    const res = await getWeighmentAnalytics(ORG, { days: 4, to: '2026-09-13' })

    const dark = dayOf(res, '2026-09-10');
    expect(dark.captured).toBe(false)
    // Every one of them. A single zero slipping through draws a bar on the
    // axis, which is the exact lie this rule exists to stop.
    expect(dark.tickets).toBeNull()
    expect(dark.lorries).toBeNull()
    expect(dark.netKg).toBeNull()
    expect(dark.ticketsTimed).toBeNull()
    expect(dark.turnaroundP50Ms).toBeNull()
  })

  it('gives a captured day with no ticket a real zero', async () => {
    // Inside the span and genuinely quiet: the bridges were open, nothing
    // crossed them. That is a measurement, and it must not look like the gap
    // above.
    feed([ticket('2026-09-11'), ticket('2026-09-13')],
         { first: at('2026-09-11'), last: at('2026-09-13') })
    const res = await getWeighmentAnalytics(ORG, { days: 3, to: '2026-09-13' })

    const quiet = dayOf(res, '2026-09-12')
    expect(quiet.captured).toBe(true)
    expect(quiet.tickets).toBe(0)
    expect(quiet.netKg).toBe(0)
    // No ticket means no turnaround to take a middle of — blank, not zero.
    expect(quiet.turnaroundP50Ms).toBeNull()
  })

  it('says how much of the window it actually holds', async () => {
    feed([ticket('2026-09-12')],
         { first: at('2026-09-07'), last: at('2026-09-13') })
    const res = await getWeighmentAnalytics(ORG, { days: 30, to: '2026-09-13' })
    expect(res.capturedDays).toBe(7)
    expect(res.captured).toEqual({ first: '2026-09-07', last: '2026-09-13' })
  })

  it('holds nothing at all when no ticket has ever arrived', async () => {
    feed([], null)
    const res = await getWeighmentAnalytics(ORG, { days: 7, to: '2026-09-13' })
    expect(res.captured).toBeNull()
    expect(res.capturedDays).toBe(0)
    expect(res.days.every((d) => d.captured === false)).toBe(true)
    expect(res.totals.tickets).toBe(0)
  })
})

describe('turnaround', () => {
  const span = { first: at('2026-09-13'), last: at('2026-09-13') }

  it('takes the middle lorry, not the average one', async () => {
    // Four quick crossings and one lorry that sat all shift. The mean is
    // 2h 24m and describes nobody; the median is one hour, which is four of
    // the five.
    feed([
      ticket('2026-09-13', { grossAt: at('2026-09-13', '06:00'), tareAt: at('2026-09-13', '07:00') }),
      ticket('2026-09-13', { grossAt: at('2026-09-13', '07:00'), tareAt: at('2026-09-13', '08:00') }),
      ticket('2026-09-13', { grossAt: at('2026-09-13', '08:00'), tareAt: at('2026-09-13', '09:00') }),
      ticket('2026-09-13', { grossAt: at('2026-09-13', '09:00'), tareAt: at('2026-09-13', '10:00') }),
      ticket('2026-09-13', { grossAt: at('2026-09-13', '06:00'), tareAt: at('2026-09-13', '15:00') }),
    ], span)
    const res = await getWeighmentAnalytics(ORG, { days: 1, to: '2026-09-13' })
    expect(dayOf(res, '2026-09-13').turnaroundP50Ms).toBe(3_600_000)
    // And the tail is carried beside it, because the tail is the thing worth
    // fixing and a middle on its own hides it.
    expect(dayOf(res, '2026-09-13').turnaroundP90Ms).toBe(9 * 3_600_000)
  })

  it('reads a lorry weighed loaded-first as a wait, not a negative one', async () => {
    // A minority of this fleet weighs the other way round — 14 of 729 on the
    // day measured. A subtraction written one way round reports those as
    // negative hours.
    feed([ticket('2026-09-13', {
      grossAt: at('2026-09-13', '10:00'), tareAt: at('2026-09-13', '09:00'),
    })], span)
    const res = await getWeighmentAnalytics(ORG, { days: 1, to: '2026-09-13' })
    expect(dayOf(res, '2026-09-13').turnaroundP50Ms).toBe(3_600_000)
  })

  it('stands only on the tickets that carry both stamps, and says how many', async () => {
    // A lorry still on the scale has one stamp. Counting it as a zero-minute
    // turnaround would report an instant crossing that never happened.
    feed([
      ticket('2026-09-13'),
      ticket('2026-09-13', { tareAt: null }),
      ticket('2026-09-13', { grossAt: null }),
    ], span)
    const res = await getWeighmentAnalytics(ORG, { days: 1, to: '2026-09-13' })
    const d = dayOf(res, '2026-09-13')
    expect(d.tickets).toBe(3)
    expect(d.ticketsTimed).toBe(1)
    expect(d.turnaroundP50Ms).toBe(3_600_000)
  })
})

describe('weight and lorries', () => {
  const span = { first: at('2026-09-12'), last: at('2026-09-13') }

  it('skips an unweighed leg rather than counting it as nothing', async () => {
    // `netWeightKg` is null on a transfer's first leg — weighed in, not yet
    // out. A zero would drag the day's tonnage down by however many lorries
    // were mid-transfer when the window closed.
    feed([
      ticket('2026-09-13', { netWeightKg: 12_000 }),
      ticket('2026-09-13', { netWeightKg: null }),
    ], span)
    const res = await getWeighmentAnalytics(ORG, { days: 1, to: '2026-09-13' })
    const d = dayOf(res, '2026-09-13')
    expect(d.netKg).toBe(12_000)
    expect(d.tickets).toBe(2)
  })

  it('counts a lorry once over the window and once per day it worked', async () => {
    // The two figures disagree on purpose, and summing the day column to get
    // the window's would be the bug: one machine crossed on both days.
    feed([
      ticket('2026-09-12', { vehiclePlate: 'KTCC849B' }),
      ticket('2026-09-13', { vehiclePlate: 'KTCC849B' }),
      ticket('2026-09-13', { vehiclePlate: 'KBZ123A' }),
    ], span)
    const res = await getWeighmentAnalytics(ORG, { days: 2, to: '2026-09-13' })
    expect(dayOf(res, '2026-09-12').lorries).toBe(1)
    expect(dayOf(res, '2026-09-13').lorries).toBe(2)
    expect(res.totals.lorries).toBe(2)
  })

  it('averages over the days that worked, never over the window', async () => {
    feed([ticket('2026-09-13')], { first: at('2026-09-07'), last: at('2026-09-13') })
    const res = await getWeighmentAnalytics(ORG, { days: 30, to: '2026-09-13' })
    // One day ran. Not 30, and not the 7 we captured.
    expect(res.totals.activeDays).toBe(1)
  })

  it('names the heaviest day with the weight it rests on', async () => {
    feed([
      ticket('2026-09-12', { netWeightKg: 5_000 }),
      ticket('2026-09-13', { netWeightKg: 9_000 }),
    ], span)
    const res = await getWeighmentAnalytics(ORG, { days: 2, to: '2026-09-13' })
    expect(res.totals.heaviestDay).toEqual({ day: '2026-09-13', netKg: 9_000 })
  })
})

describe('the bridges', () => {
  const span = { first: at('2026-09-12'), last: at('2026-09-13') }

  it('breaks the window down by centre, heaviest first', async () => {
    feed([
      ticket('2026-09-13', { centerCode: 102, centerName: 'OPAPO', netWeightKg: 3_000 }),
      ticket('2026-09-13', { centerCode: 101, centerName: 'FACTORY', netWeightKg: 8_000 }),
    ], span)
    const res = await getWeighmentAnalytics(ORG, { days: 2, to: '2026-09-13' })
    expect(res.centres.map((c) => c.code)).toEqual([101, 102])
    expect(res.centres[0]!.netKg).toBe(8_000)
  })

  it('counts the days a bridge actually raised a ticket', async () => {
    // Two bridges, the same tonnage, one working day against two. The weight
    // alone cannot tell those apart and an operator needs to.
    feed([
      ticket('2026-09-12', { centerCode: 101, netWeightKg: 4_000 }),
      ticket('2026-09-13', { centerCode: 101, netWeightKg: 4_000 }),
      ticket('2026-09-13', { centerCode: 103, centerName: 'OYANI', netWeightKg: 8_000 }),
    ], span)
    const res = await getWeighmentAnalytics(ORG, { days: 2, to: '2026-09-13' })
    expect(res.centres.find((c) => c.code === 101)!.activeDays).toBe(2)
    expect(res.centres.find((c) => c.code === 103)!.activeDays).toBe(1)
  })

  it('takes the newest spelling when a centre has been renamed', async () => {
    feed([
      ticket('2026-09-12', { centerCode: 104, centerName: 'NYAONDO' }),
      ticket('2026-09-13', { centerCode: 104, centerName: 'NYAONDO WB' }),
    ], span)
    const res = await getWeighmentAnalytics(ORG, { days: 2, to: '2026-09-13' })
    expect(res.centres).toHaveLength(1)
    expect(res.centres[0]!.name).toBe('NYAONDO WB')
  })

  it('narrows what is counted when one bridge is asked for', async () => {
    feed([
      ticket('2026-09-13', { centerCode: 101, netWeightKg: 8_000 }),
      ticket('2026-09-13', { centerCode: 102, centerName: 'OPAPO', netWeightKg: 3_000 }),
    ], span)
    const res = await getWeighmentAnalytics(ORG, { days: 2, to: '2026-09-13', centre: 102 })
    expect(res.centre).toBe(102)
    expect(res.totals.netKg).toBe(3_000)
    expect(dayOf(res, '2026-09-13').netKg).toBe(3_000)
    // One bridge asked for, one bridge described — not one bridge's days
    // beside every bridge's totals.
    expect(res.centres.map((c) => c.code)).toEqual([102])
  })
})
