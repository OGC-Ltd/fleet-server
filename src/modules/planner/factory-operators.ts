/**
 * The Drivers page's Operators tab (operator 2026-11-19): FactorySuite's
 * machine operators for a range of days, read off the work plans. A plan line
 * puts up to three operators on a machine for a shift ("Operators: EMMANUEL
 * VICENT MTULO - EXCAVATOR OPERATOR"), and the pump records the operator it
 * fuelled. FactorySuite's own operator register (/fuel/operators) is not open
 * to our API key, so the plans are the roster: an operator is listed once
 * they are on a plan line or a fuelling in the range.
 *
 * Pure, built from the Fuel page's FactoryFuel so both share one read of
 * FactorySuite (work-plans.service factoryOperatorsFor).
 */

import type { FactoryFuel, FuelIssue, FuelMachine, FuelPlanLine } from './factory-fuel.js'

/** One shift an operator is planned on. */
export interface OperatorShift {
  lineId: string
  day: string
  machine: string
  machineName: string | null
  plate: string | null
  activity: string
  department: string
  workLocation: string | null
  shiftNo: number | null
  shiftStart: string | null
  plannedHours: number | null
  plannedKm: number | null
  planCode: string
  planStatus: string
  supervisor: string | null
  /** 1 for the line's operator, 2 and 3 for the second and third. */
  seat: number
}

export interface OperatorMachine {
  reference: string
  name: string | null
  plate: string | null
  vehicleId: string | null
  shifts: number
}

export interface FactoryOperator {
  /** The folded name: the row's identity across plans and the pump. */
  key: string
  name: string
  /** What the plan wrote after the name ("EXCAVATOR OPERATOR"), the most used. */
  role: string | null
  shifts: number
  days: number
  firstDay: string | null
  lastDay: string | null
  plannedHours: number
  plannedKm: number
  departments: string[]
  supervisors: string[]
  machines: OperatorMachine[]
  lines: OperatorShift[]
  fuellings: FuelIssue[]
  /** Fuellings the pump flagged as the wrong operator for the machine. */
  mismatches: number
}

export interface FactoryOperators {
  factory: string
  from: string
  to: string
  operators: FactoryOperator[]
}

/** "EMMANUEL VICENT MTULO - EXCAVATOR OPERATOR" → name and role. */
export function splitOperator(raw: string | null | undefined): { name: string; role: string | null } | null {
  const s = String(raw ?? '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim()
  if (!s || /^(n\/?a|none|-+)$/i.test(s)) return null
  const at = s.search(/\s[-–]\s/)
  if (at < 0) return { name: s, role: null }
  const name = s.slice(0, at).trim()
  const role = s.slice(at + 3).trim() || null
  return name ? { name, role } : { name: role ?? s, role: null }
}

export const operatorKey = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

const top = (counts: Map<string, number>): string | null =>
  [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null

export function buildFactoryOperators(fuel: FactoryFuel): FactoryOperators {
  const machineByRef = new Map<string, FuelMachine>()
  for (const m of fuel.machines) machineByRef.set(m.reference.toLowerCase(), m)

  type Acc = { names: Map<string, number>; roles: Map<string, number>; lines: OperatorShift[]; fuellings: FuelIssue[] }
  const byKey = new Map<string, Acc>()
  const acc = (name: string): Acc => {
    const key = operatorKey(name)
    let a = byKey.get(key)
    if (!a) byKey.set(key, a = { names: new Map(), roles: new Map(), lines: [], fuellings: [] })
    a.names.set(name, (a.names.get(name) ?? 0) + 1)
    return a
  }

  for (const l of fuel.lines as FuelPlanLine[]) {
    const seen = new Set<string>()
    ;(l.operators ?? (l.operator ? [l.operator] : [])).forEach((raw, i) => {
      const who = splitOperator(raw)
      if (!who || seen.has(operatorKey(who.name))) return
      seen.add(operatorKey(who.name))
      const a = acc(who.name)
      if (who.role) a.roles.set(who.role, (a.roles.get(who.role) ?? 0) + 1)
      const m = machineByRef.get(l.machine.toLowerCase())
      a.lines.push({
        lineId: l.lineId, day: l.day, machine: l.machine, machineName: m?.name ?? null, plate: m?.plate ?? null,
        activity: l.activity, department: l.department, workLocation: l.workLocation,
        shiftNo: l.shiftNo, shiftStart: l.shiftStart, plannedHours: l.plannedHours, plannedKm: l.plannedKm,
        planCode: l.planCode, planStatus: l.planStatus, supervisor: l.supervisor ?? null, seat: i + 1,
      })
    })
  }
  for (const f of fuel.issues) {
    const who = splitOperator(f.operator)
    if (!who) continue
    const a = acc(who.name)
    if (who.role) a.roles.set(who.role, (a.roles.get(who.role) ?? 0) + 1)
    a.fuellings.push(f)
  }

  const operators: FactoryOperator[] = [...byKey.entries()].map(([key, a]) => {
    const lines = a.lines.sort((x, y) => y.day.localeCompare(x.day) || (x.shiftNo ?? 1) - (y.shiftNo ?? 1) || x.machine.localeCompare(y.machine, undefined, { numeric: true }))
    const days = [...new Set([...lines.map(l => l.day), ...a.fuellings.map(f => f.day)])].sort()
    const perMachine = new Map<string, number>()
    for (const l of lines) perMachine.set(l.machine, (perMachine.get(l.machine) ?? 0) + 1)
    for (const f of a.fuellings) if (!perMachine.has(f.machine)) perMachine.set(f.machine, 0)
    const machines = [...perMachine.entries()].map(([reference, shifts]) => {
      const m = machineByRef.get(reference.toLowerCase())
      return { reference, name: m?.name ?? null, plate: m?.plate ?? null, vehicleId: m?.vehicleId ?? null, shifts }
    }).sort((x, y) => y.shifts - x.shifts || x.reference.localeCompare(y.reference, undefined, { numeric: true }))
    const uniq = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => !!x))].sort()
    return {
      key,
      name: top(a.names) ?? key,
      role: top(a.roles),
      shifts: lines.length,
      days: days.length,
      firstDay: days[0] ?? null,
      lastDay: days[days.length - 1] ?? null,
      plannedHours: lines.reduce((s, l) => s + (l.plannedHours ?? 0), 0),
      plannedKm: lines.reduce((s, l) => s + (l.plannedKm ?? 0), 0),
      departments: uniq([...lines.map(l => l.department), ...a.fuellings.map(f => f.department)]),
      supervisors: uniq(lines.map(l => l.supervisor)),
      machines,
      lines,
      fuellings: a.fuellings,
      mismatches: a.fuellings.filter(f => f.flags?.includes('Operator mismatch')).length,
    }
  }).sort((x, y) => y.shifts - x.shifts || x.name.localeCompare(y.name))

  return { factory: fuel.factory, from: fuel.from, to: fuel.to, operators }
}
