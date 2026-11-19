/**
 * Reads FactorySuite's workshop feeds and hands them to the sync. Two callers:
 * the reconcile loop (every cycle; parts hourly) and the webhook, whose
 * jobcard.* / breakdown.* / requisition.* / part.* events ask for a pass now
 * rather than at the next cycle. One pass at a time; a request that lands
 * while one runs gets one more pass after it, never a queue of them.
 */

import { logger } from '../../lib/logger.js'
import { RaiFactorySuiteClient } from '../../providers/raifactorysuite/raifactorysuite.client.js'
import { syncBreakdowns, syncJobCards, syncParts, syncRequisitions, type WorkshopSyncReport } from './factorysuite-workshop.sync.js'

const PARTS_EVERY_MS = 60 * 60_000
/** Breakdowns need a window (≤ 31 days); a breakdown older than this is carded or dead. */
const BREAKDOWN_DAYS = 30

// Made on first use: building it reads env, which some test suites mock without it.
let clientInstance: RaiFactorySuiteClient | null = null
const client = () => (clientInstance ??= new RaiFactorySuiteClient())
let partsAt = 0
let running: Promise<WorkshopSyncReport | null> | null = null
let again = false
let partsWanted = false

const ymd = (d: Date) => d.toISOString().slice(0, 10)

/**
 * The breakdowns window, both ends inclusive days: tomorrow (UTC; EAT is ahead)
 * back to BREAKDOWN_DAYS days before it. FactorySuite refuses more than 31
 * days with a 400 ("Date range too wide"); now-30 d to now+1 d was 32 (live,
 * 2026-11-18), so no breakdown was ever read.
 */
export function breakdownWindow(now = Date.now()): { from: string; to: string } {
  const to = new Date(now + 86_400_000)
  const from = new Date(to.getTime() - BREAKDOWN_DAYS * 86_400_000)
  return { from: ymd(from), to: ymd(to) }
}

async function pass(opts: { silent: boolean; parts?: boolean }): Promise<WorkshopSyncReport> {
  const cards = await client().listJobCards()
  const report = await syncJobCards(cards, { silent: opts.silent })
  // A failure past the cards costs only that feed.
  try {
    const { from, to } = breakdownWindow()
    await syncBreakdowns(await client().listBreakdowns(from, to), { silent: opts.silent }, report)
  } catch (err) { logger.warn({ err }, 'FactorySuite workshop: breakdowns not read') }
  try {
    await syncRequisitions(await client().listWorkshopRequisitions(), report)
  } catch (err) { logger.warn({ err }, 'FactorySuite workshop: requisitions not read') }
  if (opts.parts || partsWanted || Date.now() - partsAt >= PARTS_EVERY_MS) {
    try {
      await syncParts(await client().listParts(), report)
      partsAt = Date.now()
      partsWanted = false
    } catch (err) { logger.warn({ err }, 'FactorySuite workshop: parts not read') }
  }
  return report
}

/** One pass now (the reconciler awaits it). Throws if the job cards cannot be read. */
export async function runWorkshopSync(opts: { silent: boolean; parts?: boolean }): Promise<WorkshopSyncReport | null> {
  if (!client().isConfigured) return null
  if (running) { again = true; return running }
  running = (async () => {
    try {
      const report = await pass(opts)
      if (report.created || report.adopted || report.moved || report.voided || report.flagged || report.history) {
        logger.info({ ...report, noVehicle: [...new Set(report.noVehicle)] }, 'FactorySuite workshop synced')
      }
      return report
    } finally {
      running = null
      if (again) {
        again = false
        void runWorkshopSync({ silent: false }).catch((err) => logger.warn({ err }, 'FactorySuite workshop: follow-up pass failed'))
      }
    }
  })()
  return running
}

let timer: NodeJS.Timeout | null = null

/** A workshop webhook event arrived: sync in a moment (events come in bursts). */
export function requestWorkshopSync(event: string) {
  if (event.startsWith('part.')) partsWanted = true
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    void runWorkshopSync({ silent: false }).catch((err) => logger.warn({ err, event }, 'FactorySuite workshop: webhook pass failed'))
  }, 3_000)
  timer.unref?.()
}

/** Webhook event names that belong to the workshop. */
export function isWorkshopEvent(kind: string) {
  return kind.startsWith('jobcard.') || kind.startsWith('breakdown.') || kind.startsWith('requisition.') || kind.startsWith('part.')
    || kind.startsWith('purchaseorder.')
}
