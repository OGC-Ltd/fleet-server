/**
 * What a completed sales run records: the load, and the fuel it took.
 *
 * A sales run is the first thing on this fleet that arrives with a WEIGHT. The
 * trip builder already measured distance and duration from the vehicle's own
 * fixes, so these cover the two things it could not do before — attach the
 * declared load to the trip, and say what the tank did across it.
 *
 * The fuel side is mostly about refusing to answer. `Trip.consumedMl` is
 * nullable and a blank is a real result: writing 0 when the tank cannot be read
 * would drag every consumption average towards zero, which is the same mistake
 * `mileageKm` avoids by skipping unmeasurable dispatches outright.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')

import { prismaMock } from '../helpers/prisma.mock.js'
import { tripFuelMl, writeManifest } from '../../src/lib/trip-builder.js'
import { factoryOf, bagsFromTonnes, BAG_KG } from '../../src/modules/webhooks/factory-map.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

const BEGAN = new Date('2026-09-09T06:58:00.000Z')
const ENDED = new Date('2026-09-09T10:30:00.000Z')

/** A level trace across the run: `n` readings falling from `fromMl` to `toMl`. */
const trace = (fromMl: number, toMl: number, n = 40) =>
  Array.from({ length: n }, (_, i) => ({
    capturedAt:  new Date(BEGAN.getTime() + ((ENDED.getTime() - BEGAN.getTime()) * i) / (n - 1)),
    fuelLevelMl: Math.round(fromMl + ((toMl - fromMl) * i) / (n - 1)),
  }))

beforeEach(() => {
  ;(prismaMock.fuelFilling.findFirst as any).mockResolvedValue(null)
  ;(prismaMock.vehicleTelemetry.findMany as any).mockResolvedValue(trace(300_000, 220_000))
  ;(prismaMock.cargoManifest.create as any).mockResolvedValue({})
})

describe('tripFuelMl', () => {
  it('measures the tank across the run', async () => {
    const ml = await tripFuelMl('veh_1', BEGAN, ENDED)
    // ~80 L burned. Both ends are medians over a 15-minute window rather than
    // single readings, so the figure is close to but not exactly the endpoints.
    expect(ml).toBeGreaterThan(70_000)
    expect(ml).toBeLessThan(90_000)
  })

  it('refuses when the vehicle refuelled mid-run', async () => {
    // initial − final is what the TANK did, not what the engine burned: fuel
    // went in as well as out. KCP 134P refuels every other day in 100–200 L
    // lots, so this is the common case, not the corner.
    ;(prismaMock.fuelFilling.findFirst as any).mockResolvedValue({ id: 'ff_1' })

    expect(await tripFuelMl('veh_1', BEGAN, ENDED)).toBeNull()
    // Short-circuits before touching the level trace.
    expect(prismaMock.vehicleTelemetry.findMany).not.toHaveBeenCalled()
  })

  it('ignores a filling the adjudicator put down to a dead probe', async () => {
    // SENSOR_FAULT means the sensor failed, not that the tank filled — no fuel
    // went in, so there is nothing to confound the difference.
    await tripFuelMl('veh_1', BEGAN, ENDED)
    const where = (prismaMock.fuelFilling.findFirst as any).mock.calls[0][0].where
    expect(where.verdict).toEqual({ not: 'SENSOR_FAULT' })
  })

  it('refuses when the tank finished fuller than it started', async () => {
    // No filling on the ledger and yet the level rose — a probe disagreeing
    // with itself. There is no burn to report, and 0 would say the run was free.
    ;(prismaMock.vehicleTelemetry.findMany as any).mockResolvedValue(trace(220_000, 300_000))
    expect(await tripFuelMl('veh_1', BEGAN, ENDED)).toBeNull()
  })

  it('refuses on too few readings to make a boundary', async () => {
    ;(prismaMock.vehicleTelemetry.findMany as any).mockResolvedValue(trace(300_000, 220_000, 3).slice(0, 2))
    expect(await tripFuelMl('veh_1', BEGAN, ENDED)).toBeNull()
  })

  it('is not thrown by one wild sample at a boundary', async () => {
    // The 99th-percentile ping-to-ping jump on this fleet is ~5 L on a probe
    // whose median step is zero. A single spike at the start must not become
    // the opening level — that error would land straight in the trip's burn.
    const rows = trace(300_000, 220_000)
    rows[0] = { ...rows[0]!, fuelLevelMl: 500_000 }
    ;(prismaMock.vehicleTelemetry.findMany as any).mockResolvedValue(rows)

    const ml = await tripFuelMl('veh_1', BEGAN, ENDED)
    expect(ml).toBeLessThan(90_000)   // not ~280 L
  })
})

describe('writeManifest', () => {
  const naitiri = factoryOf('NAITIRI')!

  it('records the declared load and the bag count for a sales run', async () => {
    await writeManifest('trip_1', 'SALES', 29.0, naitiri)

    const data = (prismaMock.cargoManifest.create as any).mock.calls[0][0].data
    expect(data.tripId).toBe('trip_1')
    expect(data.description).toBe('Processed Sugar — 580 × 50 kg bags')
    expect(data.cargoType).toBe('PACKAGED')
  })

  it('puts the tonnage in declaredWeightKg, never arrivalWeightKg', async () => {
    // Provenance. The figure is what the sales office entered — a waybill
    // number — while the arrival column is documented as a load-cell reading at
    // trip end, and this fleet has no load cells. Filing it as "arrival" would
    // turn a declaration into a measurement with nothing able to tell them
    // apart again.
    await writeManifest('trip_1', 'SALES', 29.0, naitiri)

    const data = (prismaMock.cargoManifest.create as any).mock.calls[0][0].data
    expect(data.declaredWeightKg).toBe(29_000)
    expect(data.arrivalWeightKg).toBeUndefined()
  })

  it('writes nothing for a cane run', async () => {
    // The provider sends no weight on a cane dispatch — there is no waybill in
    // that flow — so a manifest would be a row asserting nothing.
    await writeManifest('trip_1', 'CANE', null, factoryOf('NDHIWA'))
    expect(prismaMock.cargoManifest.create).not.toHaveBeenCalled()
  })

  it('writes nothing when a sales run carries no tonnage yet', async () => {
    await writeManifest('trip_1', 'SALES', null, naitiri)
    expect(prismaMock.cargoManifest.create).not.toHaveBeenCalled()
  })
})

describe('the factory registry', () => {
  it('knows what leaves each gate', () => {
    // The payload carries a tonnage and never says of what. The commodity is a
    // property of the SITE, and this is the only place it is recorded.
    expect(factoryOf('NAITIRI')?.commodity).toBe('Processed Sugar')
    expect(factoryOf('NDHIWA')?.commodity).toBe('Raw Sugarcane')
    expect(factoryOf('NOWHERE')).toBeNull()
  })

  it('counts bags in the unit the yard uses', () => {
    expect(BAG_KG).toBe(50)
    expect(bagsFromTonnes(29)).toBe(580)
    expect(bagsFromTonnes(0)).toBeNull()
  })
})
