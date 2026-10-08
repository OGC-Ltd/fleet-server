/**
 * Visits — when a unit went INTO a fence and when it came OUT (operator,
 * 2026-10-09: "if it made an entry into Sukari Industries, where did it spend
 * the time within the premises, and when it left, where did it go").
 *
 * Stops (usage-review.compute) answer "where did it stand still for ten
 * minutes". That misses the questions asked of a site: a six-minute pass over
 * the weighbridge is no stop at all, and a day inside the premises is one
 * stop at its median point, not yard → weighbridge → workshop. Visits are
 * worked out from the fences themselves, fix by fix:
 *
 *   · the fences are the organisation's site fences — areas up to
 *     MAX_FENCE_HA, the ones the Logbook counts as work areas — plus a known
 *     company site (factory, weighbridge yard) that no fence covers, as a
 *     SITE_VISIT_RADIUS_M circle;
 *   · a fence inside another (every corner within it) is an AREA of that one:
 *     "Sukari Industries · Weighbridge" inside "Sukari Industries". Its
 *     visits sit inside the premises' visit;
 *   · a visit is a run of fixes inside the fence. Outside spells shorter than
 *     MERGE_S are boundary jitter and are joined over; a visit shorter than
 *     MIN_VISIT_S is a drive through, not a visit, and is dropped;
 *   · entry and exit are put midway between the last fix on one side and the
 *     first on the other, when those are close enough (EDGE_S) to say so;
 *     otherwise at the inside fix, so a tracker that slept never stretches a
 *     visit;
 *   · stops outside every fence stay as places (named by Google / OSM), so
 *     "where did it go after it left" always has an answer.
 *
 * Pure apart from loadVisitFences: messages in, visits out.
 */

import { prisma } from '../../lib/prisma.js'
import { fenceBox, inBox, isInsideFence, haversineM, type FenceBox, type FenceGeometry } from '../../lib/geofence.js'
import { ringAreaHa } from '../../lib/zone-taxonomy.js'
import { MAX_FENCE_HA, STATIC_SITES } from './usage-review.areas.js'
import { TZ_OFFSET_MS, type ReviewMessage, type ReviewStop } from './usage-review.compute.js'

/** Outside for less than this between two inside fixes: jitter at the edge. */
export const MERGE_S = 180
/** Inside for less than this: drove through. */
export const MIN_VISIT_S = 120
/** Entry/exit is interpolated only across a gap this short. */
export const EDGE_S = 300
/** A known site with no fence, as a circle this wide — about a factory compound. */
export const SITE_VISIT_RADIUS_M = 500
/** A step longer than this inside a visit is the tracker quiet, said so. */
export const QUIET_S = 900

export interface VisitFence {
  id: string
  name: string
  geometry: FenceGeometry
  areaHa: number
  /** 'fence' — the organisation's own; 'site' — a known site with no fence. */
  source: 'fence' | 'site'
}

export interface VisitFenceMeta {
  id: string
  name: string
  parentId: string | null
  depth: number
  areaHa: number
  source: 'fence' | 'site'
}

/** What came before or after a visit. */
export type VisitRef =
  | { kind: 'fence'; id: string; visit: number }
  | { kind: 'place'; id: number; stop: number }
  | { kind: 'exit'; id: string }
  | { kind: 'end' }

export interface Visit {
  id: number
  fenceId: string
  /** The premises' visit this one sits inside, or null. */
  parent: number | null
  start: number
  end: number
  min: number
  /** Already inside when the period (or the data) began / still inside when it ended. */
  openStart: boolean
  openEnd: boolean
  /** Minutes inside with no message for more than QUIET_S at a time. */
  quietMin: number
  next: VisitRef | null
  /** Minutes from leaving to arriving at `next` (a fence or place). */
  toNextMin: number | null
}

export interface VisitNext { ref: VisitRef; times: number; avgMin: number | null }

export interface FenceRegister {
  fenceId: string
  visits: number
  hours: number
  days: number
  firstIn: number
  lastOut: number
  avgMin: number
  /** Minutes after midnight EAT: the median entry and exit time of day. */
  usualIn: number | null
  usualOut: number | null
  /** Where it went next, most often first. */
  next: VisitNext[]
}

export interface VisitsResult {
  fences: VisitFenceMeta[]
  visits: Visit[]
  register: FenceRegister[]
}

const r1 = (n: number) => Math.round(n * 10) / 10
const minuteOfDay = (ms: number) => { const d = new Date(ms + TZ_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes() }
const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

/** Points that stand for a fence's outline, for "is this fence inside that one". */
function outline(g: FenceGeometry): [number, number][] {
  if (g.type === 'POLYGON') return g.polygonCoords
  if (g.type === 'CIRCLE') {
    const out: [number, number][] = [[g.centerLng, g.centerLat]]
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * 2 * Math.PI
      const dLat = (g.radiusM * Math.cos(a)) / 111_320
      const dLng = (g.radiusM * Math.sin(a)) / (111_320 * Math.cos((g.centerLat * Math.PI) / 180))
      out.push([g.centerLng + dLng, g.centerLat + dLat])
    }
    return out
  }
  return []
}

/** Each fence's parent: the smallest other fence holding all of its outline. */
export function nestFences(fences: VisitFence[]): VisitFenceMeta[] {
  const parent = new Map<string, string | null>()
  for (const f of fences) {
    const pts = outline(f.geometry)
    let best: VisitFence | null = null
    for (const g of fences) {
      if (g.id === f.id || g.areaHa <= f.areaHa) continue
      if (!pts.every(([lng, lat]) => isInsideFence(lat, lng, g.geometry))) continue
      if (!best || g.areaHa < best.areaHa) best = g
    }
    parent.set(f.id, best?.id ?? null)
  }
  const depth = (id: string): number => { let d = 0, p = parent.get(id); while (p && d < 8) { d++; p = parent.get(p) } return d }
  return fences.map(f => ({ id: f.id, name: f.name, parentId: parent.get(f.id) ?? null, depth: depth(f.id), areaHa: r1(f.areaHa), source: f.source }))
}

/** The organisation's site fences, and the known sites no fence covers. */
export async function loadVisitFences(orgId: string): Promise<VisitFence[]> {
  const rows = await prisma.geofence.findMany({
    where: { organisationId: orgId, type: { in: ['CIRCLE', 'POLYGON'] } },
    select: { id: true, name: true, type: true, centerLat: true, centerLng: true, radiusM: true, polygonCoords: true },
  })
  const out: VisitFence[] = []
  for (const r of rows) {
    if (r.type === 'CIRCLE' && r.centerLat != null && r.centerLng != null && r.radiusM) {
      out.push({ id: r.id, name: r.name, source: 'fence', areaHa: (Math.PI * r.radiusM ** 2) / 10_000,
        geometry: { type: 'CIRCLE', centerLat: r.centerLat, centerLng: r.centerLng, radiusM: r.radiusM } })
    } else if (r.type === 'POLYGON' && Array.isArray(r.polygonCoords)) {
      const ring = r.polygonCoords as [number, number][]
      const ha = ring.length >= 3 ? ringAreaHa(ring) : 0
      if (ha > 0 && ha <= MAX_FENCE_HA) out.push({ id: r.id, name: r.name, source: 'fence', areaHa: ha, geometry: { type: 'POLYGON', polygonCoords: ring } })
    }
  }
  return [...out, ...uncoveredSites(out)]
}

/** Known sites (factories, weighbridge yards) that no fence stands on. */
export function uncoveredSites(fences: VisitFence[]): VisitFence[] {
  const out: VisitFence[] = []
  for (const s of STATIC_SITES) {
    if (s.lat == null || s.lng == null) continue
    if (fences.some(f => isInsideFence(s.lat!, s.lng!, f.geometry))) continue
    if (out.some(o => o.geometry.type === 'CIRCLE' && haversineM(o.geometry.centerLat, o.geometry.centerLng, s.lat!, s.lng!) < SITE_VISIT_RADIUS_M)) continue
    out.push({
      id: `site:${s.name}`, name: s.name, source: 'site', areaHa: (Math.PI * SITE_VISIT_RADIUS_M ** 2) / 10_000,
      geometry: { type: 'CIRCLE', centerLat: s.lat, centerLng: s.lng, radiusM: SITE_VISIT_RADIUS_M },
    })
  }
  return out
}

interface Fix { t: number; lat: number; lng: number }

/** One fence's raw visits over the fixes, in seconds. */
function runsOf(fixes: Fix[], g: FenceGeometry, box: FenceBox) {
  const runs: { a: number; b: number }[] = []   // fix indexes, inclusive
  let open = -1
  for (let i = 0; i < fixes.length; i++) {
    const f = fixes[i]!
    const inside = inBox(box, f.lat, f.lng) && isInsideFence(f.lat, f.lng, g)
    if (inside && open < 0) open = i
    if (!inside && open >= 0) { runs.push({ a: open, b: i - 1 }); open = -1 }
  }
  if (open >= 0) runs.push({ a: open, b: fixes.length - 1 })
  // Join over short outside spells: the edge, not a departure.
  const joined: { a: number; b: number }[] = []
  for (const r of runs) {
    const last = joined[joined.length - 1]
    if (last && fixes[r.a]!.t - fixes[last.b]!.t <= MERGE_S) last.b = r.b
    else joined.push({ ...r })
  }
  return joined.map(({ a, b }) => {
    const before = a > 0 ? fixes[a - 1]! : null
    const after = b < fixes.length - 1 ? fixes[b + 1]! : null
    const tin = fixes[a]!.t, tout = fixes[b]!.t
    const start = before && tin - before.t <= EDGE_S ? (before.t + tin) / 2 : tin
    const end = after && after.t - tout <= EDGE_S ? (tout + after.t) / 2 : tout
    let quiet = 0
    for (let i = a; i < b; i++) { const d = fixes[i + 1]!.t - fixes[i]!.t; if (d > QUIET_S) quiet += d }
    return { start, end, openStart: !before, openEnd: !after, quiet }
  })
}

/**
 * @param messages the review's messages (any order; the margin either side is
 *   cut to the period here).
 * @param stops the review's stops, for what came after a visit outside fences.
 */
export function computeVisits(
  messages: ReviewMessage[], period: { startMs: number; endMs: number },
  fences: VisitFence[], stops: ReviewStop[],
): VisitsResult {
  const meta = nestFences(fences)
  const metaOf = new Map(meta.map(m => [m.id, m]))
  const fixes: Fix[] = messages
    .filter(m => m.lat != null && m.lng != null && Number.isFinite(m.lat) && Number.isFinite(m.lng) && !(m.lat === 0 && m.lng === 0))
    .filter(m => m.t * 1000 >= period.startMs && m.t * 1000 < period.endMs)
    .sort((a, b) => a.t - b.t)
    .map(m => ({ t: m.t, lat: m.lat!, lng: m.lng! }))

  // Raw visits per fence.
  type Raw = { fenceId: string; start: number; end: number; openStart: boolean; openEnd: boolean; quiet: number }
  const raw: Raw[] = []
  for (const f of fences) {
    for (const r of runsOf(fixes, f.geometry, fenceBox(f.geometry))) {
      if (r.end - r.start < MIN_VISIT_S && !r.openStart && !r.openEnd) continue
      raw.push({ fenceId: f.id, ...r })
    }
  }
  raw.sort((a, b) => a.start - b.start || (metaOf.get(a.fenceId)!.depth - metaOf.get(b.fenceId)!.depth))

  const visits: Visit[] = raw.map((r, k) => ({
    id: k + 1, fenceId: r.fenceId, parent: null,
    start: Math.round(r.start * 1000), end: Math.round(r.end * 1000), min: r1((r.end - r.start) / 60),
    openStart: r.openStart, openEnd: r.openEnd, quietMin: r1(r.quiet / 60),
    next: null, toNextMin: null,
  }))
  // Each area visit inside its premises' visit (the one that covers its middle).
  for (const v of visits) {
    const pid = metaOf.get(v.fenceId)!.parentId
    if (!pid) continue
    const mid = (v.start + v.end) / 2
    const p = visits.find(u => u.fenceId === pid && u.start <= mid && u.end >= mid)
    if (p) v.parent = p.id
  }

  // ── what came next ──
  // Top level: the next top-level visit or the next stop outside every fence.
  const top = visits.filter(v => v.parent == null)
  const outsideStops = stops.filter(s => !fences.some(f => isInsideFence(s.lat, s.lng, f.geometry)))
  type Ev = { at: number; ref: VisitRef }
  const events: Ev[] = [
    ...top.map(v => ({ at: v.start, ref: { kind: 'fence' as const, id: v.fenceId, visit: v.id } })),
    ...outsideStops.map(s => ({ at: s.start, ref: { kind: 'place' as const, id: s.place, stop: s.id } })),
  ].sort((a, b) => a.at - b.at)
  for (const v of top) {
    if (v.openEnd) { v.next = { kind: 'end' }; continue }
    const ev = events.find(e => e.at >= v.end && !(e.ref.kind === 'fence' && e.ref.visit === v.id))
    if (ev) { v.next = ev.ref; v.toNextMin = r1((ev.at - v.end) / 60_000) }
  }
  // Inside a premises: the next area within the same premises' visit, else out.
  for (const v of visits) {
    if (v.parent == null) continue
    const p = visits.find(u => u.id === v.parent)!
    const sib = visits.find(u => u.parent === v.parent && u.id !== v.id && u.start >= v.end - 1000)
    if (sib && sib.start <= p.end) { v.next = { kind: 'fence', id: sib.fenceId, visit: sib.id }; v.toNextMin = r1(Math.max(0, sib.start - v.end) / 60_000) }
    else if (p.openEnd && v.openEnd) v.next = { kind: 'end' }
    else { v.next = { kind: 'exit', id: p.fenceId }; v.toNextMin = r1(Math.max(0, p.end - v.end) / 60_000) }
  }

  // ── the register: per fence, how often, how long, when, and where next ──
  const register: FenceRegister[] = []
  for (const m of meta) {
    const mine = visits.filter(v => v.fenceId === m.id)
    if (!mine.length) continue
    const sec = mine.reduce((a, v) => a + (v.end - v.start) / 1000, 0)
    const nexts = new Map<string, { ref: VisitRef; times: number; mins: number[] }>()
    for (const v of mine) {
      if (!v.next || v.next.kind === 'end') continue
      const key = v.next.kind === 'place' ? `p:${v.next.id}` : `${v.next.kind}:${v.next.id}`
      const e = nexts.get(key) ?? { ref: v.next, times: 0, mins: [] }
      e.times++
      if (v.toNextMin != null) e.mins.push(v.toNextMin)
      nexts.set(key, e)
    }
    register.push({
      fenceId: m.id,
      visits: mine.length,
      hours: r1(sec / 3600),
      days: new Set(mine.map(v => new Date(v.start + TZ_OFFSET_MS).toISOString().slice(0, 10))).size,
      firstIn: Math.min(...mine.map(v => v.start)),
      lastOut: Math.max(...mine.map(v => v.end)),
      avgMin: r1(sec / 60 / mine.length),
      usualIn: median(mine.filter(v => !v.openStart).map(v => minuteOfDay(v.start))),
      usualOut: median(mine.filter(v => !v.openEnd).map(v => minuteOfDay(v.end))),
      next: [...nexts.values()]
        .sort((a, b) => b.times - a.times)
        .slice(0, 3)
        .map(e => ({ ref: e.ref, times: e.times, avgMin: e.mins.length ? r1(e.mins.reduce((a, x) => a + x, 0) / e.mins.length) : null })),
    })
  }
  register.sort((a, b) => b.hours - a.hours)

  // Only the fences the unit went into travel with the review.
  const used = new Set(visits.map(v => v.fenceId))
  for (const v of visits) { let p = metaOf.get(v.fenceId)?.parentId; while (p) { used.add(p); p = metaOf.get(p)?.parentId ?? null } }
  return { fences: meta.filter(m => used.has(m.id)), visits, register }
}

/** "Sukari Industries · Weighbridge (work area)": the fence's own name, and
 *  what kind of place it is — every fence here is a work area. */
export const fenceLabel = (f: { name: string } | undefined, id: string) => `${f?.name ?? id} (work area)`

/** A visit's neighbour, in words, for the workbook and the PDF. */
export function refLabel(ref: VisitRef | null, fenceById: Map<string, VisitFenceMeta>, placeName: (id: number) => string): string {
  if (!ref) return ''
  if (ref.kind === 'end') return 'Still there at the end of the period'
  if (ref.kind === 'exit') return `Left ${fenceById.get(ref.id)?.name ?? ref.id}`
  if (ref.kind === 'fence') return fenceLabel(fenceById.get(ref.id), ref.id)
  return placeName(ref.id)
}
