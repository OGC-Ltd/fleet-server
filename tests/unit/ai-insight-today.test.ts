/**
 * The shift facts behind the Fleet AI Insight card.
 *
 * These are the numbers the brief now leads with, so the two distinctions the
 * aggregation exists to preserve are the ones worth pinning:
 *
 *   - dispatched ≠ left the gate. Paperwork raised is not a truck on the road,
 *     and on this fleet the gap is routinely hours.
 *   - raised ≠ needs investigating. Only a LOSS verdict is a confirmed loss;
 *     PENDING is still settling and REDISTRIBUTION has been disproved.
 *
 * Collapsing either pair is what would put an inflated number in front of the
 * fleet manager, which is the whole thing the card is judged on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')

import { prismaMock } from '../helpers/prisma.mock.js'
import { collectToday } from '../../src/modules/dashboard/ai-insight.js'

const dispatch = (id: string, destination: string | null, returned = false) => ({
  id, destination, actualReturnAt: returned ? new Date() : null,
})
const theft = (verdict: string, stolenMl: number) => ({ verdict, stolenMl })

describe('collectToday', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-08-05T06:24:00Z'))   // 09:24 EAT — a morning
  })

  it('splits the morning\'s gate departures by destination', async () => {
    // 70 runs raised: 20 to X, 50 to Y. Every one of them seen leaving.
    const dispatches = [
      ...Array.from({ length: 20 }, (_, i) => dispatch(`x${i}`, 'WEIGHBRIDGE X')),
      ...Array.from({ length: 50 }, (_, i) => dispatch(`y${i}`, 'WEIGHBRIDGE Y')),
    ]
    prismaMock.dispatch.findMany.mockResolvedValue(dispatches as never)
    prismaMock.fuelTheft.findMany.mockResolvedValue([] as never)
    prismaMock.notification.findMany.mockResolvedValue(
      dispatches.map(d => ({ feedId: `yd-${d.id}` })) as never,
    )

    const today = await collectToday('org-1')

    expect(today.dispatchesRaised).toBe(70)
    expect(today.leftGate).toBe(70)
    expect(today.stillInYard).toBe(0)
    expect(today.sinceLabel).toBe('this morning')
    expect(today.byDestination).toEqual([
      { destination: 'WEIGHBRIDGE Y', dispatched: 50, leftGate: 50 },
      { destination: 'WEIGHBRIDGE X', dispatched: 20, leftGate: 20 },
    ])
  })

  it('does not count paperwork as a truck through the gate', async () => {
    const dispatches = [dispatch('a', 'OPAPO'), dispatch('b', 'OPAPO'), dispatch('c', 'OPAPO')]
    prismaMock.dispatch.findMany.mockResolvedValue(dispatches as never)
    prismaMock.fuelTheft.findMany.mockResolvedValue([] as never)
    // Only one was actually seen clearing the barrier.
    prismaMock.notification.findMany.mockResolvedValue([{ feedId: 'yd-a' }] as never)

    const today = await collectToday('org-1')

    expect(today.dispatchesRaised).toBe(3)
    expect(today.leftGate).toBe(1)
    expect(today.stillInYard).toBe(2)
    expect(today.byDestination).toEqual([{ destination: 'OPAPO', dispatched: 3, leftGate: 1 }])
  })

  it('groups destinations the dispatchers typed inconsistently, and counts the unnamed apart', async () => {
    prismaMock.dispatch.findMany.mockResolvedValue([
      dispatch('a', 'Weighbridge X'), dispatch('b', '  WEIGHBRIDGE X '),
      dispatch('c', null), dispatch('d', '   '),
    ] as never)
    prismaMock.fuelTheft.findMany.mockResolvedValue([] as never)
    prismaMock.notification.findMany.mockResolvedValue([] as never)

    const today = await collectToday('org-1')

    expect(today.byDestination).toEqual([
      { destination: 'WEIGHBRIDGE X', dispatched: 2, leftGate: 0 },
    ])
    expect(today.destinationNotRecorded).toBe(2)
  })

  it('counts only confirmed losses as needing investigation', async () => {
    prismaMock.dispatch.findMany.mockResolvedValue([] as never)
    prismaMock.notification.findMany.mockResolvedValue([] as never)
    // 19 raised: 5 real, 9 still settling, 4 disproved, 1 unmeasurable.
    prismaMock.fuelTheft.findMany.mockResolvedValue([
      ...Array.from({ length: 5 }, () => theft('LOSS', 20_000)),
      ...Array.from({ length: 9 }, () => theft('PENDING', 5_000)),
      ...Array.from({ length: 4 }, () => theft('REDISTRIBUTION', 30_000)),
      theft('UNVERIFIED', 1_000),
    ] as never)

    const today = await collectToday('org-1')

    expect(today.fuelIssues).toEqual({
      raised: 19,
      needInvestigating: 5,
      stillSettling: 9,
      ruledOut: 4,
      unverifiable: 1,
      // Only the confirmed ones — 5 × 20 L. Redistribution volume never counts.
      litresConfirmedLost: 100,
    })
  })

  it('says "so far today" once the morning is over', async () => {
    vi.setSystemTime(new Date('2026-08-05T12:10:00Z'))   // 15:10 EAT
    prismaMock.dispatch.findMany.mockResolvedValue([] as never)
    prismaMock.fuelTheft.findMany.mockResolvedValue([] as never)
    prismaMock.notification.findMany.mockResolvedValue([] as never)

    expect((await collectToday('org-1')).sinceLabel).toBe('so far today')
  })

  it('asks for no departures at all when nothing was dispatched', async () => {
    prismaMock.dispatch.findMany.mockResolvedValue([] as never)
    prismaMock.fuelTheft.findMany.mockResolvedValue([] as never)

    const today = await collectToday('org-1')

    expect(prismaMock.notification.findMany).not.toHaveBeenCalled()
    expect(today.leftGate).toBe(0)
    expect(today.stillInYard).toBe(0)
  })

  it('flags a shift with nothing in it as quiet, so the brief can skip the zeroes', async () => {
    // 00:40 local: the fleet day rolled over forty minutes ago and nothing has
    // happened in it. Reported as one flag, not four zeros to be narrated.
    prismaMock.dispatch.findMany.mockResolvedValue([] as never)
    prismaMock.fuelTheft.findMany.mockResolvedValue([] as never)

    expect((await collectToday('org-1')).quiet).toBe(true)
  })

  it('is not quiet when either side has something in it', async () => {
    prismaMock.dispatch.findMany.mockResolvedValue([dispatch('a', 'OPAPO')] as never)
    prismaMock.fuelTheft.findMany.mockResolvedValue([] as never)
    prismaMock.notification.findMany.mockResolvedValue([] as never)
    expect((await collectToday('org-1')).quiet).toBe(false)

    // Nothing dispatched, but a drain was flagged — still worth a briefing.
    prismaMock.dispatch.findMany.mockResolvedValue([] as never)
    prismaMock.fuelTheft.findMany.mockResolvedValue([theft('LOSS', 10_000)] as never)
    expect((await collectToday('org-1')).quiet).toBe(false)
  })
})
