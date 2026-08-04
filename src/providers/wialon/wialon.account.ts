/**
 * WHICH Wialon units and zones belong to WHICH of our organisations.
 *
 * The token started out seeing one customer. It now sees eight accounts and
 * 1,504 units — Rai Group, West Kenya Sugar, Menengai, Timsales, Aquamist,
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
 * Measured against the live account 2026-08-02:
 *
 *     bact 30394506  "Mufindi Paper Mills"  218 units, 107 zones   ← KASULU
 *     bact 27625222  "RAI GROUP"            922 units
 *     bact 25601229  "Mene-ngai"            244 units, 6,169 zones
 *     bact 26777960  (Timsales)             114 units
 *     …four more, 6 units between them
 *
 * 218 is exactly the number of Kasulu vehicles our database holds that are
 * still visible in Wialon, which is the confirmation that this is the right
 * boundary and not merely a plausible one.
 *
 * SUKARI is deliberately absent. Its units sit under the shared RAI GROUP
 * account alongside West Kenya Sugar's, so `bact` does not separate them —
 * `sync:sukari-gps` scopes by the `SUKARI*` name mask instead, and matches
 * plates only within the Sukari org, so a neighbouring estate's unit cannot
 * bind to a Sukari vehicle.
 */

/**
 * Kasulu's Wialon account, and the resource its geozones hang off.
 *
 * One number: a unit's `bact` and its account's resource id are the same value.
 */
export const KASULU_WIALON_ACCOUNT_ID = 30394506

/** Data flag that returns `bact`. Without it every unit looks unowned. */
export const BILLING_PROPS_FLAG = 0x4
