/**
 * A reconciliation sheet's "Filling as per Fuel Probes": Wialon's fill report as
 * the fuel ledger holds it, each refuel once. The rows are Wialon's real answers
 * for Aquamist units (Advanced Fuel Analysis, read 2026-11-27), checked against
 * Aquamist's sheet.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/providers/wialon/wialon.client.js', () => ({
  WialonError: class extends Error { constructor(public readonly code: number) { super(`Wialon (${code})`) } },
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { resetPrismaMock } from '../../src/lib/__mocks__/prisma.js'
import { plateKey, probeFillsOf } from '../../src/modules/fuel/probe-fills.js'
import { getProbeFills, whenFree } from '../../src/modules/fuel/probe-fills.service.js'
import { WialonError } from '../../src/providers/wialon/wialon.client.js'

/** One Wialon fill row; `eat` is Nairobi time on `day`. */
const ev = (day: string, eat: string, l: number, before: number, after: number) => ({
  filledAt: new Date(`${day}T${eat}+03:00`), filledMl: Math.round(l * 1000),
  initialFuelLevelMl: Math.round(before * 1000), finalFuelLevelMl: Math.round(after * 1000),
  location: null, mileageAtFillKm: null,
})

describe('probeFillsOf', () => {
  it('counts a two-tank refuel once, at its largest row (KBY 767G, 22 Jan 2026)', () => {
    const d = '2026-01-22'
    const fills = probeFillsOf([
      ev(d, '09:28:24', 229.41, 128.31, 357.71),
      ev(d, '09:28:24', 213.00, 148, 361),
      ev(d, '09:28:54', 253.72, 106.86, 360.59),
      ev(d, '17:26:39', 14.68, 339.01, 353.69),
      ev(d, '18:44:30', 11.83, 293.81, 305.64),
      ev(d, '19:32:49', 18.47, 309.62, 328.08),
    ])
    // The sheet printed 368 L; the tank never read above 361 L.
    expect(fills.map(f => f.litres)).toEqual([253.72, 14.68, 11.83, 18.47])
    expect(fills[0]).toMatchObject({ rows: 3, beforeL: 106.86, afterL: 360.59 })
  })

  it('keeps fills on the same day apart when the level rose again (KBY 767G, 9 Jan 2026)', () => {
    const d = '2026-01-09'
    const fills = probeFillsOf([
      ev(d, '09:26:14', 11.99, 143.94, 155.93),
      ev(d, '15:35:06', 202.15, 148.99, 351.14),
      ev(d, '16:47:55', 10.86, 349.72, 360.59),
      ev(d, '20:06:52', 11.44, 335.16, 346.6),
    ])
    expect(fills.map(f => f.litres)).toEqual([11.99, 202.15, 10.86, 11.44])
  })

  it('does not join overlapping levels hours apart', () => {
    const d = '2025-12-20'
    expect(probeFillsOf([ev(d, '08:42:21', 11.58, 157.47, 169.05), ev(d, '15:22:43', 190.19, 158.35, 348.54)]))
      .toHaveLength(2)
  })
})

describe('plateKey', () => {
  it('ignores spaces, case and dashes', () => {
    expect(plateKey(' kby-767g ')).toBe('KBY767G')
    expect(plateKey('KBY 767G')).toBe(plateKey('KBY767G'))
  })
})

describe('getProbeFills', () => {
  // The ledger's rows as Wialon reported them: KBY 767G's two-tank refuel, three rows
  const row = (eat: string, l: number, before: number, after: number) => ({
    vehicleId: 'v1', filledAt: new Date(`${eat}+03:00`), filledMl: Math.round(l * 1000),
    initialFuelLevelMl: Math.round(before * 1000), finalFuelLevelMl: Math.round(after * 1000),
  })
  beforeEach(() => {
    resetPrismaMock()
    prismaMock.vehicle.findMany.mockResolvedValue([
      { id: 'v1', name: 'Aquamist KBY 767G', registrationPlate: 'KBY 767G', isActive: true },
      { id: 'old', name: 'Aquamist KBY 767G', registrationPlate: 'KBY 767G', isActive: false },
      { id: 'v2', name: 'Aquamist KDH 451K', registrationPlate: 'KDH 451K', isActive: true },
    ] as never)
    prismaMock.fuelFilling.findFirst.mockResolvedValue({ filledAt: new Date('2025-11-26T21:12:00Z') } as never)
  })

  it('reads a whole sheet in one query, each refuel once, from whole Nairobi days', async () => {
    prismaMock.fuelFilling.findMany.mockResolvedValue([
      row('2026-01-22T09:28:24', 229.41, 128.31, 357.71),
      row('2026-01-22T09:28:24', 213.00, 148, 361),
      row('2026-01-22T09:28:54', 253.72, 106.86, 360.59),
    ] as never)
    const r = await getProbeFills('org1', ['kby767g', 'KDH 451K', 'KDM 148L'], '2026-01-01', '2026-01-31', null)
    expect(r.coveredFrom).toBe('2025-11-27')
    expect(r.units.map(u => [u.plate, u.vehicle?.id ?? null, u.note])).toEqual([
      ['kby767g', 'v1', null], ['KDH 451K', 'v2', null], ['KDM 148L', null, 'Not on the platform'],
    ])
    expect(r.units[0]!.fills.map(f => f.litres)).toEqual([253.72])
    expect(r.units[1]!.fills).toEqual([])
    expect(prismaMock.fuelFilling.findMany).toHaveBeenCalledTimes(1)
    const where = prismaMock.fuelFilling.findMany.mock.calls[0]![0]!.where as any
    expect(where.vehicleId.in.sort()).toEqual(['v1', 'v2'])
    expect(where.filledAt.gte.toISOString()).toBe('2025-12-31T21:00:00.000Z')
    expect(where.filledAt.lt.toISOString()).toBe('2026-01-31T21:00:00.000Z')
  })

  it('leaves out units outside the scope of the user', async () => {
    prismaMock.fuelFilling.findMany.mockResolvedValue([] as never)
    const r = await getProbeFills('org1', ['KBY 767G'], '2026-01-01', '2026-01-01', new Set(['v2']))
    expect(r.units[0]).toMatchObject({ vehicle: null, note: 'Not on the platform' })
  })

  it('refuses a range past MAX_DAYS or backwards', async () => {
    await expect(getProbeFills('org1', ['KBY 767G'], '2025-01-01', '2026-06-01', null)).rejects.toThrow(/at most/)
    await expect(getProbeFills('org1', ['KBY 767G'], '2026-02-01', '2026-01-01', null)).rejects.toThrow(/from first/)
  })
})

describe('whenFree', () => {
  it('waits out the Wialon one-report-at-a-time refusal, and gives up on anything else', async () => {
    const busy = new (WialonError as unknown as new (c: number) => Error)(1003)
    const call = vi.fn().mockRejectedValueOnce(busy).mockRejectedValueOnce(busy).mockResolvedValue('ok')
    await expect(whenFree(call, [0, 0, 0])).resolves.toBe('ok')
    expect(call).toHaveBeenCalledTimes(3)
    await expect(whenFree(vi.fn().mockRejectedValue(busy), [0])).rejects.toBe(busy)
    const other = new (WialonError as unknown as new (c: number) => Error)(4)
    const once = vi.fn().mockRejectedValue(other)
    await expect(whenFree(once, [0, 0])).rejects.toBe(other)
    expect(once).toHaveBeenCalledTimes(1)
  })
})
