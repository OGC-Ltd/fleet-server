/**
 * The v47 Movements reports, worked out on the server: Fuel Consumption Rate
 * over a range of fleet days, AI Alarm Distribution from the dashcam search,
 * Unauthorized Passengers from the logged incidents.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const T0 = Date.parse('2026-11-05T21:00:00Z') // 6 Nov 00:00 EAT
const queries: string[] = []
const pool = {
  $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?')
    queries.push(sql)
    if (sql.includes('array_agg')) return [{ id: 'v1', first: [128_000, 128_100, 127_900], last: [129_100, 129_000] }, { id: 'v2', first: null, last: null }]
    return [{ vehicle_id: 'v1', gps_km: 32.1, odo_km: null, odo_n: 0, fixes: 400 }]
  }),
  fuelFilling: { findMany: vi.fn(async () => [{ vehicleId: 'v1', filledAt: new Date(T0 + 11 * 3_600_000), verdict: 'REFILL', observedRiseMl: 10_500, filledMl: 13_800, initialFuelLevelMl: null, finalFuelLevelMl: null }]) },
  fuelTheft: { findMany: vi.fn(async () => []) },
}
vi.mock('../../src/lib/report-db.js', () => ({ reportDb: () => pool }))
const prisma = {
  // Probe fault episodes (2026-11-25): KCX 001A's tracker reported lost tubes during the range
  sensorFaultEpisode: { findMany: vi.fn(async () => [{ vehicleId: 'v2', detail: 'Fuel probe: Lost Contact with Tubes Error - Needs Replacement', startedAt: new Date(0) }]) },
  vehicle: { findMany: vi.fn(async () => [
    { id: 'v1', registrationPlate: 'KDA 258J', name: 'KDA 258J', model: null, tankCapacityLitres: 140 },
    { id: 'v2', registrationPlate: 'KCX 001A', name: 'MENENGAI - KCX 001A', model: 'MITSUBISHI FH 517', tankCapacityLitres: null },
    // Its own standard (2026-11-25) wins over the sheet's 4.7 for its plate
    { id: 'v3', registrationPlate: 'KDA 258J ', name: 'KDA 258J B', model: null, tankCapacityLitres: null, standardKmPerL: 2.5 },
  ]) },
  operatorIncident: { findMany: vi.fn(async () => [
    { id: 'i1', organisationId: 'o', kind: 'other', other: 'Unauthorized Passengers', at: new Date(T0 + 3_600_000), vehicleId: 'v1', plate: 'KDA 258J', driver: '', location: '', status: 'Online', details: '2 people', loggedBy: 'Ann', loggedAt: new Date(T0), sharedAt: new Date(T0 + 7_200_000), updatedAt: new Date(T0) },
    { id: 'i2', organisationId: 'o', kind: 'other', other: 'Unauthorized Passengers', at: new Date(T0 + 4_000_000), vehicleId: 'v2', plate: 'KCX 001A', driver: '', location: '', status: 'Online', details: '', loggedBy: 'Ann', loggedAt: new Date(T0), sharedAt: null, updatedAt: new Date(T0) },
  ]) },
}
vi.mock('../../src/lib/prisma.js', () => ({ prisma }))
const getAlarms = vi.fn()
vi.mock('../../src/modules/dashcam/dashcam.service.js', () => ({ getAlarms }))

const { rangeBounds, fuelConsumptionRate, alarmDistribution, alarmKind, unauthorizedPassengers } = await import('../../src/modules/reports/range-reports.service.js')
const { targetFor, unitTarget } = await import('../../src/modules/reports/fuel-target-rates.js')

beforeEach(() => { queries.length = 0 })

describe('a range of fleet days', () => {
  it('runs from the first midnight to the end of the last day, Nairobi', () => {
    const r = rangeBounds('2026-11-06', '2026-11-07', 31)
    expect(r.from.toISOString()).toBe('2026-11-05T21:00:00.000Z')
    expect(r.to.toISOString()).toBe('2026-11-07T21:00:00.000Z')
    expect(r.days).toEqual(['2026-11-06', '2026-11-07'])
  })
  it('refuses a range backwards or too long', () => {
    expect(() => rangeBounds('2026-11-07', '2026-11-06', 31)).toThrow(/after/)
    expect(() => rangeBounds('2026-10-01', '2026-11-06', 31)).toThrow(/At most 31/)
  })
})

describe('target rates', () => {
  it('by registration first, then by model, longest name first; never from the plate', () => {
    expect(targetFor('KDA258J', null)).toEqual({ kmPerL: 4.7, words: '4.70', source: 'vehicle' })
    expect(targetFor('KCX 001A', 'TATA 2518 TIPPER')).toEqual({ kmPerL: 3.5, words: '3.5-4', source: 'model' })
    expect(targetFor('KCX 001A', 'TATA PRIMA')).toMatchObject({ kmPerL: 7.2 })
    expect(targetFor('KCX 001A', 'MANUAL')).toBe(null)
    expect(targetFor('KCX 001A', null)).toBe(null)
  })
  it('a unit’s own standard comes before the sheet (operator, 2026-11-25)', () => {
    expect(unitTarget(2.5)).toEqual({ kmPerL: 2.5, words: '2.50', source: 'vehicle' })
    expect(unitTarget(null)).toBe(null)
    expect(unitTarget(0)).toBe(null)
    expect(unitTarget(Number.NaN)).toBe(null)
  })
})

describe('fuel consumption rate', () => {
  it('balances the whole range per unit: start, refills, end, km, against the target', async () => {
    const out = await fuelConsumptionRate('o', null, '2026-11-06', '2026-11-07', T0 + 30 * 86_400_000)
    const [kda, kcx] = [out.rows.find((r) => r.plate === 'KDA 258J')!, out.rows.find((r) => r.plate === 'KCX 001A')!]
    // km summed over both days; tank 128.0 -> 129.1 with a 10.5 L refill
    expect(kda).toMatchObject({ distanceKm: 64.2, distanceSource: 'gps', startL: 128, filledL: 10.5, endL: 129.1, consumedL: 9.4, target: { kmPerL: 4.7 } })
    expect(kda.kmPerL).toBeCloseTo(6.83, 2)
    expect(kda.belowTarget).toBe(false)
    // no probe: no figures, and says why, rather than 0 L
    // no readings, but the tracker recorded why: the probe's fault is the comment
    expect(kcx).toMatchObject({ distanceSource: null, startL: null, consumedL: null, kmPerL: null, note: 'PROBE ISSUE: Lost Contact with Tubes Error - Needs Replacement', target: { kmPerL: 5.8 } })
    expect(prisma.sensorFaultEpisode.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ kind: { in: ['fuel_probe_fault', 'fuel_probe_dead', 'fuel_probe_status'] } }) }))
    expect(out.rows.find((r) => r.vehicleId === 'v3')!.target).toEqual({ kmPerL: 2.5, words: '2.50', source: 'vehicle' })
    expect(out.totals).toMatchObject({ units: 3, measured: 1, consumedL: 9.4 })
    expect(queries.filter((q) => q.includes('LAG(')).length).toBe(2)
  })
  it('keeps a finished day, so a second run reads only the database edges', async () => {
    await fuelConsumptionRate('o', null, '2026-11-06', '2026-11-07', T0 + 30 * 86_400_000)
    expect(queries.filter((q) => q.includes('LAG(')).length).toBe(0)
  })
})

describe('alarm distribution', () => {
  it('counts each unit by kind inside the range, and says when VSS gave only part', async () => {
    const at = (h: number) => new Date(T0 + h * 3_600_000).toISOString()
    getAlarms.mockResolvedValueOnce({ cameras: 3, partial: true, from: '', to: '', incidents: [
      { vehicleId: 'v1', plate: 'KDA 258J', label: 'Phone call', occurredAt: at(1) },
      { vehicleId: 'v1', plate: 'KDA 258J', label: 'No seatbelt', occurredAt: at(2) },
      { vehicleId: 'v1', plate: 'KDA 258J', label: 'Lane departure', occurredAt: at(3) },
      { vehicleId: 'v2', plate: 'KCX 001A', label: 'Fatigue driving', occurredAt: at(4) },
      { vehicleId: 'v2', plate: 'KCX 001A', label: 'Fatigue driving', occurredAt: at(30) },
    ] })
    const out = await alarmDistribution('o', null, '2026-11-06', '2026-11-06', T0 + 2 * 86_400_000)
    expect(out.partial).toBe(true)
    expect(out.rows.map((r) => [r.plate, r.total, r.phone, r.seatbelt, r.other, r.fatigue])).toEqual([
      ['KDA 258J', 3, 1, 1, 1, 0], ['KCX 001A', 1, 0, 0, 0, 1],
    ])
    expect(alarmKind('Smoking detected')).toBe('smoking')
  })
  it('refuses days the dashcams no longer keep', async () => {
    await expect(alarmDistribution('o', null, '2026-11-06', '2026-11-06', T0 + 20 * 86_400_000)).rejects.toThrow(/keep 7 days/)
  })
})

describe('unauthorized passengers', () => {
  it('lists the logged incidents with when each was shared', async () => {
    const out = await unauthorizedPassengers('o', new Set(['v1', 'v2']), '2026-11-06', '2026-11-06')
    expect(out.totals).toEqual({ incidents: 2, units: 2, shared: 1 })
    expect(out.incidents[0]).toMatchObject({ id: 'i1', sharedAt: T0 + 7_200_000 })
    expect(prisma.operatorIncident.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ kind: 'other', vehicleId: { in: ['v1', 'v2'] } }),
    }))
  })
})
