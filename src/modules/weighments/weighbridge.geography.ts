/**
 * Where the scales physically are.
 *
 * ## Measured from the lorries, because nobody wrote it down
 *
 * A weighment ticket carries a centre code and a bridge number and no position
 * at all — the scale software knows its own sites and has never had a reason to
 * state where they are. There is no provider endpoint for it and no column to
 * read, so the coordinates here were DERIVED, the same way `factory-map`'s site
 * points were: from the fleet's own fixes.
 *
 * The derivation is the obvious one once stated. A lorry being weighed is
 * standing on the weighbridge. So for every ticket whose plate resolves to a
 * unit we track, take that unit's telemetry fix nearest the stamp on the scale
 * (gross and tare are two separate stamps and both count), and the bridge is
 * the consensus of those points.
 *
 * Measured on the box 2026-09-13, median of the matched fixes, with the
 * interquartile spread as the check on whether they describe ONE place:
 *
 *     centre          bridge   fixes   spread
 *     101 FACTORY        1       135    17.0 m
 *     101 FACTORY        2       169    17.2 m
 *     102 OPAPO          3       162    24.9 m
 *     103 OYANI          4        44    57.3 m
 *     103 OYANI          8        23    15.6 m
 *     104 NYAONDO        5        41    18.6 m
 *
 * A spread of 15-25 m is a lorry on a scale plus consumer GPS error, which is
 * what these should look like. Oyani's bridge 4 at 57 m is the loosest and the
 * thinnest — 44 fixes — so treat that one as the approximate of the six. The
 * two FACTORY bridges land 8 m apart and Oyani's two 75 m apart, which is the
 * right answer in both cases: adjacent scales at one gate, and two separate
 * ones at a spread-out yard.
 *
 * ## Bridge numbers are GLOBAL, not per-centre
 *
 * They do not restart at each site. Factory runs 1 and 2, Opapo 3, Oyani 4 and
 * 8, Nyaondo 5 — six scales across four centres, with 6 and 7 unseen (retired,
 * or at a site that has not weighed anything since we started reading). So a
 * bridge number identifies a scale on its own and does not need the centre
 * beside it to be unambiguous; the centre is carried anyway because it is what
 * an operator names the place by.
 *
 * ## Why a table here and not a row in the database
 *
 * Same argument as `FACTORIES`. These change when somebody builds a
 * weighbridge, which is a deploy-scale event, and a table in code is reviewable
 * — a row written once by a job is not. When the provider grows a field for it,
 * this becomes a fallback and then goes away.
 *
 * If a seventh bridge appears in the ticket feed it will have no entry here and
 * `weighbridgesOf` will not return it. That is deliberate: a marker at a guessed
 * position is worse than a missing marker, and the service logs the unknown
 * number so it can be derived and added.
 */

/** The provider's centre codes, as the scale software numbers them. */
export const WEIGHBRIDGE_ORG = 'SUKARI'

export interface Weighbridge {
  /** Provider centre code — 101 FACTORY, 102 OPAPO, 103 OYANI, 104 NYAONDO. */
  centerCode: number
  /** The centre as the provider names it, and as the grid shows it. */
  centerName: string
  /** The scale's own number, unique across all four centres. */
  bridgeNo:   number
  lat:        number
  lng:        number
  /**
   * Interquartile spread, in metres, of the fixes this point is the median of.
   * Carried so a reader can see which markers are tight and which is the loose
   * one, rather than being asked to trust six identical-looking pins.
   */
  spreadM:    number
  /** Fixes behind it. A thin sample is a weaker point, and says so. */
  samples:    number
}

export const WEIGHBRIDGES: Weighbridge[] = [
  { centerCode: 101, centerName: 'FACTORY', bridgeNo: 1, lat: -0.822727, lng: 34.383195, spreadM: 17.0, samples: 135 },
  { centerCode: 101, centerName: 'FACTORY', bridgeNo: 2, lat: -0.822667, lng: 34.383260, spreadM: 17.2, samples: 169 },
  { centerCode: 102, centerName: 'OPAPO',   bridgeNo: 3, lat: -0.666770, lng: 34.528205, spreadM: 24.9, samples: 162 },
  { centerCode: 103, centerName: 'OYANI',   bridgeNo: 4, lat: -1.027548, lng: 34.586483, spreadM: 57.3, samples:  44 },
  { centerCode: 103, centerName: 'OYANI',   bridgeNo: 8, lat: -1.027008, lng: 34.586879, spreadM: 15.6, samples:  23 },
  { centerCode: 104, centerName: 'NYAONDO', bridgeNo: 5, lat: -0.910503, lng: 34.613405, spreadM: 18.6, samples:  41 },
]

const BY_NUMBER = new Map(WEIGHBRIDGES.map(b => [b.bridgeNo, b]))

/** The scale with this number, or null where we have never placed it. */
export const bridgeOf = (bridgeNo: number | null | undefined): Weighbridge | null =>
  bridgeNo == null ? null : BY_NUMBER.get(bridgeNo) ?? null
