/**
 * The units dispatched to an organisation's weighbridges, still out.
 *
 * FactorySuite announces every cane run as a `dispatch.created` webhook (and
 * the reconciler re-reads `/dispatches` behind it); both land in `dispatches`
 * through webhooks/raifactorysuite-events.handleDispatch. This reads the open
 * ones back for the weighbridge board: which trucks and tractors are out, where
 * they were sent, and how long that run usually takes.
 *
 * ## What "dispatched to a weighbridge" means here
 *
 * The dispatcher types a destination freehand. On SUKARI (measured 2026-10-01,
 * 30 days) the trucks go to the outstations, which are weighbridge yards —
 * OPAPO, NYAONDO, OYANI — and the tractors go to named farms (ADEK, ODIYO, …)
 * and bring the cane to the factory's own scale. So a destination that names
 * one of the organisation's yards is matched to that yard; anything else is a
 * FIELD run, which ends at the mill.
 *
 * ## Out longer than a run takes
 *
 * Measured, never declared: the median of the COMPLETED runs to the same
 * destination (dispatch.repository's `destinationDurations`, ≥ 5 runs). A
 * destination with too little history falls back to the organisation's median
 * over every completed cane run. The provider's own expected-return time is
 * not used — dispatchers rarely set it, and it is a promise, not a duration.
 *
 * ## Stale paperwork is not a unit on the road
 *
 * A run nobody signed back in stays open for ever: SUKARI held 111 open runs
 * older than three days on 2026-10-01, the oldest from July. Those are counted
 * and returned as `staleCount`, never drawn as vehicles out, because a board
 * that shows a July sign-out as "out 1,600 h" is a board nobody reads twice.
 */

import { prisma } from '../../lib/prisma.js'
import { destinationDurations } from '../dispatches/dispatch.repository.js'
import { findOrgCentres } from './weighment.repository.js'

const HOUR = 3_600_000

/** Older than this, an open run is stale paperwork rather than a unit out.
 *  The 99th percentile of a completed cane run on SUKARI is ~6 days, but the
 *  90th is 18 h; two days keeps every plausible run and drops the forgotten. */
export const STALE_AFTER_MS = 48 * HOUR

/** Used only when an organisation has no completed run at all to measure. */
export const FALLBACK_RUN_HOURS = 12

const OPEN_STATUSES = ['DISPATCHED', 'OVERDUE']

export type UnitType = 'TRUCK' | 'TRACTOR' | 'OTHER'

export interface DispatchedUnit {
  id: string
  plate: string
  vehicleId: string | null
  vehicleType: UnitType
  driverName: string
  destination: string | null
  /** The yard the destination names, or null for a field run to the mill. */
  siteCode: number | null
  siteName: string | null
  dispatchedAt: string
  elapsedMs: number
  /** Median hours of completed runs to this destination, or the org-wide one. */
  typicalHours: number
  typicalSource: 'destination' | 'organisation' | 'default'
  overdue: boolean
}

export interface DispatchedResult {
  asOf: string
  units: DispatchedUnit[]
  counts: { trucks: number; tractors: number; other: number; overdue: number }
  /** Open runs older than STALE_AFTER_MS: paperwork never signed back. */
  staleCount: number
  /** The newest cane dispatch we hold for this org — how live the feed is. */
  lastDispatchAt: string | null
}

/** "OPAPO", "Opapo yard", "KITALE (AMUKA) YARD" → "OPAPO", "KITALE (AMUKA)". */
export function siteKey(name: string | null | undefined): string {
  return (name ?? '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+(YARD|CENTRE|CENTER|WEIGHBRIDGE)$/, '')
}

/** The yard a freehand destination names, or null. The mill's own scale is
 *  never a destination match: a run is sent OUT to cane, not to the factory. */
export function matchSite(
  destination: string | null | undefined,
  centres: { code: number; name: string }[],
): { code: number; name: string } | null {
  const key = siteKey(destination)
  if (!key) return null
  for (const c of centres) {
    if (/FACTORY|MILL/i.test(c.name)) continue
    if (siteKey(c.name) === key) return c
  }
  return null
}

export function unitType(vehicleType: string | null | undefined): UnitType {
  const t = (vehicleType ?? '').toUpperCase()
  if (t.includes('TRACTOR')) return 'TRACTOR'
  if (t.includes('TRUCK') || t.includes('LORRY')) return 'TRUCK'
  return 'OTHER'
}

/** Median of a list of numbers; null when empty. */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

export async function getDispatchedUnits(
  organisationId: string,
  now: number = Date.now(),
): Promise<DispatchedResult> {
  const staleBefore = new Date(now - STALE_AFTER_MS)

  const [open, staleCount, last, centres, durations, orgRuns] = await Promise.all([
    prisma.dispatch.findMany({
      where: {
        organisationId, kind: 'CANE', actualReturnAt: null,
        status: { in: OPEN_STATUSES }, dispatchedAt: { gte: staleBefore },
      },
      orderBy: { dispatchedAt: 'asc' },
      select: {
        externalId: true, plate: true, vehicleId: true, driverName: true,
        destination: true, dispatchedAt: true,
        vehicle: { select: { vehicleType: true } },
      },
    }),
    prisma.dispatch.count({
      where: {
        organisationId, kind: 'CANE', actualReturnAt: null,
        status: { in: OPEN_STATUSES }, dispatchedAt: { lt: staleBefore },
      },
    }),
    prisma.dispatch.findFirst({
      where: { organisationId, kind: 'CANE' },
      orderBy: { dispatchedAt: 'desc' },
      select: { dispatchedAt: true },
    }),
    findOrgCentres(organisationId),
    destinationDurations(organisationId),
    // The organisation's whole completed history, for destinations too new to
    // have five runs of their own. Bounded to 90 days so a season's pattern,
    // not last year's, sets the bar.
    prisma.$queryRaw<{ h: number }[]>`
      SELECT EXTRACT(EPOCH FROM (actual_return_at - dispatched_at)) / 3600 AS h
        FROM dispatches
       WHERE organisation_id = ${organisationId}
         AND kind = 'CANE'
         AND actual_return_at > dispatched_at
         AND dispatched_at > NOW() - INTERVAL '90 days'
    `,
  ])

  const orgMedian = median(orgRuns.map(r => Number(r.h)))

  const units: DispatchedUnit[] = open.map((d) => {
    const typ = durations.get(d.destination?.trim().toUpperCase() ?? '')
    const typicalHours = typ?.medianHours ?? (orgMedian != null ? Number(orgMedian.toFixed(1)) : FALLBACK_RUN_HOURS)
    const typicalSource: DispatchedUnit['typicalSource'] =
      typ ? 'destination' : orgMedian != null ? 'organisation' : 'default'
    // Floored at zero: a sign-out stamped a minute ahead of our clock is not
    // "−1m out".
    const elapsedMs = Math.max(0, now - d.dispatchedAt.getTime())
    const site = matchSite(d.destination, centres)
    return {
      id:           d.externalId,
      plate:        d.plate,
      vehicleId:    d.vehicleId,
      vehicleType:  unitType(d.vehicle?.vehicleType),
      driverName:   d.driverName,
      destination:  d.destination,
      siteCode:     site?.code ?? null,
      siteName:     site?.name ?? null,
      dispatchedAt: d.dispatchedAt.toISOString(),
      elapsedMs,
      typicalHours,
      typicalSource,
      overdue:      elapsedMs > typicalHours * HOUR,
    }
  })

  return {
    asOf: new Date(now).toISOString(),
    units,
    counts: {
      trucks:   units.filter(u => u.vehicleType === 'TRUCK').length,
      tractors: units.filter(u => u.vehicleType === 'TRACTOR').length,
      other:    units.filter(u => u.vehicleType === 'OTHER').length,
      overdue:  units.filter(u => u.overdue).length,
    },
    staleCount,
    lastDispatchAt: last?.dispatchedAt.toISOString() ?? null,
  }
}
