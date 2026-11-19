/**
 * Keeps FactorySuite's work plan lines current here, one row per plan line,
 * updated in place (operator, 2026-11-19: "if an item was drafted and awaiting
 * approval we should update it based on the new changes either accepted or
 * rejected no point of having duplicates records"; "let it be dynamic but
 * ensure that we don't get a duplicated on the plan line"). A machine can be
 * on any number of plans; each of its lines is its own row.
 *
 * Why poll rather than trust events: FactorySuite sends no event when a plan
 * is created, edited or cancelled, only fuelplan.decided / .change.requested /
 * .change.decided / .released, and on 19 Nov not one of those had reached us
 * in 72 h while 35 plans were decided. So every pass reads the plans for
 * WINDOW_BACK days back to WINDOW_AHEAD days ahead, turns them into items
 * (planner/work-plan-items.ts, keyed by FactorySuite's line id) and brings
 * factorysuite_work_plan_items to match:
 *   • a new plan line is inserted;
 *   • one whose plan status or fields changed is updated in place, keeping the
 *     status it had before and when it changed, and the last fields edited;
 *   • one FactorySuite no longer has (inside the window) is deleted;
 *   • the rest only get last_seen_at.
 *
 * Two callers, one pass at a time (a request while one runs gets one more pass
 * after it, never a queue):
 *   • the RaiFactorySuite reconcile cycle, every RAIFACTORYSUITE_POLL_MS (5 min);
 *   • the webhook: fuelplan.*, fuel.request.* and fuel.issue.* ask for a pass
 *     in a moment, so a change the hook does announce is caught at once.
 *
 * A pass that changes anything clears the cached plans and tells the org's
 * open pages (workPlansChanged), which is what the missing hook should do.
 */

import type { Prisma } from '../../../generated/prisma/client.js'
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { RaiFactorySuiteClient } from '../../providers/raifactorysuite/raifactorysuite.client.js'
import { MACHINE_FACTORY_TO_ORG } from '../../providers/raifactorysuite/raifactorysuite.machine-sync.js'
import { itemEdits, itemsFromPlans, type ItemEdit, type WorkPlanItem } from './work-plan-items.js'
import { workPlansChanged } from './work-plans.service.js'

/** Days back from today (EAT) that are re-read: late decisions and edits. */
export const WINDOW_BACK = 7
/** Days ahead: plans are keyed the day before, sometimes further out. */
export const WINDOW_AHEAD = 3

export type WatchSource = 'poll' | 'hook'
export interface WatchReport {
  factories: number
  items: number
  added: number
  updated: number
  removed: number
}

let clientInstance: RaiFactorySuiteClient | null = null
const client = () => (clientInstance ??= new RaiFactorySuiteClient())

const DAY = 86_400_000
const eatDay = (now: number, offset: number) => new Date(now + 3 * 3_600_000 + offset * DAY).toISOString().slice(0, 10)

/** The days a pass reads, both ends inclusive (FactorySuite's `to` is inclusive). */
export function watchWindow(now = Date.now()): { from: string; to: string } {
  return { from: eatDay(now, -WINDOW_BACK), to: eatDay(now, WINDOW_AHEAD) }
}

/** An item as kept: what the comparison needs. */
export interface KeptItem {
  id: string
  day: string
  status: string
  line: WorkPlanItem['line']
}

/** One item's update: the item as read, and what changed on it. */
export interface ItemUpdate { item: WorkPlanItem; edits: ItemEdit[]; previousStatus: string | null }

/**
 * What a pass does with one factory's read, given the kept items. Pure:
 * returns the items to insert, to update (with their edits), to touch and to
 * delete. An empty read is never taken as "every item deleted": that is an
 * outage.
 */
export function planPass(
  factory: string,
  read: WorkPlanItem[],
  kept: KeptItem[],
  window: { from: string; to: string },
): { add: WorkPlanItem[]; update: ItemUpdate[]; touch: string[]; remove: string[] } {
  const keptById = new Map(kept.map(k => [k.id, k]))
  const seen = new Set<string>()
  const add: WorkPlanItem[] = []
  const update: ItemUpdate[] = []
  const touch: string[] = []

  for (const item of read) {
    const id = itemId(factory, item)
    seen.add(id)
    const prev = keptById.get(id)
    if (!prev) { add.push(item); continue }
    const edits = itemEdits(prev, item)
    if (edits.length === 0) { touch.push(id); continue }
    const status = edits.find(e => e.field === 'status')
    update.push({ item, edits, previousStatus: status ? prev.status : null })
  }

  const remove = read.length === 0 ? [] : kept
    .filter(k => !seen.has(k.id) && k.day >= window.from && k.day <= window.to)
    .map(k => k.id)
  return { add, update, touch, remove }
}

export const itemId = (factory: string, item: Pick<WorkPlanItem, 'lineId'>) => `${factory}|${item.lineId}`

const columns = (item: WorkPlanItem) => ({
  lineId: item.lineId,
  day: item.day,
  machine: item.machine,
  shiftNo: item.shiftNo,
  planId: item.planId,
  planCode: item.planCode,
  department: item.department,
  status: item.status,
  taskId: item.taskId,
  line: item.line as unknown as Prisma.InputJsonValue,
  reviewedBy: item.reviewedBy,
  reviewedAt: item.reviewedAt,
})

async function watchFactory(factory: string, orgCode: string, window: { from: string; to: string }) {
  const org = await prisma.organisation.findFirst({ where: { code: orgCode }, select: { id: true } })
  if (!org) return null

  const read = itemsFromPlans(await client().listWorkPlans(window.from, window.to, factory))
  const keptRows = await prisma.factorySuiteWorkPlanItem.findMany({
    where: { factoryCode: factory },
    select: { id: true, day: true, status: true, line: true },
  })
  const kept: KeptItem[] = keptRows.map(k => ({ ...k, line: k.line as unknown as WorkPlanItem['line'] }))
  const { add, update, touch, remove } = planPass(factory, read, kept, window)

  const now = new Date()
  await prisma.$transaction([
    ...(touch.length ? [prisma.factorySuiteWorkPlanItem.updateMany({ where: { id: { in: touch } }, data: { lastSeenAt: now } })] : []),
    ...(remove.length ? [prisma.factorySuiteWorkPlanItem.deleteMany({ where: { id: { in: remove } } })] : []),
    ...(add.length ? [prisma.factorySuiteWorkPlanItem.createMany({
      data: add.map(item => ({
        id: itemId(factory, item), organisationId: org.id, factoryCode: factory, ...columns(item),
        firstSeenAt: now, lastSeenAt: now,
      })),
    })] : []),
    ...update.map(({ item, edits, previousStatus }) => prisma.factorySuiteWorkPlanItem.update({
      where: { id: itemId(factory, item) },
      data: {
        ...columns(item),
        lastEdits: edits as unknown as Prisma.InputJsonValue,
        editedAt: now,
        lastSeenAt: now,
        ...(previousStatus != null ? { previousStatus, statusChangedAt: now } : {}),
      },
    })),
  ])

  const changed = add.length + update.length + remove.length
  if (changed && kept.length > 0) {
    logger.info(
      { factory, added: add.length, updated: update.length, removed: remove.length,
        statusChanges: update.filter(u => u.previousStatus != null).length },
      'FactorySuite work plan items changed',
    )
    await workPlansChanged('watch', { factoryCode: factory })
  }
  return { items: read.length, added: add.length, updated: update.length, removed: remove.length }
}

let running: Promise<WatchReport | null> | null = null
let again = false

/** One pass now over every factory that keeps work plans. Throws if a read fails. */
export async function runWorkPlanWatch(): Promise<WatchReport | null> {
  if (!client().isConfigured) return null
  if (running) { again = true; return running }
  running = (async () => {
    try {
      const window = watchWindow()
      const report: WatchReport = { factories: 0, items: 0, added: 0, updated: 0, removed: 0 }
      for (const [factory, orgCode] of Object.entries(MACHINE_FACTORY_TO_ORG)) {
        const r = await watchFactory(factory, orgCode, window)
        if (!r) continue
        report.factories++
        report.items += r.items
        report.added += r.added
        report.updated += r.updated
        report.removed += r.removed
      }
      return report
    } finally {
      running = null
      if (again) {
        again = false
        void runWorkPlanWatch().catch(err => logger.warn({ err }, 'FactorySuite work plan watch: follow-up pass failed'))
      }
    }
  })()
  return running
}

let timer: NodeJS.Timeout | null = null

/** A webhook event that may mean a plan changed: a pass in a moment (events come in bursts). */
export function requestWorkPlanWatch(event: string) {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    void runWorkPlanWatch().catch(err => logger.warn({ err, event }, 'FactorySuite work plan watch: webhook pass failed'))
  }, 3_000)
  timer.unref?.()
}

/** Webhook event names that can follow a work plan change. */
export function isWorkPlanEvent(kind: string) {
  return kind.startsWith('fuelplan.') || kind.startsWith('fuel.request.') || kind.startsWith('fuel.issue.')
}

/**
 * An org's items for days `from`..`to` that changed since the watch first
 * saw them (status or line), last change first: the Fuel page's Plan updates.
 */
export async function workPlanUpdatesFor(orgId: string, from: string, to: string) {
  const [items, watched] = await Promise.all([
    prisma.factorySuiteWorkPlanItem.findMany({
      where: { organisationId: orgId, day: { gte: from, lte: to }, editedAt: { not: null } },
      orderBy: [{ editedAt: 'desc' }, { machine: 'asc' }],
      take: 1000,
      select: {
        id: true, lineId: true, day: true, machine: true, shiftNo: true, planCode: true, department: true, status: true,
        previousStatus: true, statusChangedAt: true, lastEdits: true, editedAt: true,
        reviewedBy: true, taskId: true,
      },
    }),
    prisma.factorySuiteWorkPlanItem.aggregate({ where: { organisationId: orgId }, _min: { firstSeenAt: true }, _count: { _all: true } }),
  ])
  return {
    watching: watched._count._all > 0,
    /** Changes before this were not seen: the watch started then. */
    watchedSince: watched._min.firstSeenAt,
    from, to,
    items,
  }
}
