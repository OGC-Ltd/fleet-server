/**
 * Watches FactorySuite's work plans for changes and records each one
 * (operator, 2026-11-19: "we need to ensure that we monitor any changes
 * happening on the workplan from factory suite since we have access to
 * webhooks events and the api itself").
 *
 * Why compare reads rather than trust events: FactorySuite sends no event when
 * a plan is created, edited or cancelled, only fuelplan.decided /
 * .change.requested / .change.decided / .released, and on 19 Nov not one of
 * those had reached us in 72 h while 35 plans were decided. So every pass
 * reads the plans for WINDOW_BACK days back to WINDOW_AHEAD days ahead, compares
 * each with the last read kept in factorysuite_work_plans (planner/
 * work-plan-diff.ts) and writes what differs to factorysuite_work_plan_changes.
 *
 * Two callers, one pass at a time (a request while one runs gets one more pass
 * after it, never a queue):
 *   • the RaiFactorySuite reconcile cycle, every RAIFACTORYSUITE_POLL_MS (5 min);
 *   • the webhook: fuelplan.*, fuel.request.* and fuel.issue.* ask for a pass
 *     in a moment, so a change the hook does announce is caught at once.
 *
 * The first pass for a factory only takes the snapshot: plans already there
 * are not news. A pass that finds a change clears the cached plans and tells
 * the org's open pages (workPlansChanged), which is what the missing hook
 * should have done.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { RaiFactorySuiteClient, type RaiFactorySuiteWorkPlanRow } from '../../providers/raifactorysuite/raifactorysuite.client.js'
import { MACHINE_FACTORY_TO_ORG } from '../../providers/raifactorysuite/raifactorysuite.machine-sync.js'
import { diffWorkPlan, type WorkPlanChange } from './work-plan-diff.js'
import { workPlansChanged } from './work-plans.service.js'

/** Days back from today (EAT) that are re-read: late cancellations and edits. */
export const WINDOW_BACK = 7
/** Days ahead: plans are keyed the day before, sometimes further out. */
export const WINDOW_AHEAD = 3

export type WatchSource = 'poll' | 'hook'
export interface WatchReport {
  factories: number
  plans: number
  changes: number
  seeded: number
}

let clientInstance: RaiFactorySuiteClient | null = null
const client = () => (clientInstance ??= new RaiFactorySuiteClient())

const DAY = 86_400_000
const eatDay = (now: number, offset: number) => new Date(now + 3 * 3_600_000 + offset * DAY).toISOString().slice(0, 10)

/** The days a pass reads, both ends inclusive (FactorySuite's `to` is inclusive). */
export function watchWindow(now = Date.now()): { from: string; to: string } {
  return { from: eatDay(now, -WINDOW_BACK), to: eatDay(now, WINDOW_AHEAD) }
}

/**
 * What a pass does with one factory's read, given the kept snapshots. Pure, so
 * it can be tested without a database: returns the changes to record, the
 * plans to keep (as read) and the snapshot ids now gone.
 */
export function planPass(
  read: RaiFactorySuiteWorkPlanRow[],
  kept: Array<{ id: string; day: string; goneAt: Date | null; raw: RaiFactorySuiteWorkPlanRow }>,
  window: { from: string; to: string },
  seeded: boolean,
): { changes: WorkPlanChange[]; gone: string[] } {
  const keptById = new Map(kept.map(k => [k.id, k]))
  const seen = new Set<string>()
  const changes: WorkPlanChange[] = []

  for (const plan of read) {
    seen.add(plan.id)
    if (!seeded) continue
    const prev = keptById.get(plan.id)
    if (prev?.goneAt) {
      changes.push({ ...diffWorkPlan(null, plan)[0]!, kind: 'plan_restored' })
      changes.push(...diffWorkPlan(prev.raw, plan).filter(c => c.kind !== 'plan_added'))
    } else {
      changes.push(...diffWorkPlan(prev?.raw ?? null, plan))
    }
  }

  // A plan we kept for a day inside the window that FactorySuite no longer
  // returns was deleted (or moved out of the window: a later read restores it).
  // An empty read is never taken as "every plan deleted": that is an outage.
  const gone: string[] = []
  if (read.length > 0) {
    for (const k of kept) {
      if (seen.has(k.id) || k.goneAt || k.day < window.from || k.day > window.to) continue
      gone.push(k.id)
      if (seeded) changes.push(...diffWorkPlan(k.raw, null))
    }
  }
  return { changes, gone }
}

/**
 * Which read plans need their snapshot rewritten and which only need touching.
 * Rewritten: not kept yet, kept but marked gone, or with a change this pass (or
 * a kept column that drifted). Pure, for the tests.
 */
export function splitWrites(
  read: RaiFactorySuiteWorkPlanRow[],
  kept: Array<{ id: string; goneAt: Date | null; raw: RaiFactorySuiteWorkPlanRow }>,
  changes: WorkPlanChange[],
): { write: RaiFactorySuiteWorkPlanRow[]; touch: string[] } {
  const keptById = new Map(kept.map(k => [k.id, k]))
  const changed = new Set(changes.map(c => c.planId))
  const write: RaiFactorySuiteWorkPlanRow[] = []
  const touch: string[] = []
  for (const p of read) {
    const k = keptById.get(p.id)
    const drifted = !k || k.raw.status !== p.status || k.raw.startDate !== p.startDate
      || (k.raw.department ?? null) !== (p.department ?? null) || k.raw.planCode !== p.planCode
    if (drifted || k.goneAt || changed.has(p.id)) write.push(p)
    else touch.push(p.id)
  }
  return { write, touch }
}

async function watchFactory(factory: string, orgCode: string, window: { from: string; to: string }, source: WatchSource, event: string | null) {
  const org = await prisma.organisation.findFirst({ where: { code: orgCode }, select: { id: true } })
  if (!org) return null

  const read = await client().listWorkPlans(window.from, window.to, factory)
  const keptRows = await prisma.factorySuiteWorkPlan.findMany({
    where: { factoryCode: factory },
    select: { id: true, day: true, goneAt: true, raw: true },
  })
  const seeded = keptRows.length > 0
  const kept = keptRows.map(k => ({ ...k, raw: k.raw as unknown as RaiFactorySuiteWorkPlanRow }))
  const { changes, gone } = planPass(read, kept, window, seeded)

  // Only plans that are new, back, or differ are rewritten (raw and all); the
  // rest only get lastSeenAt, in one statement, so a quiet pass every 5 minutes
  // does not rewrite every plan's JSON.
  const { write, touch } = splitWrites(read, kept, changes)

  const now = new Date()
  await prisma.$transaction([
    ...(touch.length ? [prisma.factorySuiteWorkPlan.updateMany({ where: { id: { in: touch } }, data: { lastSeenAt: now } })] : []),
    ...write.map(p => prisma.factorySuiteWorkPlan.upsert({
      where: { id: p.id },
      create: {
        id: p.id, organisationId: org.id, factoryCode: factory, planCode: p.planCode,
        department: p.department ?? null, day: p.startDate, status: p.status, raw: p as object,
        firstSeenAt: now, lastSeenAt: now,
      },
      update: {
        planCode: p.planCode, department: p.department ?? null, day: p.startDate, status: p.status,
        raw: p as object, lastSeenAt: now, goneAt: null,
      },
    })),
    ...(gone.length ? [prisma.factorySuiteWorkPlan.updateMany({ where: { id: { in: gone } }, data: { goneAt: now } })] : []),
    ...(changes.length ? [prisma.factorySuiteWorkPlanChange.createMany({
      data: changes.map(c => ({ ...c, organisationId: org.id, factoryCode: factory, source, event, detectedAt: now })),
    })] : []),
  ])

  if (changes.length) {
    logger.info(
      { factory, source, event, changes: changes.length, plans: [...new Set(changes.map(c => c.planCode))].slice(0, 20) },
      'FactorySuite work plans changed',
    )
    await workPlansChanged(`watch.${source}`, { factoryCode: factory })
  }
  return { plans: read.length, changes: changes.length, seeded: seeded ? 0 : read.length }
}

let running: Promise<WatchReport | null> | null = null
let again: { source: WatchSource; event: string | null } | null = null

/** One pass now over every factory that keeps work plans. Throws if a read fails. */
export async function runWorkPlanWatch(opts: { source: WatchSource; event?: string | null }): Promise<WatchReport | null> {
  if (!client().isConfigured) return null
  if (running) { again = { source: opts.source, event: opts.event ?? null }; return running }
  running = (async () => {
    try {
      const window = watchWindow()
      const report: WatchReport = { factories: 0, plans: 0, changes: 0, seeded: 0 }
      for (const [factory, orgCode] of Object.entries(MACHINE_FACTORY_TO_ORG)) {
        const r = await watchFactory(factory, orgCode, window, opts.source, opts.event ?? null)
        if (!r) continue
        report.factories++
        report.plans += r.plans
        report.changes += r.changes
        report.seeded += r.seeded
      }
      if (report.seeded) logger.info({ ...report, window }, 'FactorySuite work plan watch: first snapshot taken')
      return report
    } finally {
      running = null
      if (again) {
        const next = again
        again = null
        void runWorkPlanWatch(next).catch(err => logger.warn({ err }, 'FactorySuite work plan watch: follow-up pass failed'))
      }
    }
  })()
  return running
}

let timer: NodeJS.Timeout | null = null
let timerEvent: string | null = null

/** A webhook event that may mean a plan changed: a pass in a moment (events come in bursts). */
export function requestWorkPlanWatch(event: string) {
  timerEvent = event
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    const e = timerEvent
    timerEvent = null
    void runWorkPlanWatch({ source: 'hook', event: e }).catch(err => logger.warn({ err, event: e }, 'FactorySuite work plan watch: webhook pass failed'))
  }, 3_000)
  timer.unref?.()
}

/** Webhook event names that can follow a work plan change. */
export function isWorkPlanEvent(kind: string) {
  return kind.startsWith('fuelplan.') || kind.startsWith('fuel.request.') || kind.startsWith('fuel.issue.')
}

/** The recorded changes for an org's plans on days `from`..`to`, newest first. */
export async function workPlanChangesFor(orgId: string, from: string, to: string) {
  const [changes, watched] = await Promise.all([
    prisma.factorySuiteWorkPlanChange.findMany({
      where: { organisationId: orgId, day: { gte: from, lte: to } },
      orderBy: [{ detectedAt: 'desc' }, { planCode: 'asc' }],
      take: 2000,
      select: {
        id: true, planId: true, planCode: true, department: true, day: true, kind: true, lineId: true, taskId: true,
        machine: true, shiftNo: true, field: true, fromValue: true, toValue: true, source: true, event: true, detectedAt: true,
      },
    }),
    prisma.factorySuiteWorkPlan.aggregate({ where: { organisationId: orgId }, _min: { firstSeenAt: true }, _count: { _all: true } }),
  ])
  return {
    watching: watched._count._all > 0,
    /** Changes before this were not seen: the watch started then. */
    watchedSince: watched._min.firstSeenAt,
    from, to,
    changes,
  }
}
