/**
 * The runs a report reads to name the driver at the time (dispatch-runs).
 *
 * What these pin: the query asks for runs that OVERLAP the period (signed out
 * before its end, not signed back in before its start), never reaches back
 * further than LOOKBACK_HOURS for a run left open, keeps to the caller's
 * vehicle scope, and the period itself is bounded and the right way round.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/lib/prisma.js')

import { prismaMock } from '../helpers/prisma.mock.js'
import { findRuns, runsQuerySchema, LOOKBACK_HOURS, MAX_SPAN_DAYS } from '../../src/modules/dispatches/dispatch-runs.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

const FROM = new Date('2026-11-16T00:00:00+03:00')
const TO   = new Date('2026-11-16T13:15:00+03:00')

const row = (over: Record<string, unknown> = {}) => ({
  externalId: 'd1', vehicleId: 'v1', plate: 'KDX 130Y', driverName: 'Peterlis Onyango Opuk',
  kind: 'CANE', status: 'COMPLETED',
  dispatchedAt: new Date('2026-11-16T06:10:00+03:00'), actualReturnAt: new Date('2026-11-16T11:40:00+03:00'),
  ...over,
})

describe('findRuns', () => {
  it('asks for the runs overlapping the period, bounded behind it', async () => {
    ;(prismaMock.dispatch.findMany as any).mockResolvedValue([row()])
    await findRuns('org1', null, FROM, TO)
    const where = (prismaMock.dispatch.findMany as any).mock.calls[0][0].where
    expect(where.organisationId).toBe('org1')
    expect(where.dispatchedAt.lt).toEqual(TO)
    expect(where.dispatchedAt.gte).toEqual(new Date(FROM.getTime() - LOOKBACK_HOURS * 3_600_000))
    expect(where.OR).toEqual([{ actualReturnAt: null }, { actualReturnAt: { gt: FROM } }])
    expect(where.vehicleId).toBeUndefined()
  })

  it('gives each run as stored, times as ISO, a run still out with no return', async () => {
    ;(prismaMock.dispatch.findMany as any).mockResolvedValue([row(), row({ externalId: 'd2', actualReturnAt: null, status: 'DISPATCHED' })])
    const runs = await findRuns('org1', null, FROM, TO)
    expect(runs[0]).toEqual({
      id: 'd1', vehicleId: 'v1', plate: 'KDX 130Y', driverName: 'Peterlis Onyango Opuk', kind: 'CANE', status: 'COMPLETED',
      dispatchedAt: '2026-11-16T03:10:00.000Z', actualReturnAt: '2026-11-16T08:40:00.000Z',
    })
    expect(runs[1].actualReturnAt).toBeNull()
  })

  it('keeps to the vehicle scope, and an empty scope reads nothing', async () => {
    ;(prismaMock.dispatch.findMany as any).mockResolvedValue([])
    await findRuns('org1', new Set(['v1', 'v2']), FROM, TO)
    expect((prismaMock.dispatch.findMany as any).mock.calls[0][0].where.vehicleId).toEqual({ in: ['v1', 'v2'] })
    ;(prismaMock.dispatch.findMany as any).mockClear()
    expect(await findRuns('org1', new Set(), FROM, TO)).toEqual([])
    expect(prismaMock.dispatch.findMany).not.toHaveBeenCalled()
  })
})

describe('runsQuerySchema', () => {
  it('reads the period as dates', () => {
    const q = runsQuerySchema.parse({ from: FROM.toISOString(), to: TO.toISOString() })
    expect(q.from).toEqual(FROM)
    expect(q.to).toEqual(TO)
  })

  it('refuses a period the wrong way round, or longer than a month', () => {
    expect(runsQuerySchema.safeParse({ from: TO.toISOString(), to: FROM.toISOString() }).success).toBe(false)
    const long = new Date(FROM.getTime() + (MAX_SPAN_DAYS + 1) * 86_400_000)
    expect(runsQuerySchema.safeParse({ from: FROM.toISOString(), to: long.toISOString() }).success).toBe(false)
    expect(runsQuerySchema.safeParse({ from: 'yesterday', to: TO.toISOString() }).success).toBe(false)
  })
})
