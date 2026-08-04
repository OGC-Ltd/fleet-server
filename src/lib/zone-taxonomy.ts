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
  | 'sample' | 'other'

export function categorise(name: string): ZoneCategory {
  const n = name.toLowerCase()
  if (n.startsWith('ves'))                          return 'sample'
  if (n.includes('farm') || n.includes('ha area'))  return 'farm'
  if (n.includes('nursery'))                        return 'nursery'
  if (n.includes('commercial'))                     return 'commercial'
  if (n.includes('rainfed') || n.includes('rain fed')) return 'rainfed'
  if (n.includes('factory site'))                   return 'factory'
  if (n.includes('logistic'))                       return 'logistics'
  if (n.includes('swamp') || n.includes('wet'))     return 'wetland'
  if (n.includes('river'))                          return 'water'
  if (n.includes('drain'))                          return 'drain'
  if (n.includes('road') || n.includes('haulage'))  return 'road'
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
