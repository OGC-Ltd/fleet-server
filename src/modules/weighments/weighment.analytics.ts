/**
 * The weighbridges over a window, rather than on a date.
 *
 * The day endpoint beside this one answers "what happened at the scales on the
 * 9th" and is built for a grid of tickets. This answers "how have the scales
 * been running", and is built for four measures an operator actually compares
 * across days: what was weighed in, how many lorries it took, how long each
 * one sat on the scale, and which of the four bridges carried it.
 *
 * ## A day we did not capture is not a day with no cane
 *
 * This is the whole reason this file is longer than a `groupBy`.
 *
 * The provider's feed serves a rolling window of about two days and cannot be
 * backfilled, so the table holds only the days the ingest was running for. At
 * the time of writing that is seven (2026-09-07 to 2026-09-13) against an
 * analytics screen whose default window is thirty. Emitting `tickets: 0` for
 * the other twenty-three would draw a factory that stood idle for three weeks,
 * which is not what happened — we simply were not listening.
 *
 * So every day in the window carries `captured`, and an uncaptured day carries
 * NULLS, never zeros. A zero here means the bridges were open and nothing
 * crossed them; a null means we cannot say. The client draws a gap for one and
 * a bar on the axis for the other, and the two must never look alike.
 *
 * `captured` is decided by the span of tickets we hold — first to last. That
 * is honest at the ends of the window, which is where the gap actually is, and
 * it is optimistic in one case: an ingest outage in the MIDDLE of the span
 * reads as a real quiet day. Nothing in the table can distinguish those two
 * today (there is no ingest log to join against), so the window's own span is
 * reported alongside the days and the footer says what it rests on.
 *
 * ## Turnaround is a median, not a mean
 *
 * Loading times are skewed hard right: most lorries are on and off in under an
 * hour, a few sit for most of a shift waiting on a loader. A mean follows the
 * tail and describes no lorry; the median describes the one in the middle,
 * which is the lorry an operator is actually thinking about. The 90th is
 * carried beside it because the tail is the thing worth fixing, and a middle
 * with no spread beside it hides it.
 *
 * ## Lorries are counted on the normalised plate
 *
 * Same rule as the day service, and for the same reason: the scale operators
 * type "KTCC 849B" and "KTCC849B" for one machine, and a distinct count over
 * the verbatim field reports a fleet twice its real size.
 */

import { BadRequestError } from '../../core/errors/errors.js'
import { fleetDayBounds, fleetDayKey } from '../../lib/provider-time.js'
import * as repo from './weighment.repository.js'
import type { WeighmentAggRow } from './weighment.repository.js'
import type { WeighmentAnalyticsQuery } from './weighment.schema.js'

/** One fleet day at the scales. Every measure is nullable, and the null means
 *  "not captured" rather than "none" — see the note at the top. */
export interface WeighmentDayPoint {
  day:             string
  captured:        boolean
  tickets:         number | null
  lorries:         number | null
  netKg:           number | null
  /** Tickets this day's turnaround figures stand on. Lower than `tickets`
   *  whenever a ticket carries only one of its two stamps, which is what a
   *  lorry still on the scale looks like. */
  ticketsTimed:    number | null
  turnaroundP50Ms: number | null
  turnaroundP90Ms: number | null
}

/** One bridge over the whole window. */
export interface WeighmentCentrePoint {
  code:            number
  name:            string
  tickets:         number
  lorries:         number
  netKg:           number
  ticketsTimed:    number
  turnaroundP50Ms: number | null
  turnaroundP90Ms: number | null
  /** Captured days this bridge raised at least one ticket on. A bridge that
   *  worked two of the seven days we hold is a different statement from one
   *  that worked all seven for the same total, and the tonnage alone cannot
   *  tell them apart. */
  activeDays:      number
}

export interface WeighmentAnalyticsResult {
  /** The window asked for, as fleet days, both inclusive. */
  from: string
  to:   string
  /** The span tickets actually exist over, anywhere in this organisation's
   *  history — not clipped to the window. Null when none have ever arrived. */
  captured: { first: string; last: string } | null
  /** How many days of the window fall inside that span. The client says this
   *  out loud rather than letting a 30-day heading stand over 7 days of bars. */
  capturedDays: number
  days:    WeighmentDayPoint[]
  centres: WeighmentCentrePoint[]
  totals: {
    tickets:         number
    lorries:         number
    netKg:           number
    ticketsTimed:    number
    turnaroundP50Ms: number | null
    turnaroundP90Ms: number | null
    /** Captured days with at least one ticket. The denominator for any
     *  "per working day" figure, and never the window's length. */
    activeDays:      number
    heaviestDay:     { day: string; netKg: number } | null
  }
  /** Echoed so the client can label a filtered view without holding the
   *  request that produced it. Null is every bridge. */
  centre: number | null
}

/**
 * Nearest-rank percentile over a sorted array of milliseconds.
 *
 * Nearest-rank rather than interpolated: every value in here is a measured
 * turnaround, and the answer to "what does the middle lorry wait" should be a
 * wait that a lorry actually had, not a number halfway between two of them.
 */
function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null
  const rank = Math.ceil((p / 100) * sortedAsc.length)
  return sortedAsc[Math.min(sortedAsc.length, Math.max(1, rank)) - 1] ?? null
}

/**
 * Loading time for one ticket.
 *
 * `Math.abs`, and deliberately — the day service carries the same guard and
 * the same reason. Most of this fleet weighs empty first and comes back
 * loaded, but a minority do the opposite (14 of 729 on the day measured), and
 * a subtraction written one way round would report those as negative.
 */
function turnaroundMs(row: WeighmentAggRow): number | null {
  if (!row.grossAt || !row.tareAt) return null
  return Math.abs(row.grossAt.getTime() - row.tareAt.getTime())
}

/** The fleet day a ticket belongs to, as `YYYY-MM-DD`.
 *
 *  Africa/Nairobi is a fixed +03:00 with no DST, so shifting the instant and
 *  reading the UTC date off it is exact — and it is the same arithmetic
 *  `fleetDayBounds` does in the other direction. */
const dayKeyOf = (at: Date) =>
  new Date(at.getTime() + 3 * 3_600_000).toISOString().slice(0, 10)

/** `n` days back from `day` inclusive, oldest first. */
function dayKeysEndingAt(day: string, n: number): string[] {
  const end = fleetDayBounds(day)
  if (!end) return []
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    out.push(dayKeyOf(new Date(end.from.getTime() - i * 86_400_000)))
  }
  return out
}

/** Everything a bucket accumulates before it is turned into a point. */
interface Bucket {
  tickets: number
  lorries: Set<string>
  netKg:   number
  timings: number[]
  days:    Set<string>
}

const emptyBucket = (): Bucket => ({
  tickets: 0, lorries: new Set(), netKg: 0, timings: [], days: new Set(),
})

function add(b: Bucket, row: WeighmentAggRow, dayKey: string): void {
  b.tickets += 1
  b.lorries.add(row.vehiclePlate)
  b.days.add(dayKey)
  // `netWeightKg` is null on a transfer's first leg — the load has been
  // weighed in but not yet out — so it is skipped rather than counted as zero.
  // A zero here would drag the day's tonnage down by however many lorries
  // happened to be mid-transfer when the window closed.
  if (row.netWeightKg != null) b.netKg += row.netWeightKg
  const t = turnaroundMs(row)
  if (t != null) b.timings.push(t)
}

export async function getWeighmentAnalytics(
  organisationId: string,
  q: WeighmentAnalyticsQuery,
): Promise<WeighmentAnalyticsResult> {
  const days = q.days ?? 30
  const to   = q.to ?? fleetDayKey().toISOString().slice(0, 10)

  const endBounds = fleetDayBounds(to)
  if (!endBounds) throw new BadRequestError('`to` must be YYYY-MM-DD')

  const keys = dayKeysEndingAt(to, days)
  const from = keys[0]!
  const startBounds = fleetDayBounds(from)!

  const [rows, captured] = await Promise.all([
    repo.findRange(organisationId, startBounds.from, endBounds.to),
    repo.findCapturedRange(organisationId),
  ])

  // The centre filter narrows what is COUNTED, never what the window is. The
  // per-centre breakdown below is built from the same filtered set, so asking
  // for one bridge returns that bridge alone rather than one bridge's days
  // beside four bridges' totals — which would be two different questions
  // answered in one payload.
  const kept = q.centre == null ? rows : rows.filter((r) => r.centerCode === q.centre)

  const byDay    = new Map<string, Bucket>()
  const byCentre = new Map<number, Bucket & { name: string }>()
  for (const key of keys) byDay.set(key, emptyBucket())

  for (const row of kept) {
    const key = dayKeyOf(row.tokenAt)
    const d = byDay.get(key)
    // A ticket outside the requested days cannot normally arrive — the range
    // read is bounded by the same two instants — but a row exactly on the
    // closing boundary would, and silently creating a bucket for it would
    // append a day the caller did not ask for.
    if (d) add(d, row, key)

    let c = byCentre.get(row.centerCode)
    if (!c) {
      c = Object.assign(emptyBucket(), { name: row.centerName })
      byCentre.set(row.centerCode, c)
    }
    // The newest spelling wins, as in `findOrgCentres`: a centre renamed
    // upstream must appear once, under the name it goes by now.
    c.name = row.centerName
    add(c, row, key)
  }

  const capturedFirst = captured ? dayKeyOf(captured.first) : null
  const capturedLast  = captured ? dayKeyOf(captured.last)  : null
  const isCaptured = (key: string) =>
    capturedFirst != null && capturedLast != null
    && key >= capturedFirst && key <= capturedLast

  const dayPoints: WeighmentDayPoint[] = keys.map((day) => {
    const b = byDay.get(day)!
    if (!isCaptured(day)) {
      return {
        day, captured: false,
        tickets: null, lorries: null, netKg: null,
        ticketsTimed: null, turnaroundP50Ms: null, turnaroundP90Ms: null,
      }
    }
    const timings = b.timings.sort((x, y) => x - y)
    return {
      day, captured: true,
      tickets: b.tickets,
      lorries: b.lorries.size,
      netKg:   b.netKg,
      ticketsTimed:    timings.length,
      turnaroundP50Ms: percentile(timings, 50),
      turnaroundP90Ms: percentile(timings, 90),
    }
  })

  const centres: WeighmentCentrePoint[] = [...byCentre.entries()]
    .map(([code, b]) => {
      const timings = b.timings.sort((x, y) => x - y)
      return {
        code,
        name:    b.name,
        tickets: b.tickets,
        lorries: b.lorries.size,
        netKg:   b.netKg,
        ticketsTimed:    timings.length,
        turnaroundP50Ms: percentile(timings, 50),
        turnaroundP90Ms: percentile(timings, 90),
        activeDays:      b.days.size,
      }
    })
    .sort((a, b) => b.netKg - a.netKg || a.code - b.code)

  // Totals are computed over the KEPT rows rather than by summing the day
  // points, because two of the figures do not sum. A lorry that crossed on
  // four days is one lorry over the window and four in the day column, and a
  // median of medians is not the median.
  const allTimings = kept.map(turnaroundMs).filter((t): t is number => t != null)
                         .sort((a, b) => a - b)
  const allLorries = new Set(kept.map((r) => r.vehiclePlate))
  const netTotal   = kept.reduce((s, r) => s + (r.netWeightKg ?? 0), 0)

  const worked = dayPoints.filter((d) => d.captured && (d.tickets ?? 0) > 0)
  const heaviest = worked.reduce<WeighmentDayPoint | null>(
    (best, d) => (best == null || (d.netKg ?? 0) > (best.netKg ?? 0) ? d : best), null)

  return {
    from,
    to,
    captured: capturedFirst && capturedLast
      ? { first: capturedFirst, last: capturedLast }
      : null,
    capturedDays: dayPoints.filter((d) => d.captured).length,
    days:    dayPoints,
    centres,
    totals: {
      tickets:         kept.length,
      lorries:         allLorries.size,
      netKg:           netTotal,
      ticketsTimed:    allTimings.length,
      turnaroundP50Ms: percentile(allTimings, 50),
      turnaroundP90Ms: percentile(allTimings, 90),
      activeDays:      worked.length,
      heaviestDay: heaviest && heaviest.netKg != null
        ? { day: heaviest.day, netKg: heaviest.netKg }
        : null,
    },
    centre: q.centre ?? null,
  }
}
