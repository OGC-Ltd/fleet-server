import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as svc from './planner.service.js'
import { workPlansForMap, usualPumpsFor, factoryFuelFor, factoryFuelRefillsFor, factoryFuelShiftsFor, factoryOperatorsFor, factorySupervisorsFor, planSubmissionsFor } from './work-plans.service.js'
import { tankDays as tankDaysFor } from './tank-days.js'
import { workPlanUpdatesFor } from './work-plan-watch.js'
import type { PreviewSheet, SaveSheet, PlanListQuery, StopUpdate, PlanList, CustomerFence, WorkPlansQuery, PlanSubmissionsQuery, FactoryFuelQuery, FactoryFuelRefillsQuery, FuellingPlanQuery } from './planner.schema.js'
import { buildFuellingPlan, fuellingLead, type FuellingPlan } from './fuelling-plan.js'
import { fuellingPlanFileName } from './fuelling-plan.pdf.js'
import { orgHeading } from '../reports/end-of-shift.data.js'
import { reportPool, sendReport } from '../../lib/offload/report-jobs.js'
import { NotFoundError } from '../../core/errors/errors.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

export const preview: RequestHandler = async (req, res, next) => {
  try {
    const b = req.body as PreviewSheet
    sendSuccess(res, await svc.previewSheet(p(req, 'orgId'), b.fileName, b.data))
  } catch (err) { next(err) }
}

export const save: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await svc.saveSheet(p(req, 'orgId'), req.user?.id ?? null, req.body as SaveSheet), 201)
  } catch (err) { next(err) }
}

export const list: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await svc.listPlans(p(req, 'orgId'), req.query as unknown as PlanListQuery))
  } catch (err) { next(err) }
}

export const getOne: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await svc.getPlan(p(req, 'orgId'), p(req, 'planId')))
  } catch (err) { next(err) }
}

export const updateStop: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await svc.updateStop(p(req, 'orgId'), p(req, 'planId'), p(req, 'stopId'), req.user?.id ?? null, req.body as StopUpdate))
  } catch (err) { next(err) }
}

export const setList: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await svc.setPlanList(p(req, 'orgId'), p(req, 'planId'), (req.body as PlanList).list))
  } catch (err) { next(err) }
}

export const remove: RequestHandler = async (req, res, next) => {
  try {
    await svc.removePlan(p(req, 'orgId'), p(req, 'planId'))
    sendSuccess(res, null, 204)
  } catch (err) { next(err) }
}

export const customers: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as { q?: string, fenced?: string }
    sendSuccess(res, await svc.listCustomers(p(req, 'orgId'), q.q, q.fenced === 'true'))
  } catch (err) { next(err) }
}

export const fenceCustomer: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await svc.fenceCustomer(p(req, 'orgId'), p(req, 'customerId'), req.body as CustomerFence), 201)
  } catch (err) { next(err) }
}

/** FactorySuite work plans for the Live Map (KASULU); `{ factory: null }` elsewhere. */
export const workPlans: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as WorkPlansQuery
    sendSuccess(res, await workPlansForMap(p(req, 'orgId'), q.day))
  } catch (err) { next(err) }
}

/** The Fuel page's tank days: probed machines' levels, fills and drains, from..to. */
export const tankDays: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as FactoryFuelQuery
    sendSuccess(res, await tankDaysFor(p(req, 'orgId'), q.from, q.to, req.authz?.vehicleIds ?? null))
  } catch (err) { next(err) }
}

/** The Fuel page's refills with the tracker's figures: one machine in full, or every machine's meters. */
export const factoryFuelRefills: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as FactoryFuelRefillsQuery
    sendSuccess(res, await factoryFuelRefillsFor(p(req, 'orgId'), q.from, q.to, q.machine ?? null, req.authz?.vehicleIds ?? null))
  } catch (err) { next(err) }
}

/** The Fuel page's Probe used: each machine's fuel over its planned shifts, by its probe, with the hours run. */
export const factoryFuelShifts: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as FactoryFuelQuery
    sendSuccess(res, await factoryFuelShiftsFor(p(req, 'orgId'), q.from, q.to, req.authz?.vehicleIds ?? null))
  } catch (err) { next(err) }
}

export const factoryFuel: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as FactoryFuelQuery
    sendSuccess(res, await factoryFuelFor(p(req, 'orgId'), q.from, q.to))
  } catch (err) { next(err) }
}

/** A day's or a range's plan vs actual, or `{ factory: null }` for an organisation with no FactorySuite factory. */
async function fuellingPlanOf(orgId: string, from: string, to: string): Promise<FuellingPlan | { factory: null; day: string; from: string; to: string }> {
  const fuel = await factoryFuelFor(orgId, from, to)
  if (fuel.factory == null) return { factory: null, day: from, from, to }
  // A vehicle request names no site: the pump it was last fuelled at stands in
  const requested = [...new Set(fuel.vehicleRequests.map(v => v.machine))]
  return buildFuellingPlan(fuel, { from, to }, Date.now(), await usualPumpsFor(fuel.factory, requested, to))
}

/** GET …/planner/fuelling-plan?day, or ?from&to — Reports › Fuel › Fuelling Plan (KASULU). */
export const fuellingPlan: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as FuellingPlanQuery
    const plan = await fuellingPlanOf(p(req, 'orgId'), q.from, q.to)
    // The opening sentence, as the PDF has it
    sendSuccess(res, plan.factory == null ? plan : { ...plan, lead: fuellingLead(plan) })
  } catch (err) { next(err) }
}

/** GET …/planner/fuelling-plan.pdf?day, or ?from&to — the same report as the PDF, drawn on a worker thread. */
export const fuellingPlanPdf: RequestHandler = (req, res, next) => sendReport(req, res, next, async (run) => {
  const q = req.query as unknown as FuellingPlanQuery
  const orgId = p(req, 'orgId')
  const [plan, org] = await Promise.all([fuellingPlanOf(orgId, q.from, q.to), orgHeading(orgId)])
  if (plan.factory == null) throw new NotFoundError('This organisation has no FactorySuite fuel plans')
  const factoryName = plan.factory.toLowerCase().replace(/(^|\s)([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase())
  const out = await reportPool().run('pdf.fuellingPlan', { plan, factoryName, orgName: org.name, now: Date.now() }, run)
  return { bytes: Buffer.from(out.buffer, out.byteOffset, out.byteLength), name: fuellingPlanFileName(plan, factoryName), type: 'application/pdf' }
})

/** The Drivers page's Operators tab (KASULU); `{ factory: null }` elsewhere. */
export const factoryOperators: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as FactoryFuelQuery
    sendSuccess(res, await factoryOperatorsFor(p(req, 'orgId'), q.from, q.to))
  } catch (err) { next(err) }
}

export const factorySupervisors: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as FactoryFuelQuery
    sendSuccess(res, await factorySupervisorsFor(p(req, 'orgId'), q.from, q.to))
  } catch (err) { next(err) }
}

/** The Fuel page's Plan updates: work plan items that changed on these days. */
export const workPlanUpdates: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as FactoryFuelQuery
    sendSuccess(res, await workPlanUpdatesFor(p(req, 'orgId'), q.from, q.to))
  } catch (err) { next(err) }
}

/** The Maintenance page's Plan submissions board (plan-submissions.ts). */
export const planSubmissions: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as PlanSubmissionsQuery
    sendSuccess(res, await planSubmissionsFor(p(req, 'orgId'), q.day))
  } catch (err) { next(err) }
}
