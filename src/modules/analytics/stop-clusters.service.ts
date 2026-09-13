/**
 * Where this organisation's units actually stop.
 *
 * The queries and the cache. The arithmetic is next door in `stop-clusters`,
 * which explains what the answer means; this file is about getting it out of a
 * table with millions of rows in it without putting a scan on the request path.
 *
 * ## Two passes, and why it is not one
 *
 * Measured on the box 2026-09-14: West Kenya writes 5.7 million fixes in a
 * fortnight, and merely COUNTING them took 41 s. Nothing that looks at every
 * fix and then does per-vehicle window work is going to serve a page.
 *
 * So the scan happens once and cheaply. Pass A aggregates stationary fixes to
 * an 11 m grid and throws away every cell fewer than `MIN_UNITS` distinct
 * units stopped in — one GROUP BY, no window functions, no self-join. It
 * returns a few hundred rows out of millions and takes 5-8 s. Pass B then
 * fetches the raw fixes for ONE place, the busiest, inside a 60 m box, which
 * is an indexed read of a few thousand rows.
 *
 * Merging the cells into places, finding the long axis and reading the profile
 * all happen in JS on those few hundred rows, where they cost nothing.
 *
 * ## Not warmed, deliberately
 *
 * `warm-cache` sweeps every declared key for every recently-read organisation
 * every 60 s, and its own header records what happened the last time that
 * sweep stopped fitting inside its interval: seventeen caches, four
 * organisations, and a two-vCPU box running a cache rebuild permanently. An
 * 8-second aggregate added to that sweep would be the most expensive key on
 * the box, rebuilt for organisations nobody has opened.
 *
 * So this cache declares no `warmKeysFor`. The first operator to open the card
 * waits once; everyone after that is served from memory, and a stale entry
 * refreshes in the background while they read the old one. A card nobody opens
 * costs nothing at all.
 *
 * ## What it will not do
 *
 * It will not name a place. It knows that 93 units stopped inside 25 m of a
 * point for a median of three and a half minutes; whether that is a
 * weighbridge, a gate or a canteen is the operator's to say, and inventing the
 * word would be the one part of this that could be confidently wrong.
 */

import { prisma } from '../../lib/prisma.js'
import { createWarmCache } from '../../lib/warm-cache.js'
import {
  mergeCells, offsetsFrom, principalAxisDeg, spreadRatio, projectOnto,
  binProfile, readSplit, metres,
  type GridCell, type Cluster, type Bin, type Split,
} from './stop-clusters.js'

/** Windows the card offers. Longer than a fortnight is a different question —
 *  "where did this fleet used to stop" — and costs a proportionally bigger
 *  scan to answer it. */
export const STOP_WINDOWS_DAYS = [3, 7, 14]

/** At or under this, a fix counts as stopped. Not zero: a stationary lorry's
 *  GPS reports 1 km/h often enough that zero-only loses most of a dwell. */
const STOPPED_KMH = 2

/** A cell nobody much uses is not a place. The floor is on DISTINCT UNITS
 *  rather than on fixes for the reason `Cluster.units` gives: one machine
 *  living in a yard writes more rows than a scale the whole fleet crosses. */
const MIN_UNITS = 6

/** How far apart two 11 m cells can be and still be one place. A lorry is 12 m
 *  and its fixes scatter another 10; 25 keeps one stop together without
 *  swallowing the next bay. */
const CLUSTER_RADIUS_M = 25

/** The box pass B reads, and the radius the scatter is drawn to. */
const FOCUS_RADIUS_M = 60

/** Points handed to the client for the scatter. A cloud is legible well before
 *  this; past it the payload grows and the picture does not. */
const MAX_POINTS = 1_500

export interface StopPoint { e: number; n: number }

export interface StopFocus {
  lat: number
  lng: number
  units: number
  fixes: number
  radiusM: number
  /** Metres east/north of the centre, one per fix drawn. */
  points: StopPoint[]
  /** The long axis the profile is binned along, and how elongated the cloud is
   *  — a ratio near 1 means the axis is arbitrary and the profile says little. */
  axisDeg: number
  spreadRatio: number
  profile: Bin[]
  /** Two places rather than one, when the profile says so. Usually null. */
  split: Split | null
}

export interface StopClustersPayload {
  days: number
  from: string
  /** Busiest first, by distinct units. */
  clusters: Cluster[]
  /** The busiest, drawn. Null when the fleet has no place this busy. */
  focus: StopFocus | null
}

interface CellRow { glat: number; glng: number; fixes: bigint; units: bigint }
interface FixRow { lat: number; lng: number }

async function compute(orgId: string, days: number): Promise<StopClustersPayload> {
  const from = new Date(Date.now() - days * 86_400_000)

  // ── Pass A · the whole window, aggregated to 11 m ──────────────────────────
  const cellRows = await prisma.$queryRaw<CellRow[]>`
    SELECT round(t.lat::numeric, 4)::float8       AS glat,
           round(t.lng::numeric, 4)::float8       AS glng,
           count(*)                               AS fixes,
           count(DISTINCT t.vehicle_id)           AS units
      FROM vehicle_telemetries t
      JOIN vehicles v ON v.id = t.vehicle_id
     WHERE v.organisation_id = ${orgId}
       AND t.captured_at >= ${from}
       AND t.lat IS NOT NULL
       AND coalesce(t.speed_kmh, 0) < ${STOPPED_KMH}
     GROUP BY 1, 2
    HAVING count(DISTINCT t.vehicle_id) >= ${MIN_UNITS}
     ORDER BY fixes DESC
     LIMIT 4000
  `

  const cells: GridCell[] = cellRows.map(r => ({
    lat: r.glat, lng: r.glng, fixes: Number(r.fixes), units: Number(r.units),
  }))
  const clusters = mergeCells(cells, CLUSTER_RADIUS_M).slice(0, 8)

  const head = clusters[0]
  if (!head) return { days, from: from.toISOString(), clusters, focus: null }

  // ── Pass B · one place, at full resolution ─────────────────────────────────
  //
  // A degree box rather than a radius in SQL: the index is on the columns, and
  // trimming the corners to a circle is a filter in JS over a few thousand rows.
  const dLat = FOCUS_RADIUS_M / 111_320
  const fixes = await prisma.$queryRaw<FixRow[]>`
    SELECT t.lat, t.lng
      FROM vehicle_telemetries t
      JOIN vehicles v ON v.id = t.vehicle_id
     WHERE v.organisation_id = ${orgId}
       AND t.captured_at >= ${from}
       AND coalesce(t.speed_kmh, 0) < ${STOPPED_KMH}
       AND t.lat BETWEEN ${head.lat - dLat} AND ${head.lat + dLat}
       AND t.lng BETWEEN ${head.lng - dLat} AND ${head.lng + dLat}
     LIMIT 20000
  `

  const inside = fixes.filter(
    f => metres(f.lat, f.lng, head.lat, head.lng) <= FOCUS_RADIUS_M,
  )
  // Thinned by stride rather than by slice: taking the first 1,500 rows would
  // hand back whichever corner the index happened to return, and the scatter
  // would be a picture of the query plan.
  const stride = Math.max(1, Math.ceil(inside.length / MAX_POINTS))
  const drawn = inside.filter((_, i) => i % stride === 0)

  const offs = offsetsFrom(head, drawn)
  const axisDeg = principalAxisDeg(offs)
  const profile = binProfile(projectOnto(offs, axisDeg))

  return {
    days,
    from: from.toISOString(),
    clusters,
    focus: {
      lat: head.lat,
      lng: head.lng,
      units: head.units,
      fixes: head.fixes,
      radiusM: FOCUS_RADIUS_M,
      points: offs.map(o => ({ e: Number(o.e.toFixed(1)), n: Number(o.n.toFixed(1)) })),
      axisDeg,
      spreadRatio: spreadRatio(offs),
      profile,
      split: readSplit(profile),
    },
  }
}

const cache = createWarmCache<StopClustersPayload>({
  name: 'stop-clusters',
  maxEntries: 40,
  compute: async (key) => {
    const [orgId = '', daysRaw = ''] = key.split('|')
    return compute(orgId, Number(daysRaw))
  },
  // No `warmKeysFor` — see the note at the top of this file.
})

export function getStopClusters(orgId: string, days: number): Promise<StopClustersPayload> {
  return cache.get(`${orgId}|${days}`)
}
