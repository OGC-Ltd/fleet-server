/**
 * The shift facts behind the Fleet AI Insight card.
 *
 * Four distinctions the aggregation exists to preserve, each one a number that
 * was wrong on the card before it was pinned here:
 *
 *   - dispatched ≠ left the gate. Paperwork raised is not a truck on the road.
 *   - "left the gate today" is keyed on the CROSSING, not on when the run was
 *     raised. This fleet dispatches through the night, so a unit clearing the
 *     barrier at 00:14 against yesterday's paperwork is today's departure — and
 *     keying it the other way reported it as no departure at all.
 *   - out now excludes CANCELLED. Measured on SUKARI, 47 of 114 dispatches with
 *     no return time were cancelled runs; counting them overstated the fleet on
 *     the road by 70%.
 *   - raised ≠ needs investigating. Only a DRAIN our own telemetry confirmed
 *     is worth sending somebody out on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')

import { prismaMock } from '../helpers/prisma.mock.js'
import { collectToday } from '../../src/modules/dashboard/ai-insight.js'

/** A run raised today, as the `dispatchedAt` query returns it. */
const raised = (id: string, destination: string | null) => ({ id, destination, actualReturnAt: null })
/** A run open right now, as the `actualReturnAt: null` query returns it. */
const openRun = (destination: string | null, status = 'DISPATCHED') => ({ destination, status })
const theft = (verdict: string, stolenMl: number, verdictReason: string | null = null) =>
  ({ verdict, stolenMl, verdictReason })

interface DispatchArgs { where?: { dispatchedAt?: unknown; actualReturnAt?: unknown; id?: unknown } }
interface NotifArgs { where?: { feedId?: unknown } }

/**
 * `dispatch.findMany` now answers three different questions and
 * `notification.findMany` two, so both mocks route on the WHERE clause rather
 * than on call order — which would silently swap the answers if the query order
 * in collectToday ever changed.
 */
function mockDispatches(opts: {
  raisedToday?: Array<{ id: string; destination: string | null; actualReturnAt: null }>
  openRuns?: Array<{ destination: string | null; status: string }>
  departedRuns?: Array<{ destination: string | null }>
}) {
  ;(prismaMock.dispatch.findMany as unknown as {
    mockImplementation: (fn: (a: DispatchArgs) => Promise<unknown>) => void
  }).mockImplementation((args) => {
    if (args?.where?.id)                    return Promise.resolve(opts.departedRuns ?? [])
    if (args?.where?.actualReturnAt === null) return Promise.resolve(opts.openRuns ?? [])
    return Promise.resolve(opts.raisedToday ?? [])
  })
}

/** Gate crossings seen today, by feed id. */
function mockGateCrossings(feedIds: string[]) {
  ;(prismaMock.notification.findMany as unknown as {
    mockImplementation: (fn: (a: NotifArgs) => Promise<unknown>) => void
  }).mockImplementation((args) =>
    Promise.resolve(args?.where?.feedId ? feedIds.map(feedId => ({ feedId })) : []),
  )
}

function mockFeedKinds(rows: Array<{ alertType: string; _count: { _all: number } }>) {
  ;(prismaMock.notification.groupBy as unknown as {
    mockResolvedValue: (v: unknown) => void
  }).mockResolvedValue(rows)
}

describe('collectToday', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-08-05T06:24:00Z'))   // 09:24 EAT — a morning
    mockFeedKinds([])
    prismaMock.vehicleAlert.count.mockResolvedValue(0 as never)
    prismaMock.dispatch.count.mockResolvedValue(0 as never)   // returned today
    prismaMock.fuelTheft.findMany.mockResolvedValue([] as never)
    mockDispatches({})
    mockGateCrossings([])
  })

  it('splits the morning\'s gate departures by destination', async () => {
    const departed = [
      ...Array.from({ length: 20 }, () => ({ destination: 'WEIGHBRIDGE X' })),
      ...Array.from({ length: 50 }, () => ({ destination: 'WEIGHBRIDGE Y' })),
    ]
    mockDispatches({
      raisedToday: Array.from({ length: 74 }, (_, i) => raised(`d${i}`, 'WEIGHBRIDGE Y')),
      departedRuns: departed,
    })
    mockGateCrossings(departed.map((_, i) => `yd-d${i}`))

    const today = await collectToday('org-1')

    expect(today.dispatchesRaised).toBe(74)
    expect(today.leftGate).toBe(70)
    expect(today.stillInYard).toBe(4)
    expect(today.sinceLabel).toBe('this morning')
    expect(today.byDestination).toEqual([
      { destination: 'Weighbridge Y', units: 50 },
      { destination: 'Weighbridge X', units: 20 },
    ])
  })

  it('counts a crossing made today against paperwork raised yesterday', async () => {
    // The 00:14 departure that the old keying reported as nothing at all: no
    // run was raised today, yet a unit demonstrably left the gate.
    mockDispatches({ raisedToday: [], departedRuns: [{ destination: 'OPAPO' }] })
    mockGateCrossings(['yd-yesterday-1'])

    const today = await collectToday('org-1')

    expect(today.dispatchesRaised).toBe(0)
    expect(today.leftGate).toBe(1)
    expect(today.byDestination).toEqual([{ destination: 'Opapo', units: 1 }])
    expect(today.quiet).toBe(false)
  })

  it('excludes cancelled paperwork from the units it says are out', async () => {
    mockDispatches({
      openRuns: [
        ...Array.from({ length: 43 }, () => openRun('NYAONDO', 'DISPATCHED')),
        ...Array.from({ length: 24 }, () => openRun('OPAPO', 'OVERDUE')),
      ],
    })

    const today = await collectToday('org-1')

    // 43 + 24 — the 47 CANCELLED rows never reach this query.
    expect(today.outNow).toBe(67)
    expect(today.outNowOverdue).toBe(24)
    expect(today.outNowByDestination).toEqual([
      { destination: 'Nyaondo', units: 43 },
      { destination: 'Opapo',   units: 24 },
    ])
  })

  it('bounds "out now" to runs released today, as the factory board does', async () => {
    // The correction. Unbounded, this counted every run the provider had ever
    // left open: 193 on 2026-08-05 against 142 on the factory's own screen.
    // The query must carry the fleet-day floor, or the tail creeps back.
    mockDispatches({ openRuns: Array.from({ length: 139 }, () => openRun('OPAPO')) })

    const today = await collectToday('org-1')

    expect(today.outNow).toBe(139)
    const open = (prismaMock.dispatch.findMany.mock.calls as unknown as Array<[DispatchArgs]>)
      .map(c => c[0]).find(a => a?.where?.actualReturnAt === null)!
    expect(open.where).toMatchObject({ dispatchedAt: { gte: expect.any(Date) } })
  })

  it('keeps stale open paperwork out of the headline, but still reports it', async () => {
    // Runs open from earlier days are what the provider forgot to close — 31 of
    // them that day, six older than a week. They must not inflate `outNow`, and
    // they must not vanish either: the gap is how the drift gets noticed.
    prismaMock.dispatch.count.mockResolvedValue(31 as never)
    mockDispatches({ openRuns: [openRun('OPAPO')] })

    const today = await collectToday('org-1')

    expect(today.outNow).toBe(1)
    expect(today.outNowStale).toBe(31)
  })

  it('counts runs closed today however long ago they were raised', async () => {
    prismaMock.dispatch.count.mockResolvedValue(4 as never)
    const today = await collectToday('org-1')
    expect(today.returned).toBe(4)
    expect(today.quiet).toBe(false)
  })

  it('groups destinations the dispatchers typed inconsistently, and counts the unnamed apart', async () => {
    mockDispatches({
      departedRuns: [
        { destination: 'Weighbridge X' }, { destination: '  WEIGHBRIDGE X ' },
        { destination: null }, { destination: '   ' },
      ],
    })
    mockGateCrossings(['yd-a', 'yd-b', 'yd-c', 'yd-d'])

    const today = await collectToday('org-1')

    expect(today.byDestination).toEqual([{ destination: 'Weighbridge X', units: 2 }])
    expect(today.destinationNotRecorded).toBe(2)
  })

  it('counts only CONFIRMED drains as needing investigation', async () => {
    // A drain we merely relayed from the provider is not a chase. Confirmation
    // is derived from verdictReason, so the two DRAIN rows below are the same
    // verdict and a very different call on somebody's morning.
    prismaMock.fuelTheft.findMany.mockResolvedValue([
      ...Array.from({ length: 5 }, () => theft('DRAIN', 20_000, 'level-stayed-down')),
      ...Array.from({ length: 9 }, () => theft('PENDING', 5_000, 'settling')),
      ...Array.from({ length: 4 }, () => theft('REDISTRIBUTION', 30_000, 'level-recovered')),
      theft('DRAIN', 1_000, 'insufficient-telemetry'),
      theft('REFILL', 8_000, 'filling-in-window'),
    ] as never)

    const today = await collectToday('org-1')

    expect(today.fuelIssues).toEqual({
      raised: 20, needInvestigating: 5, stillSettling: 9, ruledOut: 4,
      explainedByRefuel: 1, notConfirmed: 1,
      // Only the confirmed drains — 5 × 20 L. Redistribution and refill never
      // count, and neither does a drain we could not check.
      litresDrained: 100,
    })
  })

  it('says "so far today" once the morning is over', async () => {
    vi.setSystemTime(new Date('2026-08-05T12:10:00Z'))   // 15:10 EAT
    expect((await collectToday('org-1')).sinceLabel).toBe('so far today')
  })

  it('is quiet only when nothing is raised, moving, out or home', async () => {
    expect((await collectToday('org-1')).quiet).toBe(true)

    // Units on the road at 02:00 against no new paperwork is NOT a quiet day —
    // this fleet's round trip is about nineteen hours.
    mockDispatches({ openRuns: [openRun('NYAONDO')] })
    expect((await collectToday('org-1')).quiet).toBe(false)
  })

  it('asks for no departed-run lookup when no crossing was seen', async () => {
    const today = await collectToday('org-1')

    const calls = prismaMock.dispatch.findMany.mock.calls as unknown as Array<[DispatchArgs]>
    expect(calls.some(([a]) => a?.where?.id)).toBe(false)
    expect(today.leftGate).toBe(0)
  })

  it('summarises the day\'s feed by kind and keeps the newest lines', async () => {
    prismaMock.vehicleAlert.count.mockResolvedValue(3 as never)
    mockFeedKinds([
      { alertType: 'ZONE_ENTRY', _count: { _all: 2914 } },
      { alertType: 'DISPATCH',   _count: { _all: 260 } },
    ])
    ;(prismaMock.notification.findMany as unknown as {
      mockImplementation: (fn: (a: NotifArgs) => Promise<unknown>) => void
    }).mockImplementation((args) =>
      Promise.resolve(args?.where?.feedId ? [] : [
        { text: 'KTCB 295U fuel drop', severity: 'warning', alertType: 'fuelInconsistency', occurredAt: new Date('2026-08-05T06:12:00Z') },
      ]),
    )

    const today = await collectToday('org-1')

    expect(today.feed.byKind).toEqual({ ZONE_ENTRY: 2914, DISPATCH: 260 })
    expect(today.feed.overspeedingAlerts).toBe(3)
    expect(today.feed.latest).toEqual([
      { at: '09:12', severity: 'warning', text: 'KTCB 295U fuel drop' },
    ])
  })
})
