/**
 * The units dispatched to the weighbridges and still out.
 *
 * What these pin: a freehand destination is matched to the organisation's own
 * yard (never to the mill), trucks and tractors are told apart, "out longer
 * than a run takes" is measured against that destination's completed runs,
 * and a run nobody signed back is counted as stale rather than drawn as out.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')

import { prismaMock } from '../helpers/prisma.mock.js'
import {
  siteKey, matchSite, unitType, getDispatchedUnits, STALE_AFTER_MS,
} from '../../src/modules/weighments/weighment.dispatched.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

const CENTRES = [
  { code: 101, name: 'FACTORY' },
  { code: 102, name: 'OPAPO' },
  { code: 1115, name: 'KITALE (AMUKA) YARD' },
]

describe('siteKey / matchSite', () => {
  it('normalises case, spacing and a trailing YARD', () => {
    expect(siteKey('  Opapo ')).toBe('OPAPO')
    expect(siteKey('KITALE (AMUKA) YARD')).toBe('KITALE (AMUKA)')
  })

  it('matches a destination to the yard it names', () => {
    expect(matchSite('opapo', CENTRES)).toEqual({ code: 102, name: 'OPAPO' })
    expect(matchSite('Kitale (Amuka)', CENTRES)?.code).toBe(1115)
  })

  it('treats a farm as a field run, and never matches the mill', () => {
    expect(matchSite('ADEK', CENTRES)).toBeNull()
    expect(matchSite('FACTORY', CENTRES)).toBeNull()
    expect(matchSite(null, CENTRES)).toBeNull()
  })
})

describe('unitType', () => {
  it('reads trucks and tractors off the registry type', () => {
    expect(unitType('TRUCK')).toBe('TRUCK')
    expect(unitType('TRACTOR')).toBe('TRACTOR')
    expect(unitType('UNSPECIFIED')).toBe('OTHER')
    expect(unitType(null)).toBe('OTHER')
  })
})

describe('getDispatchedUnits', () => {
  const now = Date.parse('2026-10-01T12:00:00Z')
  const run = (over: Record<string, unknown>) => ({
    externalId: 'd1', plate: 'KDA 512Q', vehicleId: 'v1', driverName: 'JOHN OUMA',
    destination: 'OPAPO', dispatchedAt: new Date(now - 3 * 3_600_000),
    vehicle: { vehicleType: 'TRUCK' },
    ...over,
  })

  beforeEach(() => {
    ;(prismaMock.weighment.groupBy as any).mockResolvedValue(
      CENTRES.map(c => ({ centerCode: c.code, centerName: c.name })),
    )
    ;(prismaMock.dispatch.count as any).mockResolvedValue(111)
    ;(prismaMock.dispatch.findFirst as any).mockResolvedValue({ dispatchedAt: new Date(now - 3_600_000) })
  })

  it('measures each unit against its destination, else the organisation', async () => {
    ;(prismaMock.dispatch.findMany as any).mockResolvedValue([
      run({ externalId: 'a' }),                                                    // 3 h of a 12.8 h run
      run({ externalId: 'b', destination: 'ADEK', vehicle: { vehicleType: 'TRACTOR' },
            dispatchedAt: new Date(now - 11 * 3_600_000) }),                       // 11 h of a 9.7 h run
      run({ externalId: 'c', destination: 'NEW FARM', vehicle: { vehicleType: 'TRACTOR' },
            dispatchedAt: new Date(now - 9 * 3_600_000) }),                        // 9 h of the org's 8 h
    ])
    ;(prismaMock.$queryRaw as any)
      // destinationDurations
      .mockResolvedValueOnce([
        { destination: 'OPAPO', n: 307n, median_h: 12.8 },
        { destination: 'ADEK',  n: 84n,  median_h: 9.7 },
      ])
      // the organisation's completed runs
      .mockResolvedValueOnce([{ h: 6 }, { h: 8 }, { h: 10 }])

    const out = await getDispatchedUnits('org', now)
    const by = Object.fromEntries(out.units.map(u => [u.id, u]))

    expect(by.a).toMatchObject({ siteCode: 102, vehicleType: 'TRUCK', typicalHours: 12.8, typicalSource: 'destination', overdue: false })
    expect(by.b).toMatchObject({ siteCode: null, vehicleType: 'TRACTOR', typicalHours: 9.7, overdue: true })
    expect(by.c).toMatchObject({ typicalHours: 8, typicalSource: 'organisation', overdue: true })
    expect(out.counts).toEqual({ trucks: 1, tractors: 2, other: 0, overdue: 2 })
    expect(out.staleCount).toBe(111)
  })

  it('asks only for cane runs dispatched inside the stale window', async () => {
    ;(prismaMock.dispatch.findMany as any).mockResolvedValue([])
    ;(prismaMock.$queryRaw as any).mockResolvedValue([])
    await getDispatchedUnits('org', now)
    const where = (prismaMock.dispatch.findMany as any).mock.calls[0][0].where
    expect(where).toMatchObject({ organisationId: 'org', kind: 'CANE', actualReturnAt: null })
    expect(where.dispatchedAt.gte.getTime()).toBe(now - STALE_AFTER_MS)
  })
})
