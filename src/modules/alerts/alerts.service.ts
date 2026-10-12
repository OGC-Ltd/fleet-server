/**
 * The Alerts page: fuel and overspeeding alerts from every organisation a
 * person holds, on one page, filtered by organisation, kind and decision, and
 * escalated or de-escalated there (operator, 2026-10-12: "list all
 * organizations alerts and we can filter so that it ease the pain of
 * navigating from one organization to the next").
 *
 * Reading spans organisations, so it is authorised here (alerts.scope), not by
 * the org-scoped middleware. Deciding stays org-scoped: each row carries its
 * organisation, and the page posts to that organisation's own route, where the
 * usual guards run (fuel: /fuel/thefts/:id/review; speeding: reviewSpeeding).
 */

import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../core/errors/errors.js'
import { prisma } from '../../lib/prisma.js'
import { resolveSubject } from '../../lib/authz/subject.js'
import { cachedPlace, reverseGeocode } from '../../lib/geocode.js'
import { logger } from '../../lib/logger.js'
import { publishNotification } from '../../lib/notifications/notification.store.js'
import { canAssignTriage, triageAssignerOrgs } from '../repairs/repairs.authz.js'
import { probeHoldVehicleIds } from '../fuel/probe-hold.js'
import { FUEL_INCIDENT_WINDOW_MS } from '../telemetry/telemetry.repository.js'
import * as repo from './alerts.repository.js'
import { cachedSummary, forgetAlertSummaries, keepSummary } from './alerts.summary-cache.js'
import { alertScopes } from './alerts.scope.js'
import {
  ALERT_KINDS, decodeCursor, fuelChoices, fuelStatus, mergePage, speedingChoices, speedingStatus,
  type AlertKindSlug, type FuelChoice, type Outcome,
} from './alerts.rules.js'
import type { ListAlertsQuery, MarkReadDto } from './alerts.schema.js'

const DAY_MS = 86_400_000
/** With no `from`, the page opens on the last week. */
const DEFAULT_DAYS = 7
/** Nairobi is UTC+3 all year. */
const FLEET_OFFSET_MS = 3 * 3_600_000

/** Midnight on the fleet's clock, `daysBack` days before today (the page's own period start). */
export function fleetMidnight(now: number, daysBack = 0): Date {
  const local = now + FLEET_OFFSET_MS
  return new Date(local - (local % DAY_MS) - FLEET_OFFSET_MS - daysBack * DAY_MS)
}
/** The widest window served, as on the incident reports. */
const MAX_SPAN_DAYS = 366
/** Place names warmed in the background per page; the rest show coordinates. */
const WARM_PLACES = 20

export interface Decision {
  outcome: Outcome
  reason: string | null
  note: string | null
  by: string | null
  at: string | null
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null)

/** A fuel choice as the outcome and reason the review route takes. */
const FUEL_CHOICE: Record<FuelChoice, { outcome: Outcome; reason: string | null }> = {
  theft: { outcome: 'ESCALATED', reason: 'theft' },
  probe_fault: { outcome: 'ESCALATED', reason: 'probe_fault' },
  not_theft: { outcome: 'DEESCALATED', reason: null },
}

/** A fuel alert's current decision, from the row (the log may predate it). */
function fuelDecision(r: repo.FuelAlertRow): Decision | null {
  const base = { note: r.reviewNote, by: r.reviewedBy, at: iso(r.reviewedAt) }
  if (r.reviewStatus === 'CONFIRMED_THEFT') return { outcome: 'ESCALATED', reason: 'theft', ...base }
  if (r.reviewStatus === 'PROBE_FAULT') return { outcome: 'ESCALATED', reason: 'probe_fault', ...base }
  if (r.reviewStatus === 'NOT_THEFT') return { outcome: 'DEESCALATED', reason: null, ...base }
  return null
}

function speedingDecision(r: repo.SpeedingAlertRow): Decision | null {
  if (r.reviewStatus !== 'ESCALATED' && r.reviewStatus !== 'DEESCALATED') return null
  return { outcome: r.reviewStatus, reason: null, note: r.reviewNote, by: r.reviewedBy, at: iso(r.reviewedAt) }
}

/** Which organisations this person reaches at all: every one for a platform role. */
async function reachableOrgIds(userId: string) {
  const subject = await resolveSubject(userId)
  const orgIds = subject.isPlatform
    ? (await prisma.organisation.findMany({ select: { id: true } })).map((o) => o.id)
    : [...subject.orgs.keys()]
  return { subject, orgIds }
}

function windowOf(q: ListAlertsQuery) {
  const to = q.to ?? new Date()
  const from = q.from ?? new Date(to.getTime() - DEFAULT_DAYS * DAY_MS)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new BadRequestError('from and to must be valid dates')
  if (to < from) throw new BadRequestError('to must not be before from')
  if ((to.getTime() - from.getTime()) / DAY_MS > MAX_SPAN_DAYS) {
    throw new BadRequestError(`range must be ${MAX_SPAN_DAYS} days or fewer`)
  }
  return { from, to }
}

export async function listAlerts(userId: string, q: ListAlertsQuery) {
  const [{ subject, orgIds }, reader] = await Promise.all([reachableOrgIds(userId), readerFor(userId)])
  const scopes = alertScopes(subject, orgIds)
  const { from, to } = windowOf(q)
  const cursor = decodeCursor(q.cursor)
  if (q.cursor && !cursor) throw new BadRequestError('invalid cursor')
  const range = { from: from.toISOString(), to: to.toISOString() }
  if (scopes.length === 0) {
    return { orgs: [], counts: cursor ? null : [], range, data: [], cursor: null, hasNextPage: false }
  }

  // The organisation filter can only narrow what this person may read.
  const picked = q.orgs.length ? scopes.filter((s) => q.orgs.includes(s.orgId)) : scopes
  const kinds: readonly AlertKindSlug[] = q.kind === 'all' ? ALERT_KINDS : [q.kind]
  const of = (kind: AlertKindSlug, list = picked) => list.filter((s) => s.kinds.includes(kind))
  const w: repo.AlertWindow = { scopes: picked, from, to, q: q.q || undefined, minOverKmh: q.minOverKmh, reader }
  // Counts for every organisation, not only the picked ones, so the filter can
  // say what each holds. Asked once, with the first page: they do not page.
  const withCounts = !cursor

  const [orgs, deciders, fuelCounts, speedCounts, fuel, speeding] = await Promise.all([
    prisma.organisation.findMany({
      where: { id: { in: scopes.map((s) => s.orgId) } },
      select: { id: true, code: true, name: true },
      orderBy: { name: 'asc' },
    }),
    triageAssignerOrgs(userId, scopes.map((s) => s.orgId)),
    withCounts && of('fuel', scopes).length ? repo.fuelCounts(w, of('fuel', scopes)) : Promise.resolve([]),
    withCounts && of('speeding', scopes).length ? repo.speedingCounts(w, of('speeding', scopes)) : Promise.resolve([]),
    kinds.includes('fuel') && of('fuel').length
      ? repo.fuelRows(w, of('fuel'), q.status, cursor, q.limit, q.read) : Promise.resolve([]),
    kinds.includes('speeding') && of('speeding').length
      ? repo.speedingRows(w, of('speeding'), q.status, cursor, q.limit, q.read) : Promise.resolve([]),
  ])

  const page = mergePage<{ at: Date; id: string; fuel?: repo.FuelAlertRow; speeding?: repo.SpeedingAlertRow }>([
    fuel.map((r) => ({ at: r.at, id: r.id, fuel: r })),
    speeding.map((r) => ({ at: r.at, id: r.id, speeding: r })),
  ], q.limit)

  const pageFuel = page.rows.flatMap((r) => (r.fuel ? [r.fuel] : []))
  const pageSpeeding = page.rows.flatMap((r) => (r.speeding ? [r.speeding] : []))
  const [log, onHold] = await Promise.all([
    repo.decisionsFor(pageFuel.map((r) => r.id), pageSpeeding.map((r) => r.id)),
    probeHoldVehicleIds([...new Set(pageFuel.map((r) => r.vehicleId))]),
  ])
  const history = new Map<string, Decision[]>()
  for (const d of log) {
    const key = `${d.kind}:${d.alertId}`
    const list = history.get(key) ?? []
    list.push({ outcome: d.outcome, reason: d.reason, note: d.note, by: d.actor?.fullName ?? null, at: iso(d.at) })
    history.set(key, list)
  }
  // A decision made before the log existed is on the row only.
  const historyOf = (key: string, current: Decision | null) => history.get(key) ?? (current ? [current] : [])

  const now = Date.now()
  let warmed = 0
  const data = page.rows.map((row) => {
    if (row.fuel) {
      const r = row.fuel
      const decision = fuelDecision(r)
      const probeHold = onHold.has(r.vehicleId)
      return {
        kind: 'fuel' as const,
        id: r.id, orgId: r.orgId, vehicleId: r.vehicleId, plate: r.plate, vehicleName: r.vehicleName,
        at: iso(r.at),
        read: r.read,
        status: fuelStatus(r.reviewStatus),
        decision,
        history: historyOf(`FUEL:${r.id}`, decision),
        choices: fuelChoices(r).map((c) => FUEL_CHOICE[c]),
        // Off the map without a decision: cleared with a newer alert on the
        // same unit, or deleted (before Delete was retired) into a case.
        cleared: r.reviewStatus === 'DISMISSED' || r.reviewStatus === 'UNDER_REVIEW'
          ? (r.followUpStatus ? 'case' : 'unit') : null,
        fuel: {
          litres: r.stolenMl / 1000,
          location: r.location,
          cause: r.cause,
          rule: r.rule,
          confidence: r.confidence,
          tankBeforeL: r.tankBeforeMl == null ? null : r.tankBeforeMl / 1000,
          tankAfterL: r.tankAfterMl == null ? null : r.tankAfterMl / 1000,
          detectedAt: iso(r.detectedAt),
          driverName: r.driverName,
          probeHold,
          // Still on the map: what the map's own query would return for it.
          live: r.reviewStatus == null && r.dismissedAt == null && !probeHold
            && now - new Date(r.at).getTime() < FUEL_INCIDENT_WINDOW_MS,
        },
      }
    }
    const r = row.speeding!
    const decision = speedingDecision(r)
    let place: string | null = null
    if (r.peakLat != null && r.peakLng != null) {
      place = cachedPlace(r.peakLat, r.peakLng)
      if (!place && warmed++ < WARM_PLACES) void reverseGeocode(r.peakLat, r.peakLng).catch(() => {})
    }
    return {
      kind: 'speeding' as const,
      id: r.id, orgId: r.orgId, vehicleId: r.vehicleId, plate: r.plate, vehicleName: r.vehicleName,
      at: iso(r.at),
      read: r.read,
      status: speedingStatus(r.reviewStatus),
      decision,
      history: historyOf(`SPEEDING:${r.id}`, decision),
      choices: speedingChoices(r.reviewStatus).map((outcome) => ({ outcome, reason: null })),
      cleared: null,
      speeding: {
        peakKmh: r.peakKmh,
        avgKmh: r.avgKmh,
        limitKmh: r.limitKmh,
        limitSource: r.limitSource,
        overByKmh: r.overByKmh,
        durationSec: r.durationSec,
        distanceM: r.distanceM,
        frames: r.frames,
        driverName: r.driverName,
        endedAt: iso(r.endedAt),
        lat: r.peakLat,
        lng: r.peakLng,
        place,
      },
    }
  })

  const kindsIn = new Map(scopes.map((s) => [s.orgId, s.kinds]))
  return {
    orgs: orgs.map((o) => ({
      id: o.id, code: o.code, name: o.name,
      kinds: kindsIn.get(o.id) ?? [],
      canDecide: deciders.has(o.id),
    })),
    counts: withCounts
      ? [
          ...fuelCounts.map((c) => ({ ...c, kind: 'fuel' as const })),
          ...speedCounts.map((c) => ({ ...c, kind: 'speeding' as const })),
        ]
      : null,
    range,
    data,
    cursor: page.cursor,
    hasNextPage: page.hasNextPage,
  }
}

export interface AlertSummary {
  /** Open alerts this person has not read, both kinds, every organisation
   *  they read. */
  open: number
  fuel: number
  speeding: number
  /** The start of the window counted: the page's default "7 days". */
  from: string
}

/**
 * The Alerts badge: how many alerts are open over the page's default window
 * (today and the six days before it, on the fleet's clock), so the number on
 * the badge is the number the page opens on. Held a minute per reach; a
 * decision clears it (alerts.summary-cache).
 */
export async function alertSummary(userId: string): Promise<AlertSummary> {
  const now = Date.now()
  const from = fleetMidnight(now, DEFAULT_DAYS - 1)
  // Per person: read marks are.
  const key = JSON.stringify(['summary', userId, from.getTime()])
  const hit = cachedSummary<AlertSummary>(key, now)
  if (hit) return hit

  const [{ subject, orgIds }, reader] = await Promise.all([reachableOrgIds(userId), readerFor(userId)])
  const scopes = alertScopes(subject, orgIds)
  const w: repo.AlertWindow = { scopes, from, to: new Date(now), reader }
  const fuelScopes = scopes.filter((s) => s.kinds.includes('fuel'))
  const speedScopes = scopes.filter((s) => s.kinds.includes('speeding'))
  const [fuel, speeding] = await Promise.all([
    fuelScopes.length ? repo.fuelCounts(w, fuelScopes) : Promise.resolve([]),
    speedScopes.length ? repo.speedingCounts(w, speedScopes) : Promise.resolve([]),
  ])
  const open = (rows: repo.CountRow[]) => rows.reduce((n, r) => n + (r.status === 'open' && !r.read ? r.n : 0), 0)
  const value: AlertSummary = {
    open: open(fuel) + open(speeding),
    fuel: open(fuel),
    speeding: open(speeding),
    from: from.toISOString(),
  }
  keepSummary(key, value, now)
  return value
}

async function readerFor(userId: string): Promise<repo.Reader> {
  const row = await repo.readerOf(userId)
  return { userId, readAt: row?.alertsReadAt ?? null }
}

/** Mark alerts read for this person: opened, or decided, on the page. */
export async function markRead(userId: string, items: MarkReadDto['items']) {
  const { count } = await repo.markRead(userId, items.map((i) => ({
    kind: i.kind === 'fuel' ? 'FUEL' as const : 'SPEEDING' as const, alertId: i.id,
  })))
  forgetAlertSummaries()
  return { marked: count }
}

/** "Mark all read": every alert that has arrived is read for this person. */
export async function markAllRead(userId: string) {
  const at = new Date()
  await repo.markAllRead(userId, at)
  forgetAlertSummaries()
  return { readAt: at.toISOString() }
}

export interface AlertHistory {
  /** Alerts a fleet day per organisation, every state, since the first one. */
  days: { orgId: string; kind: AlertKindSlug; day: string; n: number }[]
}

/**
 * Every alert ever received, a day at a time (the Alerts page's chart): both
 * kinds, every state, every organisation this person reads. Held a minute per
 * reach, as the badge is: it is read on every visit to the page.
 */
export async function alertHistory(userId: string): Promise<AlertHistory> {
  const { subject, orgIds } = await reachableOrgIds(userId)
  const scopes = alertScopes(subject, orgIds)
  const now = Date.now()
  const key = JSON.stringify(['history', scopes])
  const hit = cachedSummary<AlertHistory>(key, now)
  if (hit) return hit

  // From the start of time: the fuel side floors itself at its epoch.
  const w: repo.AlertWindow = { scopes, from: new Date(0), to: new Date(now) }
  const fuelScopes = scopes.filter((s) => s.kinds.includes('fuel'))
  const speedScopes = scopes.filter((s) => s.kinds.includes('speeding'))
  const [fuel, speeding] = await Promise.all([
    fuelScopes.length ? repo.fuelDays(w, fuelScopes) : Promise.resolve([]),
    speedScopes.length ? repo.speedingDays(w, speedScopes) : Promise.resolve([]),
  ])
  const value: AlertHistory = {
    days: [
      ...fuel.map((r) => ({ ...r, kind: 'fuel' as const })),
      ...speeding.map((r) => ({ ...r, kind: 'speeding' as const })),
    ],
  }
  keepSummary(key, value, now)
  return value
}

/**
 * Escalate (a real overspeed, to be taken up with the driver) or de-escalate
 * (not one) an overspeeding episode. The organisation's administrators and
 * the platform administrator, as for fuel alerts (one rule:
 * repairs.authz canAssignTriage). A decision may be changed later; every one
 * is kept in alert_decisions.
 */
export async function reviewSpeeding(orgId: string, id: string, userId: string, outcome: Outcome, note: string) {
  const check = await canAssignTriage(userId, orgId)
  if (!check.ok) {
    throw new ForbiddenError(check.reason === 'not_a_member'
      ? 'Only an administrator of this organisation can escalate or de-escalate an overspeeding alert'
      : 'Only a system administrator or the platform administrator can escalate or de-escalate an overspeeding alert')
  }
  const row = await prisma.speedingIncident.findFirst({
    where: { id, organisationId: orgId },
    select: {
      id: true, vehicleId: true, reviewStatus: true, peakKmh: true, limitKmh: true,
      vehicle: { select: { registrationPlate: true } },
    },
  })
  if (!row) throw new NotFoundError('Overspeeding alert')
  if (!speedingChoices(row.reviewStatus).includes(outcome)) {
    throw new ConflictError(`This alert is already ${outcome === 'ESCALATED' ? 'escalated' : 'de-escalated'}`)
  }

  const now = new Date()
  const stored = await prisma.$transaction(async (tx) => {
    // Only while it still stands as read: of two decisions landing at once,
    // the first wins and the second is told.
    const { count } = await tx.speedingIncident.updateMany({
      where: { id, reviewStatus: row.reviewStatus },
      data: { reviewStatus: outcome, reviewedAt: now, reviewedById: userId, reviewNote: note },
    })
    if (count === 0) return false
    await tx.alertDecision.create({
      data: { organisationId: orgId, kind: 'SPEEDING', alertId: id, outcome, note, actorId: userId, at: now },
    })
    return true
  })
  if (!stored) throw new ConflictError('Somebody else decided this alert a moment ago. Reload to see their decision.')
  forgetAlertSummaries()

  const me = await prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } })
  const by = me?.fullName ?? null
  // Escalations go to the organisation's feed, as a fuel escalation does.
  // De-escalations do not: clearing a run of GPS jumps would fill everyone's
  // feed with "not a violation".
  if (outcome === 'ESCALATED') {
    try {
      publishNotification({
        orgId,
        id: `speeding-${id}-escalated-${now.getTime()}`,
        source: 'speeding-review',
        alertType: 'SPEEDING_ESCALATED',
        severity: 'warning',
        text: `OVERSPEEDING ESCALATED: ${by ?? 'An administrator'} escalated ${row.vehicle.registrationPlate}, `
          + `${Math.round(row.peakKmh)} km/h where the limit is ${Math.round(row.limitKmh)} km/h.`,
        at: now,
        plate: row.vehicle.registrationPlate,
        vehicleId: row.vehicleId,
        extra: { incidentId: id },
      })
    } catch (err) {
      logger.warn({ err, incidentId: id }, 'Speeding review: feed publish failed')
    }
  }
  return { id, review: { status: outcome, at: now.toISOString(), by, note } }
}
