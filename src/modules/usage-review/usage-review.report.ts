/**
 * The figures behind the Logbook PDF's report pages — the analysis the
 * hand-built KDP 365T tracking report (Aug–Sep 2026) carried, worked out from
 * the review so every vehicle gets it:
 *
 *   · executive summary — distance, driving, trips, active days, time at home,
 *     the top-3 places' share of stopped time, and four key findings;
 *   · where the stopped time went, place by place, home first;
 *   · how the period's hours divided — driving, idling, stopped at home,
 *     stopped away, each hour counted once (a stop's engine-on minutes are
 *     idling, so stopped is engine off);
 *   · when it drives — trips by weekday and by start hour;
 *   · the most frequent routes, place to place, and round trips;
 *   · the top sites with their median arrival and departure times.
 *
 * Pure: the review in, figures out. "Home" is usage-review.areas' home area —
 * every place of that kind counts as one home, named after its anchor place.
 */

import { TZ_OFFSET_MS, type ReviewPlace, type UsageReview } from './usage-review.compute.js'
import type { AreaSummary } from './usage-review.areas.js'

const r1 = (n: number) => Math.round(n * 10) / 10
const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0)
export function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2
}
const eat = (ms: number) => new Date(ms + TZ_OFFSET_MS)
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
/** 0 = Monday … 6 = Sunday, in Kenyan time. */
const weekdayOf = (ms: number) => (eat(ms).getUTCDay() + 6) % 7
const hourOf = (ms: number) => eat(ms).getUTCHours()
const minuteOfDay = (ms: number) => { const d = eat(ms); return d.getUTCHours() * 60 + d.getUTCMinutes() }

/** "riat centre, Kanyikela (NE, 1.2 km)" → "Riat Centre, Kanyikela": the
 *  name's first two parts, first letters raised, the direction note dropped. */
export function shortPlaceName(p: Pick<ReviewPlace, 'id' | 'name' | 'exactName'>): string {
  if (p.exactName) return p.exactName
  if (!p.name) return `Place ${p.id}`
  const head = p.name.replace(/\s*\(.*\)\s*$/, '')
  return head.split(',').slice(0, 2).map(s => s.trim()).filter(Boolean).join(', ')
    .replace(/(^|[\s,/–-])(\p{Ll})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase())
}

export interface SiteRow {
  key: string
  name: string
  home: boolean
  kind: 'work' | 'home' | 'elsewhere'
  /** What the place is (Banking, Food and drink…); null for home or unknown. */
  activity: string | null
  hours: number
  visits: number
  days: number
  avgH: number
  /** Minutes after midnight EAT; null when every visit ran over the period's edge. */
  arrive: number | null
  depart: number | null
}

export interface RouteRow { from: string; to: string; round: boolean; trips: number; km: number; hours: number }

export interface Finding { title: string; text: string; stat: string; statLabel: string }

export interface ReportFigures {
  stoppedH: number
  homeH: number
  homeShare: number | null
  top3Share: number | null
  homeName: string | null
  /** A home area was found: without one, nothing shows a home row. */
  hasHome: boolean
  activeKm: { mean: number | null; median: number | null; peak: { date: string; km: number } | null }
  tripKm: { mean: number | null; median: number | null }
  tripMin: number | null
  byWeekday: number[]
  byHour: number[]
  busiestDay: number | null
  quietestDay: number | null
  peakHour: number | null
  beforeNoonShare: number | null
  /** Driving, idling, stopped at home, stopped away — hours, each counted
   *  once: stopped is engine off, its engine-on minutes being idling. */
  split: { driving: number; idling: number | null; home: number; away: number }
  /** Every place, home merged into one row, most hours first. */
  sites: SiteRow[]
  routes: RouteRow[]
  findings: Finding[]
}

export function reportFigures(rv: Pick<UsageReview, 'places' | 'stops' | 'trips' | 'days' | 'summary' | 'period'>, areas: AreaSummary | null): ReportFigures {
  const s = rv.summary
  const placeById = new Map(rv.places.map(p => [p.id, p]))
  const isHome = (id: number) => placeById.get(id)?.kind === 'home'
  const anchor = areas?.homePlace != null ? placeById.get(areas.homePlace) ?? null : null
  const homeName = anchor ? shortPlaceName(anchor) : null
  const siteKey = (id: number) => (isHome(id) ? 'home' : `p${id}`)
  const siteName = (id: number) => (isHome(id) ? `Home (${homeName ?? shortPlaceName(placeById.get(id)!)})` : shortPlaceName(placeById.get(id) ?? { id, name: null }))

  const stoppedH = sum(rv.places.map(p => p.hours))
  const homeH = sum(rv.places.filter(p => p.kind === 'home').map(p => p.hours))

  // ── sites: home as one, every other place on its own ──
  const startMs = rv.period.startMs, endMs = rv.period.endMs
  const groups = new Map<string, { ids: number[] }>()
  for (const p of rv.places) {
    const k = siteKey(p.id)
    const g = groups.get(k) ?? { ids: [] }
    g.ids.push(p.id)
    groups.set(k, g)
  }
  const sites: SiteRow[] = [...groups.entries()].map(([key, g]) => {
    const st = rv.stops.filter(x => g.ids.includes(x.place))
    const hours = sum(g.ids.map(id => placeById.get(id)!.hours))
    const first = placeById.get(g.ids[0]!)!
    return {
      key, name: siteName(g.ids[0]!), home: key === 'home', kind: first.kind ?? 'elsewhere',
      activity: key === 'home' ? null : first.activity ?? null,
      hours: r1(hours), visits: st.length, days: new Set(st.map(x => eat(x.start).toISOString().slice(0, 10))).size,
      avgH: st.length ? Math.round((hours / st.length) * 100) / 100 : 0,
      // A stop that began before the period has no arrival in it; one that
      // ran past its end, no departure.
      arrive: median(st.filter(x => x.start > startMs + 60_000).map(x => minuteOfDay(x.start))),
      depart: median(st.filter(x => x.end < endMs - 60_000).map(x => minuteOfDay(x.end))),
    }
  }).sort((a, b) => b.hours - a.hours)
  for (const x of sites) { if (x.arrive != null) x.arrive = Math.round(x.arrive); if (x.depart != null) x.depart = Math.round(x.depart) }

  // ── routes: place to place, home as one ──
  const routeMap = new Map<string, RouteRow>()
  for (const t of rv.trips) {
    const a = siteKey(t.fromPlace), b = siteKey(t.toPlace)
    const k = `${a}>${b}`
    const r = routeMap.get(k) ?? { from: siteName(t.fromPlace), to: siteName(t.toPlace), round: a === b, trips: 0, km: 0, hours: 0 }
    r.trips++; r.km += t.km; r.hours += t.min / 60
    routeMap.set(k, r)
  }
  const routes = [...routeMap.values()].map(r => ({ ...r, km: Math.round(r.km), hours: r1(r.hours) }))
    .sort((a, b) => b.trips - a.trips || b.km - a.km)

  // ── when it drives ──
  const byWeekday = Array(7).fill(0) as number[]
  const byHour = Array(24).fill(0) as number[]
  for (const t of rv.trips) { byWeekday[weekdayOf(t.start)]!++; byHour[hourOf(t.start)]!++ }
  const argmax = (xs: number[]) => (xs.some(x => x > 0) ? xs.indexOf(Math.max(...xs)) : null)
  const busiestDay = argmax(byWeekday)
  const quietestDay = rv.trips.length ? byWeekday.indexOf(Math.min(...byWeekday)) : null
  const peakHour = argmax(byHour)
  const beforeNoonShare = rv.trips.length ? sum(byHour.slice(0, 12)) / rv.trips.length : null

  // ── distance ──
  const active = rv.days.filter(d => d.moved)
  const peakDay = active.reduce<{ date: string; km: number } | null>((b, d) => (!b || d.km > b.km ? { date: d.date, km: d.km } : b), null)
  const activeKm = {
    mean: active.length ? r1(sum(active.map(d => d.km)) / active.length) : null,
    median: median(active.map(d => d.km)),
    peak: peakDay,
  }
  const tripKm = {
    mean: rv.trips.length ? r1(sum(rv.trips.map(t => t.km)) / rv.trips.length) : null,
    median: median(rv.trips.map(t => t.km)),
  }
  const tripMin = rv.trips.length ? Math.round(sum(rv.trips.map(t => t.min)) / rv.trips.length) : null

  // Stopped with the engine off. A stop's engine-on minutes are idling, and
  // counted there: added again here, the parts ran past the period's hours
  // (KCP 136P, Aug–Sep 2026: 1,484 h of a 1,464 h period).
  const parkedH = (home: boolean) => sum(rv.stops.filter(st => isHome(st.place) === home)
    .map(st => Math.max(0, (st.end - st.start) / 3_600_000 - (st.idleMin ?? 0) / 60)))

  const top3 = sites.slice(0, 3)
  const top3Share = stoppedH > 0 ? sum(top3.map(x => x.hours)) / stoppedH : null
  const homeShare = stoppedH > 0 && homeH > 0 ? homeH / stoppedH : null

  // ── findings ──
  const pctS = (v: number | null) => (v == null ? '-' : `${Math.round(v * 100)}%`)
  const nf0 = (v: number | null | undefined) => (v == null ? '-' : Math.round(v).toLocaleString('en-GB'))
  const nf1 = (v: number | null | undefined) => (v == null ? '-' : (Math.round(v * 10) / 10).toLocaleString('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 }))
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const dlabel = (d: string) => `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]}`
  const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`
  const firstAway = sites.find(x => !x.home)
  // Each finding's figure says something its text and the tiles above do not
  // (2026-10-10: the top-3 share stood both in a tile and here).
  const lead = homeShare != null ? firstAway : sites[0]
  const findings: Finding[] = [
    {
      title: 'Activity Concentration',
      text: homeShare != null
        ? firstAway ? `Away from home, the most stopped time was at ${firstAway.name} (${nf1(firstAway.hours)} h).` : 'All of the stopped time was in the home area.'
        : sites[0] ? `No home area stands out; the most stopped time was at ${sites[0].name} (${nf1(sites[0].hours)} h).` : 'No stops of 10 minutes or more in the period.',
      stat: lead && stoppedH > 0 ? pctS(lead.hours / stoppedH) : pctS(homeShare),
      statLabel: lead ? `of stopped time at ${lead.name}` : homeShare != null ? 'of stopped time at home' : 'of stopped time',
    },
    {
      title: 'Distance Profile',
      text: activeKm.median != null && activeKm.peak
        ? `The median active day covered ${nf0(activeKm.median)} km; the longest, ${dlabel(activeKm.peak.date)}, covered ${nf0(activeKm.peak.km)} km.`
        : 'It did not move in the period.',
      stat: activeKm.median && activeKm.peak ? `${nf1(activeKm.peak.km / activeKm.median)}×` : '-', statLabel: 'longest day against the median',
    },
    {
      title: 'Trip Length',
      text: rv.trips.length
        ? `The average trip covered ${nf1(tripKm.mean)} km and lasted ${nf0(tripMin)} min.`
        : 'No trips between stops in the period.',
      stat: tripKm.median != null ? `${nf1(tripKm.median)} km` : '-', statLabel: 'median trip',
    },
    {
      title: 'Time-of-Day Pattern',
      text: peakHour != null && busiestDay != null
        ? `More trips started between ${hh(peakHour)} and ${hh(peakHour + 1)} than in any other hour; ${WEEKDAYS[busiestDay]} was the busiest day.`
        : 'No trips to read a pattern from.',
      stat: pctS(beforeNoonShare), statLabel: 'of trips started before noon',
    },
  ]

  return {
    stoppedH: r1(stoppedH), homeH: r1(homeH), homeShare, top3Share, homeName, hasHome: homeH > 0,
    activeKm, tripKm, tripMin, byWeekday, byHour, busiestDay, quietestDay, peakHour, beforeNoonShare,
    split: { driving: s.driveH, idling: s.idleH, home: r1(parkedH(true)), away: r1(parkedH(false)) },
    sites, routes, findings,
  }
}
