/**
 * Fuelling: plan vs actual (operator 2026-11-27, after a FactorySuite day
 * report for Mufindi, 25 Nov 2026): one day, every machine an approved work
 * plan or vehicle request asked fuel for, against what the pumps put in.
 *
 *   Planned   — every machine on an approved plan line that day whose fuel
 *               request is approved (or not yet released), and every
 *               approved fuel request no plan line asked for (Transport's
 *               buses and hired vehicles: FuelVehicleRequest). A machine on
 *               two shifts is one machine, its litres added.
 *   Litres    — the litres on the line's fuel request, as FactorySuite's own
 *               report counts them (a full tank's request carries a figure),
 *               else what the line asked for. A full tank with no figure is
 *               "Full tank": it counts in the machine totals, never in a litre
 *               total or a percentage.
 *   Fuelled   — the day's completed fuellings at the pumps, by machine.
 *   Status    — Fuelling now (a fuelling still open), Not fuelled, Short
 *               (more than 10% under), Over (more than 10% over), As planned.
 *               A full tank with no figure is As planned once it is fuelled.
 *   Site      — the line's fuelling location; a vehicle request names none,
 *               so the pump that fuelled it, else the one it was last
 *               fuelled at (FactorySuite's report put Transport's buses at
 *               Logistics Centre 1).
 *   Off plan  — machines fuelled that day that no approved plan or request
 *               named; listed apart, never in the planned totals.
 *
 * Pure: built from the Fuel page's read (factoryFuelFor), so the page and the
 * PDF tell the same figures.
 */

import type { FactoryFuel, FuelMachine } from './factory-fuel.js'
import { foldName } from './work-plan-match.js'

export const FUELLING_STATUSES = ['Fuelling now', 'Short', 'Over', 'Not fuelled', 'As planned'] as const
export type FuellingStatus = typeof FUELLING_STATUSES[number]

/** Within this share of the planned litres is As planned. */
export const AS_PLANNED_SHARE = 0.1

/** Plan statuses that have not been approved, or were withdrawn: not planned. */
const NOT_APPROVED = new Set(['', 'DRAFT', 'SUBMITTED', 'PENDING', 'REJECTED', 'CANCELLED', 'WITHDRAWN'])
const approved = (status: string | null | undefined) => !NOT_APPROVED.has(String(status ?? '').trim().toUpperCase())

export interface FuellingMachine {
  machine: string
  /** The register's category, else its name; null when the register has no such machine. */
  type: string | null
  /** Where it is fuelled (the plan line's fuelling location), else the pump that fuelled it. */
  site: string | null
  department: string | null
  /** The litres planned, or null for a full tank with no figure. */
  plannedL: number | null
  fullTank: boolean
  fuelledL: number
  /** Fuelled less planned; null with no litre figure. */
  diffL: number | null
  fuellings: number
  status: FuellingStatus
  /** On a vehicle request rather than a work plan. */
  request: boolean
}

export interface FuellingOffPlan {
  machine: string
  type: string | null
  site: string | null
  department: string | null
  fuelledL: number
  fuellings: number
}

export interface FuellingGroup {
  name: string
  planned: number
  fuelled: number
  plannedL: number
  fuelledL: number
}

export interface FuellingPlan {
  factory: string
  day: string
  /** The day is over (before today in East Africa): the figures are final. */
  closed: boolean
  machines: FuellingMachine[]
  offPlan: FuellingOffPlan[]
  /** Plan lines that day whose plan or fuel request still waits for approval, not counted. */
  pendingLines: number
  /** Plan lines whose fuel request was rejected or cancelled, not counted. */
  rejectedLines: number
  totals: {
    planned: number
    fuelled: number
    notFuelled: number
    fuellingNow: number
    short: number
    over: number
    asPlanned: number
    /** Full tanks with no figure among those not fuelled. */
    fullTankWaiting: number
    fullTanks: number
    /** Litres planned on plans with a figure. */
    plannedL: number
    /** Litres fuelled on every planned machine. */
    fuelledL: number
    /** Litres fuelled on plans with a figure: the share's top. */
    fuelledOnFiguresL: number
    /** Planned less fuelled over the Short machines. */
    shortfallL: number
    offPlanL: number
  }
  bySite: FuellingGroup[]
  byType: FuellingGroup[]
}

const round = (n: number) => Math.round(n * 100) / 100
const add = (a: number | null, b: number | null | undefined) => (b == null ? a : (a ?? 0) + b)

/** East Africa's calendar day for `now`. */
export const eatDay = (now: number) => new Date(now + 3 * 3_600_000).toISOString().slice(0, 10)

export function fuellingStatus(plannedL: number | null, fuelledL: number, open: boolean): FuellingStatus {
  if (open) return 'Fuelling now'
  if (fuelledL <= 0) return 'Not fuelled'
  if (plannedL == null) return 'As planned'
  if (plannedL <= 0) return 'Over'
  if (fuelledL < plannedL * (1 - AS_PLANNED_SHARE)) return 'Short'
  if (fuelledL > plannedL * (1 + AS_PLANNED_SHARE)) return 'Over'
  return 'As planned'
}

const typeOf = (m: FuelMachine | undefined) => m?.category?.trim() || m?.name?.trim() || null

/**
 * `usualPumps`: folded machine → the pump it was last fuelled at, for a vehicle
 * request (it names no site) the pumps have not fuelled that day.
 */
export function buildFuellingPlan(fuel: FactoryFuel, day: string, now = Date.now(), usualPumps: ReadonlyMap<string, string> = new Map()): FuellingPlan {
  const register = new Map(fuel.machines.map(m => [foldName(m.reference), m]))
  type Acc = {
    machine: string; site: string | null; department: string | null; request: boolean
    plannedL: number | null; fullTank: boolean; noFigure: boolean
  }
  const planned = new Map<string, Acc>()
  const acc = (machine: string) => {
    const k = foldName(machine)
    if (!planned.has(k)) planned.set(k, { machine, site: null, department: null, request: false, plannedL: null, fullTank: false, noFigure: false })
    return planned.get(k)!
  }
  let pendingLines = 0
  let rejectedLines = 0
  for (const l of fuel.lines) {
    if (l.day !== day) continue
    // As FactorySuite's own report: a line counts once its plan and its fuel
    // request are approved (25 Nov: CTR-03, EX-08, BH-03, MTR-06 and MTR-10 sat
    // on approved plans with pending requests and were not in it). A line whose
    // request is not released yet (17:00 the evening before) counts on its plan.
    const req = String(l.requestStatus ?? '').trim().toUpperCase()
    if (!approved(l.planStatus) || (req && !approved(req))) {
      if (/^(REJECTED|CANCELLED|WITHDRAWN)$/.test(req)) rejectedLines += 1; else pendingLines += 1
      continue
    }
    const a = acc(l.machine)
    a.site ??= l.fuelingLocation
    a.department ??= l.department
    // The request's litres first: it is what was approved (CTR-02, 25 Nov: line 100 L, request 110 L)
    const litres = l.requestLitres ?? (l.fullTank ? null : l.litresRequested)
    if (l.fullTank) a.fullTank = true
    if (litres == null) a.noFigure = true
    else a.plannedL = add(a.plannedL, litres)
  }
  for (const v of fuel.vehicleRequests ?? []) {
    if (v.day !== day || !approved(v.status)) continue
    const fresh = !planned.has(foldName(v.machine))
    const a = acc(v.machine)
    if (fresh) a.request = true
    a.department ??= v.department
    const litres = v.fullTank ? null : v.litresRequested
    if (v.fullTank) a.fullTank = true
    if (litres == null) a.noFigure = true
    else a.plannedL = add(a.plannedL, litres)
  }

  const pumped = new Map<string, { machine: string; litres: number; count: number; open: boolean; pump: string | null; department: string | null }>()
  for (const i of fuel.issues) {
    if (i.day !== day) continue
    const k = foldName(i.machine)
    const p = pumped.get(k) ?? { machine: i.machine, litres: 0, count: 0, open: false, pump: null, department: null }
    if (i.done) { p.litres += i.litres ?? 0; p.count += 1 } else p.open = true
    p.pump ??= i.pump
    p.department ??= i.department
    pumped.set(k, p)
  }

  const machines: FuellingMachine[] = [...planned.entries()].map(([k, a]) => {
    const p = pumped.get(k)
    const fuelledL = round(p?.litres ?? 0)
    // A full tank with litres on some shift and none on another: the figure stands for what is known
    const plannedL = a.plannedL == null ? null : round(a.plannedL)
    return {
      machine: a.machine,
      type: typeOf(register.get(k)),
      site: a.site ?? p?.pump ?? usualPumps.get(k) ?? null,
      department: a.department ?? p?.department ?? null,
      plannedL,
      fullTank: a.fullTank && plannedL == null,
      fuelledL,
      diffL: plannedL == null ? null : round(fuelledL - plannedL),
      fuellings: p?.count ?? 0,
      status: fuellingStatus(plannedL, fuelledL, p?.open ?? false),
      request: a.request,
    }
  })
  const rank = (s: FuellingStatus) => FUELLING_STATUSES.indexOf(s)
  machines.sort((a, b) => rank(a.status) - rank(b.status)
    || (a.status === 'Not fuelled' ? (b.plannedL ?? -1) - (a.plannedL ?? -1) : (a.diffL ?? Infinity) - (b.diffL ?? Infinity))
    || a.machine.localeCompare(b.machine, undefined, { numeric: true }))

  const offPlan: FuellingOffPlan[] = [...pumped.entries()]
    .filter(([k, p]) => !planned.has(k) && (p.count > 0 || p.open))
    .map(([k, p]) => ({ machine: p.machine, type: typeOf(register.get(k)), site: p.pump, department: p.department, fuelledL: round(p.litres), fuellings: p.count }))
    .sort((a, b) => b.fuelledL - a.fuelledL || a.machine.localeCompare(b.machine, undefined, { numeric: true }))

  const count = (s: FuellingStatus) => machines.filter(m => m.status === s).length
  const sum = (ms: FuellingMachine[], f: (m: FuellingMachine) => number) => round(ms.reduce((t, m) => t + f(m), 0))
  const withFigure = machines.filter(m => m.plannedL != null)
  const totals = {
    planned: machines.length,
    fuelled: machines.filter(m => m.fuelledL > 0).length,
    notFuelled: count('Not fuelled'),
    fuellingNow: count('Fuelling now'),
    short: count('Short'),
    over: count('Over'),
    asPlanned: count('As planned'),
    fullTankWaiting: machines.filter(m => m.status === 'Not fuelled' && m.fullTank).length,
    fullTanks: machines.filter(m => m.fullTank).length,
    plannedL: sum(withFigure, m => m.plannedL ?? 0),
    fuelledL: sum(machines, m => m.fuelledL),
    fuelledOnFiguresL: sum(withFigure, m => m.fuelledL),
    shortfallL: sum(machines.filter(m => m.status === 'Short'), m => -(m.diffL ?? 0)),
    offPlanL: round(offPlan.reduce((t, m) => t + m.fuelledL, 0)),
  }

  const groups = (keyOf: (m: FuellingMachine) => string | null, none: string) => {
    const by = new Map<string, FuellingGroup>()
    for (const m of machines) {
      const name = keyOf(m) ?? none
      const g = by.get(name) ?? { name, planned: 0, fuelled: 0, plannedL: 0, fuelledL: 0 }
      g.planned += 1
      if (m.fuelledL > 0) g.fuelled += 1
      if (m.plannedL != null) { g.plannedL = round(g.plannedL + m.plannedL); g.fuelledL = round(g.fuelledL + m.fuelledL) }
      by.set(name, g)
    }
    return [...by.values()]
  }
  // A vehicle request with no pump to go by: FactorySuite gives it no site
  const bySite = groups(m => m.site ?? (m.request ? 'Vehicle requests, no site' : null), 'No site given')
    .sort((a, b) => b.planned - a.planned || b.fuelled - a.fuelled || a.name.localeCompare(b.name))
  // Litres by type: a type whose plans give no figure has nothing to draw
  const byType = groups(m => m.type, 'Unspecified')
    .filter(g => g.plannedL > 0 || g.fuelledL > 0)
    .sort((a, b) => b.plannedL - a.plannedL || b.fuelledL - a.fuelledL || a.name.localeCompare(b.name))

  return { factory: fuel.factory, day, closed: day < eatDay(now), machines, offPlan, pendingLines, rejectedLines, totals, bySite, byType }
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-GB')

/** The report's opening sentence. */
export function fuellingLead(p: FuellingPlan): string {
  const t = p.totals
  if (!t.planned) return 'No machine was on an approved plan or vehicle request for this day.'
  const so = p.closed ? '' : ' so far'
  const one = t.planned === 1
  const verb = p.closed ? (t.fuelled === 0 && one ? 'was' : 'were') : t.fuelled === 0 && one ? 'has been' : 'have been'
  const machines = `planned machine${one ? '' : 's'}`
  const head = t.fuelled === t.planned
    ? `${one ? 'The' : `All ${fmt(t.planned)}`} ${machines} ${verb} fuelled${so}`
    : t.fuelled === 0
      ? `None of the ${fmt(t.planned)} ${machines} ${verb} fuelled${so}`
      : `${t.fuelled * 2 < t.planned ? 'Only ' : ''}${fmt(t.fuelled)} of the ${fmt(t.planned)} ${machines} ${verb} fuelled${so}`
  // Litres against litres: full tanks with no figure apart, as FactorySuite's report
  const intoFull = round(t.fuelledL - t.fuelledOnFiguresL)
  const litres = t.fuelled
    ? `, and they received ${fmt(t.fuelledOnFiguresL)} litres against ${fmt(t.plannedL)} litres planned${intoFull > 0 ? `, with ${fmt(intoFull)} more into full tanks` : ''}.`
    : `; ${fmt(t.plannedL)} litres were planned.`
  const waiting = p.bySite
    .map(g => ({ name: g.name, left: g.planned - g.fuelled }))
    .filter(g => g.left > 0 && !/no site/i.test(g.name))
    .sort((a, b) => b.left - a.left)[0]
  const tail = waiting ? ` ${waiting.name} has the most machines still ${p.closed ? 'not fuelled' : 'waiting'} (${fmt(waiting.left)}).` : ''
  return `${head}${litres}${tail}`.replace(/^./, c => c.toUpperCase())
}
