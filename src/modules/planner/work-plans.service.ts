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
import { LIVE_FENCE } from '../../lib/fence-archive.js'
import { logger } from '../../lib/logger.js'
import { emitDashboardWorkPlansChanged } from '../../lib/sse.js'
import {
  RaiFactorySuiteClient,
  type RaiFactorySuiteFuelIssueRow,
  type RaiFactorySuiteFuelRequestRow,
  type RaiFactorySuiteMachineRow,
  type RaiFactorySuiteWorkPlanRow,
} from '../../providers/raifactorysuite/raifactorysuite.client.js'
import { MACHINE_FACTORY_TO_ORG } from '../../providers/raifactorysuite/raifactorysuite.machine-sync.js'
import { buildMapWorkPlans, type MapWorkPlans } from './work-plan-match.js'
import { collapsePlans } from './work-plan-items.js'
import { buildFactorySupervisors, lineWindow, runKey, type FactorySupervisors, type LineRun } from './factory-supervisors.js'
import { buildFactoryFuel, type FactoryFuel } from './factory-fuel.js'
import { buildFactoryOperators, type FactoryOperators } from './factory-operators.js'
import { meterRefill, refillFigures, refillSpan, refillWindows, type MachineRefill, type MachineRefills, type RefillWindow } from './fuel-refills.js'
import { createHash } from 'node:crypto'
import { asDaySeries, EDGE_READING_COUNT, type BalanceDrain, type BalanceFilling } from '../fuel/fuel-balance.js'
import { machineShiftUse, measureSpan, shiftWindows, type MachineShiftUse, type ShiftWindow, type WindowEdges } from './fuel-shifts.js'
import { reportDb } from '../../lib/report-db.js'
import { addDays, buildPlanSubmissions, type PlanSubmissions } from './plan-submissions.js'

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

/** The register and the day's fuel requests, for the map's plan card. They
 *  share the plans' cache life, and a failure of either only leaves the card
 *  without what it would have added. */
type Extras = { machines: RaiFactorySuiteMachineRow[]; requests: RaiFactorySuiteFuelRequestRow[]; issues: RaiFactorySuiteFuelIssueRow[] }
const extrasCache = new Map<string, { at: number; extras: Promise<Extras> }>()
function extrasFor(factory: string, day: string): Promise<Extras> {
  const key = `${factory}|${day}`
  const hit = extrasCache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.extras
  const soft = <T>(read: Promise<T[]>, what: string): Promise<T[]> => read.catch((err: unknown) => {
    logger.warn({ err, factory, day }, `FactorySuite ${what} unavailable for the work plan card`)
    extrasCache.delete(key)
    return []
  })
  const extras = Promise.all([
    soft(client().listMachines(), 'machine register'),
    soft(client().listFuelRequests(day, day, factory), 'fuel requests'),
    soft(client().listFuelIssues(day, day, factory), 'fuel issues'),
  ]).then(([machines, requests, issues]) => ({
    machines: machines.filter(m => !m.factoryCode || m.factoryCode === factory),
    requests,
    issues,
  }))
  extrasCache.set(key, { at: Date.now(), extras })
  return extras
}

function plansFor(factory: string, day: string): Promise<RaiFactorySuiteWorkPlanRow[]> {
  const key = `${factory}|${day}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows
  // No duplicate plan line: one line per machine-shift (planner/work-plan-items).
  const rows = client().listWorkPlans(day, day, factory).then(collapsePlans)
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
  for (const c of [cache, extrasCache, fuelCache, submissionsCache]) {
    for (const key of c.keys()) {
      if (factories.some(f => key.startsWith(`${f}|`))) c.delete(key)
    }
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

/**
 * The Maintenance page's Plan submissions board (plan-submissions.ts): the 14
 * days ending on `day` (tomorrow in EAT by default, the day plans are being
 * sent for). Reads 31 days of plan headers so every department that plans
 * gets a row. Cached like the map's plans and cleared by the same hooks
 * (workPlansChanged), which also tell the open page to re-read.
 */
const submissionsCache = new Map<string, { at: number; out: Promise<PlanSubmissions> }>()
export type PlanSubmissionsForPage = (PlanSubmissions & { today: string; fetchedAt: string }) | { factory: null; today: string }

export async function planSubmissionsFor(orgId: string, day?: string): Promise<PlanSubmissionsForPage> {
  const today = eatToday()
  const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { code: true } })
  const factory = org ? FACTORY_OF_ORG[org.code] : undefined
  if (!factory || !client().isConfigured) return { factory: null, today }

  const to = day ?? addDays(today, 1)
  const key = `${factory}|${to}`
  const hit = submissionsCache.get(key)
  if (!hit || Date.now() - hit.at >= CACHE_MS) {
    // Collapsing is for plan LINES; the board reads every plan header.
    const out = client().listWorkPlans(addDays(to, -30), to, factory)
      .then(plans => buildPlanSubmissions(factory, to, plans))
    submissionsCache.set(key, { at: Date.now(), out })
    out.catch(() => submissionsCache.delete(key))
  }
  const out = await submissionsCache.get(key)!.out
  return { ...out, today, fetchedAt: new Date().toISOString() }
}

export type WorkPlansForMap =(MapWorkPlans & { fetchedAt: string }) | { factory: null; day: string }

export async function workPlansForMap(orgId: string, day = eatToday()): Promise<WorkPlansForMap> {
  const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { code: true } })
  const factory = org ? FACTORY_OF_ORG[org.code] : undefined
  if (!factory || !client().isConfigured) return { factory: null, day }

  const [rows, extras, vehicles, fences] = await Promise.all([
    plansFor(factory, day),
    extrasFor(factory, day),
    prisma.vehicle.findMany({
      where: { organisationId: orgId, equipmentReference: { not: null } },
      select: { id: true, registrationPlate: true, name: true, equipmentReference: true, tankCapacityLitres: true },
    }),
    prisma.geofence.findMany({
      where: { organisationId: orgId, ...LIVE_FENCE },
      select: { id: true, name: true, isActive: true, type: true },
    }),
  ])
  const out = buildMapWorkPlans(day, factory, rows, vehicles, fences.map(f => ({ ...f, type: String(f.type) })), extras)
  const unplacedLocations = out.locations.filter(l => !l.fenceId).map(l => l.name)
  if (unplacedLocations.length) logger.debug({ orgId, day, unplacedLocations }, 'Work plan locations with no geofence')
  return { ...out, fetchedAt: new Date().toISOString() }
}

/**
 * The Fuel page (operator 2026-11-14): FactorySuite's plans, fuel requests and
 * pump issues for `from`..`to` (≤ 31 days, both inclusive), with the register
 * and our units — see buildFactoryFuel. Cached like the map's plans and
 * cleared by the same work plan hooks. A failed read of requests or issues
 * leaves those empty rather than failing the page; plans and the register
 * are the page, so their failure is an error.
 */
const fuelCache = new Map<string, { at: number; out: Promise<FactoryFuel> }>()
export type FactoryFuelForPage = (FactoryFuel & { fetchedAt: string }) | { factory: null; from: string; to: string }

export async function factoryFuelFor(orgId: string, from: string, to: string): Promise<FactoryFuelForPage> {
  const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { code: true } })
  const factory = org ? FACTORY_OF_ORG[org.code] : undefined
  if (!factory || !client().isConfigured) return { factory: null, from, to }

  const key = `${factory}|${from}|${to}|${orgId}`
  const hit = fuelCache.get(key)
  if (!hit || Date.now() - hit.at >= CACHE_MS) {
    const soft = <T>(read: Promise<T[]>, what: string): Promise<T[]> => read.catch((err: unknown) => {
      logger.warn({ err, factory, from, to }, `FactorySuite ${what} unavailable for the Fuel page`)
      return []
    })
    const out = Promise.all([
      // No duplicate plan line (planner/work-plan-items): the Fuel page,
      // Operators and Supervisors all read these lines.
      client().listWorkPlans(from, to, factory).then(collapsePlans),
      soft(client().listFuelRequests(from, to, factory), 'fuel requests'),
      soft(client().listFuelIssues(from, to, factory), 'fuel issues'),
      client().listMachines(),
      prisma.vehicle.findMany({
        where: { organisationId: orgId, equipmentReference: { not: null } },
        select: { id: true, registrationPlate: true, equipmentReference: true, tankCapacityLitres: true },
      }),
    ]).then(([plans, requests, issues, machines, units]) => buildFactoryFuel(
      factory, from, to, plans, requests, issues,
      machines.filter(m => !m.factoryCode || m.factoryCode === factory), units,
    ))
    fuelCache.set(key, { at: Date.now(), out })
    out.catch(() => fuelCache.delete(key))
  }
  const out = await fuelCache.get(key)!.out
  return { ...out, fetchedAt: new Date().toISOString() }
}

/**
 * The Drivers page's Operators tab: the operators the work plans and the pump
 * name over `from`..`to` (factory-operators.ts). Built from the Fuel page's
 * read, so it shares that cache and its hooks.
 */
export type FactoryOperatorsForPage = (FactoryOperators & { fetchedAt: string }) | { factory: null; from: string; to: string }

export async function factoryOperatorsFor(orgId: string, from: string, to: string): Promise<FactoryOperatorsForPage> {
  const fuel = await factoryFuelFor(orgId, from, to)
  if (fuel.factory === null) return fuel
  return { ...buildFactoryOperators(fuel), fetchedAt: fuel.fetchedAt }
}

/**
 * The Scorecard's Supervisors view: each supervisor's plan lines over
 * `from`..`to` with what the machine ran in each line's window
 * (factory-supervisors.ts). One query reads every judged window: the hours
 * meter's rise inside it (Wialon `cneh`, on ~96% of fixes and the most trusted
 * engine time), engine-on time where the meter is missing, and the first
 * working fix from an hour before the start. Measured on prod 2026-11-19:
 * 382 windows over two weeks in ~9 s, so the answer is cached like the Fuel
 * page's read it is built from.
 */
export type FactorySupervisorsForPage = (FactorySupervisors & { fetchedAt: string }) | { factory: null; from: string; to: string }
const supervisorCache = new Map<string, { at: number; out: Promise<FactorySupervisors> }>()

export async function factorySupervisorsFor(orgId: string, from: string, to: string): Promise<FactorySupervisorsForPage> {
  const fuel = await factoryFuelFor(orgId, from, to)
  if (fuel.factory === null) return fuel
  const key = `${orgId}|${from}|${to}`
  const hit = supervisorCache.get(key)
  if (!hit || Date.now() - hit.at >= CACHE_MS) {
    const now = new Date()
    const vehicleOf = new Map(fuel.machines.map(m => [m.reference.toUpperCase(), m]))
    const windows: Array<{ key: string; vehicleId: string; start: Date; end: Date }> = []
    for (const l of fuel.lines) {
      const m = vehicleOf.get(l.machine.toUpperCase())
      const w = lineWindow(l.day, l.shiftStart, l.plannedHours)
      if (!m?.vehicleId || !w || w.end > now) continue
      windows.push({ key: runKey(l.lineId, l.day), vehicleId: m.vehicleId, ...w })
    }
    const out = readLineRuns(windows).then(runs => buildFactorySupervisors(fuel, runs, now))
    supervisorCache.set(key, { at: Date.now(), out })
    out.catch(() => supervisorCache.delete(key))
  }
  const out = await supervisorCache.get(key)!.out
  return { ...out, fetchedAt: new Date().toISOString() }
}

/**
 * The Fuel page machine panel's refills: one machine's fuellings over
 * `from`..`to`, each with what only our telemetry knows (fuel-refills.ts):
 * the tracker's meter either side of the fuelling, and the fuel burned and
 * engine hours run in the shift it was for. The rest of the seven figures are
 * on the Fuel page's read already. Telemetry comes through the report pool
 * (lib/report-db), a shift at a time: a month of one machine's fuellings is a
 * few dozen windows of a day or less.
 *
 * With no machine named, every machine's fuellings with the meters only, in
 * one query (readRefillMeters): the Fuel page's table shows each row's latest
 * refill. Only each machine's latest fuelling gets its shift balance
 * (withLatestShift), for the table's Consumed; the rest stay with the panel.
 *
 * A machine that is not one of our units, or one outside the caller's
 * vehicles (`scope`), gets its refills with no tracker figures.
 */
export type MachineRefillsForPage = (MachineRefills & { fetchedAt: string }) | { factory: null; from: string; to: string }
const REFILLS_CACHE_MS = 2 * 60_000
const refillsCache = new Map<string, { at: number; out: Promise<MachineRefills> }>()

export async function factoryFuelRefillsFor(
  orgId: string, from: string, to: string, reference: string | null, scope: ReadonlySet<string> | null = null,
): Promise<MachineRefillsForPage> {
  const fuel = await factoryFuelFor(orgId, from, to)
  if (fuel.factory === null) return fuel
  const found = refillWindows(fuel, reference)
  // A unit outside the caller's vehicles reads as untracked.
  const windows = found.windows.map(w => (w.vehicleId && scope && !scope.has(w.vehicleId) ? { ...w, vehicleId: null } : w))
  const units = [...new Set(windows.map(w => w.vehicleId ?? '-'))].sort().join(',')
  const key = `${orgId}|${from}|${to}|${reference?.toUpperCase() ?? '*'}|${createHash('sha1').update(units).digest('hex')}`
  const hit = refillsCache.get(key)
  if (!hit || Date.now() - hit.at >= REFILLS_CACHE_MS) {
    const read = (reference == null ? readRefillMeters(windows).then(withLatestShift(windows)) : readRefills(windows)).then(withMeterNow(windows))
    const out = read.then(refills => ({
      factory: fuel.factory, from, to,
      machine: reference == null ? null : found.machine?.reference ?? reference,
      basis: found.machine?.basis ?? null,
      refills,
    }))
    refillsCache.set(key, { at: Date.now(), out })
    out.catch(() => refillsCache.delete(key))
    for (const [k, v] of refillsCache) if (Date.now() - v.at >= REFILLS_CACHE_MS) refillsCache.delete(k)
  }
  const out = await refillsCache.get(key)!.out
  return { ...out, fetchedAt: new Date().toISOString() }
}

/**
 * Each tracked machine's meter now, off the same telemetry column as its
 * refill meters: odometer_m in km, or engine_hours_meter in h on an
 * hour-rated machine (RefillWindow.km). The live snapshot's mileage is
 * Wialon's own counter (cnm_km) and runs on another base (MTR-21: 37,488 km
 * there against 1,815 km here), so Odometer after must not mix the two. The
 * latest fix with that meter in the last 7 days.
 */
function withMeterNow(windows: RefillWindow[]) {
  return async (refills: MachineRefill[]): Promise<MachineRefill[]> => {
    const asked = new Map<string, boolean>()
    for (const w of windows) if (w.vehicleId) asked.set(`${w.vehicleId}|${w.km}`, w.km)
    if (!asked.size) return refills
    const keys = [...asked.keys()]
    const rows = await reportDb().$queryRaw<Array<{ vid: string; km: boolean; at: Date; meter: number }>>`
      SELECT v.vid, v.km, n.captured_at AS at, n.meter
        FROM unnest(${keys.map(k => k.split('|')[0]!)}::text[], ${keys.map(k => asked.get(k)!)}::boolean[]) AS v(vid, km)
        JOIN LATERAL (
          SELECT t.captured_at, (CASE WHEN v.km THEN t.odometer_m / 1000.0 ELSE t.engine_hours_meter END)::float8 AS meter
            FROM vehicle_telemetries t
           WHERE t.vehicle_id = v.vid AND t.captured_at >= now() - interval '7 days'
             AND (CASE WHEN v.km THEN t.odometer_m ELSE t.engine_hours_meter END) IS NOT NULL
           ORDER BY t.captured_at DESC LIMIT 1) n ON true`
    const nowOf = new Map(rows.map(r => [`${r.vid}|${r.km}`, {
      value: Math.round(r.meter * 10) / 10, at: r.at.toISOString(), unit: r.km ? 'km' as const : 'h' as const,
    }]))
    const keyOf = new Map(windows.map(w => [w.issueId, w.vehicleId ? `${w.vehicleId}|${w.km}` : null]))
    return refills.map(r => {
      const k = keyOf.get(r.issueId)
      return { ...r, meterNow: k ? nowOf.get(k) ?? null : null }
    })
  }
}

/**
 * Every fuelling's meters in one query: the last fix with a meter in the two
 * hours before the nozzle went in, and the first in the two hours after it
 * came out. Two index seeks a fuelling, so a month of them stays cheap.
 */
async function readRefillMeters(windows: RefillWindow[]): Promise<MachineRefill[]> {
  const asked = windows.filter(w => w.vehicleId && w.fuelStart && w.fuelEnd)
  if (!asked.length) return windows.map(w => meterRefill(w, null))
  const rows = await reportDb().$queryRaw<Array<{ k: string; before_at: Date | null; before: number | null; after_at: Date | null; after: number | null }>>`
    WITH w AS (
      SELECT * FROM unnest(${asked.map(w => w.issueId)}::text[], ${asked.map(w => w.vehicleId!)}::text[],
                           ${asked.map(w => w.fuelStart!)}::timestamptz[], ${asked.map(w => w.fuelEnd!)}::timestamptz[],
                           ${asked.map(w => w.km)}::boolean[]) AS w(k, vid, st, en, km))
    SELECT w.k, b.captured_at AS before_at, b.meter AS before, a.captured_at AS after_at, a.meter AS after
      FROM w
      LEFT JOIN LATERAL (
        SELECT t.captured_at, (CASE WHEN w.km THEN t.odometer_m / 1000.0 ELSE t.engine_hours_meter END)::float8 AS meter
          FROM vehicle_telemetries t
         WHERE t.vehicle_id = w.vid AND t.captured_at <= w.st AND t.captured_at >= w.st - interval '2 hours'
           AND (CASE WHEN w.km THEN t.odometer_m ELSE t.engine_hours_meter END) IS NOT NULL
         ORDER BY t.captured_at DESC LIMIT 1) b ON true
      LEFT JOIN LATERAL (
        SELECT t.captured_at, (CASE WHEN w.km THEN t.odometer_m / 1000.0 ELSE t.engine_hours_meter END)::float8 AS meter
          FROM vehicle_telemetries t
         WHERE t.vehicle_id = w.vid AND t.captured_at >= w.en AND t.captured_at <= w.en + interval '2 hours'
           AND (CASE WHEN w.km THEN t.odometer_m ELSE t.engine_hours_meter END) IS NOT NULL
         ORDER BY t.captured_at ASC LIMIT 1) a ON true`
  const byKey = new Map(rows.map(r => [r.k, { beforeAt: r.before_at, before: r.before, afterAt: r.after_at, after: r.after }]))
  return windows.map(w => meterRefill(w, byKey.get(w.issueId) ?? null))
}

/**
 * The table's Consumed is the machine panel's (operator 2026-11-20: "we need
 * the one populated on the side panel to reflect on the row"): the shift
 * balance of each machine's latest fuelling, read exactly as the panel reads
 * it (readRefills), and put on that refill of the meters-only answer. Only the
 * latest per machine, so a month's read costs one shift of telemetry a
 * machine; four machines at a time.
 */
function withLatestShift(windows: RefillWindow[]) {
  return async (refills: MachineRefill[]): Promise<MachineRefill[]> => {
    const latest = new Map<string, RefillWindow>()
    for (const w of windows) {
      if (!w.vehicleId || !w.shift || !w.fuelEnd) continue
      const had = latest.get(w.vehicleId)
      if (!had || had.fuelEnd!.getTime() < w.fuelEnd.getTime()) latest.set(w.vehicleId, w)
    }
    const asked = [...latest.values()]
    const shiftOf = new Map<string, MachineRefill['shift']>()
    let next = 0
    const worker = async () => {
      while (next < asked.length) {
        const w = asked[next++]!
        // One machine's read failing leaves its Consumed blank, not the table's meters.
        const [r] = await readRefills([w]).catch(() => [] as MachineRefill[])
        if (r?.shift) shiftOf.set(w.issueId, r.shift)
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, asked.length) }, worker))
    return refills.map(r => (shiftOf.has(r.issueId) ? { ...r, shift: shiftOf.get(r.issueId)! } : r))
  }
}

async function readRefills(windows: RefillWindow[]): Promise<MachineRefill[]> {
  const now = new Date()
  // One machine's windows: one unit, or none.
  const vehicleId = windows.find(w => w.vehicleId)?.vehicleId ?? null
  if (!vehicleId || !windows.length) return windows.map(w => refillFigures(w, null, [], [], now))
  const spans = windows.map(w => refillSpan(w, now))
  const known = spans.filter((s): s is { from: Date; to: Date } => s != null)
  if (!known.length) return windows.map(w => refillFigures(w, null, [], [], now))
  const lo = new Date(Math.min(...known.map(s => s.from.getTime())))
  const hi = new Date(Math.max(...known.map(s => s.to.getTime())))
  const db = reportDb()
  const [fillings, drains] = await Promise.all([
    db.fuelFilling.findMany({
      where: { vehicleId, filledAt: { gte: lo, lte: hi } },
      select: { filledAt: true, verdict: true, observedRiseMl: true, filledMl: true, initialFuelLevelMl: true, finalFuelLevelMl: true },
    }),
    db.fuelTheft.findMany({
      where: { vehicleId, beganAt: { gte: lo, lte: hi }, OR: [{ drainCause: 'SIPHON' }, { reviewStatus: 'CONFIRMED_THEFT' }] },
      select: { beganAt: true, verdict: true, drainCause: true, cleanDropMl: true, measuredDropMl: true,
                stolenMl: true, finalFuelLevelMl: true, reviewStatus: true, dismissedAt: true },
    }),
  ])
  const fills = fillings.map(f => ({ ...f, verdict: f.verdict as string | null, at: f.filledAt.getTime() }))
  const lost = drains.map(d => ({ ...d, verdict: d.verdict as string | null, drainCause: d.drainCause as string | null,
    reviewStatus: d.reviewStatus as string | null, at: d.beganAt.getTime() }))

  const out: MachineRefill[] = new Array(windows.length)
  let next = 0
  const worker = async () => {
    while (next < windows.length) {
      const i = next++
      const span = spans[i]
      if (!span) { out[i] = refillFigures(windows[i]!, null, fills, lost, now); continue }
      const rows = await db.$queryRaw<Array<{ captured_at: Date; lat: number | null; lng: number | null; speed_kmh: number | null;
        fuel_level_ml: number | null; engine_hours_meter: number | null; odometer_m: number | null }>>`
        SELECT captured_at, lat, lng, speed_kmh, fuel_level_ml, engine_hours_meter, odometer_m
          FROM vehicle_telemetries
         WHERE vehicle_id = ${vehicleId} AND captured_at >= ${span.from} AND captured_at <= ${span.to}
         ORDER BY captured_at ASC`
      const readings = rows.map(r => ({
        ...asDaySeries({ t: r.captured_at.getTime(), lat: r.lat, lng: r.lng, speedKmh: r.speed_kmh, fuelMl: r.fuel_level_ml }),
        engineHours: r.engine_hours_meter,
        odometerKm: r.odometer_m != null ? r.odometer_m / 1000 : null,
      }))
      out[i] = refillFigures(windows[i]!, readings, fills, lost, now)
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, windows.length) }, worker))
  return out
}

/**
 * The Fuel page's Probe used column (fuel-shifts.ts): each machine's fuel
 * burned over its planned shifts from..to, by its probe, with the engine hours
 * and kilometres it ran in them; a shift still running up to now. Every
 * window's edges come in one query (readShiftEdges), the units' fills and
 * drains in two, so a month of plans stays a few index seeks a shift.
 *
 * A machine outside the caller's vehicles (`scope`), or not one of our units,
 * gets its shifts counted with nothing measured.
 */
export type MachineShiftsForPage =
  | { factory: string; from: string; to: string; machines: MachineShiftUse[]; fetchedAt: string }
  | { factory: null; from: string; to: string }
const SHIFTS_CACHE_MS = 2 * 60_000
const shiftsCache = new Map<string, { at: number; out: Promise<{ factory: string; machines: MachineShiftUse[] }> }>()

export async function factoryFuelShiftsFor(
  orgId: string, from: string, to: string, scope: ReadonlySet<string> | null = null,
): Promise<MachineShiftsForPage> {
  const fuel = await factoryFuelFor(orgId, from, to)
  if (fuel.factory === null) return fuel
  const windows = shiftWindows(fuel).map(w => (w.vehicleId && scope && !scope.has(w.vehicleId) ? { ...w, vehicleId: null } : w))
  const units = [...new Set(windows.map(w => w.vehicleId ?? '-'))].sort().join(',')
  const key = `${orgId}|${from}|${to}|${createHash('sha1').update(units).digest('hex')}`
  const hit = shiftsCache.get(key)
  if (!hit || Date.now() - hit.at >= SHIFTS_CACHE_MS) {
    const now = new Date()
    const out = readShifts(windows, now).then(machines => ({ factory: fuel.factory, machines }))
    shiftsCache.set(key, { at: Date.now(), out })
    out.catch(() => shiftsCache.delete(key))
    for (const [k, v] of shiftsCache) if (Date.now() - v.at >= SHIFTS_CACHE_MS) shiftsCache.delete(k)
  }
  const out = await shiftsCache.get(key)!.out
  return { factory: out.factory, from, to, machines: out.machines, fetchedAt: new Date().toISOString() }
}

async function readShifts(windows: ShiftWindow[], now: Date): Promise<MachineShiftUse[]> {
  const asked = windows
    .map(w => ({ w, span: w.vehicleId ? measureSpan(w, now) : null }))
    .filter((x): x is { w: ShiftWindow; span: { from: Date; to: Date } } => x.span != null)
  const edges = await readShiftEdges(asked.map(({ w, span }) => ({ key: w.key, vehicleId: w.vehicleId!, ...span })))
  const ids = [...new Set(asked.map(x => x.w.vehicleId!))]
  const ledger = new Map<string, { fillings: BalanceFilling[]; drains: BalanceDrain[] }>()
  if (ids.length) {
    const lo = new Date(Math.min(...asked.map(x => x.span.from.getTime())))
    const hi = new Date(Math.max(...asked.map(x => x.span.to.getTime())))
    const db = reportDb()
    const [fillings, drains] = await Promise.all([
      db.fuelFilling.findMany({
        where: { vehicleId: { in: ids }, filledAt: { gte: lo, lte: hi } },
        select: { vehicleId: true, filledAt: true, verdict: true, observedRiseMl: true, filledMl: true, initialFuelLevelMl: true, finalFuelLevelMl: true },
      }),
      db.fuelTheft.findMany({
        where: { vehicleId: { in: ids }, beganAt: { gte: lo, lte: hi }, OR: [{ drainCause: 'SIPHON' }, { reviewStatus: 'CONFIRMED_THEFT' }] },
        select: { vehicleId: true, beganAt: true, verdict: true, drainCause: true, cleanDropMl: true, measuredDropMl: true,
                  stolenMl: true, finalFuelLevelMl: true, reviewStatus: true, dismissedAt: true },
      }),
    ])
    for (const id of ids) ledger.set(id, { fillings: [], drains: [] })
    for (const f of fillings) ledger.get(f.vehicleId)?.fillings.push({ ...f, verdict: f.verdict as string | null, at: f.filledAt.getTime() })
    for (const d of drains) ledger.get(d.vehicleId)?.drains.push({ ...d, verdict: d.verdict as string | null, drainCause: d.drainCause as string | null,
      reviewStatus: d.reviewStatus as string | null, at: d.beganAt.getTime() })
  }
  return machineShiftUse(windows, edges, ledger, now)
}

/**
 * Each window's two ends in one query: the first and last 7 fixes that read a
 * tank, and the first and last engine-hours and odometer readings. Index seeks
 * on (vehicle_id, captured_at), a handful a window.
 */
async function readShiftEdges(windows: Array<{ key: string; vehicleId: string; from: Date; to: Date }>): Promise<Map<string, WindowEdges>> {
  const out = new Map<string, WindowEdges>()
  if (!windows.length) return out
  const rows = await reportDb().$queryRaw<Array<{
    k: string; first: number[] | null; last: number[] | null
    h0: number | null; h1: number | null; o0: number | null; o1: number | null
  }>>`
    WITH w AS (
      SELECT * FROM unnest(${windows.map(w => w.key)}::text[], ${windows.map(w => w.vehicleId)}::text[],
                           ${windows.map(w => w.from)}::timestamptz[], ${windows.map(w => w.to)}::timestamptz[]) AS w(k, vid, st, en))
    SELECT w.k,
      (SELECT array_agg(x.f) FROM (SELECT t.fuel_level_ml AS f FROM vehicle_telemetries t
         WHERE t.vehicle_id = w.vid AND t.captured_at >= w.st AND t.captured_at < w.en AND t.fuel_level_ml >= 1000
         ORDER BY t.captured_at ASC LIMIT ${EDGE_READING_COUNT}) x) AS first,
      (SELECT array_agg(x.f) FROM (SELECT t.fuel_level_ml AS f FROM vehicle_telemetries t
         WHERE t.vehicle_id = w.vid AND t.captured_at >= w.st AND t.captured_at < w.en AND t.fuel_level_ml >= 1000
         ORDER BY t.captured_at DESC LIMIT ${EDGE_READING_COUNT}) x) AS last,
      (SELECT t.engine_hours_meter::float8 FROM vehicle_telemetries t
         WHERE t.vehicle_id = w.vid AND t.captured_at >= w.st AND t.captured_at < w.en AND t.engine_hours_meter IS NOT NULL
         ORDER BY t.captured_at ASC LIMIT 1) AS h0,
      (SELECT t.engine_hours_meter::float8 FROM vehicle_telemetries t
         WHERE t.vehicle_id = w.vid AND t.captured_at >= w.st AND t.captured_at < w.en AND t.engine_hours_meter IS NOT NULL
         ORDER BY t.captured_at DESC LIMIT 1) AS h1,
      (SELECT (t.odometer_m / 1000.0)::float8 FROM vehicle_telemetries t
         WHERE t.vehicle_id = w.vid AND t.captured_at >= w.st AND t.captured_at < w.en AND t.odometer_m IS NOT NULL
         ORDER BY t.captured_at ASC LIMIT 1) AS o0,
      (SELECT (t.odometer_m / 1000.0)::float8 FROM vehicle_telemetries t
         WHERE t.vehicle_id = w.vid AND t.captured_at >= w.st AND t.captured_at < w.en AND t.odometer_m IS NOT NULL
         ORDER BY t.captured_at DESC LIMIT 1) AS o1
      FROM w`
  for (const r of rows) {
    out.set(r.k, {
      first: (r.first ?? []).map(Number), last: (r.last ?? []).map(Number),
      hoursFirst: r.h0, hoursLast: r.h1, kmFirst: r.o0, kmLast: r.o1,
    })
  }
  return out
}

async function readLineRuns(windows: Array<{ key: string; vehicleId: string; start: Date; end: Date }>): Promise<Map<string, LineRun>> {
  const runs = new Map<string, LineRun>()
  if (!windows.length) return runs
  const rows = await prisma.$queryRaw<Array<{ k: string; samples: bigint; meter_h: number | null; on_s: number | null; first_work: Date | null }>>`
    WITH w AS (
      SELECT * FROM unnest(${windows.map(w => w.key)}::text[], ${windows.map(w => w.vehicleId)}::text[],
                           ${windows.map(w => w.start)}::timestamptz[], ${windows.map(w => w.end)}::timestamptz[]) AS w(k, vid, st, en))
    SELECT w.k,
           r.samples, r.meter_h, r.on_s,
           (SELECT min(t.captured_at) FROM vehicle_telemetries t
             WHERE t.vehicle_id = w.vid AND t.captured_at >= w.st - interval '1 hour' AND t.captured_at < w.en
               AND (coalesce(t.speed_kmh, 0) > 0 OR (t.engine_on AND t.ignition_known))) AS first_work
      FROM w
      CROSS JOIN LATERAL (
        SELECT count(*) AS samples,
               (max(g.engine_hours_meter) - min(g.engine_hours_meter))::float8 AS meter_h,
               coalesce(sum(least(g.gap, 900)) FILTER (WHERE g.engine_on AND g.gap > 0), 0)::float8 AS on_s
          FROM (SELECT t.engine_hours_meter, t.engine_on,
                       EXTRACT(EPOCH FROM (t.captured_at - lag(t.captured_at) OVER (ORDER BY t.captured_at))) AS gap
                  FROM vehicle_telemetries t
                 WHERE t.vehicle_id = w.vid AND t.captured_at >= w.st AND t.captured_at < w.en) g) r`
  for (const r of rows) {
    runs.set(r.k, {
      samples: Number(r.samples),
      hours: r.meter_h != null ? r.meter_h : r.on_s != null ? r.on_s / 3600 : null,
      firstWorkAt: r.first_work,
    })
  }
  return runs
}
