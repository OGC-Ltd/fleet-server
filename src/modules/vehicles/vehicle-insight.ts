/**
 * A unit's insight: what about this machine deserves the operator's attention,
 * why, and what to do about it. Shown on the sidebar AI card the moment a unit
 * is picked on the map.
 *
 * Operator, 2026-10-20: "make it smart by giving it memory and access to data
 * … a workflow that will make sure that we get a productive insight that is
 * thoughtful and easy to derive insight from", and "it should run on the
 * background and when a unit is clicked it should be instantaneous".
 *
 * ## The workflow
 *
 *   1. GATHER   one batched read per organisation (collectSignals): fourteen
 *               days of the unit's fuel cases and what people decided about
 *               them, parked falls, fillings, measured burn against the
 *               FactorySuite register, speeding against the fortnight before,
 *               open sensor faults and repairs, and its running against its
 *               own usual day (fuel_daily_trends).
 *   2. COMPARE  deterministic findings from those signals (deriveFindings),
 *               each with the ids of the records behind it. These are also the
 *               facts-only insight when there is no model.
 *   3. REMEMBER the unit's last few insights (this table is the memory), with
 *               what has since become of everything they flagged — a case
 *               reviewed, a repair closed, a fault recovered (recall).
 *   4. WRITE    the model ranks and connects the findings, uses the memory,
 *               and writes a headline, the findings that matter and one
 *               action. Every number it writes must be one it was given
 *               (insightRejectionReason), or the facts-only insight stands.
 *   5. SERVE    a click reads the newest stored row: no model on the click.
 *
 * ## Why in the background, and what it costs
 *
 * The model is never on the request path. The sweep (startVehicleInsightSweep)
 * re-reads every organisation's signals every ten minutes and rewrites a unit
 * only when its signals have CHANGED (signalsHash over the findings, not the
 * raw numbers, so a unit idling a little longer does not buy a completion) or
 * its insight is old. Model calls per sweep are capped, units someone has
 * clicked go first, and a unit with nothing to say is written from facts
 * without asking the model at all.
 */

import { createHash } from 'node:crypto'
import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { fleetDayKey } from '../../lib/provider-time.js'
import { GRAMMAR_RULES, tidyProse } from '../../lib/prose-grammar.js'

// ── tuning ──────────────────────────────────────────────────────────────────

const SWEEP_MS = 10 * 60_000
/** A unit whose signals have not changed is still rewritten this often, so the
 *  memory's "since then" stays current. */
const REWRITE_AFTER_MS = 6 * 3_600_000
/** Model calls per sweep, all organisations together. */
const MODEL_CALLS_PER_SWEEP = 120
const MODEL_CONCURRENCY = 4
/** Insights kept per unit — the memory. */
const KEEP_PER_VEHICLE = 20
const WINDOW_DAYS = 14
const MEMORY_DEPTH = 3
/** Units picked on the map in this window are swept first. */
const ASKED_WINDOW_MS = 60 * 60_000

const DAY_MS = 86_400_000
const ANNOUNCED_CAUSES = ['UNEXPLAINED_BURN', 'SIPHON']

// ── shapes ──────────────────────────────────────────────────────────────────

export interface Ref { kind: 'fuel_case' | 'parked_fall' | 'repair' | 'fault'; id: string }

export interface VehicleSignals {
  plate: string
  type: string | null
  /** Measured running against the unit's own usual day (finished days only). */
  activity: {
    yesterdayHours: number | null
    usualHours: number | null
    yesterdayKm: number | null
    usualKm: number | null
    workedDays: number
    /** Finished days with a fuel_daily_trends row: how much of the window we
     *  can see. Units without a fuel probe have none. */
    knownDays: number
  }
  fuel: {
    fillings: number
    filledL: number
    openCases: { id: string; at: string; litres: number; cause: string }[]
    confirmedTheft: number
    probeFault: number
    notTheft: number
    parkedFallsLost: number
    parkedFallsL: number
    /** Measured burn (litres the tank lost on working days) over modelled burn. */
    measuredL: number | null
    expectedL: number | null
  }
  burn: { measuredLph: number | null; ratedLph: number | null }
  speeding: { count: number; before: number; maxOverKmh: number | null }
  faults: { open: { id: string; kind: string; since: string }[]; count: number }
  repairs: { open: { id: string; kind: string; stage: string; since: string; overdue: boolean }[] }
}

export interface Finding {
  kind: string
  /** 3 = act now, 2 = look today, 1 = worth knowing. */
  weight: 1 | 2 | 3
  text: string
  refs: Ref[]
}

export interface VehicleInsightView {
  vehicleId: string
  generatedAt: string
  source: 'model' | 'facts'
  headline: string
  findings: { kind: string; text: string }[]
  action: string | null
  risk: 'low' | 'medium' | 'high'
}

// ── 1. gather ───────────────────────────────────────────────────────────────

const round1 = (n: number) => Math.round(n * 10) / 10
const litres = (ml: number | bigint | null | undefined) => (ml == null ? 0 : Math.round(Number(ml) / 1000))
const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const dateLabel = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short' })
const day = (d: Date) => dateLabel.format(d)

/**
 * Every active unit's signals in one organisation (or just `onlyVehicleId`).
 * Ten grouped reads, each on an indexed (vehicle|organisation, time) range.
 */
export async function collectSignals(orgId: string, onlyVehicleId?: string): Promise<Map<string, VehicleSignals>> {
  const today = fleetDayKey()
  const from = new Date(today.getTime() - WINDOW_DAYS * DAY_MS)
  const before = new Date(from.getTime() - WINDOW_DAYS * DAY_MS)
  const one = onlyVehicleId ?? null

  const vehicles = await prisma.vehicle.findMany({
    where: { organisationId: orgId, isActive: true, ...(one && { id: one }) },
    select: {
      id: true, registrationPlate: true, name: true, vehicleType: true, equipmentType: true,
      ratedConsumption: true, ratedConsumptionBasis: true, fuelRate: { select: { lPerHour: true } },
    },
  })
  if (!vehicles.length) return new Map()

  const [trends, cases, falls, fills, speeding, faults, repairs] = await Promise.all([
    prisma.$queryRaw<Array<{ vehicle_id: string; day: Date; engine_seconds: number | null; distance_m: number | null; consumed_ml: number | null; engine_burn_ml: number | null }>>`
      SELECT t.vehicle_id, t.day, t.engine_seconds, t.distance_m, t.consumed_ml, t.engine_burn_ml
        FROM fuel_daily_trends t JOIN vehicles v ON v.id = t.vehicle_id
       WHERE v.organisation_id = ${orgId} AND (${one}::text IS NULL OR v.id = ${one})
         AND t.day >= ${from} AND t.day < ${today}`,
    prisma.$queryRaw<Array<{ id: string; vehicle_id: string; began_at: Date; stolen_ml: number; drain_cause: string | null; review_status: string | null; dismissed_at: Date | null }>>`
      SELECT f.id, f.vehicle_id, f.began_at, f.stolen_ml, f.drain_cause::text, f.review_status::text, f.dismissed_at
        FROM fuel_thefts f JOIN vehicles v ON v.id = f.vehicle_id
       WHERE v.organisation_id = ${orgId} AND (${one}::text IS NULL OR v.id = ${one})
         AND f.began_at >= ${from} AND f.drain_cause::text = ANY(${ANNOUNCED_CAUSES})`,
    prisma.$queryRaw<Array<{ vehicle_id: string; lost: bigint; lost_ml: bigint }>>`
      SELECT vehicle_id, count(*)::bigint AS lost, coalesce(sum(dropped_ml), 0)::bigint AS lost_ml
        FROM parked_fuel_falls
       WHERE organisation_id = ${orgId} AND (${one}::text IS NULL OR vehicle_id = ${one})
         AND settled_at >= ${from} AND verdict::text IN ('CONFIRMED', 'UNRESOLVED')
       GROUP BY 1`,
    prisma.$queryRaw<Array<{ vehicle_id: string; n: bigint; ml: bigint }>>`
      SELECT f.vehicle_id, count(*)::bigint AS n, coalesce(sum(f.filled_ml), 0)::bigint AS ml
        FROM fuel_fillings f JOIN vehicles v ON v.id = f.vehicle_id
       WHERE v.organisation_id = ${orgId} AND (${one}::text IS NULL OR v.id = ${one})
         AND f.filled_at >= ${from} AND f.verdict::text <> 'SENSOR_FAULT'
       GROUP BY 1`,
    prisma.$queryRaw<Array<{ vehicle_id: string; now_n: bigint; before_n: bigint; max_over: number | null }>>`
      SELECT vehicle_id,
             count(*) FILTER (WHERE started_at >= ${from})::bigint AS now_n,
             count(*) FILTER (WHERE started_at <  ${from})::bigint AS before_n,
             max(over_by_kmh) FILTER (WHERE started_at >= ${from}) AS max_over
        FROM speeding_incidents
       WHERE organisation_id = ${orgId} AND (${one}::text IS NULL OR vehicle_id = ${one})
         AND started_at >= ${before}
       GROUP BY 1`,
    prisma.$queryRaw<Array<{ id: string; vehicle_id: string; kind: string; started_at: Date; recovered_at: Date | null }>>`
      SELECT id, vehicle_id, kind, started_at, recovered_at
        FROM sensor_fault_episodes
       WHERE organisation_id = ${orgId} AND (${one}::text IS NULL OR vehicle_id = ${one})
         AND (started_at >= ${from} OR recovered_at IS NULL)`,
    prisma.$queryRaw<Array<{ id: string; vehicle_id: string; target_kind: string; fault_kind: string | null; stage: string; created_at: Date; expected_resolution_at: Date | null }>>`
      SELECT id, vehicle_id, target_kind, fault_kind, stage, created_at, expected_resolution_at
        FROM repair_report_items
       WHERE organisation_id = ${orgId} AND (${one}::text IS NULL OR vehicle_id = ${one})
         AND resolved_at IS NULL`,
  ])

  const by = <T extends { vehicle_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>()
    for (const r of rows) (m.get(r.vehicle_id) ?? m.set(r.vehicle_id, []).get(r.vehicle_id)!).push(r)
    return m
  }
  const trendsBy = by(trends), casesBy = by(cases), faultsBy = by(faults), repairsBy = by(repairs)
  const fallsBy = new Map(falls.map(r => [r.vehicle_id, r]))
  const fillsBy = new Map(fills.map(r => [r.vehicle_id, r]))
  const speedBy = new Map(speeding.map(r => [r.vehicle_id, r]))
  const yesterday = new Date(today.getTime() - DAY_MS).getTime()

  const out = new Map<string, VehicleSignals>()
  for (const v of vehicles) {
    const t = trendsBy.get(v.id) ?? []
    // A worked day is one the engine ran. The usual is over worked days only,
    // so a machine that rests on Sundays is not "half its usual" every week.
    const worked = t.filter(r => (r.engine_seconds ?? 0) > 600)
    const y = t.find(r => r.day.getTime() === yesterday)
    const prior = worked.filter(r => r.day.getTime() !== yesterday)
    const usualH = median(prior.map(r => (r.engine_seconds ?? 0) / 3600))
    const usualKm = median(prior.map(r => (r.distance_m ?? 0) / 1000))
    const measured = worked.filter(r => r.consumed_ml != null && r.engine_burn_ml != null)

    const c = casesBy.get(v.id) ?? []
    const openCases = c.filter(r => r.review_status == null && r.dismissed_at == null)
    const rated = v.ratedConsumptionBasis === 'HOURS' ? v.ratedConsumption : null
    const sp = speedBy.get(v.id)
    const f = faultsBy.get(v.id) ?? []

    out.set(v.id, {
      plate: v.registrationPlate || v.name,
      type: v.equipmentType ?? v.vehicleType ?? null,
      activity: {
        yesterdayHours: y?.engine_seconds != null ? round1(y.engine_seconds / 3600) : null,
        usualHours: usualH != null ? round1(usualH) : null,
        yesterdayKm: y?.distance_m != null ? round1(y.distance_m / 1000) : null,
        usualKm: usualKm != null ? round1(usualKm) : null,
        workedDays: worked.length,
        knownDays: t.filter(r => r.engine_seconds != null).length,
      },
      fuel: {
        fillings: Number(fillsBy.get(v.id)?.n ?? 0),
        filledL: litres(fillsBy.get(v.id)?.ml),
        openCases: openCases
          .sort((a, b) => b.began_at.getTime() - a.began_at.getTime())
          .map(r => ({ id: r.id, at: day(r.began_at), litres: litres(r.stolen_ml), cause: r.drain_cause ?? '' })),
        confirmedTheft: c.filter(r => r.review_status === 'CONFIRMED_THEFT').length,
        probeFault: c.filter(r => r.review_status === 'PROBE_FAULT').length,
        notTheft: c.filter(r => r.review_status === 'NOT_THEFT').length,
        parkedFallsLost: Number(fallsBy.get(v.id)?.lost ?? 0),
        parkedFallsL: litres(fallsBy.get(v.id)?.lost_ml),
        measuredL: measured.length >= 3 ? litres(measured.reduce((s, r) => s + (r.consumed_ml ?? 0), 0)) : null,
        expectedL: measured.length >= 3 ? litres(measured.reduce((s, r) => s + (r.engine_burn_ml ?? 0), 0)) : null,
      },
      burn: {
        measuredLph: v.fuelRate?.lPerHour != null ? round1(v.fuelRate.lPerHour) : null,
        ratedLph: rated != null ? round1(rated) : null,
      },
      speeding: {
        count: Number(sp?.now_n ?? 0),
        before: Number(sp?.before_n ?? 0),
        maxOverKmh: sp?.max_over != null ? Math.round(sp.max_over) : null,
      },
      faults: {
        open: f.filter(r => r.recovered_at == null).map(r => ({ id: r.id, kind: r.kind, since: day(r.started_at) })),
        count: f.filter(r => r.started_at >= from).length,
      },
      repairs: {
        open: (repairsBy.get(v.id) ?? []).map(r => ({
          id: r.id,
          kind: r.fault_kind ?? r.target_kind,
          stage: r.stage,
          since: day(r.created_at),
          overdue: r.expected_resolution_at != null && r.expected_resolution_at < today,
        })),
      },
    })
  }
  return out
}

// ── 2. compare ──────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const humanKind = (k: string) => k.toLowerCase().replace(/_/g, ' ')

/** What the signals say, most pressing first. Deterministic: the facts-only
 *  insight is built from these, and the model is given them to work from. */
export function deriveFindings(s: VehicleSignals): Finding[] {
  const out: Finding[] = []

  const open = s.fuel.openCases
  if (open.length) {
    const siphon = open.some(c => c.cause === 'SIPHON')
    const total = open.reduce((n, c) => n + c.litres, 0)
    out.push({
      kind: 'fuel_cases_open', weight: siphon ? 3 : 2,
      text: `${plural(open.length, 'fuel alert')} not yet reviewed, ${total} L in all, the latest on ${open[0].at}${siphon ? ', with the engine off (possible theft)' : ''}.`,
      refs: open.map(c => ({ kind: 'fuel_case', id: c.id })),
    })
  }
  if (s.fuel.confirmedTheft) {
    out.push({ kind: 'theft_confirmed', weight: 3, text: `${plural(s.fuel.confirmedTheft, 'confirmed theft')} in the last ${WINDOW_DAYS} days.`, refs: [] })
  }
  if (s.fuel.parkedFallsLost) {
    out.push({
      kind: 'parked_falls', weight: s.fuel.parkedFallsLost >= 2 ? 3 : 2,
      text: `Fuel fell while it stood parked ${plural(s.fuel.parkedFallsLost, 'time')} in ${WINDOW_DAYS} days and did not come back, ${s.fuel.parkedFallsL} L.`,
      refs: [],
    })
  }
  if (s.burn.measuredLph != null && s.burn.ratedLph != null && s.burn.ratedLph > 0) {
    const over = (s.burn.measuredLph - s.burn.ratedLph) / s.burn.ratedLph
    if (over >= 0.2) {
      out.push({
        kind: 'burn_over_rated', weight: over >= 0.5 ? 3 : 2,
        text: `Burns ${s.burn.measuredLph} L/h against a rated ${s.burn.ratedLph} L/h, ${Math.round(over * 100)}% over.`,
        refs: [],
      })
    }
  }
  if (s.fuel.measuredL != null && s.fuel.expectedL != null && s.fuel.expectedL >= 50) {
    const gap = s.fuel.measuredL - s.fuel.expectedL
    if (gap >= 0.25 * s.fuel.expectedL) {
      out.push({
        kind: 'fuel_gap', weight: 2,
        text: `The tank lost ${s.fuel.measuredL} L on its working days against ${s.fuel.expectedL} L its running explains, ${gap} L unaccounted.`,
        refs: [],
      })
    }
  }
  if (s.fuel.probeFault) {
    out.push({ kind: 'probe_faults', weight: 1, text: `${plural(s.fuel.probeFault, 'fuel alert')} in ${WINDOW_DAYS} days turned out to be the probe.`, refs: [] })
  }
  const overdue = s.repairs.open.filter(r => r.overdue)
  if (s.repairs.open.length) {
    out.push({
      kind: 'repairs_open', weight: overdue.length ? 2 : 1,
      text: `${plural(s.repairs.open.length, 'repair')} open (${s.repairs.open.map(r => `${humanKind(r.kind)}, ${humanKind(r.stage)} since ${r.since}`).join('; ')})${overdue.length ? `, ${overdue.length} past ${overdue.length === 1 ? 'its' : 'their'} expected date` : ''}.`,
      refs: s.repairs.open.map(r => ({ kind: 'repair', id: r.id })),
    })
  }
  if (s.faults.open.length) {
    out.push({
      kind: 'faults_open', weight: 2,
      text: `Sensor fault still open: ${s.faults.open.map(f => `${humanKind(f.kind)} since ${f.since}`).join('; ')}.`,
      refs: s.faults.open.map(f => ({ kind: 'fault', id: f.id })),
    })
  }
  if (s.speeding.count >= 3 && s.speeding.count >= 2 * Math.max(1, s.speeding.before)) {
    out.push({
      kind: 'speeding_up', weight: 2,
      text: `Overspeeding ${plural(s.speeding.count, 'time')} in ${WINDOW_DAYS} days against ${s.speeding.before} the fortnight before${s.speeding.maxOverKmh != null ? `, up to ${s.speeding.maxOverKmh} km/h over` : ''}.`,
      refs: [],
    })
  } else if (s.speeding.count >= 5) {
    out.push({ kind: 'speeding', weight: 1, text: `Overspeeding ${plural(s.speeding.count, 'time')} in ${WINDOW_DAYS} days.`, refs: [] })
  }
  const a = s.activity
  if (a.yesterdayHours != null && a.usualHours != null && a.usualHours >= 1 && a.workedDays >= 4) {
    if (a.yesterdayHours < 0.5 * a.usualHours) {
      out.push({ kind: 'ran_less', weight: 1, text: `Ran ${a.yesterdayHours} h yesterday against a usual ${a.usualHours} h.`, refs: [] })
    } else if (a.yesterdayHours > 1.6 * a.usualHours) {
      out.push({ kind: 'ran_more', weight: 1, text: `Ran ${a.yesterdayHours} h yesterday against a usual ${a.usualHours} h.`, refs: [] })
    }
  } else if (a.workedDays === 0 && a.knownDays >= 7) {
    // Only on a week of rows: a unit without a fuel probe has no rollup rows
    // at all, and "no data" read as "idle" for 804 units on the first run.
    out.push({ kind: 'idle_fortnight', weight: 1, text: `Has not worked in the last ${WINDOW_DAYS} days.`, refs: [] })
  }

  return out.sort((x, y) => y.weight - x.weight)
}

const riskOf = (fs: Finding[]): 'low' | 'medium' | 'high' =>
  fs.some(f => f.weight === 3) ? 'high' : fs.some(f => f.weight === 2) ? 'medium' : 'low'

/** The change detector: the findings' kinds and weights, and which records sit
 *  behind them — not their numbers, which move every day. */
export function signalsHash(fs: Finding[]): string {
  const key = fs.map(f => `${f.kind}:${f.weight}:${f.refs.map(r => r.id).sort().join(',')}`).sort().join('|')
  return createHash('sha1').update(key).digest('hex').slice(0, 16)
}

const ACTION_FOR: Record<string, string> = {
  fuel_cases_open: 'Review the open fuel alerts on the Alerts page.',
  theft_confirmed: 'Follow up the confirmed theft with security.',
  parked_falls: 'Check where it parks overnight and who has access to it.',
  burn_over_rated: 'Have the engine and the fuel rate checked.',
  fuel_gap: 'Compare its fuel issues against what the tank shows.',
  repairs_open: 'Chase the open repair in Maintenance.',
  faults_open: 'Send the faulty sensor for repair.',
  speeding_up: 'Speak to the driver about speed.',
}

export function factsInsight(s: VehicleSignals, fs: Finding[]): Omit<VehicleInsightView, 'vehicleId' | 'generatedAt'> {
  const top = fs[0]
  return {
    source: 'facts',
    headline: top ? top.text : `${s.plate}: nothing needs attention in the last ${WINDOW_DAYS} days.`,
    findings: fs.slice(top ? 1 : 0, 4).map(f => ({ kind: f.kind, text: f.text })),
    action: top ? ACTION_FOR[top.kind] ?? null : null,
    risk: riskOf(fs),
  }
}

// ── 3. remember ─────────────────────────────────────────────────────────────

interface Memory { at: string; headline: string; flagged: { kind: string; text: string; since: string[] }[] }

/** The unit's last few insights, each flagged item followed up: what has
 *  become of the cases, repairs and faults behind it since. */
async function recall(vehicleId: string): Promise<Memory[]> {
  const past = await prisma.vehicleInsight.findMany({
    where: { vehicleId }, orderBy: { generatedAt: 'desc' }, take: MEMORY_DEPTH,
    select: { generatedAt: true, headline: true, findings: true },
  })
  if (!past.length) return []

  type Stored = { kind: string; text: string; refs?: Ref[] }
  const refs = past.flatMap(p => ((p.findings as unknown as Stored[]) ?? []).flatMap(f => f.refs ?? []))
  const ids = (k: Ref['kind']) => [...new Set(refs.filter(r => r.kind === k).map(r => r.id))]
  const [cases, repairs, faults] = await Promise.all([
    prisma.fuelTheft.findMany({ where: { id: { in: ids('fuel_case') } }, select: { id: true, reviewStatus: true, dismissedAt: true } }),
    prisma.repairReportItem.findMany({ where: { id: { in: ids('repair') } }, select: { id: true, stage: true, resolvedAt: true } }),
    prisma.sensorFaultEpisode.findMany({ where: { id: { in: ids('fault') } }, select: { id: true, recoveredAt: true } }),
  ])
  const now = new Map<string, string>()
  for (const c of cases) now.set(c.id, c.reviewStatus ? `fuel alert reviewed: ${humanKind(c.reviewStatus)}` : c.dismissedAt ? 'fuel alert dismissed' : 'fuel alert still not reviewed')
  for (const r of repairs) now.set(r.id, r.resolvedAt ? `repair closed ${day(r.resolvedAt)}` : `repair still ${humanKind(r.stage)}`)
  for (const f of faults) now.set(f.id, f.recoveredAt ? `sensor recovered ${day(f.recoveredAt)}` : 'sensor still faulty')

  return past.map(p => ({
    at: day(p.generatedAt),
    headline: p.headline,
    flagged: ((p.findings as unknown as Stored[]) ?? []).map(f => ({
      kind: f.kind,
      text: f.text,
      since: [...new Set((f.refs ?? []).map(r => now.get(r.id)).filter((x): x is string => !!x))],
    })),
  }))
}

// ── 4. write ────────────────────────────────────────────────────────────────

export const INSIGHT_PROMPT =
  'You are the fleet analyst for a Kenyan haulage and plantation fleet, briefing the duty operator on ONE unit. ' +
  'You receive JSON: `unit`, `findings` (measured, most pressing first, each with a `kind`), `signals` (the ' +
  'measurements behind them, over the last 14 days) and `memory` (your last insights on this unit, and what has ' +
  'since become of each item you flagged). ' +
  'Write an insight the operator can act on in ten seconds. Rank by what costs money or risks theft; connect ' +
  'findings that explain each other (for example a parked fuel fall and an open fuel alert on the same unit, or ' +
  'high burn and an open fault); and use the memory: say when something you flagged before is still not dealt ' +
  'with, or has been. Do not repeat a finding in two places. ' +
  'Return STRICT JSON: {"headline": string, "findings": [{"kind": string, "text": string}], "action": string, ' +
  '"risk": "low"|"medium"|"high"} (risk: high only for possible or confirmed theft or fuel lost while parked). headline: one sentence, at most 20 words, the single most important thing. ' +
  'findings: at most 3, each one sentence, each `kind` copied from the input findings; leave out what the headline ' +
  'already says. action: one imperative sentence naming the next step. When there are no findings, the headline ' +
  'says the unit needs no attention and findings is empty. ' +
  'CRITICAL: use ONLY numbers and dates present in the JSON, written exactly as given; never compute, estimate or ' +
  'round a new figure. Never mention a field name, a null, or something the JSON does not contain. Only a finding ' +
  'whose text says "possible theft" may be called theft. No markdown, no advice beyond the action.'

const ABSENCE = /\b(not (reported|recorded|available|known|provided)|no data|unknown|unreported|n\/?a)\b/i
const PLACEHOLDER = /\b(null|undefined|NaN)\b|\b[a-z]+[A-Z][a-z]+\b|\w {2,}\w|\w=\w/

/** Every number the input carries, as written. */
function numbersIn(x: unknown, out = new Set<string>()): Set<string> {
  if (typeof x === 'number') out.add(String(x))
  else if (typeof x === 'string') for (const m of x.match(/\d+(?:\.\d+)?/g) ?? []) out.add(m)
  else if (Array.isArray(x)) x.forEach(v => numbersIn(v, out))
  else if (x && typeof x === 'object') Object.values(x).forEach(v => numbersIn(v, out))
  return out
}

/** Why a model reply may not stand, or null. Every figure must be one it was
 *  given; every finding must be one of ours; theft only where we said so. */
export function insightRejectionReason(
  reply: { headline?: unknown; findings?: unknown; action?: unknown; risk?: unknown },
  input: unknown, findings: Finding[],
): string | null {
  if (typeof reply.headline !== 'string' || !reply.headline.trim()) return 'no headline'
  if (!Array.isArray(reply.findings)) return 'findings is not a list'
  if (reply.findings.length > 3) return 'more than 3 findings'
  if (!['low', 'medium', 'high'].includes(String(reply.risk))) return 'bad risk'
  const kinds = new Set(findings.map(f => f.kind))
  const texts = [reply.headline, typeof reply.action === 'string' ? reply.action : '']
  for (const f of reply.findings as { kind?: unknown; text?: unknown }[]) {
    if (typeof f?.text !== 'string' || !f.text.trim()) return 'empty finding'
    if (!kinds.has(String(f.kind))) return `unknown finding kind (${String(f.kind)})`
    texts.push(f.text)
  }
  const all = texts.join(' ')
  const absence = all.match(ABSENCE)
  if (absence) return `narrates an absence ("${absence[0]}")`
  const ph = all.match(PLACEHOLDER)
  if (ph) return `leaks a placeholder ("${ph[0]}")`
  const known = numbersIn(input)
  for (const n of all.match(/\d+(?:\.\d+)?/g) ?? []) {
    if (!known.has(n)) return `a figure it was not given (${n})`
  }
  if (/\btheft|stolen|steal/i.test(all) && !findings.some(f => /possible theft|confirmed theft/.test(f.text))) {
    return 'calls it theft without a theft finding'
  }
  return null
}

async function askModel(
  s: VehicleSignals, fs: Finding[], memory: Memory[],
): Promise<Omit<VehicleInsightView, 'vehicleId' | 'generatedAt'> | null> {
  if (!env.OPENAI_API_KEY) return null
  const input = {
    unit: { plate: s.plate, type: s.type },
    findings: fs.map(f => ({ kind: f.kind, text: f.text })),
    signals: s,
    memory,
  }
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: env.VEHICLE_BRIEF_MODEL,
        messages: [
          { role: 'system', content: INSIGHT_PROMPT + GRAMMAR_RULES },
          { role: 'user', content: JSON.stringify(input) },
        ],
        response_format: { type: 'json_object' },
        ...(env.VEHICLE_BRIEF_MODEL.startsWith('gpt-5') && { reasoning_effort: env.VEHICLE_BRIEF_EFFORT }),
      }),
      signal: AbortSignal.timeout(45_000),
    })
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body = await res.json() as { choices?: { message?: { content?: string } }[] }
    const reply = JSON.parse(body.choices?.[0]?.message?.content ?? '{}')
    const why = insightRejectionReason(reply, input, fs)
    if (why) {
      logger.warn({ plate: s.plate, reason: why, reply }, 'Vehicle insight: model reply rejected — the facts insight stands')
      return null
    }
    return {
      source: 'model',
      headline: tidyProse(reply.headline),
      findings: (reply.findings as { kind: string; text: string }[]).map(f => ({ kind: f.kind, text: tidyProse(f.text) })),
      action: typeof reply.action === 'string' && reply.action.trim() ? tidyProse(reply.action) : null,
      // Ours, not the model's: on the first run it called a unit that had
      // merely not worked "medium" and anything with an open alert "high".
      risk: riskOf(fs),
    }
  } catch (err) {
    logger.warn({ err, plate: s.plate }, 'Vehicle insight: model failed — the facts insight stands')
    return null
  }
}

// ── store and serve ─────────────────────────────────────────────────────────

/** Units picked on the map recently: swept first. */
const lastAsked = new Map<string, number>()
const writing = new Set<string>()

async function write(orgId: string, vehicleId: string, s: VehicleSignals, fs: Finding[], useModel: boolean) {
  if (writing.has(vehicleId)) return
  writing.add(vehicleId)
  try {
    const memory = useModel ? await recall(vehicleId) : []
    const written = (useModel ? await askModel(s, fs, memory) : null) ?? factsInsight(s, fs)
    // The refs ride on the stored findings so the next insight can follow them up.
    const refsOf = new Map(fs.map(f => [f.kind, f.refs]))
    await prisma.vehicleInsight.create({
      data: {
        organisationId: orgId, vehicleId,
        source: written.source, model: written.source === 'model' ? env.VEHICLE_BRIEF_MODEL : null,
        headline: written.headline,
        findings: written.findings.map(f => ({ ...f, refs: refsOf.get(f.kind) ?? [] })) as object[],
        action: written.action, risk: written.risk,
        signals: s as unknown as object, signalsHash: signalsHash(fs),
      },
    })
    // Keep the memory bounded.
    const old = await prisma.vehicleInsight.findMany({
      where: { vehicleId }, orderBy: { generatedAt: 'desc' }, skip: KEEP_PER_VEHICLE, select: { id: true },
    })
    if (old.length) await prisma.vehicleInsight.deleteMany({ where: { id: { in: old.map(o => o.id) } } })
  } finally {
    writing.delete(vehicleId)
  }
}

const toView = (r: { vehicleId: string; generatedAt: Date; source: string; headline: string; findings: unknown; action: string | null; risk: string }): VehicleInsightView => ({
  vehicleId: r.vehicleId,
  generatedAt: r.generatedAt.toISOString(),
  source: r.source === 'model' ? 'model' : 'facts',
  headline: r.headline,
  findings: ((r.findings as { kind: string; text: string }[]) ?? []).map(f => ({ kind: f.kind, text: f.text })),
  action: r.action,
  risk: (['low', 'medium', 'high'].includes(r.risk) ? r.risk : 'low') as VehicleInsightView['risk'],
})

/**
 * The click. The newest stored insight, at once. A unit the sweep has not
 * reached yet is written from facts on the spot (one unit's signals, no model)
 * and its model version is asked for in the background; the card picks it up
 * on its next read.
 */
export async function getVehicleInsight(orgId: string, vehicleId: string): Promise<VehicleInsightView | null> {
  lastAsked.set(vehicleId, Date.now())
  const latest = await prisma.vehicleInsight.findFirst({ where: { vehicleId, organisationId: orgId }, orderBy: { generatedAt: 'desc' } })
  if (latest && (latest.source === 'model' || !env.OPENAI_API_KEY || Date.now() - latest.generatedAt.getTime() < SWEEP_MS)) return toView(latest)

  const signals = (await collectSignals(orgId, vehicleId)).get(vehicleId)
  if (!signals) return latest ? toView(latest) : null
  const fs = deriveFindings(signals)
  if (!latest) await write(orgId, vehicleId, signals, fs, false)
  if (fs.some(f => f.weight >= 2)) void write(orgId, vehicleId, signals, fs, true).catch(err => logger.warn({ err }, 'Vehicle insight: write failed'))
  const now = await prisma.vehicleInsight.findFirst({ where: { vehicleId }, orderBy: { generatedAt: 'desc' } })
  return now ? toView(now) : null
}

// ── the sweep ───────────────────────────────────────────────────────────────

/** One pass: every organisation's signals; rewrite what changed or aged. */
export async function sweepVehicleInsights(): Promise<{ facts: number; model: number }> {
  const orgs = await prisma.organisation.findMany({ select: { id: true } })
  const jobs: { orgId: string; vehicleId: string; s: VehicleSignals; fs: Finding[]; priority: number }[] = []
  let facts = 0

  for (const org of orgs) {
    const signals = await collectSignals(org.id)
    const latest = await prisma.$queryRaw<Array<{ vehicle_id: string; generated_at: Date; signals_hash: string; source: string }>>`
      SELECT DISTINCT ON (vehicle_id) vehicle_id, generated_at, signals_hash, source
        FROM vehicle_insights WHERE organisation_id = ${org.id}
       ORDER BY vehicle_id, generated_at DESC`
    const last = new Map(latest.map(r => [r.vehicle_id, r]))

    for (const [vehicleId, s] of signals) {
      const fs = deriveFindings(s)
      const hash = signalsHash(fs)
      const prev = last.get(vehicleId)
      const changed = !prev || prev.signals_hash !== hash
      const aged = !!prev && Date.now() - prev.generated_at.getTime() > REWRITE_AFTER_MS
      // The model only where there is something to weigh: a unit whose only
      // findings are worth-knowing (ran more or less than usual) reads as well
      // from the facts, and that is most of them.
      const wantsModel = fs.some(f => f.weight >= 2) && !!env.OPENAI_API_KEY
      if (!changed && !aged && (prev!.source === 'model' || !wantsModel)) continue
      if (!wantsModel) {
        // Nothing to say beyond the facts: written now, no model.
        if (changed) { await write(org.id, vehicleId, s, fs, false); facts++ }
        continue
      }
      const asked = Date.now() - (lastAsked.get(vehicleId) ?? 0) < ASKED_WINDOW_MS
      jobs.push({ orgId: org.id, vehicleId, s, fs, priority: (asked ? 100 : 0) + (changed ? 10 : 0) + Math.max(...fs.map(f => f.weight)) })
    }
  }

  jobs.sort((a, b) => b.priority - a.priority)
  const todo = jobs.slice(0, MODEL_CALLS_PER_SWEEP)
  let model = 0
  for (let i = 0; i < todo.length; i += MODEL_CONCURRENCY) {
    await Promise.all(todo.slice(i, i + MODEL_CONCURRENCY).map(j =>
      write(j.orgId, j.vehicleId, j.s, j.fs, true).then(() => { model++ }).catch(err => logger.warn({ err }, 'Vehicle insight: write failed'))))
  }
  return { facts, model }
}

/** Started from index.ts, beside the fleet brief's warmer. */
export function startVehicleInsightSweep(): () => void {
  if (!env.VEHICLE_INSIGHT_ENABLED) {
    logger.info('Vehicle insight sweep NOT started (VEHICLE_INSIGHT_ENABLED=false)')
    return () => {}
  }
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    const t = Date.now()
    try {
      const r = await sweepVehicleInsights()
      logger.info({ ...r, ms: Date.now() - t }, 'Vehicle insight sweep')
    } catch (err) {
      logger.warn({ err }, 'Vehicle insight sweep failed')
    } finally {
      running = false
    }
  }
  // Not at boot: the server has enough to warm in its first minute.
  const first = setTimeout(() => void tick(), 90_000)
  const timer = setInterval(() => void tick(), SWEEP_MS)
  return () => { clearTimeout(first); clearInterval(timer) }
}
