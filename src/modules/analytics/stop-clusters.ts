/**
 * Where a fleet's units actually stop, and whether a stop is ONE place.
 *
 * ## What this answers
 *
 * A yard's drawing says where things are meant to be. This says where the
 * lorries put themselves: the places inside an organisation's operation that
 * many different units stop at, ranked by how many units use them. It is the
 * generalisation of the pass that placed Kabras' two weighbridges — see
 * `weighments/weighbridge.geography` for the case that produced it — and the
 * useful half of that pass was never the coordinates. It was the SHAPE: a busy
 * stop that turns out to be two stops nineteen metres apart is a fact about how
 * the yard works, and nothing in the paperwork was going to say it.
 *
 * ## The arithmetic lives here, away from the queries
 *
 * Everything in this file is a pure function of numbers. The service beside it
 * owns the two SQL passes and the cache; this owns the merging, the axis, the
 * binning and the peak read — which are the parts that can be wrong in ways a
 * screenshot will not reveal, and so are the parts under test.
 *
 * ## Metres, flat
 *
 * Every distance here is a flat projection: degrees x 111_320, longitude
 * uncorrected. This fleet works between 1.1 S and 0.8 N, where cos(lat) is
 * 0.9998 at worst — 2 cm in 100 m. A cluster radius of 25 m does not notice,
 * and the alternative is a haversine in the inner loop of an O(n^2) merge.
 */

/** Degrees to metres, at this fleet's latitudes. See the note above. */
export const M_PER_DEG = 111_320

export interface GridCell {
  lat: number
  lng: number
  fixes: number
  units: number
}

export interface Cluster {
  lat: number
  lng: number
  /** Stationary fixes inside it. A measure of DWELL, not of traffic: one lorry
   *  parked all afternoon outweighs thirty passing over a scale. */
  fixes: number
  /**
   * Distinct units that stopped in it — the ranking figure, and deliberately
   * not `fixes`. The question is "where does the fleet stop", and a yard where
   * one machine lives all week is not that, however many rows it writes.
   *
   * It is a lower bound: a unit counted in two of this cluster's cells is
   * counted once here only if the grid pass reported it that way, which it
   * cannot. So this is the maximum over the merged cells, never their sum —
   * summing would let a cluster of six cells claim six times its real reach.
   */
  units: number
  /** Cells merged into it. A cluster of one cell is a point somebody parked at
   *  twice; a cluster of a dozen is a yard. */
  cells: number
}

export const metres = (
  aLat: number, aLng: number, bLat: number, bLng: number,
): number => Math.hypot((aLat - bLat) * M_PER_DEG, (aLng - bLng) * M_PER_DEG)

/**
 * Grid cells into places.
 *
 * Single-link merging at `radiusM`: a cell joins the first cluster whose
 * centre it is within, and the centre moves to the weighted mean as it grows.
 * That is a deliberately simple rule, and its one real property is the one
 * that matters here — an 11 m grid cuts a real stop into four cells whenever
 * it straddles a boundary, and nothing downstream should have to care whether
 * it did.
 *
 * Cells arrive heaviest-first (the query orders them), which is what keeps the
 * merge stable: a place's own busiest cell is the seed, and the quieter cells
 * around it join it rather than founding rivals.
 */
export function mergeCells(cells: GridCell[], radiusM = 25): Cluster[] {
  const out: Array<Cluster & { wLat: number; wLng: number; w: number }> = []

  for (const c of cells) {
    const hit = out.find(o => metres(o.lat, o.lng, c.lat, c.lng) <= radiusM)
    if (!hit) {
      out.push({
        lat: c.lat, lng: c.lng, fixes: c.fixes, units: c.units, cells: 1,
        wLat: c.lat * c.fixes, wLng: c.lng * c.fixes, w: c.fixes,
      })
      continue
    }
    hit.fixes += c.fixes
    // See the note on `units`: the max, never the sum.
    hit.units = Math.max(hit.units, c.units)
    hit.cells += 1
    hit.wLat += c.lat * c.fixes
    hit.wLng += c.lng * c.fixes
    hit.w += c.fixes
    hit.lat = hit.wLat / hit.w
    hit.lng = hit.wLng / hit.w
  }

  return out
    .map(({ wLat: _wLat, wLng: _wLng, w: _w, ...rest }) => rest)
    .sort((a, b) => b.units - a.units || b.fixes - a.fixes)
}

export interface Point { lat: number; lng: number }
/** Metres east and north of a centre. */
export interface Offset { e: number; n: number }

export const offsetsFrom = (centre: Point, points: Point[]): Offset[] =>
  points.map(p => ({
    e: (p.lng - centre.lng) * M_PER_DEG,
    n: (p.lat - centre.lat) * M_PER_DEG,
  }))

/**
 * The compass bearing of the cloud's long axis, in degrees east of north.
 *
 * The first principal component, by the closed form for a 2x2 covariance —
 * there is no iteration and no library. It matters because the split this
 * module looks for is only visible along ONE direction: two scales side by
 * side are two peaks east-west and a single smear north-south, and a profile
 * binned along the wrong axis reports one place where there are two.
 *
 * A round cloud has no long axis and the answer is arbitrary rather than
 * wrong; `spreadRatio` below is what says so.
 */
export function principalAxisDeg(offs: Offset[]): number {
  if (offs.length < 2) return 0
  const n = offs.length
  const me = offs.reduce((s, o) => s + o.e, 0) / n
  const mn = offs.reduce((s, o) => s + o.n, 0) / n
  let ee = 0, nn = 0, en = 0
  for (const o of offs) {
    const de = o.e - me, dn = o.n - mn
    ee += de * de; nn += dn * dn; en += de * dn
  }
  // atan2 of the eigenvector of the larger eigenvalue, written directly.
  const deg = (Math.atan2(2 * en, ee - nn) / 2) * (180 / Math.PI)
  // Measured from EAST by that form; the caller wants it from east too, so the
  // profile's "+12 m" reads as "twelve metres along the long axis".
  return Number(deg.toFixed(1))
}

/** How elongated the cloud is: 1 is round, higher is a line. Reported so a
 *  reader can tell an axis that means something from one that does not. */
export function spreadRatio(offs: Offset[]): number {
  if (offs.length < 2) return 1
  const n = offs.length
  const me = offs.reduce((s, o) => s + o.e, 0) / n
  const mn = offs.reduce((s, o) => s + o.n, 0) / n
  let ee = 0, nn = 0, en = 0
  for (const o of offs) {
    const de = o.e - me, dn = o.n - mn
    ee += de * de; nn += dn * dn; en += de * dn
  }
  const tr = (ee + nn) / n
  const det = (ee * nn - en * en) / (n * n)
  const disc = Math.max(0, (tr * tr) / 4 - det)
  const hi = tr / 2 + Math.sqrt(disc)
  const lo = tr / 2 - Math.sqrt(disc)
  if (lo <= 1e-9) return Infinity
  return Number(Math.sqrt(hi / lo).toFixed(2))
}

/** Each point's position along `axisDeg`, in metres from the centre. */
export const projectOnto = (offs: Offset[], axisDeg: number): number[] => {
  const a = (axisDeg * Math.PI) / 180
  return offs.map(o => o.e * Math.cos(a) + o.n * Math.sin(a))
}

export interface Bin { at: number; n: number }

/** A histogram of `values` in `binM`-metre bins, gaps included as zeroes — a
 *  profile with its empty bins dropped is a profile with no troughs in it. */
export function binProfile(values: number[], binM = 3): Bin[] {
  if (values.length === 0) return []
  const idx = values.map(v => Math.floor(v / binM))
  const lo = Math.min(...idx), hi = Math.max(...idx)
  const counts = new Map<number, number>()
  for (const i of idx) counts.set(i, (counts.get(i) ?? 0) + 1)
  const out: Bin[] = []
  for (let i = lo; i <= hi; i++) out.push({ at: i * binM, n: counts.get(i) ?? 0 })
  return out
}

export interface Split {
  /** The two peaks, in metres along the axis, with their counts. */
  a: Bin
  b: Bin
  /** The emptiest bin between them. */
  trough: Bin
  /** How far apart the two peaks are, in metres. */
  apartM: number
  /** trough.n / min(a.n, b.n). 0 is a clean split; 1 is a flat ridge. */
  dip: number
}

/**
 * Is this one place or two?
 *
 * The test is a DIP, not a distance: two bins of comparable height with a
 * genuine gap between them. Anything long enough splits under a 2-means — the
 * main gate at Kabras did, with the same 19 m separation as the weighbridge —
 * so "a split improves the spread" proves nothing and is not what this asks.
 *
 * Four conditions, and each one is a way this was wrong before it was tested:
 *
 *  - Both peaks carry at least `minShare` of the TALLER OF THE TWO, or a busy
 *    stop with a bit of noise beside it reads as a pair.
 *  - Both carry at least `minOfMax` of the TALLEST BIN IN THE PROFILE. Without
 *    this the pair only has to be comparable to each other, and two bins of
 *    two fixes each, with one fix between them, scored a cleaner dip than the
 *    real peaks did — the answer was a split between two pieces of noise at
 *    the edge of a plainly single stop.
 *  - The trough is under `maxDip` of the smaller peak, or a ridge with a dent
 *    in it reads as a gap.
 *  - The peaks are at least three bins apart, so adjacent bins of one blurred
 *    stop cannot qualify.
 *
 * Returns null for "one place", which is the answer most of the time and is
 * meant to be rendered as such rather than as a failed split.
 */
export function readSplit(
  bins: Bin[], { minShare = 0.6, minOfMax = 0.5, maxDip = 0.55 } = {},
): Split | null {
  if (bins.length < 5) return null
  const tallest = Math.max(...bins.map(b => b.n))
  if (tallest === 0) return null
  const floor = tallest * minOfMax
  let best: Split | null = null

  for (let i = 0; i < bins.length; i++) {
    for (let j = i + 3; j < bins.length; j++) {
      const a = bins[i]!, b = bins[j]!
      const lo = Math.min(a.n, b.n), hi = Math.max(a.n, b.n)
      if (lo === 0 || lo < floor || lo / hi < minShare) continue
      let trough = bins[i + 1]!
      for (let k = i + 2; k < j; k++) if (bins[k]!.n < trough.n) trough = bins[k]!
      const dip = trough.n / lo
      if (dip > maxDip) continue
      // The strongest split wins: deepest relative trough, then the tallest
      // pair, so a shallow dip between two giants does not beat a clean gap
      // between two ordinary peaks.
      if (best == null || dip < best.dip || (dip === best.dip && lo > Math.min(best.a.n, best.b.n))) {
        best = { a, b, trough, apartM: Number((b.at - a.at).toFixed(1)), dip: Number(dip.toFixed(2)) }
      }
    }
  }
  return best
}
