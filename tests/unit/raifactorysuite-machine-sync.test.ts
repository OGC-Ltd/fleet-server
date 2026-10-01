/**
 * RaiFactorySuite machine register → vehicles: the GPS-id join, the
 * write-only-what-changed rule the hourly poller relies on, and clearing a
 * register row that has moved off a vehicle.
 */

import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma/client.js'
import type { RaiFactorySuiteMachineRow } from '../../src/providers/raifactorysuite/raifactorysuite.client.js'
import { syncMachineRegister } from '../../src/providers/raifactorysuite/raifactorysuite.machine-sync.js'
import { equipmentTypeOf, ratedConsumptionOf, fleetCodeOf } from '../../src/providers/raifactorysuite/raifactorysuite.machine.js'

const machine = (o: Partial<RaiFactorySuiteMachineRow>): RaiFactorySuiteMachineRow => ({
  id: 'm-bh01', factoryCode: 'MUFINDI PAPER MILLS', reference: 'BH-01', registrationNumber: 'T275EAA',
  name: 'Backhoe', category: 'Backhoe', makeModel: 'JCB', fuelType: 'Diesel', contractor: 'KSP',
  consumptionBasis: 'HOUR', expectedConsumption: 6, rateUnit: 'Ltrs/Hr',
  fuelSensorFitted: true, gpsUnitId: '30356417', active: true, ...o,
})

const blank = {
  machineId: null, equipmentType: null, equipmentCategory: null, equipmentReference: null,
  makeModel: null, contractor: null, fuelType: null, ratedConsumption: null,
  ratedConsumptionBasis: null, fuelSensorFitted: null,
  machineName: null, machineRegistrationNumber: null, ratedConsumptionUnit: null,
}

function fakeDb(vehicles: Record<string, unknown>[]) {
  const update = vi.fn(async (_args: unknown) => ({}))
  const db = {
    organisation: { findUnique: vi.fn(async () => ({ id: 'org-kasulu' })) },
    vehicle:      { findMany: vi.fn(async () => vehicles), update },
  } as unknown as PrismaClient
  return { db, update }
}

describe('syncMachineRegister', () => {
  it('joins on the GPS id and writes the type and rated consumption', async () => {
    const { db, update } = fakeDb([{ id: 'v1', externalId: 'wialon:30356417', name: 'MUFINDI: BH 01', ...blank }])
    const r = await syncMachineRegister(db, [machine({})], { apply: true })
    expect(r.matched).toEqual([{ vehicle: 'MUFINDI: BH 01', reference: 'BH-01', via: 'gps' }])
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0]![0]).toMatchObject({
      where: { id: 'v1' },
      data:  {
        machineId: 'm-bh01', equipmentType: 'Backhoe', machineName: 'Backhoe', machineRegistrationNumber: 'T275EAA',
        makeModel: 'JCB', fuelType: 'Diesel', ratedConsumption: 6, ratedConsumptionBasis: 'HOURS', ratedConsumptionUnit: 'Ltrs/Hr',
      },
    })
  })

  it('writes nothing when the register has not changed', async () => {
    const { db, update } = fakeDb([{
      id: 'v1', externalId: 'wialon:30356417', name: 'MUFINDI: BH 01',
      machineId: 'm-bh01', equipmentType: 'Backhoe', equipmentCategory: 'Backhoe', equipmentReference: 'BH-01',
      makeModel: 'JCB', contractor: 'KSP', fuelType: 'Diesel', ratedConsumption: 6,
      ratedConsumptionBasis: 'HOURS', fuelSensorFitted: true,
      machineName: 'Backhoe', machineRegistrationNumber: 'T275EAA', ratedConsumptionUnit: 'Ltrs/Hr',
    }])
    const r = await syncMachineRegister(db, [machine({})], { apply: true })
    expect(r.written).toBe(0)
    expect(update).not.toHaveBeenCalled()
  })

  it('clears a vehicle whose register row now points at another unit', async () => {
    const { db, update } = fakeDb([
      { id: 'old', externalId: 'wialon:111', name: 'MUFINDI: BH 01', ...blank, machineId: 'm-bh01', equipmentType: 'Backhoe' },
      { id: 'new', externalId: 'wialon:30356417', name: 'MUFINDI: BH 01 (new tracker)', ...blank },
    ])
    const r = await syncMachineRegister(db, [machine({})], { apply: true })
    expect(r.cleared).toBe(1)
    expect(update.mock.calls[0]![0]).toMatchObject({ where: { id: 'old' }, data: { machineId: null } })
    expect(update.mock.calls[1]![0]).toMatchObject({ where: { id: 'new' }, data: { machineId: 'm-bh01' } })
  })

  it('reports a GPS id we do not hold, and never matches by plate', async () => {
    const { db, update } = fakeDb([{ id: 'v1', externalId: 'wialon:29038708', name: 'MUFINDI: OPTIM - CTR 06', ...blank }])
    const r = await syncMachineRegister(db, [machine({ reference: 'CTR-06', gpsUnitId: '30302527' })], { apply: true })
    expect(r.matched).toHaveLength(0)
    expect(r.noVehicle.map(m => m.reference)).toEqual(['CTR-06'])
    expect(update).not.toHaveBeenCalled()
  })

  it('does not write in preview', async () => {
    const { db, update } = fakeDb([{ id: 'v1', externalId: 'wialon:30356417', name: 'MUFINDI: BH 01', ...blank }])
    const r = await syncMachineRegister(db, [machine({})], { apply: false })
    expect(r.matched).toHaveLength(1)
    expect(update).not.toHaveBeenCalled()
  })
})

describe('register normalisation', () => {
  it('cleans categories without merging machine kinds', () => {
    expect(equipmentTypeOf('Concret Mixer')).toBe('Concrete Mixer')
    expect(equipmentTypeOf('CONCRETE MIXER')).toBe('Concrete Mixer')
    expect(equipmentTypeOf('FES - LMV')).toBe('LMV')
    expect(equipmentTypeOf('Hired Truck')).toBe('Truck')
    expect(equipmentTypeOf('DIESEL GENERATORS')).toBe('Diesel Generator')
    expect(equipmentTypeOf('CASE PUMA')).toBe('Case Puma')
    expect(equipmentTypeOf(null)).toBeNull()
  })

  it('reads km/L as DISTANCE without inverting it, and refuses a blank rate', () => {
    expect(ratedConsumptionOf(machine({ consumptionBasis: 'KM_PER_LITRE', expectedConsumption: 2.6 })))
      .toEqual({ value: 2.6, basis: 'DISTANCE' })
    expect(ratedConsumptionOf(machine({ expectedConsumption: null }))).toBeNull()
  })

  it('reads fleet numbers from both spellings', () => {
    expect(fleetCodeOf('BH-01')).toBe('BH01')
    expect(fleetCodeOf('MUFINDI: BH 01')).toBe('BH01')
    expect(fleetCodeOf('T441EPH')).toBeNull()
  })
})
