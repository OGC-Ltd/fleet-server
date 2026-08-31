/**
 * Reading structure out of a Wialon unit NAME.
 *
 * Wialon stores a unit's name and almost nothing else — no plate field, no
 * body type, no department. What structure exists lives in the naming
 * convention the operator types by hand, which differs per customer, so each
 * fleet gets its own reader here rather than one regex pretending to cover all
 * of them.
 *
 * Menengai's convention, measured across all 244 units of account 25601229 on
 * 2026-08-31:
 *
 *     <DEPARTMENT> - Menengai - <PLATE>        CPO - Menengai - KCC 386Z
 *     <DEPARTMENT> - RAIMDF   - <PLATE|ASSET>  FG  - RAIMDF   - KCP 070P
 *     MORL FARM EQUIPMENT     - <PLATE|ASSET>  MORL FARM EQUIPMENT - KTCC 085A
 *
 * ## Why the business unit is part of the group key
 *
 * The account holds three businesses — Menengai (210 units), Rai MDF (20) and
 * MORL Farm (14) — and the operator confirmed on 2026-08-31 that all three
 * belong to one organisation. `FG` is a department in TWO of them: 71 Menengai
 * units and 13 Rai MDF ones. Keying vehicle groups on the department alone —
 * the obvious reading of the name — silently merges 84 vehicles from two
 * separate businesses into one group. So the key is <business unit>/<dept>,
 * derived in that order.
 */

/** The three businesses inside Wialon account 25601229. */
export type MenengaiBusinessUnit = 'MENENGAI' | 'RAIMDF' | 'MORL'

export interface MenengaiUnitName {
  businessUnit: MenengaiBusinessUnit
  /** Department or equipment code, uppercased. `GENERAL` when the name has none. */
  department:   string
  /** Normalised registration, or null for the 17 units that carry no plate. */
  plate:        string | null
}

/**
 * Order matters and is not alphabetical: it is most-specific-first.
 *
 * No name in the account carries two of these words (checked across all 244),
 * so the order is currently cosmetic — but it is fixed here so that a future
 * unit named "FG - RAIMDF - Menengai …" resolves deterministically rather
 * than by whichever branch happened to be written first.
 */
const BUSINESS_UNITS: Array<[MenengaiBusinessUnit, RegExp]> = [
  ['RAIMDF',   /RAIMDF/i],
  ['MORL',     /\bMORL\b/i],
  ['MENENGAI', /MENENGAI/i],
]

/**
 * Kenyan plate: 2-4 letters, 3-4 digits, optional trailing letter.
 *
 * Deliberately a separate copy from the one in prisma/sync-sukari-wialon.ts.
 * That one additionally strips fuel-economy suffixes ("2km/l") that are fused
 * onto Sukari plates; no Menengai name carries one, and importing that
 * machinery here would mean maintaining a shape this fleet does not have.
 *
 * Anchored on the digits, which is what keeps asset names out: "EXCAVATOR 002"
 * and "TRACTOR 02" have too few digits, "YUVRAJ 215" and "JCB 1 H00052413"
 * have no letter-run on a word boundary immediately before the digits. All 17
 * unplated units were confirmed by hand against this expression.
 */
const PLATE_RE = /\b([A-Z]{2,4}\s*\d{3,4}\s*[A-Z]?)\b/

/** Compare plates on letters and digits only — operators space them by hand. */
export const normalisePlate = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

const segments = (name: string): string[] =>
  name.split(/\s*-\s*/).map(s => s.trim()).filter(Boolean)

/**
 * The registration in a unit name, or null.
 *
 * Scans segments in order and takes the FIRST match, which is what separates a
 * plate from a device model written after it: "CPO - Menengai - KCC 386Z -
 * FMB140" ends in a Teltonika part number that satisfies the plate shape on
 * its own. Reading left to right, the real plate is found first.
 */
export function menengaiPlate(name: string): string | null {
  for (const part of segments(name)) {
    const m = part.toUpperCase().match(PLATE_RE)
    if (m) return normalisePlate(m[1]!)
  }
  return null
}

/**
 * The department, from the leading segment.
 *
 * The rule is one line — the first token that is not the business unit's own
 * name — and it was chosen because it settles every measured variant without a
 * lookup table of special cases:
 *
 *   "VS Menengai CAMERA - KCS 078M"  → VS       (the MDVR truck, not its own dept)
 *   "Menengai - LOGGER 01"           → GENERAL  (no department segment at all)
 *   "MORL FARM EQUIPMENT - …"        → FARM     (MORL is the business unit)
 *   "MORL FARM - GENSET PACKHOUSE"   → FARM     (…and the double-spaced variant)
 *   "TR- RAIMDF - TRACTOR 01"        → TR       (the missing space is a split artefact)
 *   "RAIMDF - KDJ 069X"              → GENERAL
 */
function departmentOf(leading: string, businessUnit: MenengaiBusinessUnit): string {
  const own = businessUnit === 'MENENGAI' ? /^MENENGAI$/ : businessUnit === 'MORL' ? /^MORL$/ : /^RAIMDF$/
  for (const token of leading.toUpperCase().split(/\s+/)) {
    if (token && !own.test(token)) return token
  }
  return 'GENERAL'
}

/** Parse one Menengai-account unit name. */
export function parseMenengaiUnit(name: string): MenengaiUnitName {
  const businessUnit = BUSINESS_UNITS.find(([, re]) => re.test(name))?.[0] ?? 'MENENGAI'
  return {
    businessUnit,
    department: departmentOf(segments(name)[0] ?? '', businessUnit),
    plate:      menengaiPlate(name),
  }
}

/** Human label for a business unit, for group names. */
const BU_LABEL: Record<MenengaiBusinessUnit, string> = {
  MENENGAI: 'Menengai',
  RAIMDF:   'Rai MDF',
  MORL:     'MORL Farm',
}

/**
 * Vehicle group for a unit: `<business unit>/<department>`.
 *
 * The code is prefixed with the org code to match the convention every other
 * group in the database follows (`KASULU_TRACKED_UNITS`), and because
 * `vehicle_groups` is unique on (organisation_id, code) rather than on code.
 */
export function menengaiGroup(name: string): { code: string; name: string } {
  const { businessUnit, department } = parseMenengaiUnit(name)
  return {
    code: `MENENGAI_${businessUnit}_${department}`.replace(/\s+/g, '_'),
    name: `${BU_LABEL[businessUnit]} · ${department}`,
  }
}
