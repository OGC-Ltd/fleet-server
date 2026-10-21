import { BadRequestError } from '../../core/errors/errors.js'
import * as repo from './incidents.repository.js'
import type { SummaryQuery, ListQuery, InsightsQuery } from './incidents.schema.js'

/**
 * The widest window any of these endpoints will serve.
 *
 * Matches the clamp telemetry.controller already applies to its history range.
 * A year is more than the reports ask for (they are month-scale) and well
 * inside what the indexes handle; beyond it the request is a mistake, and
 * failing loudly is better than serving a slow scan.
 */
const MAX_SPAN_DAYS = 366

function range(from: Date, to: Date): repo.Range {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new BadRequestError('from and to must be valid dates')
  }
  if (to < from) throw new BadRequestError('to must not be before from')
  const spanDays = (to.getTime() - from.getTime()) / 86_400_000
  if (spanDays > MAX_SPAN_DAYS) {
    throw new BadRequestError(`range must be ${MAX_SPAN_DAYS} days or fewer`)
  }
  return { from, to }
}

/**
 * The aggregate list pages by OFFSET, so the cursor is a count rather than an
 * id — see the note in the repository. Rejected rather than silently treated as
 * zero, because a malformed cursor that quietly restarts at page one is how a
 * "Load more" button ends up looping over the same fifty rows forever.
 */
function offsetFrom(cursor?: string): number {
  if (!cursor) return 0
  const n = Number(cursor)
  if (!Number.isInteger(n) || n < 0) throw new BadRequestError('invalid cursor')
  return n
}

const kindsFrom = (kind?: string): string[] | undefined =>
  kind ? kind.split(',').map(k => k.trim()).filter(Boolean) : undefined

/* ── speeding ─────────────────────────────────────────────────────────────── */

export async function speedingSummary(orgId: string, q: SummaryQuery) {
  const offset = offsetFrom(q.cursor)
  const { rows, hasNextPage } = await repo.speedingSummary(orgId, range(q.from, q.to), {
    sort: q.sort, limit: q.limit, offset, minCount: q.minCount, search: q.q,
  })
  return {
    data:   rows,
    cursor: hasNextPage ? String(offset + rows.length) : null,
    hasNextPage,
  }
}

export async function speedingList(orgId: string, q: ListQuery) {
  return repo.speedingList(orgId, range(q.from, q.to), {
    vehicleId: q.vehicleId, cursor: q.cursor, limit: q.limit,
  })
}

export async function speedingInsights(orgId: string, q: InsightsQuery) {
  const r = range(q.from, q.to)
  const [insights, prevIncidents, capture] = await Promise.all([
    repo.speedingInsights(orgId, r),
    repo.speedingPrevCount(orgId, r),
    repo.captureStart(orgId),
  ])
  return {
    ...insights,
    /**
     * Null means "we have no history that far back", NOT zero. The UI must
     * render "no comparison yet" — a 100% drop that is really an absent history
     * is the classic version of this bug.
     */
    monthOverMonth: prevIncidents == null ? null : {
      prevIncidents,
      deltaPct: prevIncidents === 0
        ? null
        : Math.round(((insights.incidents - prevIncidents) / prevIncidents) * 100),
    },
    /** So the screen can say a short month is short because capture is young. */
    captureStartedAt: capture.speeding,
  }
}

/* ── sensor faults ────────────────────────────────────────────────────────── */

export async function faultSummary(orgId: string, q: SummaryQuery) {
  const offset = offsetFrom(q.cursor)
  const { rows, hasNextPage } = await repo.faultSummary(orgId, range(q.from, q.to), {
    sort: q.sort, limit: q.limit, offset, kinds: kindsFrom(q.kind), minCount: q.minCount, search: q.q,
  })
  return {
    data:   rows,
    cursor: hasNextPage ? String(offset + rows.length) : null,
    hasNextPage,
  }
}

export async function faultList(orgId: string, q: ListQuery) {
  return repo.faultList(orgId, range(q.from, q.to), {
    vehicleId: q.vehicleId, kinds: kindsFrom(q.kind), cursor: q.cursor, limit: q.limit,
  })
}

export async function faultInsights(orgId: string, q: InsightsQuery) {
  const r = range(q.from, q.to)
  const [insights, capture] = await Promise.all([
    repo.faultInsights(orgId, r),
    repo.captureStart(orgId),
  ])
  return { ...insights, captureStartedAt: capture.faults }
}
