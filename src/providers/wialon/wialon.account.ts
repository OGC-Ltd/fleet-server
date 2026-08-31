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
 * ## Two fleets, two shapes
 *
 * KASULU and MENENGAI each own their account outright, so `bact` is the whole
 * boundary and the table below is the whole policy.
 *
 * WEST KENYA SUGAR is deliberately absent, and so is SUKARI, for the same
 * reason: neither has a single unit billed to its own account. "WEST KENYA
 * SUGAR" exists as resource 28842931 and holds 7 zones, but ZERO units carry
 * that `bact` — all 486 of them (299 named `West Sugar*`, 187 named `WKS*`)
 * sit under RAI GROUP beside Sukari's 344. Separating those needs a name mask,
 * which is what `sync:sukari-gps` already does for Sukari, and this table
 * would be lying if it implied `bact` could do it.
 */

import { menengaiGroup, menengaiPlate } from './wialon.unit-name.js'

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

export interface WialonFleet {
  /** Our `organisations.code`. */
  orgCode:  string
  /** Name used when the shell organisation is seeded. */
  orgName:  string
  /** The account that owns this fleet's units, and its geozone resource. */
  accountId: number
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
    orgName:   'Menengai Group',
    accountId: MENENGAI_WIALON_ACCOUNT_ID,
    groupOf:   menengaiGroup,
    // 227 of the 244 units name a real registration; the other 17 are plant and
    // gensets ("MORL FARM EQUIPMENT - GENSET MOLO RIVER"). Those keep the unit
    // name, so the column stays unique and the screen says what Wialon says
    // rather than a blank or an invented code.
    plateOf:   (nm) => menengaiPlate(nm) ?? nm.trim(),
  },
]

/** The fleet definition for an organisation code, or null if it has none. */
export function findFleet(orgCode: string): WialonFleet | null {
  const wanted = orgCode.trim().toUpperCase()
  return FLEETS.find(f => f.orgCode === wanted) ?? null
}

/** Every org code this module can sync — used for the CLI's error message. */
export const syncableOrgCodes = (): string[] => FLEETS.map(f => f.orgCode)
