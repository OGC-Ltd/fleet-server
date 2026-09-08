/**
 * What a zone IS, derived from its name, plus how big it is.
 *
 * Two consumers need the same answer and must never disagree: the map overlay
 * colours each zone by category, and the notification layer decides from the
 * same category which zones are worth NAMING to an operator. This used to live
 * in geofence.repository, which made it a module-layer concern the notification
 * path could not reach without importing a repository.
 */

/**
 * Land-use category, derived from the zone name.
 *
 * The estate's zones came from Wialon, which stores a name and nothing else —
 * there is no class column to read. The names are consistent enough to key off
 * (the surveyor's own convention, mirrored in ESTATE AREAS TO BE PLANTED), and
 * the category picks the overlay colour: an unrecognised name falls back to
 * `other` and still draws. This is presentation, never enforcement.
 */
export type ZoneCategory =
  | 'farm' | 'nursery' | 'commercial' | 'rainfed' | 'factory'
  | 'logistics' | 'facility' | 'wetland' | 'water' | 'drain' | 'road'
  | 'restricted' | 'sample' | 'other'

/**
 * These rules were written against ONE account's vocabulary and have now met
 * three more.
 *
 * Kasulu's zones come from a surveyor and read like a survey — "Factory site
 * Location", "Logistic centre1", "Rainfed Area". Sukari, Menengai and West
 * Kenya name theirs the way an operator types them: "Naitiri Factory",
 * "KABRAS FACTORY -WKS", "Menengai Yard NEW". Measured against production,
 * every one of their twelve zones fell to `other` and drew in the fallback
 * grey — three fleets whose map said nothing about their own ground while
 * Kasulu's showed eleven land uses.
 *
 * So `factory` stops requiring the word "site", and a YARD is recognised as
 * the logistics area it is. Both are widenings of an existing rule rather than
 * new vocabulary, and neither reclassifies anything on Kasulu.
 */
export function categorise(name: string): ZoneCategory {
  const n = name.toLowerCase()
  if (n.startsWith('ves'))                          return 'sample'
  /* First, and before any land use: a keep-out is the one zone whose colour
     must not be the same grey as "we could not tell". It outranks whatever
     else the name says, because "NO GO ZONES -SUKARI" is a prohibition before
     it is a place. */
  if (n.includes('no go') || n.includes('no-go') || n.includes('nogo')
    || n.includes('keep out') || n.includes('keep-out')
    || n.includes('restricted'))                    return 'restricted'
  if (n.includes('farm') || n.includes('ha area'))  return 'farm'
  if (n.includes('nursery'))                        return 'nursery'
  if (n.includes('commercial'))                     return 'commercial'
  if (n.includes('rainfed') || n.includes('rain fed')) return 'rainfed'
  /* Roads are settled BEFORE the factory, and that ordering is load-bearing.
     Kasulu has a corridor called "Main Haulage road from  Factory to Zone3" —
     a road named for where it goes. While the factory rule demanded the word
     "site" the two could not collide; widening it to the plain word put a
     haulage road in the factory's colour, which the existing test caught. A
     name that says both is the road. */
  if (n.includes('road') || n.includes('haulage'))  return 'road'
  // Was 'factory site' — the surveyor's phrasing. Three fleets write the plain
  // word and meant exactly the same thing.
  if (n.includes('factory'))                        return 'factory'
  // A yard or depot is where units are kept and turned around, which is what
  // this category already means for Kasulu's "Logistic centre".
  if (n.includes('logistic') || n.includes('yard') || n.includes('depot')) return 'logistics'
  if (n.includes('swamp') || n.includes('wet'))     return 'wetland'
  if (n.includes('river'))                          return 'water'
  if (n.includes('drain'))                          return 'drain'
  if (n.includes('workshop') || n.includes('residence') || n.includes('dispensary')
    || n.includes('lab') || n.includes('reservoir') || n.includes('camp')) return 'facility'
  return 'other'
}

/**
 * Is this one of OUR surveyed estate features, as opposed to a provider's
 * sample point?
 *
 * The Kasulu account holds 107 zones and they are two different things:
 *
 *   40 estate features — the farms, nurseries, swamps, wetlands, workshops,
 *      logistic centres, factory site, drains, rivers and haulage roads that
 *      make up the estate. Surveyed geometry: 29 polygons and 11 corridors,
 *      drawn to the actual boundaries. These are what appear on the plotted
 *      overlay and what an operator recognises by name.
 *
 *   67 `VES` points — bulk-imported sampling locations, every one of them a
 *      CIRCLE of exactly 1000 m. Measured 2026-08-02: no VES zone is anything
 *      but a 1 km circle, and no 1 km circle is anything but a VES zone, so
 *      the name and the geometry agree completely on which set a zone is in.
 *
 * A 1 km circle around a sample point is not a place a vehicle "arrives at",
 * and because they overlap heavily one vehicle crosses several at once: the
 * Live Feed was a wall of "arrived at VES 125 / VES 126 / VES 127", six or
 * more per vehicle per minute, naming locations that mean nothing to anyone
 * reading it. Presence is still evaluated against them — they remain part of
 * containment — but they are never narrated.
 */
export function isEstateFeature(category: ZoneCategory): boolean {
  return category !== 'sample'
}

/**
 * Is arriving here an EVENT, or just where the work happens?
 *
 * Being an estate feature is not enough to be worth a feed line. The estate's
 * categories divide cleanly into destinations — the factory, the logistics
 * centres, the workshop, the dispensary — and the ground a machine spends its
 * whole shift on: farm blocks, nurseries, the commercial area, haulage roads,
 * drains, rivers, wetlands.
 *
 * Measured on KASULU over 17 hours (2026-08-04), 2,924 zone feed items:
 *
 *   farm 22.9% · commercial 21.4% · nursery 16.2% · road 7.6% · drain 0.8%
 *   facility 14.1% · logistics 10.7% · factory 6.2%
 *
 * A tractor working a field crosses those boundaries continuously — the busiest
 * emitted 527 lines in a day, one every three minutes, and the 3-minute dwell
 * cannot help because the movement is real. The result was a feed where fuel
 * events were 4.3% of the traffic and an operator reported never seeing a
 * refuel at all.
 *
 * Presence is unaffected: containment still drives keep-out breaches and the
 * "— inside FARM #215" context on the lines that DO get published. This governs
 * narration only.
 */
export function isNarratableDestination(category: ZoneCategory): boolean {
  return category === 'factory' || category === 'logistics' || category === 'facility'
}

const R = 6_371_000
const rad = (d: number) => (d * Math.PI) / 180

/** Shoelace on a local equirectangular projection — hectares. */
export function ringAreaHa(pts: Array<[number, number]>): number {
  if (pts.length < 3) return 0
  const lat0 = rad(pts.reduce((s, p) => s + p[1], 0) / pts.length)
  const xy = pts.map(([lng, lat]) => [rad(lng) * Math.cos(lat0) * R, rad(lat) * R] as const)
  let a = 0
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i]!
    const [x2, y2] = xy[(i + 1) % xy.length]!
    a += x1 * y2 - x2 * y1
  }
  return Math.abs(a / 2) / 10_000
}
