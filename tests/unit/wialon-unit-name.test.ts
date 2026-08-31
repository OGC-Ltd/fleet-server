/**
 * Reading Menengai's Wialon unit names.
 *
 * Every name below is a REAL one, copied from account 25601229 on 2026-08-31.
 * They are here because each defeats the obvious implementation:
 *
 *   • `FG` is a department in two different businesses — the case that forces
 *     the business unit into the group key.
 *   • four names are typed inconsistently ("TR- RAIMDF", "MORL FARM  -" with a
 *     double space, "VS Menengai CAMERA", a bare "RAIMDF -") and must land in
 *     the same groups as their well-formed siblings rather than inventing four
 *     one-vehicle groups.
 *   • one unit carries a device part number that satisfies the plate shape,
 *     AFTER the real plate.
 */

import { describe, it, expect } from 'vitest'
import {
  parseMenengaiUnit, menengaiPlate, menengaiGroup, normalisePlate,
} from '../../src/providers/wialon/wialon.unit-name.js'

describe('business unit', () => {
  it('separates the three businesses sharing the account', () => {
    expect(parseMenengaiUnit('CPO - Menengai - KCC 386Z').businessUnit).toBe('MENENGAI')
    expect(parseMenengaiUnit('FG - RAIMDF - KCP 070P').businessUnit).toBe('RAIMDF')
    expect(parseMenengaiUnit('MORL FARM EQUIPMENT - KTCC 085A').businessUnit).toBe('MORL')
  })

  it('reads Rai MDF from the middle segment, not the leading one', () => {
    // The leading segment is the DEPARTMENT here — the business is named second.
    expect(parseMenengaiUnit('WL - RAIMDF - WLOADER 01').businessUnit).toBe('RAIMDF')
  })
})

describe('department', () => {
  it('keeps the same department in two businesses apart', () => {
    // The whole reason the group key carries the business unit: 71 Menengai
    // units and 13 Rai MDF ones both lead with FG.
    const men = menengaiGroup('FG - Menengai - KDJ 083J')
    const mdf = menengaiGroup('FG - RAIMDF - KCP 070P')

    expect(men.code).not.toBe(mdf.code)
    expect(men.code).toBe('MENENGAI_MENENGAI_FG')
    expect(mdf.code).toBe('MENENGAI_RAIMDF_FG')
    expect(men.name).toBe('Menengai · FG')
    expect(mdf.name).toBe('Rai MDF · FG')
  })

  it('files the camera truck under its department, not a group of its own', () => {
    // "VS Menengai CAMERA - KCS 078M" is the one MDVR unit in the fleet. It is
    // a VS truck that happens to carry a recorder.
    expect(parseMenengaiUnit('VS Menengai CAMERA - KCS 078M').department).toBe('VS')
    expect(parseMenengaiUnit('VS - Menengai - KCS 078M').department).toBe('VS')
  })

  it('survives the hand-typed variants', () => {
    expect(parseMenengaiUnit('TR- RAIMDF - TRACTOR 01').department).toBe('TR')
    expect(parseMenengaiUnit('TR - RAIMDF - TRACTOR 02').department).toBe('TR')
    // Double space before the dash.
    expect(parseMenengaiUnit('MORL FARM  - GENSET PACKHOUSE').department).toBe('FARM')
    expect(parseMenengaiUnit('MORL FARM EQUIPMENT - GENSET MOLO RIVER').department).toBe('FARM')
  })

  it('says GENERAL when the name carries no department at all', () => {
    expect(parseMenengaiUnit('Menengai - LOGGER 01').department).toBe('GENERAL')
    expect(parseMenengaiUnit('RAIMDF - KDJ 069X').department).toBe('GENERAL')
  })
})

describe('plate', () => {
  it('reads the registration out of each business unit’s shape', () => {
    expect(menengaiPlate('CPO - Menengai - KCC 386Z')).toBe('KCC386Z')
    expect(menengaiPlate('FG - RAIMDF - KCP 070P')).toBe('KCP070P')
    expect(menengaiPlate('MORL FARM EQUIPMENT - KTCC 085A')).toBe('KTCC085A')
  })

  it('prefers the plate over a device part number written after it', () => {
    // FMB140 is a Teltonika model and satisfies the plate shape on its own.
    // Reading left to right is what keeps the real registration.
    expect(menengaiPlate('CPO - Menengai - KCC 386Z - FMB140')).toBe('KCC386Z')
  })

  it('returns null for the plant and gensets rather than a near-miss', () => {
    // All 17 unplated units in the account are one of these shapes. Each has
    // digits somewhere; none is a registration.
    for (const name of [
      'CIVIL - Menengai - EXCAVATOR 002',
      'CIVIL - Menengai - EXCAVATOR001',
      'FL - RAIMDF - FORKLIFT 04',
      'LOGYARD - Menengai - JCB 1 H00052413',
      'Menengai - LOGGER 01',
      'MORL FARM  - GENSET PACKHOUSE',
      'MORL FARM EQUIPMENT - COMBINED HARVESTER',
      'MORL FARM EQUIPMENT - YUVRAJ 215',
      'TR- RAIMDF - TRACTOR 01',
      'WL - RAIMDF - WLOADER 01',
    ]) {
      expect(menengaiPlate(name), name).toBeNull()
    }
  })

  it('compares plates on letters and digits only', () => {
    expect(normalisePlate('KCC 386Z')).toBe(normalisePlate('kcc386z'))
  })
})

describe('group codes', () => {
  it('never contains whitespace, so it is a usable unique key', () => {
    for (const name of [
      'MORL FARM  - GENSET PACKHOUSE',
      'VS Menengai CAMERA - KCS 078M',
      'Menengai - LOGGER 01',
    ]) {
      expect(menengaiGroup(name).code, name).not.toMatch(/\s/)
    }
  })
})
