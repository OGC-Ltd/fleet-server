/**
 * The day's FactorySuite work plans for the Live Map's Work plans switch.
 *
 * Driven by FactorySuite's work plan webhook (WORK_PLANNER_HOOK). A fuelplan.*
 * event clears the cached plans and tells the org's open maps, which re-read
 * here (workPlansChanged); the map does not poll. A read goes through to
 * FactorySuite (`GET /fuel/plans`) only when the cache is empty: after a hook,
 * on a new day, or once CACHE_MS has passed, which heals a delivery that never
 * arrived the next time any map reads.
 * Nothing is stored. Positions are not here: the map already has every unit
 * live and decides "in its work location" itself, frame by frame.
 *
 * Only organisations whose FactorySuite factory keeps work plans have any —
 * today that is KASULU (MUFINDI PAPER MILLS). Every other org gets
 * `{ factory: null }`, which is how the map knows not to offer the switch.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { emitDashboardWorkPlansChanged } from '../../lib/sse.js'
import { RaiFactorySuiteClient, type RaiFactorySuiteWorkPlanRow } from '../../providers/raifactorysuite/raifactorysuite.client.js'
import { MACHINE_FACTORY_TO_ORG } from '../../providers/raifactorysuite/raifactorysuite.machine-sync.js'
import { buildMapWorkPlans, type MapWorkPlans } from './work-plan-match.js'

const FACTORY_OF_ORG: Record<string, string> = Object.fromEntries(
  Object.entries(MACHINE_FACTORY_TO_ORG).map(([factory, org]) => [org, factory]),
)

// A safety net only: the hooks are what clear it.
const CACHE_MS = 10 * 60_000
const cache = new Map<string, { at: number; rows: Promise<RaiFactorySuiteWorkPlanRow[]> }>()
// Made on first use, so importing this module (the webhook controller does)
// never reads the FactorySuite config.
let clientInstance: RaiFactorySuiteClient | null = null
const client = () => (clientInstance ??= new RaiFactorySuiteClient())

/** Today in East Africa (UTC+3), YYYY-MM-DD. */
export function eatToday(now = Date.now()): string {
  return new Date(now + 3 * 3_600_000).toISOString().slice(0, 10)
}

function plansFor(factory: string, day: string): Promise<RaiFactorySuiteWorkPlanRow[]> {
  const key = `${factory}|${day}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows
  const rows = client().listWorkPlans(day, day, factory)
  cache.set(key, { at: Date.now(), rows })
  // A failed read is not kept: the map's retry asks again.
  rows.catch(() => cache.delete(key))
  return rows
}

/** The factory a work plan event names, wherever FactorySuite put it. */
function eventFactory(data: unknown): string | null {
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  const plan = (o['plan'] && typeof o['plan'] === 'object' ? o['plan'] : {}) as Record<string, unknown>
  for (const v of [o['factoryCode'], o['factory'], plan['factoryCode'], plan['factory']]) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null)

/**
 * A work plan changed in FactorySuite (fuelplan.decided, .change.requested,
 * .change.decided, .released). Drops the cached plans for its factory, so the
 * next read is fresh, and tells that org's open maps to re-read now.
 *
 * Safe to repeat: FactorySuite retries a delivery it thinks failed, and a
 * second clear-and-tell costs one extra read. An event for a factory with no
 * org here (SANDBOX sends none, but a new factory might) changes nothing; one
 * that names no factory clears every factory's plans.
 *
 * Returns the orgs told.
 */
export async function workPlansChanged(event: string, data: unknown): Promise<number> {
  const factory = eventFactory(data)
  const factories = factory ? [factory] : Object.keys(MACHINE_FACTORY_TO_ORG)
  for (const key of cache.keys()) {
    if (factories.some(f => key.startsWith(`${f}|`))) cache.delete(key)
  }

  const codes = factories.map(f => MACHINE_FACTORY_TO_ORG[f]).filter((c): c is string => Boolean(c))
  if (codes.length === 0) {
    logger.info({ event, factory }, 'Work plan event for a factory with no organisation here')
    return 0
  }
  const orgs = await prisma.organisation.findMany({ where: { code: { in: codes } }, select: { id: true } })
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  for (const org of orgs) {
    emitDashboardWorkPlansChanged(org.id, {
      event,
      planCode: str(o['planCode']),
      status:   str(o['status']),
    })
  }
  return orgs.length
}

export type WorkPlansForMap =(MapWorkPlans & { fetchedAt: string }) | { factory: null; day: string }

export async function workPlansForMap(orgId: string, day = eatToday()): Promise<WorkPlansForMap> {
  const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { code: true } })
  const factory = org ? FACTORY_OF_ORG[org.code] : undefined
  if (!factory || !client().isConfigured) return { factory: null, day }

  const [rows, vehicles, fences] = await Promise.all([
    plansFor(factory, day),
    prisma.vehicle.findMany({
      where: { organisationId: orgId, equipmentReference: { not: null } },
      select: { id: true, registrationPlate: true, name: true, equipmentReference: true },
    }),
    prisma.geofence.findMany({
      where: { organisationId: orgId },
      select: { id: true, name: true, isActive: true, type: true },
    }),
  ])
  const out = buildMapWorkPlans(day, factory, rows, vehicles, fences.map(f => ({ ...f, type: String(f.type) })))
  const unplacedLocations = out.locations.filter(l => !l.fenceId).map(l => l.name)
  if (unplacedLocations.length) logger.debug({ orgId, day, unplacedLocations }, 'Work plan locations with no geofence')
  return { ...out, fetchedAt: new Date().toISOString() }
}
