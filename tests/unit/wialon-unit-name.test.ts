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
  parseMenengaiUnit, menengaiPlate, menengaiGroup, normalisePlate, formatPlate,
  parseWestSugarUnit, westSugarGroup,
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
    expect(menengaiPlate('CPO - Menengai - KCC 386Z')).toBe('KCC 386Z')
    expect(menengaiPlate('FG - RAIMDF - KCP 070P')).toBe('KCP 070P')
    expect(menengaiPlate('MORL FARM EQUIPMENT - KTCC 085A')).toBe('KTCC 085A')
  })

  it('prefers the plate over a device part number written after it', () => {
    // FMB140 is a Teltonika model and satisfies the plate shape on its own.
    // Reading left to right is what keeps the real registration.
    expect(menengaiPlate('CPO - Menengai - KCC 386Z - FMB140')).toBe('KCC 386Z')
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

  it('stores the registration the way it is written', () => {
    // Not "KCC386Z". The 598 Sukari rows already in the table read "KHMA 994J",
    // and a plate that matches neither the vehicle's own name nor a real
    // number plate is the defect this replaced.
    expect(formatPlate('KCC386Z')).toBe('KCC 386Z')
    expect(formatPlate('kcc 386z')).toBe('KCC 386Z')
    expect(formatPlate('KTCC  271G')).toBe('KTCC 271G')
  })

  it('still compares on letters and digits only', () => {
    expect(normalisePlate('KCC 386Z')).toBe(normalisePlate('kcc386z'))
  })

  it('leaves anything that is not plate-shaped alone', () => {
    // The 85 units named by IMEI or asset keep their unit name as identifier;
    // reformatting must not mangle those.
    expect(formatPlate('West Sugar - A')).toBe('West Sugar - A')
    expect(formatPlate('MORL FARM EQUIPMENT - GENSET MOLO RIVER')).toBe('MORL FARM EQUIPMENT - GENSET MOLO RIVER')
  })
})

/**
 * West Sugar. Also all real names, and this fleet is messier than Menengai in
 * ways that are load-bearing: the name length varies from two segments to five,
 * so nothing can be read positionally, and 32 units share four names.
 */
describe('West Sugar — division', () => {
  it('separates the two naming conventions', () => {
    expect(parseWestSugarUnit('WKS - Amuka - KDR 095Q').division).toBe('WKS')
    expect(parseWestSugarUnit('West Sugar-Admin-KBJ 194Q-11km/l').division).toBe('WESTSUGAR')
  })

  it('does not treat a word merely starting with wks as the WKS division', () => {
    expect(parseWestSugarUnit('WKSOMETHING - X - KBV 196V').division).toBe('WESTSUGAR')
  })
})

describe('West Sugar — group', () => {
  it('uses the estate for WKS', () => {
    expect(parseWestSugarUnit('WKS - Naitiri - KBV 196V').group).toBe('NAITIRI')
    expect(parseWestSugarUnit('WKS - Amuka - KDR 095Q').group).toBe('AMUKA')
  })

  it('folds the estate misspellings back together', () => {
    // 12 of the 62 Kabras units are spelled KABARAS; three Naitiri names have
    // the next field run into them.
    expect(parseWestSugarUnit('WKS - Kabaras - KDL 280X').group).toBe('KABRAS')
    expect(parseWestSugarUnit('WKS - Kabras - KDL 232X').group).toBe('KABRAS')
    expect(parseWestSugarUnit('WKS - NAITIRIC - KBV 196V').group).toBe('NAITIRI')
    expect(parseWestSugarUnit('WKS - NAITIRIKDR 083Q - X').group).toBe('NAITIRI')
    expect(parseWestSugarUnit('WKS - Naitiri KTCB 257N - X').group).toBe('NAITIRI')
  })

  it('refuses to read an identifier as a group', () => {
    // Two-segment names have no middle. Reading segment[1] regardless would
    // file fifteen vehicles under a group called "A".
    expect(parseWestSugarUnit('West Sugar - A').group).toBe('GENERAL')
    expect(parseWestSugarUnit('West Sugar - D').group).toBe('GENERAL')
    expect(parseWestSugarUnit('West Sugar - 864022086783544').group).toBe('GENERAL')
    expect(parseWestSugarUnit('West Sugar-KTCB 497Z').group).toBe('GENERAL')
    // …and a plate or an IMEI sitting in the middle slot is still an identifier.
    expect(parseWestSugarUnit('WKS - KTCB 504Z - something').group).toBe('GENERAL')
    expect(parseWestSugarUnit('West Sugar - 864022086612164 - x').group).toBe('GENERAL')
  })

  it('keeps the departments West Sugar actually writes', () => {
    expect(parseWestSugarUnit('West Sugar-Admin-KBJ 194Q-11km/l').group).toBe('ADMIN')
    expect(parseWestSugarUnit('West Sugar-Winches-KTCB 497Z-2km/l').group).toBe('WINCHES')
    expect(parseWestSugarUnit('West Sugar - HP Equipment - KBV 196V').group).toBe('HP EQUIPMENT')
  })

  it('keeps the two divisions apart in the group code', () => {
    expect(westSugarGroup('WKS - Winches - KBV 196V').code).toBe('WESTSUGAR_WKS_WINCHES')
    expect(westSugarGroup('West Sugar-Winches-KTCB 497Z-2km/l').code).toBe('WESTSUGAR_WESTSUGAR_WINCHES')
    expect(westSugarGroup('West Sugar - HP Equipment - KBV 196V').code).not.toMatch(/\s/)
  })
})

describe('West Sugar — plate', () => {
  it('finds the plate before the fuel-economy figure', () => {
    // 120 names carry one. Every one is its own segment, so left-to-right
    // scanning reaches the plate first and no stripping is needed.
    expect(parseWestSugarUnit('West Sugar-Admin-KBJ 194Q-11km/l').plate).toBe('KBJ 194Q')
    expect(parseWestSugarUnit('West Sugar-Winches-KTCB 497Z-2km/l').plate).toBe('KTCB 497Z')
    expect(parseWestSugarUnit('WKS  - Naitiri -  KTCC 271G').plate).toBe('KTCC 271G')
  })

  it('returns null for the units named only by IMEI or a single letter', () => {
    for (const n of ['West Sugar - A', 'West Sugar - D', 'West Sugar - 864022086783544', 'West Sugar - CMF']) {
      expect(parseWestSugarUnit(n).plate, n).toBeNull()
    }
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
