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

/** Equipment code → class. Edit here when RaiFactorySuite confirms the legend. */
const CODE_TO_CLASS: Record<string, VehicleClass> = {
  // Unambiguous
  BUS:   'BUS',
  EX:    'PLANT',    // excavator — matches the declared "Excavator"
  DZ:    'PLANT',    // dozer — matches the declared "BULLDOZER"
  WL:    'PLANT',    // wheel loader
  GR:    'PLANT',    // grader
  BH:    'PLANT',    // backhoe
  COMP:  'PLANT',    // compactor
  HYD:   'PLANT',    // hydraulic unit — 43 L, the smallest group
  CM:    'PLANT',
  HST:   'PLANT',
  GL:    'PLANT',

  // Tractors — large tanks (320–385 L), consistent with farm/crawler tractors
  FT:    'TRACTOR',  // farm tractor
  FTT:   'TRACTOR',  // farm tractor + trailer
  CTR:   'TRACTOR',  // crawler tractor
  T:     'TRACTOR',

  // Light vehicles — 85–90 L tanks
  LMV:   'SALOON',   // light motor vehicle
  MTR:   'SALOON',

  // Haulage
  DB:    'TRUCK',    // dump body
  HFT:   'LORRY',    // 593 L — heavy freight
  WB:    'TRUCK',    // water bowser (a declared TYPE value)
  SPY:   'TRUCK',
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

const NAME_CODE = /^[A-Za-z]+\s*[:\-]?\s*([A-Za-z]+)/

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

  const code = NAME_CODE.exec(name.trim())?.[1]?.toUpperCase()
  return (code && CODE_TO_CLASS[code]) || 'UNSPECIFIED'
}
