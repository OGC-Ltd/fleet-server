import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as service from './fuel.service.js'
import * as followUps from './fuel-followup.service.js'
import { UnauthorizedError, GoneError } from '../../core/errors/errors.js'
import { getProbeReport } from './probe-report.service.js'
import { getFleetTankState } from './fuel-tank-state.service.js'
import { fleetDayStart } from '../../lib/provider-time.js'
import * as signals from './fuel-signal-alerts.service.js'
import { getPerformanceReview, getUnitPerformance, reviewPeriod } from './fuel-performance-review.service.js'
import { NotFoundError } from '../../core/errors/errors.js'
import type { CreateFillingDto, ListFillingQuery, CreateTheftDto, ListTheftQuery, ListFollowUpQuery, FollowUpNoteDto, AssignFollowUpDto, RecallFollowUpDto, TheftOutcomesQuery, ReviewTheftDto, SignalAlertQuery, EvaluateSignalsDto, EscalateFollowUpDto } from './fuel.schema.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

export const listFillings: RequestHandler = async (req, res, next) => {
  try {
    const { data, cursor, hasNextPage } = await service.listFillings(p(req, 'orgId'), req.query as unknown as ListFillingQuery)
    sendSuccess(res, data, 200, { cursor, hasNextPage })
  } catch (err) { next(err) }
}

export const getFilling: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.getFilling(p(req, 'orgId'), p(req, 'fillingId')))
  } catch (err) { next(err) }
}

export const createFilling: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.createFilling(req.body as CreateFillingDto), 201)
  } catch (err) { next(err) }
}

export const listThefts: RequestHandler = async (req, res, next) => {
  try {
    const { data, cursor, hasNextPage } = await service.listThefts(p(req, 'orgId'), req.query as unknown as ListTheftQuery)
    sendSuccess(res, data, 200, { cursor, hasNextPage })
  } catch (err) { next(err) }
}

/** Whether the caller may escalate or de-escalate an alert here. */
export const theftReviewRights: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, { canReview: await service.canReviewTheft(p(req, 'orgId'), req.user?.id ?? null) })
  } catch (err) { next(err) }
}

export const reviewTheft: RequestHandler = async (req, res, next) => {
  try {
    const { outcome, note, reason } = req.body as ReviewTheftDto
    sendSuccess(res, await service.reviewTheft(p(req, 'orgId'), p(req, 'theftId'), actor(req), outcome, note, reason))
  } catch (err) { next(err) }
}

/**
 * ARCHIVED (operator, 2026-10-01): "Delete" on a fuel alert is retired. An
 * alert now leaves the dashboard only by being escalated or de-escalated
 * (reviewTheft), so every one that goes carries a decision, a reason and a
 * name. The route still answers, with 410 Gone and what to do instead, so an
 * old dashboard still showing the button says why rather than failing blind.
 * Nothing is written. service.dismissTheft and repo.dismissTheft are kept,
 * unreached, should the operator ever want deletion back.
 */
export const dismissTheft: RequestHandler = (_req, _res, next) => {
  next(new GoneError('Deleting a fuel alert has been retired. Escalate or de-escalate it instead, so the decision is on record.'))
}

// ── Follow-ups on dismissed incidents ──────────────────────────────────────

/** Acting on a follow-up is recorded against an account, so there must be one. */
const actor = (req: Parameters<RequestHandler>[0]): string => {
  const id = req.user?.id
  if (!id) throw new UnauthorizedError('An account is required to act on a follow-up')
  return id
}

export const theftOutcomes: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.theftOutcomes(p(req, 'orgId'), req.query as unknown as TheftOutcomesQuery))
  } catch (err) { next(err) }
}

export const listFollowUps: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await followUps.listFollowUps(p(req, 'orgId'), req.query as unknown as ListFollowUpQuery, req.user?.id ?? null))
  } catch (err) { next(err) }
}

export const getFollowUp: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await followUps.getFollowUp(p(req, 'orgId'), p(req, 'followUpId'), req.user?.id ?? null))
  } catch (err) { next(err) }
}

export const acceptFollowUp: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await followUps.acceptFollowUp(p(req, 'orgId'), p(req, 'followUpId'), actor(req)))
  } catch (err) { next(err) }
}

export const declineFollowUp: RequestHandler = async (req, res, next) => {
  try {
    const { note } = req.body as FollowUpNoteDto
    sendSuccess(res, await followUps.declineFollowUp(p(req, 'orgId'), p(req, 'followUpId'), actor(req), note))
  } catch (err) { next(err) }
}

export const listFollowUpAssignees: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await followUps.listAssignees(p(req, 'orgId'), p(req, 'followUpId'), actor(req)))
  } catch (err) { next(err) }
}

export const assignFollowUp: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await followUps.assignFollowUp(p(req, 'orgId'), p(req, 'followUpId'), actor(req), req.body as AssignFollowUpDto))
  } catch (err) { next(err) }
}

export const recallFollowUp: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await followUps.recallFollowUp(p(req, 'orgId'), p(req, 'followUpId'), actor(req), req.body as RecallFollowUpDto))
  } catch (err) { next(err) }
}

export const noteFollowUp: RequestHandler = async (req, res, next) => {
  try {
    const { note } = req.body as FollowUpNoteDto
    sendSuccess(res, await followUps.addNote(p(req, 'orgId'), p(req, 'followUpId'), actor(req), note))
  } catch (err) { next(err) }
}

export const escalateFollowUp: RequestHandler = async (req, res, next) => {
  try {
    const { note, reason } = req.body as EscalateFollowUpDto
    sendSuccess(res, reason === 'probe_fault'
      ? await followUps.markProbeFault(p(req, 'orgId'), p(req, 'followUpId'), actor(req), note)
      : await followUps.resolveFollowUp(p(req, 'orgId'), p(req, 'followUpId'), actor(req), 'ESCALATED', note))
  } catch (err) { next(err) }
}

export const deescalateFollowUp: RequestHandler = async (req, res, next) => {
  try {
    const { note } = req.body as FollowUpNoteDto
    sendSuccess(res, await followUps.resolveFollowUp(p(req, 'orgId'), p(req, 'followUpId'), actor(req), 'DEESCALATED', note))
  } catch (err) { next(err) }
}

export const probeFaultFollowUp: RequestHandler = async (req, res, next) => {
  try {
    const { note } = req.body as FollowUpNoteDto
    sendSuccess(res, await followUps.markProbeFault(p(req, 'orgId'), p(req, 'followUpId'), actor(req), note))
  } catch (err) { next(err) }
}

export const reraiseFollowUpRepair: RequestHandler = async (req, res, next) => {
  try {
    const { note } = req.body as FollowUpNoteDto
    sendSuccess(res, await followUps.reraiseRepair(p(req, 'orgId'), p(req, 'followUpId'), actor(req), note))
  } catch (err) { next(err) }
}

export const listFuelAudit: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await followUps.listAudit(p(req, 'orgId'), req.user?.id ?? null))
  } catch (err) { next(err) }
}

export const getTheft: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.getTheft(p(req, 'orgId'), p(req, 'theftId')))
  } catch (err) { next(err) }
}

export const createTheft: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.createTheft(req.body as CreateTheftDto), 201)
  } catch (err) { next(err) }
}

/**
 * Per-vehicle tank state for the Fuel FSL table: what the tank held when the
 * machine started work, what it holds now, and how much the probe moved about
 * while working. See modules/fuel/fuel-tank-state.
 *
 * Whole-fleet in one call on purpose — the table draws every vehicle, and a
 * per-vehicle endpoint would have the dashboard fire 200 requests against a
 * 100 req/60s limit.
 */
/**
 * Every probe and sensor on the fleet, with its state, its history and what it
 * is fitted to — see probe-report.service.
 *
 * Whole-fleet and unpaginated, like `tank-state`: the grid draws every unit at
 * once and an operator triaging faults is reading the WHOLE list, not a page of
 * it. Served from a ten-minute cache because the build scans a month of
 * telemetry; probe faults do not move faster than that.
 *
 * `?state=` narrows to what wants attention, which is the view the report is
 * generated from. Anything else returns the fleet.
 */
export const listProbeHealth: RequestHandler = async (req, res, next) => {
  try {
    const rows = await getProbeReport(p(req, 'orgId'))
    const state = String(req.query['state'] ?? '').toLowerCase()
    const filtered = state === 'faulty'  ? rows.filter(r => r.needsAttention)
                   : state === 'healthy' ? rows.filter(r => !r.needsAttention)
                   : rows
    sendSuccess(res, {
      rows: filtered,
      // Counted over the WHOLE fleet, not the filtered set: the tallies are
      // what the operator filters BY, so they must not move when they do.
      summary: {
        total:        rows.length,
        needsAttention: rows.filter(r => r.needsAttention).length,
        probeDied:    rows.filter(r => r.fuelProbe.state === 'DIED').length,
        probeSilent:  rows.filter(r => r.fuelProbe.state === 'SILENT').length,
        probeOk:      rows.filter(r => r.fuelProbe.state === 'OK').length,
        sensorUncalibrated: rows.filter(r => r.fuelSensor.uncalibrated).length,
        // Provisioned and saying nothing. Counted separately because it is not
        // a probe fault — no channel on the unit can be judged at all.
        trackerSilent:      rows.filter(r => r.trackerSilent).length,
      },
      generatedAt: new Date().toISOString(),
    })
  } catch (err) { next(err) }
}

export const listTankState: RequestHandler = async (req, res, next) => {
  try {
    // `?date=YYYY-MM-DD` reads the tank as it stood at the END of that fleet
    // day, so the FSL table's Initial/Current pair matches the events it is
    // shown beside. Omitted, or today, means now — a day still in progress has
    // no end, and pinning it to midnight would freeze the live column.
    const asOf = asOfFromQuery(req.query['date'])
    sendSuccess(res, await getFleetTankState(p(req, 'orgId'), asOf))
  } catch (err) { next(err) }
}

/**
 * End of the requested fleet day, or now — whichever is earlier.
 *
 * Fleet days are Kenyan, not UTC (see lib/provider-time): a 01:00 EAT reading
 * belongs to that day and not the previous one. An unparseable or future date
 * falls back to now rather than erroring, because this drives a table and a bad
 * query string should not blank it.
 *
 * ## The last instant of the day, NOT the first of the next
 *
 * This is a one-millisecond distinction that silently emptied every past day,
 * and it is worth stating why rather than leaving the `- 1` looking like a
 * rounding nicety.
 *
 * `getFleetTankState` derives its own day from the `asOf` it is handed —
 * `fleetDayStart(asOf)` — so `asOf` must land INSIDE the day being asked for.
 * Midnight-at-the-end belongs to the following day: `fleetDayStart` of it
 * returns that same instant, the service's window becomes
 * `[asOf, asOf]`, and every figure derived from the day's readings — closing
 * level, mileage, engine hours, both expected burns, turbulence, stops — comes
 * back null for want of any rows in a zero-width window.
 *
 * It fails in a way designed to be missed: the previous-day lookup, which
 * reaches back 24 hours from that same boundary, then spans exactly the day
 * that was requested, so the table renders the requested day's real closing
 * level in the INITIAL column while Current sits blank. It reads as a data gap
 * rather than an off-by-one.
 *
 * `recordFuelTrends` has always bounded its own day this way, which is why the
 * persisted `fuel_daily_trends` rows are right where the live table was wrong.
 */
export function asOfFromQuery(raw: unknown): Date {
  const now = new Date()
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return now
  const dayStart = fleetDayStart(new Date(`${raw}T12:00:00Z`))
  if (Number.isNaN(dayStart.getTime())) return now
  const dayEnd = new Date(dayStart.getTime() + 86_400_000 - 1)
  return dayEnd < now ? dayEnd : now
}

// ── Signal alerts — see fuel-signal-alerts ─────────────────────────────────

export const scanVehicleSignals: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await signals.scanVehicle(p(req, 'orgId'), p(req, 'vehicleId'), req.query as unknown as SignalAlertQuery))
  } catch (err) { next(err) }
}

export const evaluateSignals: RequestHandler = async (req, res, next) => {
  try {
    const vehicleId = (req.params['vehicleId'] as string | undefined) ?? null
    sendSuccess(res, await signals.evaluateSamples(p(req, 'orgId'), vehicleId, req.body as EvaluateSignalsDto))
  } catch (err) { next(err) }
}

/** Every unit's refills against its standard — Fuel › Report's performance review. */
export const performanceReview: RequestHandler = async (req, res, next) => {
  try {
    const { from, to } = reviewPeriod(req.query['from'], req.query['to'])
    sendSuccess(res, await getPerformanceReview(p(req, 'orgId'), from, to))
  } catch (err) { next(err) }
}

/** One unit's refills, row by row, for the review's drill-down. */
export const unitPerformance: RequestHandler = async (req, res, next) => {
  try {
    const { from, to } = reviewPeriod(req.query['from'], req.query['to'])
    const unit = await getUnitPerformance(p(req, 'orgId'), p(req, 'vehicleId'), from, to)
    if (!unit) throw new NotFoundError('Vehicle')
    sendSuccess(res, { from, to, unit })
  } catch (err) { next(err) }
}
