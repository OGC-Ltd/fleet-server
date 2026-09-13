/**
 * Sugar out of the gate: tonnage per day, and which units carried it.
 *
 * The shape of this service is an argument about populations, so that is what
 * these pin. Tonnage is summed over DISPATCHES, because a load is known when
 * the sales office raises the run and a truck with a dark tracker still carried
 * it. Distance comes from TRIPS, because only a trip has been measured. The two
 * sets differ, and `runsMeasured` is what stops a reader assuming the kilometres
 * cover every run in the tonnage.
 *
 * The third population arrived later: runs raised by the TRANSPORT team rather
 * than the sales office. Those leave the same gate carrying the same sugar and
 * belong in the same table, but the provider sends no weight on them — so they
 * count as runs and abstain from the tonnage, which `runsWeighed` states.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')

import { prismaMock } from '../helpers/prisma.mock.js'
import { getSugarHauls } from '../../src/modules/analytics/sugar-hauls.service.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

const TO = new Date('2026-09-09T12:00:00.000Z')

const run = (over: Record<string, unknown> = {}) => ({
  id: 'd1', plate: 'KCP 134P', driverName: 'Duncan Mwangi', destination: 'Raiply',
  dispatchedAt: new Date('2026-09-09T06:58:00.000Z'),
  actualReturnAt: new Date('2026-09-09T11:30:00.000Z'),
  status: 'COMPLETED', kind: 'SALES' as const,
  tonnageT: 29, factoryCode: 'NAITIRI', vehicleId: 'veh_1',
  ...over,
})

/** A transport-team run: same gate, same sugar, no weight on the payload. */
const transportRun = (over: Record<string, unknown> = {}) =>
  run({ id: 'd9', kind: 'CANE', tonnageT: null, ...over })

beforeEach(() => {
  ;(prismaMock.dispatch.findMany as any).mockResolvedValue([run()])
  ;(prismaMock.trip.findMany as any).mockResolvedValue([])
})

describe('getSugarHauls', () => {
  it('asks for both offices: any sales run, and transport runs out of a sugar gate', async () => {
    // Not `kind: 'SALES'`, which reported the sales office's paperwork rather
    // than the sugar that left. Not a bare kind widening either — that would
    // drag Ndhiwa's inbound cane deliveries into a table about sugar going out.
    await getSugarHauls('org_1', 30, TO)
    const { where } = (prismaMock.dispatch.findMany as any).mock.calls[0][0]

    expect(where.kind).toBeUndefined()
    expect(where.OR).toEqual([
      { kind: 'SALES' },
      { kind: 'CANE', factoryCode: { in: ['NAITIRI'] } },
    ])
  })

  it('counts a transport run, and leaves its tonnage null rather than zero', async () => {
    // A zero would hold the tonnage still while the run count climbed, and
    // halve every tonnes-per-run a reader took off this table.
    ;(prismaMock.dispatch.findMany as any).mockResolvedValue([transportRun()])

    const out = await getSugarHauls('org_1', 30, TO)
    const u = out.units[0]!
    expect(u.runs).toBe(1)
    expect(u.runsWeighed).toBe(0)
    expect(u.tonnes).toBeNull()
    expect(u.bags).toBeNull()
    expect(out.totals.runs).toBe(1)
    expect(out.totals.runsWeighed).toBe(0)
    expect(out.totals.tonnes).toBeNull()
  })

  it('sums the weighed runs only, and says how many stood behind the figure', async () => {
    ;(prismaMock.dispatch.findMany as any).mockResolvedValue([run(), transportRun()])

    const out = await getSugarHauls('org_1', 30, TO)
    const u = out.units[0]!
    expect(u.runs).toBe(2)
    expect(u.runsWeighed).toBe(1)
    expect(u.tonnes).toBe(29)        // not 29 spread over two runs
    expect(out.totals.runsWeighed).toBe(1)
  })

  it('carries each run, newest first, with both ends of its clock', async () => {
    // The aggregate row can say how much a truck moved and never when. The
    // history is what the page's per-run rows and its date filter read.
    ;(prismaMock.dispatch.findMany as any).mockResolvedValue([
      run({ id: 'd1' }),
      run({ id: 'd2', dispatchedAt: new Date('2026-09-09T09:00:00.000Z'),
            actualReturnAt: null, status: 'DISPATCHED' }),
    ])

    const out = await getSugarHauls('org_1', 30, TO)
    const h = out.units[0]!.history
    expect(h.map(r => r.id)).toEqual(['d2', 'd1'])
    expect(h[1]!.dispatchedAt).toBe('2026-09-09T06:58:00.000Z')
    expect(h[1]!.returnedAt).toBe('2026-09-09T11:30:00.000Z')
    // Still out: null, not a timestamp standing in for one.
    expect(h[0]!.returnedAt).toBeNull()
    expect(h[0]!.driver).toBe('Duncan Mwangi')
  })

  it('puts a unit nobody weighed below one that was, not at the top', async () => {
    // Descending by tonnage with a null in it: an unweighed unit is not the
    // heaviest and it is not the lightest either — it is unranked, so it sorts
    // to the tail on run count rather than leading on a null.
    ;(prismaMock.dispatch.findMany as any).mockResolvedValue([
      transportRun({ id: 'd9', plate: 'KCP 999P' }),
      run({ id: 'd1', plate: 'KCP 134P' }),
    ])

    const out = await getSugarHauls('org_1', 30, TO)
    expect(out.units.map(u => u.plate)).toEqual(['KCP 134P', 'KCP 999P'])
  })

  it('counts tonnage and bags per day, and names the gate', async () => {
    const out = await getSugarHauls('org_1', 30, TO)

    const today = out.days[out.days.length - 1]!
    expect(today.runs).toBe(1)
    expect(today.tonnes).toBe(29)
    expect(today.bags).toBe(580)
    expect(out.origin).toBe('Naitiri')
  })

  it('plots every day in the window, zeroed where nothing ran', async () => {
    // A missing day would silently shorten the axis and redraw the shape of the
    // week. Zero is a fact here: no sugar left the gate.
    const out = await getSugarHauls('org_1', 7, TO)
    expect(out.days).toHaveLength(7)
    expect(out.days.slice(0, 6).every(d => d.runs === 0 && d.tonnes === 0)).toBe(true)
  })

  it('counts the load even when no trip could be measured', async () => {
    // The whole reason tonnage is summed over dispatches. A dark tracker means
    // no trip, and the sugar went anyway.
    const out = await getSugarHauls('org_1', 30, TO)

    expect(out.totals.tonnes).toBe(29)
    expect(out.units[0]!.runs).toBe(1)
    expect(out.units[0]!.runsMeasured).toBe(0)
    expect(out.units[0]!.km).toBeNull()      // not 0 — nothing was measured
    expect(out.totals.km).toBeNull()
  })

  it('joins distance and fuel from the trip when one was built', async () => {
    ;(prismaMock.trip.findMany as any).mockResolvedValue([
      { dispatchId: 'd1', mileageKm: 240, consumedMl: 96_000 },
    ])

    const out = await getSugarHauls('org_1', 30, TO)
    const u = out.units[0]!
    expect(u.runsMeasured).toBe(1)
    expect(u.km).toBe(240)
    expect(u.litresPerKm).toBe(0.4)          // 96 L over 240 km
  })

  it('leaves litresPerKm null when the tank could not be balanced', async () => {
    // trip-builder returns null consumedMl for a run containing a refuel. 0
    // would report a truck that hauled 29 tonnes for nothing.
    ;(prismaMock.trip.findMany as any).mockResolvedValue([
      { dispatchId: 'd1', mileageKm: 240, consumedMl: null },
    ])

    const out = await getSugarHauls('org_1', 30, TO)
    expect(out.units[0]!.km).toBe(240)
    expect(out.units[0]!.litresPerKm).toBeNull()
  })

  it('rates fuel as a ratio of totals, not a mean of per-run rates', async () => {
    // A short repositioning move and a long haul are not two equal opinions
    // about what a kilometre costs.
    ;(prismaMock.dispatch.findMany as any).mockResolvedValue([
      run({ id: 'd1' }),
      run({ id: 'd2', dispatchedAt: new Date('2026-09-09T09:00:00.000Z') }),
    ])
    ;(prismaMock.trip.findMany as any).mockResolvedValue([
      { dispatchId: 'd1', mileageKm: 200, consumedMl: 100_000 },  // 0.50 L/km
      { dispatchId: 'd2', mileageKm: 2,   consumedMl: 4_000   },  // 2.00 L/km
    ])

    const out = await getSugarHauls('org_1', 30, TO)
    // 104 L over 202 km = 0.51, not the 1.25 a mean of the two rates would give.
    expect(out.units[0]!.litresPerKm).toBe(0.51)
  })

  it('groups by unit and ranks the heaviest first', async () => {
    ;(prismaMock.dispatch.findMany as any).mockResolvedValue([
      run({ id: 'd1', plate: 'KCP 134P', tonnageT: 29 }),
      run({ id: 'd2', plate: 'KCP 132P', tonnageT: 31, driverName: 'Other Driver' }),
      run({ id: 'd3', plate: 'KCP 132P', tonnageT: 30, driverName: 'Other Driver',
            dispatchedAt: new Date('2026-09-09T09:00:00.000Z') }),
    ])

    const out = await getSugarHauls('org_1', 30, TO)
    expect(out.units.map(u => u.plate)).toEqual(['KCP 132P', 'KCP 134P'])
    expect(out.units[0]!.runs).toBe(2)
    expect(out.units[0]!.tonnes).toBe(61)
    expect(out.units[0]!.bags).toBe(1220)
    expect(out.totals.units).toBe(2)
    expect(out.totals.runs).toBe(3)
  })

  it('does not name an origin when the window spans two factories', async () => {
    // Naming one of them would be wrong, and naming both is not what the
    // subtitle is for.
    ;(prismaMock.dispatch.findMany as any).mockResolvedValue([
      run({ id: 'd1', factoryCode: 'NAITIRI' }),
      run({ id: 'd2', factoryCode: 'NDHIWA' }),
    ])
    expect((await getSugarHauls('org_1', 30, TO)).origin).toBeNull()
  })
})
