/**
 * The Alerts page's reads: fuel alerts and overspeeding episodes across every
 * organisation the caller may read, one page at a time, newest first.
 *
 * A FUEL ALERT is exactly what the map announces (telemetry.repository's open
 * incidents): an announced drain cause, from the clean-slate epoch on. Unlike
 * the map, the page does not stop at 24 hours or at a decision: an alert that
 * aged off the map undecided is still open here, and a decided one is listed
 * under its decision.
 *
 * An OVERSPEEDING ALERT is one completed episode from speeding_incidents.
 *
 * Both lists page on (time, id COLLATE "C") so they can be merged into one
 * page (alerts.scope mergePage).
 */

import { Prisma } from '../../../generated/prisma/client.js'
import { prisma } from '../../lib/prisma.js'
import { ANNOUNCED_CAUSES } from '../fuel/fuel-theft-classifier.js'
import { FUEL_INCIDENT_EPOCH, incidentReasonSlugs } from '../telemetry/telemetry.repository.js'
import { likeTerm, type AlertStatus, type Cursor } from './alerts.rules.js'
import type { OrgScope } from './alerts.scope.js'

export interface AlertWindow {
  scopes: OrgScope[]
  from: Date
  to: Date
  q?: string
  minOverKmh?: number
}

/** `(org = a) OR (org = b AND vehicle = ANY(...))`, one arm per organisation. */
function scopeSql(scopes: OrgScope[], orgCol: string, vehicleCol: string): Prisma.Sql {
  if (scopes.length === 0) return Prisma.sql`FALSE`
  const arms = scopes.map((s) => (s.vehicleIds
    ? Prisma.sql`(${Prisma.raw(orgCol)} = ${s.orgId} AND ${Prisma.raw(vehicleCol)} = ANY(${s.vehicleIds}::text[]))`
    : Prisma.sql`${Prisma.raw(orgCol)} = ${s.orgId}`))
  return Prisma.sql`(${Prisma.join(arms, ' OR ')})`
}

const plateSql = (q?: string) => (q
  ? Prisma.sql`AND (v.registration_plate ILIKE ${likeTerm(q)} OR v.name ILIKE ${likeTerm(q)})`
  : Prisma.empty)

const cursorSql = (timeCol: string, idCol: string, c: Cursor | null) => (c
  ? Prisma.sql`AND (${Prisma.raw(timeCol)} < ${c.at}
       OR (${Prisma.raw(timeCol)} = ${c.at} AND ${Prisma.raw(idCol)} COLLATE "C" < ${c.id}))`
  : Prisma.empty)

// ── Fuel ────────────────────────────────────────────────────────────────────

/** fuel.repository's reading of FuelTheft.reviewStatus, as SQL (alerts.scope fuelStatus). */
const FUEL_BUCKET = Prisma.sql`CASE
  WHEN t.review_status::text IN ('CONFIRMED_THEFT', 'PROBE_FAULT') THEN 'escalated'
  WHEN t.review_status::text = 'NOT_THEFT' THEN 'deescalated'
  ELSE 'open' END`

function fuelWhere(w: AlertWindow, scopes: OrgScope[]): Prisma.Sql {
  // The epoch is a floor on the window, as it is on the map: nothing that
  // began before it was ever announced.
  const from = w.from > FUEL_INCIDENT_EPOCH ? w.from : FUEL_INCIDENT_EPOCH
  return Prisma.sql`
    ${scopeSql(scopes, 'v.organisation_id', 't.vehicle_id')}
    AND (t.drain_cause::text = ANY(${ANNOUNCED_CAUSES as unknown as string[]}::text[])
      OR t.cause_reason      = ANY(${incidentReasonSlugs()}::text[]))
    AND t.began_at >= ${from} AND t.began_at <= ${w.to}
    ${plateSql(w.q)}`
}

export interface FuelAlertRow {
  id: string
  orgId: string
  vehicleId: string
  plate: string
  vehicleName: string | null
  at: Date
  detectedAt: Date
  stolenMl: number
  location: string | null
  tankBeforeMl: number | null
  tankAfterMl: number | null
  cause: string | null
  rule: string | null
  confidence: number | null
  reviewStatus: string | null
  reviewedAt: Date | null
  reviewNote: string | null
  reviewedBy: string | null
  dismissedAt: Date | null
  followUpStatus: string | null
  driverName: string | null
}

export function fuelRows(w: AlertWindow, scopes: OrgScope[], status: AlertStatus | 'all', cursor: Cursor | null, limit: number) {
  const statusSql = status === 'all' ? Prisma.empty : Prisma.sql`AND ${FUEL_BUCKET} = ${status}`
  return prisma.$queryRaw<FuelAlertRow[]>`
    SELECT t.id, v.organisation_id AS "orgId", t.vehicle_id AS "vehicleId",
           v.registration_plate AS plate, v.name AS "vehicleName",
           t.began_at AS at, t.detected_at AS "detectedAt", t.stolen_ml AS "stolenMl",
           t.initial_location AS location,
           t.initial_fuel_level_ml AS "tankBeforeMl", t.final_fuel_level_ml AS "tankAfterMl",
           t.drain_cause::text AS cause, t.cause_reason AS rule, t.cause_confidence AS confidence,
           t.review_status::text AS "reviewStatus", t.reviewed_at AS "reviewedAt",
           t.review_note AS "reviewNote", ru.full_name AS "reviewedBy",
           t.dismissed_at AS "dismissedAt", f.status::text AS "followUpStatus",
           d.full_name AS "driverName"
      FROM fuel_thefts t
      JOIN vehicles v ON v.id = t.vehicle_id
      LEFT JOIN users ru ON ru.id = t.reviewed_by_id
      LEFT JOIN users d ON d.id = t.driver_id
      LEFT JOIN fuel_theft_followups f ON f.theft_id = t.id
     WHERE ${fuelWhere(w, scopes)}
       ${statusSql}
       ${cursorSql('t.began_at', 't.id', cursor)}
     ORDER BY t.began_at DESC, t.id COLLATE "C" DESC
     LIMIT ${limit + 1}`
}

export interface CountRow { orgId: string; status: AlertStatus; n: number }

export function fuelCounts(w: AlertWindow, scopes: OrgScope[]) {
  return prisma.$queryRaw<CountRow[]>`
    SELECT v.organisation_id AS "orgId", ${FUEL_BUCKET} AS status, count(*)::int AS n
      FROM fuel_thefts t
      JOIN vehicles v ON v.id = t.vehicle_id
     WHERE ${fuelWhere(w, scopes)}
     GROUP BY 1, 2`
}

// ── Overspeeding ────────────────────────────────────────────────────────────

const SPEED_BUCKET = Prisma.sql`CASE
  WHEN s.review_status::text = 'ESCALATED' THEN 'escalated'
  WHEN s.review_status::text = 'DEESCALATED' THEN 'deescalated'
  ELSE 'open' END`

function speedingWhere(w: AlertWindow, scopes: OrgScope[]): Prisma.Sql {
  return Prisma.sql`
    ${scopeSql(scopes, 's.organisation_id', 's.vehicle_id')}
    AND s.started_at >= ${w.from} AND s.started_at <= ${w.to}
    ${w.minOverKmh ? Prisma.sql`AND s.over_by_kmh >= ${w.minOverKmh}` : Prisma.empty}
    ${plateSql(w.q)}`
}

export interface SpeedingAlertRow {
  id: string
  orgId: string
  vehicleId: string
  plate: string
  vehicleName: string | null
  at: Date
  endedAt: Date
  durationSec: number
  peakKmh: number
  avgKmh: number | null
  limitKmh: number
  limitSource: string
  overByKmh: number
  frames: number
  distanceM: number | null
  driverName: string | null
  peakLat: number | null
  peakLng: number | null
  reviewStatus: string | null
  reviewedAt: Date | null
  reviewNote: string | null
  reviewedBy: string | null
}

export function speedingRows(w: AlertWindow, scopes: OrgScope[], status: AlertStatus | 'all', cursor: Cursor | null, limit: number) {
  const statusSql = status === 'all' ? Prisma.empty : Prisma.sql`AND ${SPEED_BUCKET} = ${status}`
  return prisma.$queryRaw<SpeedingAlertRow[]>`
    SELECT s.id, s.organisation_id AS "orgId", s.vehicle_id AS "vehicleId",
           v.registration_plate AS plate, v.name AS "vehicleName",
           s.started_at AS at, s.ended_at AS "endedAt", s.duration_sec AS "durationSec",
           s.peak_kmh AS "peakKmh", s.avg_kmh AS "avgKmh", s.limit_kmh AS "limitKmh",
           s.limit_source AS "limitSource", s.over_by_kmh AS "overByKmh", s.frames,
           s.distance_m AS "distanceM", s.driver_name AS "driverName",
           s.peak_lat AS "peakLat", s.peak_lng AS "peakLng",
           s.review_status::text AS "reviewStatus", s.reviewed_at AS "reviewedAt",
           s.review_note AS "reviewNote", ru.full_name AS "reviewedBy"
      FROM speeding_incidents s
      JOIN vehicles v ON v.id = s.vehicle_id
      LEFT JOIN users ru ON ru.id = s.reviewed_by_id
     WHERE ${speedingWhere(w, scopes)}
       ${statusSql}
       ${cursorSql('s.started_at', 's.id', cursor)}
     ORDER BY s.started_at DESC, s.id COLLATE "C" DESC
     LIMIT ${limit + 1}`
}

export function speedingCounts(w: AlertWindow, scopes: OrgScope[]) {
  return prisma.$queryRaw<CountRow[]>`
    SELECT s.organisation_id AS "orgId", ${SPEED_BUCKET} AS status, count(*)::int AS n
      FROM speeding_incidents s
      JOIN vehicles v ON v.id = s.vehicle_id
     WHERE ${speedingWhere(w, scopes)}
     GROUP BY 1, 2`
}

// ── Decisions ───────────────────────────────────────────────────────────────

/** Every decision on these alerts, oldest first. */
export function decisionsFor(fuelIds: string[], speedingIds: string[]) {
  const or: Prisma.AlertDecisionWhereInput[] = []
  if (fuelIds.length) or.push({ kind: 'FUEL', alertId: { in: fuelIds } })
  if (speedingIds.length) or.push({ kind: 'SPEEDING', alertId: { in: speedingIds } })
  if (or.length === 0) return Promise.resolve([])
  return prisma.alertDecision.findMany({
    where: { OR: or },
    orderBy: { at: 'asc' },
    select: {
      kind: true, alertId: true, outcome: true, reason: true, note: true, at: true,
      actor: { select: { fullName: true } },
    },
  })
}
