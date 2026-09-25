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
 * ## Kabras, where there are no tickets to anchor on
 *
 * West Kenya's scales do not report to us at all — the provider feed is
 * Sukari's entirely — so the derivation above has nothing to stand on: no
 * ticket, no stamp, no bridge number. They were measured a second way,
 * from the shape of the traffic rather than from a document.
 *
 * A lorry visiting a mill stops in many places. A scale is the stop that is
 * SHORT and that almost every visiting unit makes. So: every stop of 45 s to
 * 15 min made by a unit that comes and goes (under 30 % of its fixes inside
 * the site — this excludes the loaders and tractors that live in the yard and
 * would otherwise dominate), mean-shifted to its local density peak.
 *
 * The cluster that came out sits 4 m from the weighbridge the operations
 * survey drew, with the tightest spread on the site — which is the check that
 * matters, because the survey is an independent source and the two agree.
 *
 * That cluster is BIMODAL. Projected east-west in 3 m bins it has two peaks of
 * 117 and 111 stops with a trough of 31 between them: two scales, 19 m apart,
 * with the surveyed pin between them. The site's other busy stop — the main
 * gate — was run through the same test as a control and is single-peaked
 * (104, with only noise either side), so this is a property of the
 * weighbridge's traffic and not of the method.
 *
 *     scale            stops   units   spread   dwell
 *     KABRAS west       391      30      4.7 m   1.8 min
 *     KABRAS east       425      29      5.1 m   1.6 min
 *
 * 24 of the 35 units that used the weighbridge used BOTH, which is what two
 * lanes of one facility look like. The spreads are tighter than any of the six
 * Sukari scales above; that is a consequence of the method, not of better
 * positions — these are medians of stops rather than of single fixes.
 *
 * Measured on the box 2026-09-13. The caveat worth carrying: West Kenya's
 * telemetry only begins in August 2026, so this is six weeks of one season,
 * where Sukari's derivation had a ticket behind every point. If the mill moves
 * a scale, nothing here will notice.
 *
 * These two carry no bridge number, because nothing numbers them. That is the
 * honest shape and it is load-bearing: `bridgeOf` maps the PROVIDER's
 * numbering, and a Kabras scale given a number would collide with a Sukari
 * scale that really has one.
 *
 * ## West Kenya's yards, measured from the lorries that load there
 *
 * Since ~2026-09-17 the feed also carries Kabras and Nzoia (West Kenya), and
 * neither sends a bridge number. Their yard deliveries are farmers' tractors we
 * do not track, and a transfer ticket is raised when the lorry ARRIVES at the
 * factory: at ticket time our lorries stood at Kabras, Naitiri and Nzoia, not
 * at the yard the ticket names. That places the two factories below.
 *
 * The yard is where the lorry LOADED: its longest stop (15 min or more, over
 * 2 km from where it arrived) in the 10 h before the ticket. Per yard, the
 * densest cluster of those stops, and the median of the ones within 300 m.
 * Measured on the box 2026-09-25:
 *
 *     site                      fixes / of   units   spread   method
 *     Kitale (Amuka) yard         33 / 50      11     24 m    loading stop
 *     Misikhu yard                46 / 64      13     31 m    loading stop
 *     Weyeta yard (Nzoia)         20 / 24       4     20 m    loading stop
 *     Selient yard                34 / 58      14     19 m    loading stop
 *     Naitiri factory yard       114           ~20   ~200 m    transfers on arrival
 *     Nzoia factory yard          17            4    ~80 m    transfers on arrival
 *
 * Nzoia's two bridges were then GIVEN by the operator (2026-09-26), as CW and
 * HD, and replace the derived point: CW 0.5700258, 34.6544478 and HD
 * 0.5671175, 34.6562756, ~380 m apart (both corrected by the operator the same
 * day; their first DMS readings sat 112 m and 39 m off).
 *
 * Naitiri's weighbridge was likewise GIVEN by the operator (2026-09-26) at
 * 0.7813181, 34.8778280. The arrival-fix point it replaces was 570 m off: at
 * Naitiri the lorries queue across a ~200 m yard, so ticket-time fixes place
 * the queue, not the deck. The derived arrival point had
 * landed 64 m from CW, which is the check on the method used for the others.
 *
 * Kitale is the check: two of our own units weighed there on DELIVERY tickets,
 * and those fixes land 50 m from the loading-stop point.
 *
 * Deliberately NOT placed:
 *   - Magut and Khalaba: their lorries' three densest stops are the SAME
 *     three places, one of them Selient's point, so the method finds where
 *     that shared traffic stops, not either yard.
 *   - Makhese: 3 transfers, and the "yard" came out on Naitiri factory.
 *   - Busia, Lake Agro, and Kabras's own Weyeta code: delivery tickets only,
 *     by lorries we do not track, so nothing to measure from.
 *
 * These carry the SITE code (weighment.ingest: provider code + factory base)
 * so the service can hang each one's newest weighing on it. Arrival points sit
 * where the ticket was raised, which at Kabras was ~60 m from the scales: read
 * them as the site, not the deck.
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

export interface Weighbridge {
  /** A stable id for the scale. Not the bridge number: half of these have
   *  none, and a marker needs a key either way. */
  key:        string
  /** The organisation whose yard this scale stands in. Scales are one mill
   *  group's or another's, never the country's — see the service. */
  orgCode:    string
  /** The SITE code as `weighments.center_code` stores it: Ndhiwa's are the
   *  provider's own (101 FACTORY, 102 OPAPO, 103 OYANI, 104 NYAONDO), West
   *  Kenya's carry their factory's base (1101 Kabras Factory Yard, 2101 Nzoia
   *  Factory Yard). Null only for a site no ticket names. */
  centerCode: number | null
  /** The centre as the provider names it, and as the grid shows it. */
  centerName: string
  /** The scale's number in the PROVIDER's global numbering, or null for a
   *  scale that has never appeared on a ticket. Null is not a gap to fill in:
   *  it is the difference between a scale we read and a scale we measured. */
  bridgeNo:   number | null
  /** How an operator names this scale, for the marker's title. */
  label:      string
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
  { key: 'wb-1', orgCode: 'SUKARI', centerCode: 101, centerName: 'FACTORY', bridgeNo: 1, label: 'Bridge 1', lat: -0.822727, lng: 34.383195, spreadM: 17.0, samples: 135 },
  { key: 'wb-2', orgCode: 'SUKARI', centerCode: 101, centerName: 'FACTORY', bridgeNo: 2, label: 'Bridge 2', lat: -0.822667, lng: 34.383260, spreadM: 17.2, samples: 169 },
  { key: 'wb-3', orgCode: 'SUKARI', centerCode: 102, centerName: 'OPAPO',   bridgeNo: 3, label: 'Bridge 3', lat: -0.666770, lng: 34.528205, spreadM: 24.9, samples: 162 },
  { key: 'wb-4', orgCode: 'SUKARI', centerCode: 103, centerName: 'OYANI',   bridgeNo: 4, label: 'Bridge 4', lat: -1.027548, lng: 34.586483, spreadM: 57.3, samples:  44 },
  { key: 'wb-8', orgCode: 'SUKARI', centerCode: 103, centerName: 'OYANI',   bridgeNo: 8, label: 'Bridge 8', lat: -1.027008, lng: 34.586879, spreadM: 15.6, samples:  23 },
  { key: 'wb-5', orgCode: 'SUKARI', centerCode: 104, centerName: 'NYAONDO', bridgeNo: 5, label: 'Bridge 5', lat: -0.910503, lng: 34.613405, spreadM: 18.6, samples:  41 },

  // Kabras. Derived from the traffic rather than from tickets — see the note
  // above — and named for where they stand, because nothing numbers them.
  { key: 'kabras-w', orgCode: 'WESTSUGAR', centerCode: 1101, centerName: 'KABRAS', bridgeNo: null, label: 'West scale', lat: 0.376930, lng: 34.834102, spreadM: 4.7, samples: 391 },
  { key: 'kabras-e', orgCode: 'WESTSUGAR', centerCode: 1101, centerName: 'KABRAS', bridgeNo: null, label: 'East scale', lat: 0.376854, lng: 34.834258, spreadM: 5.1, samples: 425 },

  // West Kenya's other sites, from the feed's Kabras and Nzoia tickets. See
  // the note above for how each was measured and which were left out.
  { key: 'naitiri',   orgCode: 'WESTSUGAR', centerCode: 1107, centerName: 'NAITIRI',        bridgeNo: null, label: 'Weighbridge', lat: 0.7813181, lng: 34.8778280, spreadM: 0, samples: 0 },
  { key: 'misikhu',   orgCode: 'WESTSUGAR', centerCode: 1104, centerName: 'MISIKHU',        bridgeNo: null, label: 'Yard', lat: 0.723797, lng: 34.769075, spreadM: 31, samples: 46 },
  { key: 'selient',   orgCode: 'WESTSUGAR', centerCode: 1114, centerName: 'SELIENT',        bridgeNo: null, label: 'Yard', lat: 0.510809, lng: 35.025235, spreadM: 19, samples: 34 },
  { key: 'kitale',    orgCode: 'WESTSUGAR', centerCode: 1115, centerName: 'KITALE (AMUKA)', bridgeNo: null, label: 'Yard', lat: 1.098563, lng: 35.008331, spreadM: 24, samples: 33 },
  // Operator-given, so no spread or sample count: 0 means "not measured".
  { key: 'nzoia-cw',  orgCode: 'WESTSUGAR', centerCode: 2101, centerName: 'NZOIA',          bridgeNo: null, label: 'CW bridge', lat: 0.5700258, lng: 34.6544478, spreadM: 0, samples: 0 },
  { key: 'nzoia-hd',  orgCode: 'WESTSUGAR', centerCode: 2101, centerName: 'NZOIA',          bridgeNo: null, label: 'HD bridge', lat: 0.5671175, lng: 34.6562756, spreadM: 0, samples: 0 },
  { key: 'weyeta-nz', orgCode: 'WESTSUGAR', centerCode: 2103, centerName: 'WEYETA',         bridgeNo: null, label: 'Yard', lat: 0.594721, lng: 34.475541, spreadM: 20, samples: 20 },
]

/* The PROVIDER's numbering only. A scale with no number was never in the
   ticket feed, so putting it here would let a Kabras scale answer to a number
   that belongs to one of Sukari's. */
const BY_NUMBER = new Map(
  WEIGHBRIDGES.filter(b => b.bridgeNo != null).map(b => [b.bridgeNo as number, b]),
)

/** The scale with this number, or null where we have never placed it. */
export const bridgeOf = (bridgeNo: number | null | undefined): Weighbridge | null =>
  bridgeNo == null ? null : BY_NUMBER.get(bridgeNo) ?? null

/**
 * This organisation's scales that no ticket will ever mention.
 *
 * They cannot be found the way the ticketed ones are — there is no feed to
 * scope them by — so they are claimed by the organisation named here. It is the
 * one place an org name is written down, and it is written down because the
 * alternative is a yard with two measured scales and no way to reach them.
 */
export const unticketedScalesOf = (orgCode: string | null | undefined): Weighbridge[] =>
  orgCode == null ? [] : WEIGHBRIDGES.filter(b => b.orgCode === orgCode && b.bridgeNo == null)
