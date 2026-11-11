/**
 * Keep the vehicle registry in step with Wialon: a BullMQ repeatable that runs
 * the unit registry sync (providers/wialon/wialon.registry-sync) for every
 * fleet whose registry IS Wialon (wialon.account: Kasulu, Menengai, West
 * Sugar, Kabras, Nzoia, Timsales, Aquamist). Sukari's registry is
 * RaiFactorySuite and is never touched here.
 *
 * Before this, `npm run sync:<fleet> -- --apply` was run by hand, so a unit
 * added in Wialon had no vehicle row (and no map marker, alerts or reports)
 * until someone remembered. Now each cycle:
 *
 *   · creates rows for new units, with their last known position;
 *   · updates renamed, regrouped, retyped or re-tanked units, writing only the
 *     rows that changed;
 *   · deactivates units deleted from Wialon (history kept).
 *
 * The live poller re-reads its device list every 5 minutes (lib/poller), so a
 * new unit starts reporting within one cache period of the cycle that made it.
 *
 * WIALON_REGISTRY_SYNC: 'apply' (default), 'dry' (log what would change,
 * write nothing) or 'off'. A fleet whose unit count halved or doubled is
 * refused and logged as an error; the other fleets carry on.
 */

import { Queue, Worker, type Job } from 'bullmq'
import { getQueueRedis } from '../redis.js'
import { env } from '../../config/env.js'
import { logger } from '../logger.js'
import { prisma } from '../prisma.js'
import { WialonClient } from '../../providers/wialon/wialon.client.js'
import { findFleet, syncableOrgCodes } from '../../providers/wialon/wialon.account.js'
import {
  RegistrySyncRefused, WialonUnitSource, syncWialonFleet, type RegistrySyncReport,
} from '../../providers/wialon/wialon.registry-sync.js'

export const WIALON_REGISTRY_QUEUE = 'wialon-registry'
const SYNC_JOB = 'wialon-registry:sync'

export interface WialonRegistryCycle {
  apply:   boolean
  fleets:  Array<{
    org: string
    created: number; updated: number; deactivated: number; unchanged: number; failed: number
    refused?: string; error?: string
  }>
  ms: number
}

/** One cycle over every Wialon fleet. Exported to run by hand or from a test. */
export async function runWialonRegistrySync(apply = env.WIALON_REGISTRY_SYNC === 'apply'): Promise<WialonRegistryCycle> {
  const startedAt = Date.now()
  const cycle: WialonRegistryCycle = { apply, fleets: [], ms: 0 }

  const client = new WialonClient(env.WIALON_TOKEN, env.WIALON_API_URL)
  await client.login()
  const source = new WialonUnitSource(client)

  try {
    for (const code of syncableOrgCodes()) {
      const fleet = findFleet(code)!
      try {
        const r = await syncWialonFleet(prisma, source, fleet, { apply, positions: 'created' })
        cycle.fleets.push(summarise(r, apply))
        logChanges(r, apply)
      } catch (err) {
        const refused = err instanceof RegistrySyncRefused
        cycle.fleets.push({
          org: code, created: 0, updated: 0, deactivated: 0, unchanged: 0, failed: 0,
          ...(refused ? { refused: err.message } : { error: err instanceof Error ? err.message : String(err) }),
        })
        // One fleet failing must not abandon the others.
        logger.error({ err, org: code }, refused
          ? 'Wialon registry sync REFUSED for fleet — nothing written; check the account and token'
          : 'Wialon registry sync failed for fleet')
      }
    }
  } finally {
    await client.logout()
  }

  cycle.ms = Date.now() - startedAt
  const busy = cycle.fleets.some(f => f.created || f.updated || f.deactivated || f.failed || f.refused || f.error)
  ;(busy ? logger.info.bind(logger) : logger.debug.bind(logger))(cycle, 'Wialon registry sync cycle complete')
  return cycle
}

function summarise(r: RegistrySyncReport, apply: boolean): WialonRegistryCycle['fleets'][number] {
  if (apply && r.applied) {
    return {
      org: r.orgCode, created: r.applied.created, updated: r.applied.updated,
      deactivated: r.applied.deactivated, unchanged: r.unchanged, failed: r.applied.failed,
    }
  }
  return {
    org: r.orgCode, created: r.toCreate.length, updated: r.toUpdate.length,
    deactivated: r.toDeactivate.length, unchanged: r.unchanged, failed: 0,
  }
}

/** Every change by name, so "where did this unit come from" has an answer in the log. */
function logChanges(r: RegistrySyncReport, apply: boolean): void {
  const verb = apply ? 'applied' : 'would apply (dry run)'
  for (const v of r.toCreate)     logger.info({ org: r.orgCode, plate: v.plate, unit: v.name, type: v.type }, `Wialon registry: new unit ${verb}`)
  for (const v of r.toUpdate)     logger.info({ org: r.orgCode, plate: v.plate, unit: v.name, fields: v.fields }, `Wialon registry: unit update ${verb}`)
  for (const v of r.toDeactivate) logger.info({ org: r.orgCode, plate: v.plate, unit: v.name, externalId: v.externalId }, `Wialon registry: unit gone from Wialon, deactivation ${verb}`)
  for (const h of r.handOvers)    logger.info({ org: r.orgCode, plate: h.plate, from: h.externalId }, `Wialon registry: plate hand-over ${verb}`)
  for (const f of r.applied?.failures ?? []) logger.warn({ org: r.orgCode, unit: f.name, externalId: f.externalId, error: f.error }, 'Wialon registry: unit write failed')
}

let queue:  Queue  | null = null
let worker: Worker | null = null
let running = false

export interface WialonRegistryHandle { stop: () => Promise<void> }

export async function startWialonRegistrySync(): Promise<WialonRegistryHandle> {
  const noop: WialonRegistryHandle = { stop: async () => {} }

  if (env.WIALON_REGISTRY_SYNC === 'off') {
    logger.warn('WIALON_REGISTRY_SYNC=off — Wialon registry sync NOT started')
    return noop
  }
  if (!env.WIALON_TOKEN) {
    logger.warn('No WIALON_TOKEN — Wialon registry sync NOT started')
    return noop
  }
  const connection = getQueueRedis()
  if (!connection) {
    logger.warn('No REDIS_URL — Wialon registry sync NOT started; run `npm run sync:<fleet> -- --apply` by hand')
    return noop
  }

  queue = new Queue(WIALON_REGISTRY_QUEUE, { connection })

  // Repeatable jobs accumulate in Redis when their schedule changes.
  for (const r of await queue.getRepeatableJobs()) {
    if (r.name === SYNC_JOB) await queue.removeRepeatableByKey(r.key)
  }

  await queue.add(SYNC_JOB, {}, {
    repeat:           { pattern: env.WIALON_REGISTRY_SYNC_CRON },
    removeOnComplete: { count: 50 },
    removeOnFail:     { count: 50 },
    attempts:         2,
    backoff:          { type: 'exponential', delay: 120_000 },
  })

  worker = new Worker(WIALON_REGISTRY_QUEUE, async (job: Job) => {
    if (job.name !== SYNC_JOB) return
    if (running) {
      logger.warn({ jobId: job.id }, 'Wialon registry sync: previous cycle still running — skipping this tick')
      return
    }
    running = true
    try { return await runWialonRegistrySync() } finally { running = false }
  }, { connection, concurrency: 1 })

  worker.on('failed', (job, err) => logger.error({ err, jobId: job?.id }, 'Wialon registry sync job failed'))

  logger.info(
    { queue: WIALON_REGISTRY_QUEUE, cron: env.WIALON_REGISTRY_SYNC_CRON, mode: env.WIALON_REGISTRY_SYNC },
    'Wialon registry sync scheduled',
  )

  return {
    async stop() {
      await worker?.close()
      await queue?.close()
      worker = null
      queue  = null
    },
  }
}
