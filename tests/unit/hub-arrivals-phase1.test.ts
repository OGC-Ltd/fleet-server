import { describe, expect, it } from 'vitest'
import { unitClass, registerClass, type UnitClass } from '../../src/modules/route-ahead/unit-class.js'
import { etaBand, availability, inArrivalClass, classCounts } from '../../src/modules/route-ahead/hub-arrivals.js'
import { equipmentTypeOf } from '../../src/providers/raifactorysuite/raifactorysuite.machine.js'

describe('unitClass', () => {
  it('reads the register first', () => {
    expect(unitClass('TRACTOR', 'Mahindra 9200 4WD')).toBe('TRACTOR')
    expect(unitClass('PLANT', 'MUFINDI: EX 11')).toBe('PLANT')
    expect(unitClass('SALOON', 'KDA 001A')).toBe('CAR')
    expect(unitClass('LORRY', 'KCB 123A')).toBe('TRUCK')
  })
  it('takes a KT plate as a tractor where the register says nothing', () => {
    expect(unitClass('UNSPECIFIED', 'WKS - Nzoia Sugar - KTCC 224P')).toBe('TRACTOR')
    expect(unitClass('UNSPECIFIED', 'FG - Menengai - KCC 385Z')).toBe('TRUCK')
    expect(unitClass('UNSPECIFIED', 'WKS - Kabras KTCB 358X')).toBe('TRACTOR')
    expect(unitClass('UNSPECIFIED', 'WKS - Kabras - KDJ 827Z')).toBe('TRUCK')
    expect(unitClass('UNSPECIFIED', 'WKS - Kabras - KTCB358X')).toBe('TRACTOR')
  })
})

describe('unitClass from the FactorySuite machine register (KASULU)', () => {
  // Every category GET /machines sent on 2026-10-20 (367 rows), through the
  // sync's own normaliser, with the register's basis.
  const REGISTER: [string, 'HOUR' | 'KM_PER_LITRE', UnitClass][] = [
    ['Truck', 'KM_PER_LITRE', 'TRUCK'], ['Hired Truck', 'KM_PER_LITRE', 'TRUCK'],
    ['Water Bowser', 'KM_PER_LITRE', 'TRUCK'], ['Bus', 'KM_PER_LITRE', 'TRUCK'], ['Hired Bus', 'KM_PER_LITRE', 'TRUCK'],
    ['LMV', 'KM_PER_LITRE', 'CAR'], ['FES - LMV', 'KM_PER_LITRE', 'CAR'], ['Hired LMV', 'KM_PER_LITRE', 'CAR'],
    ['POLICE', 'KM_PER_LITRE', 'CAR'],
    ['Mahindra Tractor', 'HOUR', 'TRACTOR'], ['FES - Mahindra', 'HOUR', 'TRACTOR'], ['FES-Mahindra', 'KM_PER_LITRE', 'TRACTOR'],
    ['CASE PUMA', 'HOUR', 'TRACTOR'], ['CASE STEIGER', 'HOUR', 'TRACTOR'], ['CASE 110', 'HOUR', 'TRACTOR'],
    ['CASE MAGNUM', 'HOUR', 'TRACTOR'], ['Case SprayingTractor', 'HOUR', 'TRACTOR'], ['TRACTOR', 'HOUR', 'TRACTOR'],
    ['FES - Challenger', 'HOUR', 'TRACTOR'], ['FES - Fendt', 'HOUR', 'TRACTOR'], ['FES - Massey Ferguson', 'HOUR', 'TRACTOR'],
    ['Excavator', 'HOUR', 'PLANT'], ['Bull Dozer', 'HOUR', 'PLANT'], ['Wheel Loader', 'HOUR', 'PLANT'],
    ['Grader', 'HOUR', 'PLANT'], ['FES - Grader', 'KM_PER_LITRE', 'PLANT'], ['Backhoe', 'HOUR', 'PLANT'],
    ['Compactor', 'HOUR', 'PLANT'], ['COMPACTOR', 'HOUR', 'PLANT'], ['SMALLCOMPACTOR', 'HOUR', 'PLANT'],
    ['Hydra Crane', 'HOUR', 'PLANT'], ['HYDRA', 'HOUR', 'PLANT'], ['Slew Loader', 'HOUR', 'PLANT'],
    ['Concret Mixer', 'HOUR', 'PLANT'], ['CONCRETE MIXER', 'HOUR', 'PLANT'], ['Concrete Pump', 'HOUR', 'PLANT'],
    ['DRILLING MACHINE', 'HOUR', 'PLANT'], ['FES - Forklift', 'HOUR', 'PLANT'], ['FES - Chopper harvester', 'HOUR', 'PLANT'],
    ['Hired Machines', 'HOUR', 'PLANT'],
    ['DIESEL GENERATORS', 'HOUR', 'FIXED'], ['DIESEL GENERATOR', 'HOUR', 'FIXED'], ['SMALL DIESEL GENERATORS', 'HOUR', 'FIXED'],
    ['SMALL PETROL GENERATORS', 'HOUR', 'FIXED'], ['FES - Generator', 'HOUR', 'FIXED'], ['HIRED GENERATOR', 'HOUR', 'FIXED'],
    ['Hand Compactor', 'HOUR', 'FIXED'], ['Drums', 'HOUR', 'FIXED'],
  ]
  it.each(REGISTER)('%s (%s) is %s', (category, basis, want) => {
    const reg = { equipmentType: equipmentTypeOf(category), ratedConsumptionBasis: basis === 'HOUR' ? 'HOURS' : 'DISTANCE' }
    expect(unitClass('UNSPECIFIED', 'MUFINDI - X 01', reg)).toBe(want)
  })

  it('overrides the Wialon type where the two disagree (live, 2026-10-20)', () => {
    expect(unitClass('UNSPECIFIED', 'MUFINDI - DG 06', { equipmentType: 'Diesel Generator', ratedConsumptionBasis: 'HOURS' })).toBe('FIXED')
    expect(unitClass('UNSPECIFIED', 'MUFINDI - WL 08', { equipmentType: 'Wheel Loader', ratedConsumptionBasis: 'HOURS' })).toBe('PLANT')
    expect(unitClass('TRACTOR', 'MUFINDI - HYD 01', { equipmentType: 'Hydra Crane', ratedConsumptionBasis: 'HOURS' })).toBe('PLANT')
    expect(unitClass('TRUCK', 'MUFINDI - SPY 01', { equipmentType: 'Case Spraying Tractor', ratedConsumptionBasis: 'HOURS' })).toBe('TRACTOR')
    expect(unitClass('PLANT', 'MUFINDI - DB 30', { equipmentType: 'Truck', ratedConsumptionBasis: 'DISTANCE' })).toBe('TRUCK')
  })

  it('falls to the rated basis for a type no rule names, then to the Wialon type', () => {
    expect(registerClass({ equipmentType: 'Something New', ratedConsumptionBasis: 'DISTANCE' })).toBe('TRUCK')
    expect(registerClass({ equipmentType: 'Something New', ratedConsumptionBasis: 'HOURS' })).toBe('PLANT')
    expect(registerClass({ equipmentType: null, ratedConsumptionBasis: null })).toBeNull()
    expect(unitClass('BUS', 'MUFINDI - BUS 02', { equipmentType: null })).toBe('TRUCK')
    expect(unitClass('TRACTOR', 'MUFINDI - CTR 30', null)).toBe('TRACTOR')
  })
})

describe('unitClass from FactorySuite /vehicles (SUKARI = NDHIWA)', () => {
  // vehicleType is FactorySuite's own type, synced by plate; checked against
  // GET /vehicles 2026-10-20: all 594 tracked units agree.
  it('keeps FactorySuite TRACTOR, TRUCK and COMPANY_VEHICLE', () => {
    expect(unitClass('TRACTOR', '125F Bell 38 KHMA 858U')).toBe('TRACTOR')
    expect(unitClass('TRACTOR', 'KTCC 870B')).toBe('TRACTOR')
    expect(unitClass('TRUCK', 'KDL 705E')).toBe('TRUCK')
    expect(unitClass('COMPANY_VEHICLE', 'KBV 714U')).toBe('CAR')
    expect(inArrivalClass(unitClass('COMPANY_VEHICLE', 'KBV 714U'), 'VEHICLE')).toBe(true)
    expect(inArrivalClass(unitClass('TRACTOR', '125F Bell 38 KHMA 858U'), 'VEHICLE')).toBe(false)
  })
})

describe('inArrivalClass', () => {
  it('keeps plant out of "Truck or car" and generators out of everything', () => {
    expect(inArrivalClass('TRUCK', 'VEHICLE')).toBe(true)
    expect(inArrivalClass('CAR', 'VEHICLE')).toBe(true)
    expect(inArrivalClass('PLANT', 'VEHICLE')).toBe(false)
    expect(inArrivalClass('TRACTOR', 'VEHICLE')).toBe(false)
    expect(inArrivalClass('PLANT', 'PLANT')).toBe(true)
    expect(inArrivalClass('TRACTOR', 'TRACTOR')).toBe(true)
    for (const c of ['all', 'VEHICLE', 'TRACTOR', 'PLANT', 'MOTORBIKE'] as const) expect(inArrivalClass('FIXED', c)).toBe(false)
  })
  it('counts the window classes', () => {
    const row = (vehicleType: string, equipmentType: string | null) =>
      ({ vehicleId: equipmentType ?? vehicleType, name: null, vehicleType, equipmentType, lat: null, lng: null, speedKmh: null, capturedAt: null })
    expect(classCounts([row('PLANT', 'Excavator'), row('UNSPECIFIED', 'Diesel Generator'), row('SALOON', 'LMV'),
      row('TRACTOR', 'Hydra Crane'), row('TRACTOR', 'Mahindra Tractor'), row('LORRY', null)]))
      .toEqual({ VEHICLE: 2, TRACTOR: 1, PLANT: 2 })
  })
})

describe('etaBand', () => {
  it('bands only past an hour', () => {
    expect(etaBand(59 * 60)).toBeNull()
    expect(etaBand(61 * 60)).toBe('1–2 h')
    expect(etaBand(3 * 3600)).toBe('2–4 h')
    expect(etaBand(5 * 3600)).toBe('4 h+')
  })
})

describe('availability', () => {
  const now = Date.UTC(2026, 9, 15, 6)
  it('is busy on a dispatch, stale without a recent fix, else free', () => {
    expect(availability(now - 60_000, true, now)).toBe('busy')
    expect(availability(now - 45 * 60_000, false, now)).toBe('stale')
    expect(availability(now - 60_000, false, now)).toBe('free')
  })
})
