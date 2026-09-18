import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { ConflictError, NotFoundError } from '../../core/errors/errors.js'
import * as repo from './repairs.repository.js'
import * as svc from './repairs.service.js'
import type {
  CreateRepairReport, ResolveItem, SetStage, ListReportsQuery, ListItemsQuery,
} from './repairs.schema.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

export const listReports: RequestHandler = async (req, res, next) => {
  try {
    const result = await repo.findReports(p(req, 'orgId'), req.query as unknown as ListReportsQuery)
    sendSuccess(res, result.data, 200, { cursor: result.cursor, hasNextPage: result.hasNextPage })
  } catch (err) { next(err) }
}

export const listItems: RequestHandler = async (req, res, next) => {
  try {
    const result = await repo.findItems(p(req, 'orgId'), req.query as unknown as ListItemsQuery)
    sendSuccess(res, result.data, 200, { cursor: result.cursor, hasNextPage: result.hasNextPage })
  } catch (err) { next(err) }
}

export const getReport: RequestHandler = async (req, res, next) => {
  try {
    const report = await repo.findReportById(p(req, 'reportId'), p(req, 'orgId'))
    if (!report) throw new NotFoundError('Repair report not found')
    sendSuccess(res, report)
  } catch (err) { next(err) }
}

/**
 * 201 even when the mail did not go, with the outcome in the body.
 *
 * This follows the mailer's own doctrine: the work is done and durably
 * recorded, so a 5xx would be false, and it would invite a retry of a thing
 * that has already happened. The honesty requirement is met by `email.status`
 * reaching the screen — the dashboard prints "filed, but no email was sent"
 * rather than a tick — not by the status code.
 */
export const createReport: RequestHandler = async (req, res, next) => {
  try {
    const { report, email } = await svc.submitRepairReport(
      p(req, 'orgId'), req.user!.id, req.body as CreateRepairReport,
    )
    sendSuccess(res, { ...report, email }, 201)
  } catch (err) {
    // The partial unique index catching a second open job on the same target.
    // Translated here rather than left as a P2002, which tells the technician
    // nothing about which unit is already reported.
    if ((err as { code?: string }).code === 'P2002') {
      next(new ConflictError('A repair is already open for one of these units'))
      return
    }
    next(err)
  }
}

export const resolveItem: RequestHandler = async (req, res, next) => {
  try {
    const orgId  = p(req, 'orgId')
    const itemId = p(req, 'itemId')
    const item = await svc.closeItem(itemId, orgId, req.user!.id, req.body as ResolveItem)
    if (item) { sendSuccess(res, item); return }

    // Nothing was updated. Two different reasons, two different answers — a
    // 404 for a job that was never here, a 409 for one somebody else closed
    // first, whose notes must not be silently replaced by these.
    const exists = await repo.itemExists(itemId, orgId)
    throw exists
      ? new ConflictError('This job has already been closed')
      : new NotFoundError('Repair job not found')
  } catch (err) { next(err) }
}

/**
 * Move an open job along the ladder.
 *
 * Three answers, and the difference between them is what a technician needs:
 * 404 for a job that was never here, 409 for one somebody signed off while
 * this button was on screen, and 200 for the move. A no-op move — clicking the
 * stage the job is already at — is also a 200 carrying the unchanged item,
 * because nothing is wrong and a 409 would send the screen into an error state
 * over a double click.
 */
export const setStage: RequestHandler = async (req, res, next) => {
  try {
    const orgId  = p(req, 'orgId')
    const itemId = p(req, 'itemId')
    const { item, reason } = await svc.changeStage(itemId, orgId, req.user!.id, req.body as SetStage)
    if (item) { sendSuccess(res, item); return }

    if (reason === 'nochange') {
      const unchanged = await repo.findItemById(itemId, orgId)
      if (unchanged) { sendSuccess(res, unchanged); return }
    }

    const exists = await repo.itemExists(itemId, orgId)
    throw exists
      ? new ConflictError('This job has been signed off — its stage can no longer change')
      : new NotFoundError('Repair job not found')
  } catch (err) { next(err) }
}
