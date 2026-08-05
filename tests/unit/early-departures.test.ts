/**
 * "Out early" counts SIGN-OUTS, not gate crossings.
 *
 * The card used to count only departures measured off the vehicle's own fixes,
 * and on a fleet where most units carry no tracker that is a census of the
 * trackers rather than of the yard. Measured on SUKARI, 2026-08-05: 55 tractors
 * were signed out before 06:00 and the card said 5 — 33 of the 55 are on
 * vehicles with no Wialon unit bound at all (they have never produced a fix), 7
 * had a tracker that stayed silent, and of the 15 that did report, 10 genuinely
 * cleared the barrier after 06:00.
 *
 * So the yard's own record is the departure, and the measured crossing rides
 * along on the row as `gateAt` — the answer to "how long did it then stand
 * there", not to "did it go".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')

import { prismaMock } from '../helpers/prisma.mock.js'
import { operationsToday } from '../../src/modules/analytics/analytics.repository.js'

// 2026-08-05 in EAT (UTC+3): local midnight is 2026-08-04T21:00Z.
const local = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(Date.UTC(2026, 7, 5, h! - 3, m!))
}

const dispatch = (id: string, at: string, over: Record<string, unknown> = {}) => ({
  id,
  plate:        'KTCC 870B',
  driverName:   'AUGUSTINE OWINO NYAMWOK',
  destination:  'kwoyo u k',
  dispatchedAt: local(at),
  ...over,
})

/** Sign-outs at 03:47, 05:15 and 07:30 local — two of them before 06:00. */
const TRACTORS = [
  dispatch('dsp_1', '03:47'),
  dispatch('dsp_2', '05:15', { plate: 'KTCC 835B', driverName: 'JOHN OTIENO' }),
  dispatch('dsp_3', '07:30', { plate: 'KTCC 201G', driverName: 'PETER OWUOR' }),
]

beforeEach(() => {
  // The fleet day is derived from the clock (fleetDayStart), so it has to be
  // pinned — otherwise these assertions pass only on 2026-08-05.
  vi.useFakeTimers()
  vi.setSystemTime(local('08:15'))
  /* eslint-disable @typescript-eslint/no-explicit-any */
  ;(prismaMock.vehicle.groupBy as any).mockResolvedValue([
    { vehicleType: 'TRACTOR', _count: { _all: 481 } },
  ])
  ;(prismaMock.fuelFilling.findMany as any).mockResolvedValue([])
  ;(prismaMock.dispatch.findMany as any).mockImplementation(
    ({ where }: { where: { vehicle?: { vehicleType?: string } } }) =>
      Promise.resolve(where.vehicle?.vehicleType === 'TRACTOR' ? TRACTORS : []),
  )
  ;(prismaMock.dispatch.count as any).mockResolvedValue(0)
  ;(prismaMock.notification.findMany as any).mockResolvedValue([])
  /* eslint-enable @typescript-eslint/no-explicit-any */
})

afterEach(() => vi.useRealTimers())

describe('operationsToday — early departures', () => {
  it('counts every tractor signed out, tracker or no tracker', async () => {
    const ops = await operationsToday('org_1')

    expect(ops.earlyDepartures.tractorsOut).toBe(3)
    expect(ops.earlyDepartures.before04).toBe(1)   // 03:47
    expect(ops.earlyDepartures.before05).toBe(1)
    expect(ops.earlyDepartures.before06).toBe(2)   // + 05:15
    expect(ops.earlyDepartures.list.map(r => r.plate)).toEqual(['KTCC 870B', 'KTCC 835B'])
  })

  it('times the row by the sign-out, never by the crossing', async () => {
    // This is the case the old card got wrong in the other direction: a unit
    // signed out at 05:15 that does not clear the barrier until 06:02 is still
    // a pre-06:00 release of the yard.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.notification.findMany as any).mockResolvedValue([
      { feedId: 'yd-dsp_2', occurredAt: local('06:02'), text: 'KTCC 835B cleared the gate.' },
    ])

    const ops = await operationsToday('org_1')

    expect(ops.earlyDepartures.before06).toBe(2)
    const row = ops.earlyDepartures.list.find(r => r.plate === 'KTCC 835B')!
    expect(row.at).toBe(local('05:15').toISOString())
    expect(row.gateAt).toBe(local('06:02').toISOString())
  })

  it('reports how many of the early runs telemetry actually watched', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.notification.findMany as any).mockResolvedValue([
      { feedId: 'yd-dsp_1', occurredAt: local('03:55'), text: 'KTCC 870B cleared the gate.' },
    ])

    const ops = await operationsToday('org_1')

    expect(ops.earlyDepartures.gateConfirmed).toBe(1)
    expect(ops.earlyDepartures.list.find(r => r.plate === 'KTCC 835B')!.gateAt).toBeNull()
  })

  it('does not quote an untimed crossing as a measured one', async () => {
    // The bounded branch in lib/yard-departure: we know it left — the sign-out
    // said so — but no fix at the gate means there is no crossing time to show.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.notification.findMany as any).mockResolvedValue([
      {
        feedId:     'yd-dsp_1',
        occurredAt: local('04:40'),
        text:       'KTCC 870B is clear of the yard — departure time not observed (no fix at the gate).',
      },
    ])

    const ops = await operationsToday('org_1')

    // The run still counts, on its own sign-out clock.
    expect(ops.earlyDepartures.before04).toBe(1)
    expect(ops.earlyDepartures.gateConfirmed).toBe(0)
    expect(ops.earlyDepartures.list[0]!.gateAt).toBeNull()
  })

  it('asks the database only for the early runs it can annotate', async () => {
    await operationsToday('org_1')

    const where = (prismaMock.notification.findMany.mock.calls[0]![0] as {
      where: { feedId: { in: string[] } }
    }).where
    // dsp_3 was signed out at 07:30 — not an early run, so not looked up.
    expect(where.feedId.in).toEqual(['yd-dsp_1', 'yd-dsp_2'])
  })
})
