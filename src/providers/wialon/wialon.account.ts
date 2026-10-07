/**
 * WHICH Wialon units and zones belong to WHICH of our organisations.
 *
 * The token started out seeing one customer. It now sees eight accounts and
 * 1,496 units — Rai Group, West Kenya Sugar, Menengai, Timsales, Aquamist,
 * Exon, Sukari and Mufindi Paper Mills — because the reseller kept adding
 * estates to the same credential. Every script that said "give me the units"
 * or "give me the resource" silently grew a blast radius:
 *
 *   • `sync:wialon` iterated ALL of them into the KASULU org. Measured
 *     2026-08-02, a run would have UPDATED 218 rows and CREATED 1,286 —
 *     every West Sugar, Timsales and Aquamist unit imported as a Kasulu
 *     vehicle, with a telemetry ping each.
 *   • `sync:geofences` took `resources[0]`, which is now "AQAUMIST LTD" with
 *     ZERO zones, so it imported nothing at all. The neighbouring entry,
 *     "Mene-ngai", holds 6,169 zones — one shift in Wialon's sort order and it
 *     would have written those into Kasulu instead.
 *
 * ## The key
 *
 * A unit's `bact` is the id of the ACCOUNT that owns it, returned under data
 * flag `0x4` (billing properties), and it equals that account's resource id.
 * It is the durable answer: it survives renames, which matter here — four
 * Kasulu units have already been renamed `XNMUFINDI: …` as they were retired,
 * and a name-prefix filter has to keep guessing at conventions like that.
 *
 * Re-measured against the live account 2026-08-31:
 *
 *     bact 27625222  "RAI GROUP"            915 units          41 zones
 *     bact 25601229  "Mene-ngai"            244 units, all reporting, 6,169 zones
 *     bact 30394506  "Mufindi Paper Mills"  214 units          12 zones   ← KASULU
 *     bact 26777960  (Timsales)             115 units
 *     …five more, 8 units between them
 *
 * ## Two shapes of boundary
 *
 * KASULU and MENENGAI each own their account outright, so `bact` is the whole
 * boundary for them.
 *
 * WEST SUGAR does not. "WEST KENYA SUGAR" exists as resource 28842931 and
 * holds 7 zones, but ZERO units carry that `bact` — all 486 of them (299 named
 * `West Sugar*`, 187 named `WKS*`) sit under RAI GROUP beside Sukari's 344. So
 * that fleet is `bact` AND a name mask, never the mask alone: one more unit
 * named "West Sugar - 862129083035851" sits under account 17082202, a two-unit
 * account that also holds a Menengai-named vehicle, and a bare name mask would
 * sweep it in from a customer boundary nobody has confirmed.
 *
 * SUKARI stays absent. Its registry comes from RaiFactorySuite, and Wialon only
 * supplies the GPS binding — `sync:sukari-gps` matches those by PLATE onto rows
 * that already exist. Nothing here should create Sukari vehicles.
 */

import { menengaiGroup, menengaiPlate, westSugarGroup, parseWestSugarUnit } from './wialon.unit-name.js'
import { classifyByNameAndTank, statedTankCapacity, type VehicleClass } from './wialon.vehicle-type.js'
import type { WialonSensor } from './wialon.sensors.js'

/** Data flag that returns `bact`. Without it every unit looks unowned. */
export const BILLING_PROPS_FLAG = 0x4

/**
 * Kasulu's Wialon account, and the resource its geozones hang off.
 *
 * One number: a unit's `bact` and its account's resource id are the same value.
 */
export const KASULU_WIALON_ACCOUNT_ID = 30394506

/** Menengai's, holding Menengai, Rai MDF and MORL Farm — one organisation. */
export const MENENGAI_WIALON_ACCOUNT_ID = 25601229

/** Rai Group's shared account: Sukari, West Sugar, WKS, Aquamist and Pan Paper. */
export const RAI_GROUP_WIALON_ACCOUNT_ID = 27625222

/**
 * West Sugar's own resource — its REPORTS, not its units.
 *
 * Not an account id and deliberately not in `FLEETS`: zero units carry this
 * `bact`, so it can never answer "whose unit is this". What it holds is the
 * fleet's report templates, including the per-unit Advanced Fuel Analysis the
 * fuel sync reads its fillings and drains from. RAI GROUP, where the units
 * actually bill, carries no such template at all.
 *
 * The same split Sukari already has (units under RAI GROUP, reports on 28843152),
 * which is why `ORG_RESOURCES` in fuel-sync states both ids per org rather than
 * deriving one from the other.
 */
export const WEST_SUGAR_REPORT_RESOURCE_ID = 28842931

/**
 * Timsales owns its account outright, like Kasulu and Menengai. Measured
 * 2026-10-07: 115 units, every one named "Timsales …" (or "EX - Timsales …"
 * for retired ones), 104 reporting in the last day, all 115 with a fuel sensor.
 *
 * The token sees NO resource for this account — no zones and no report
 * templates — so Timsales has vehicles and live positions but no fuel ledger
 * (fuel-sync ORG_RESOURCES) and no geofences until the reseller shares one.
 */
export const TIMSALES_WIALON_ACCOUNT_ID = 26777960

/**
 * Aquamist's resource — zones and reports, not units (the West Sugar split).
 *
 * Its 77 units bill to RAI GROUP and are named "AQUAMIST - <plate>". This
 * resource ("Aquamist") holds 4 zones and the per-vehicle Advanced Fuel
 * Analysis template. "AQAUMIST LTD" (29564956, sic) is a second, empty one —
 * zero zones, one test template — and is not used.
 */
export const AQUAMIST_RESOURCE_ID = 29561763

export interface WialonFleet {
  /** Our `organisations.code`. */
  orgCode:  string
  /** Name used when the shell organisation is seeded. */
  orgName:  string
  /** The account that owns this fleet's units, and its geozone resource. */
  accountId: number
  /**
   * When the account holds MORE than this fleet, the names that are ours.
   *
   * Applied on top of `accountId`, never instead of it. Rai Group's account
   * carries five customers; without this, one org would swallow all 915 units.
   */
  nameMask?: RegExp
  /** Which vehicle group a unit belongs to, read from its name. */
  groupOf:  (unitName: string) => { code: string; name: string }
  /**
   * What goes in `vehicles.registration_plate`.
   *
   * The column is globally UNIQUE, so this must return something distinct per
   * unit. A fleet whose names carry no plate returns the name itself, which is
   * what Kasulu has always done — Wialon exposes no plate field and its custom
   * fields on that account are telematics metadata (PROBE IDENTIFIER, SIMCARD
   * ICCID, TIGO), not registrations.
   */
  plateOf:  (unitName: string) => string
  /**
   * The fleet's own vehicle-type rule, where the shared code legend
   * (classifyUnit) cannot read its names. Absent → classifyUnit.
   */
  typeOf?:  (unitName: string, sensors?: Record<string, WialonSensor>) => VehicleClass
  /**
   * The fleet's own tank-capacity reader, where its sensor names state the
   * tank in a spelling the shared `tankCapacityOf` does not read. Absent →
   * tankCapacityOf.
   */
  tankOf?:  (sensors?: Record<string, WialonSensor>) => number | null
}

const FLEETS: WialonFleet[] = [
  {
    orgCode:   'KASULU',
    orgName:   'Kasulu Ltd',
    accountId: KASULU_WIALON_ACCOUNT_ID,
    // Wialon gives us no classification to split this fleet on: every unit is
    // named "MUFINDI - <code|IMEI>" with no department segment.
    groupOf:   () => ({ code: 'KASULU_TRACKED_UNITS', name: 'TRACKED UNITS' }),
    plateOf:   (nm) => nm.trim(),
  },
  {
    orgCode:   'MENENGAI',
    orgName:   'Menengai',
    accountId: MENENGAI_WIALON_ACCOUNT_ID,
    groupOf:   menengaiGroup,
    // 227 of the 244 units name a real registration; the other 17 are plant and
    // gensets ("MORL FARM EQUIPMENT - GENSET MOLO RIVER"). Those keep the unit
    // name, so the column stays unique and the screen says what Wialon says
    // rather than a blank or an invented code.
    plateOf:   (nm) => menengaiPlate(nm) ?? nm.trim(),
    // 36 units state their tank as "(Qty 600L)"; 2026-10-07, on request.
    tankOf:    statedTankCapacity,
  },
  {
    orgCode:   'WESTSUGAR',
    orgName:   'West Sugar',
    accountId: RAI_GROUP_WIALON_ACCOUNT_ID,
    // `\b` after each alternative, so "WKSOMETHING" is not West Sugar. Anchored,
    // so a Sukari unit that merely mentions the words cannot drift in.
    // Kabras ("WKS - Kabras - …") and Nzoia ("WKS - Nzoia Sugar/Quarry - …")
    // are their own organisations since 2026-10-07 — excluded here, or this
    // sync would claim them back.
    nameMask:  /^\s*(west\s*sugar|wks)\b(?!\s*-\s*(kabras|nzoia)\b)/i,
    groupOf:   westSugarGroup,
    // 421 of 486 name a plate. The remainder are IMEIs and single letters, and
    // 32 units share just four names between them ("West Sugar - A" fifteen
    // times), so the unit name alone is NOT an identifier for this fleet — the
    // sync's duplicate resolution is what finally makes the column unique.
    plateOf:   (nm) => parseWestSugarUnit(nm).plate ?? nm.trim(),
    // 23 units state their tank as "(Qty 593L)"; 2026-10-07, on request.
    tankOf:    statedTankCapacity,
  },
  {
    // Kabras Sugar: the West Kenya units named "WKS - Kabras - …", split into
    // their own organisation on request (2026-10-07). 154 units in Rai Group's
    // account; West Kenya keeps the other 309 (Nzoia, Naitiri, …). Reports
    // and fuel templates are on the West Kenya resource, shared with WESTSUGAR.
    orgCode:   'KABRAS',
    orgName:   'Kabras Sugar',
    accountId: RAI_GROUP_WIALON_ACCOUNT_ID,
    nameMask:  /^\s*(west\s*sugar|wks)\s*-\s*kabras\b/i,
    groupOf:   westSugarGroup,
    plateOf:   (nm) => parseWestSugarUnit(nm).plate ?? nm.trim(),
    tankOf:    statedTankCapacity,
  },
  {
    // Nzoia Sugar: "WKS - Nzoia Sugar - …" (59) and "WKS - Nzoia Quarry - …"
    // (1), split out of West Kenya on request (2026-10-07), as Kabras was.
    // The six "SUKARI - Nzoia Sugar - …" units are Sukari's register and stay.
    orgCode:   'NZOIA',
    orgName:   'Nzoia Sugar',
    accountId: RAI_GROUP_WIALON_ACCOUNT_ID,
    nameMask:  /^\s*(west\s*sugar|wks)\s*-\s*nzoia\b/i,
    groupOf:   westSugarGroup,
    plateOf:   (nm) => parseWestSugarUnit(nm).plate ?? nm.trim(),
    tankOf:    statedTankCapacity,
  },
  {
    orgCode:   'TIMSALES',
    orgName:   'Timsales Ltd',
    accountId: TIMSALES_WIALON_ACCOUNT_ID,
    // Names carry the machine ("LOGGER 16", "CAT 7", "BULLDOZER 05") or a
    // plate, never a department — one group, as Kasulu.
    groupOf:   () => ({ code: 'TIMSALES_TRACKED_UNITS', name: 'TRACKED UNITS' }),
    // 77 of 115 name a registration; machines keep their unit name.
    plateOf:   (nm) => menengaiPlate(nm) ?? nm.trim(),
    typeOf:    classifyByNameAndTank,
    // "(Qty 97L)" / "(100L Tank)" — see statedTankCapacity.
    tankOf:    statedTankCapacity,
  },
  {
    orgCode:   'AQUAMIST',
    orgName:   'Aquamist Ltd',
    accountId: RAI_GROUP_WIALON_ACCOUNT_ID,
    // Anchored, so no Sukari or West Sugar unit can match. All 77 measured
    // units read "AQUAMIST - <plate>".
    nameMask:  /^\s*aquamist\b/i,
    groupOf:   () => ({ code: 'AQUAMIST_TRACKED_UNITS', name: 'TRACKED UNITS' }),
    plateOf:   (nm) => menengaiPlate(nm) ?? nm.trim(),
    typeOf:    classifyByNameAndTank,
    // "(Qty 97L)" / "(100L Tank)" — see statedTankCapacity.
    tankOf:    statedTankCapacity,
  },
]

/** The fleet definition for an organisation code, or null if it has none. */
export function findFleet(orgCode: string): WialonFleet | null {
  const wanted = orgCode.trim().toUpperCase()
  return FLEETS.find(f => f.orgCode === wanted) ?? null
}

/** Every org code this module can sync — used for the CLI's error message. */
export const syncableOrgCodes = (): string[] => FLEETS.map(f => f.orgCode)
