/**
 * Vehicle classification for Wialon units.
 *
 * Wialon does not classify units — there is no body-type field. Two signals
 * exist, and they are used in order of trustworthiness:
 *
 *  1. The unit's custom "TYPE" field, where the operator filled it in. This is
 *     authoritative but sparse (8 of 224 units: BULLDOZER, Excavator, DUMP
 *     TRUCK, WATER BOWSER).
 *
 *  2. The equipment code that prefixes every unit name — "MUFINDI: BUS 03",
 *     "MUFINDI: EX 25", "MUFINDI: LMV 11". This covers the whole fleet.
 *
 * The code → type mapping below is INFERRED, corroborated by each group's
 * median fuel-tank size (a 90 L group is light vehicles; a 640 L group is
 * heavy plant). Several codes are unambiguous — BUS, EX(cavator), DZ (dozer,
 * matches the declared BULLDOZER), WL (wheel loader), GR (grader), BH
 * (backhoe), COMP (compactor). Others are a best reading of the abbreviation
 * and should be confirmed with RaiFactorySuite: the legend lives here so a
 * correction is a one-line edit, not a schema change.
 *
 * Median tank size per code, for reference when revising:
 *   EX 400 · OPTIM 402 · LMV 90 · MTR 85 · FT 385 · FTT 320 · CTR 385
 *   DZ 640 · WL 304 · BUS 100 · BH 115 · GR 500 · COMP 345 · HYD 43
 */

/** Types the dashboard renders and colours. */
export type VehicleClass =
  | 'BUS' | 'TRACTOR' | 'TRUCK' | 'LORRY' | 'SALOON' | 'PLANT' | 'UNSPECIFIED'

/**
 * Equipment code → class. The legend is the operator's, confirmed 2026-07-29.
 *
 * Where the legend was ambiguous it is settled by KM PER ENGINE HOUR, which
 * separates road haulage from plant far better than tank size does: plant runs
 * for hours without covering ground. Medians over the live fleet:
 *
 *   HFT 891 · LMV 409 · FT 51 · DB 29 · BUS 25 · FTT 24 · HST 18 · WB 16
 *   WL 12 · MTR 8 · GR 4 · DZ 3.8 · GL 3.8 · CM 2.8 · CTR 2.4 · COMP 1.9
 *   BH 1.8 · HYD 1.2 · EX 0.5
 */
const CODE_TO_CLASS: Record<string, VehicleClass> = {
  // Plant — all well under 15 km per engine hour.
  EX:    'PLANT',    // excavator — matches the declared "Excavator"
  DZ:    'PLANT',    // dozer — matches the declared "BULLDOZER"
  WL:    'PLANT',    // wheel loader
  GR:    'PLANT',    // grader
  BH:    'PLANT',    // backhoe loader
  COMP:  'PLANT',    // compactor — NOTE: distinct from COM below
  CM:    'PLANT',    // compactor, the other code the operator uses for one
  HST:   'PLANT',
  GL:    'PLANT',

  BUS:   'BUS',

  // Tractors.
  MTR:   'TRACTOR',  // motor tractor. Was SALOON, inferred from an 85 L tank —
                     // but 8 km per engine hour is not a road car.
  CTR:   'TRACTOR',  // cane tractor. The legend allows "container truck" too;
                     // 2.4 km per engine hour rules that out — a container
                     // truck sits with FT/FTT at 24-51.
  HYD:   'TRACTOR',  // operator-confirmed. Was PLANT, guessed from "hydraulic"
                     // and the fleet's smallest tank (43 L); 1.2 km per engine
                     // hour fits a tractor working a field either way.

  // Haulage.
  FT:    'TRUCK',    // flatbed truck. Was TRACTOR, inferred from a 385 L tank.
  FTT:   'LORRY',    // flatbed TRAILER truck — the trailer is why it is LORRY
                     // rather than TRUCK, matching HFT.
  HFT:   'LORRY',    // heavy flatbed / freight truck — 891 km per engine hour
  DB:    'TRUCK',    // dump body
  WB:    'TRUCK',    // water bowser (a declared TYPE value)
  COM:   'TRUCK',    // commercial vehicle
  SPY:   'TRUCK',

  // Light vehicles.
  LMV:   'SALOON',   // light motor vehicle

  // NOT codes, deliberately absent:
  //   T — a Tanzanian PLATE letter ("MUFINDI:T199 ELC"), not equipment.
  //   I — never real; it was the old regex backtracking through "MUFIND|I"
  //       on the 29 units named "MUFINDI: 002" style, with no code at all.
}

/**
 * Declared TYPE values → class. Free text, so matched case-insensitively on
 * distinctive words rather than exact strings.
 */
function fromDeclaredType(value: string): VehicleClass | null {
  const v = value.toLowerCase()
  if (/bulldozer|dozer|excavator|loader|grader|compactor|backhoe/.test(v)) return 'PLANT'
  if (/bus|coach/.test(v))                    return 'BUS'
  if (/tractor/.test(v))                      return 'TRACTOR'
  if (/lorry|trailer|prime\s*mover/.test(v))  return 'LORRY'
  if (/truck|bowser|tipper/.test(v))          return 'TRUCK'
  if (/saloon|sedan|car|pick\s*-?up|d\/?cab/.test(v)) return 'SALOON'
  return null
}

/**
 * Pull the equipment code out of a unit name.
 *
 * Scans the tokens for the first one that IS a known code, rather than
 * assuming a fixed position. Two shapes in this account defeat a positional
 * regex:
 *
 *   "MUFINDI: OPTIM - CM 01"  a SITE prefix sits between org and code, so the
 *                             29 OPTIM units were read as code "OPTIM" and
 *                             classified UNSPECIFIED despite carrying real
 *                             codes (CM, COMP, CTR, …).
 *   "MUFINDI: 002"            no code at all — the old regex backtracked
 *                             through "MUFINDI" and captured a bare "I".
 *
 * Unknown tokens are skipped, so a name with no code yields null and stays
 * UNSPECIFIED rather than being forced into a bucket.
 */
function codeFromName(name: string): string | null {
  for (const token of name.toUpperCase().split(/[^A-Z0-9]+/)) {
    if (token && token in CODE_TO_CLASS) return token
  }
  return null
}

/**
 * Classify a unit. The operator's declared TYPE wins; otherwise the equipment
 * code in the name decides. A name with no recognisable code stays
 * UNSPECIFIED rather than being forced into a bucket.
 */
export function classifyUnit(
  name: string,
  customFields?: Record<string, { n: string; v: string }>,
): VehicleClass {
  for (const f of Object.values(customFields ?? {})) {
    if (!/^type$/i.test(f.n) || !f.v) continue
    const declared = fromDeclaredType(f.v)
    if (declared) return declared
  }

  const code = codeFromName(name)
  return (code && CODE_TO_CLASS[code]) || 'UNSPECIFIED'
}
