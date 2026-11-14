/**
 * FactorySuite work plans → what the map can draw (pure; no I/O).
 *
 * A work plan line names its machine by the register reference ("EX-01") and
 * its ground by an estate name ("Zone 4", "Nursery A", "Factory Site"). The
 * map needs our vehicle and our geofence for each, so both are resolved here:
 *
 *   • machine → vehicle by `equipmentReference`, which the hourly register sync
 *     writes on every KASULU vehicle the register places by its GPS id.
 *   • work location → geofence by name. The plan sheet and Wialon spell the
 *     same ground differently ("Factory Site" / "Factory site Location",
 *     "Reservoir" / "Reservoir site", "Logistics Centre 2" / "Logistic centre2"),
 *     so names are compared folded, then by prefix, then through ALIASES.
 *     A name nothing matches stays unplaced and is listed, never guessed.
 */

import type {
  RaiFactorySuiteFuelIssueRow,
  RaiFactorySuiteFuelRequestRow,
  RaiFactorySuiteMachineRow,
  RaiFactorySuiteWorkPlanLine,
  RaiFactorySuiteWorkPlanRow,
} from '../../providers/raifactorysuite/raifactorysuite.client.js'

export interface FenceRef { id: string; name: string; isActive: boolean; type: string }
export interface VehicleRef {
  id: string
  registrationPlate: string
  name: string
  equipmentReference: string | null
  tankCapacityLitres?: number | null
}

/** Lower case, letters and digits only, spelling variants folded. */
export function foldName(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/[​-‍﻿]/g, '')
    .toLowerCase()
    .replace(/centre/g, 'center')
    .replace(/logistics/g, 'logistic')
    .replace(/resevoir/g, 'reservoir')
    .replace(/[^a-z0-9]/g, '')
}

/** Folded plan-sheet name → folded fence names that are the same ground.
 *  "2500 Ha Area" is the operators' Wialon name for the drawing's ZONE 4
 *  (FleetMap ZONE_PLAN_ALIAS). */
const ALIASES: Record<string, string[]> = {
  zone4:      ['zone4', '2500haarea'],
  nurseryb:   ['nurseryb'],
  rainfed:    ['rainfedarea'],
}

const MIN_PREFIX = 6

/** The fence for a plan's work location, or null. Active polygons win over
 *  inactive ones and over corridors (a LINE is a road, not a place). */
export function fenceForLocation(location: string | null | undefined, fences: FenceRef[]): FenceRef | null {
  const full = foldName(location)
  if (!full) return null
  const bare = foldName(String(location).replace(/\([^)]*\)/g, ''))
  const rank = (f: FenceRef) => (f.isActive ? 0 : 2) + (f.type === 'LINE' ? 1 : 0)
  const best = (hits: FenceRef[]) => hits.sort((a, b) => rank(a) - rank(b) || a.name.length - b.name.length)[0] ?? null
  const folded = fences.map(f => ({ f, k: foldName(f.name) }))

  const exactKeys = [full, ...(ALIASES[full] ?? []), bare, ...(ALIASES[bare] ?? [])].filter(Boolean)
  for (const key of exactKeys) {
    const hit = best(folded.filter(x => x.k === key).map(x => x.f))
    if (hit) return hit
  }
  // "Factory Site" → "Factory site Location", "Reservoir" → "Reservoir site".
  // Only on the full name and only when long enough to mean something:
  // "Zone (424 ha)" must not become every fence that starts with "zone".
  if (full.length >= MIN_PREFIX) {
    const hit = best(folded.filter(x => x.k.startsWith(full)).map(x => x.f))
    if (hit) return hit
  }
  return null
}

/** EAT (UTC+3, no DST): a plan day plus a "06:00:00" shift start → UTC ms. */
function shiftStartMs(day: string, hhmmss: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmmss ?? '')
  if (!m) return null
  const ms = Date.parse(`${day}T${m[1]!.padStart(2, '0')}:${m[2]}:00+03:00`)
  return Number.isFinite(ms) ? ms : null
}

export interface MapWorkPlanLine {
  id: string
  taskId: string
  machine: string
  machineName: string | null
  activity: string
  workLocation: string | null
  shiftNo: number | null
  shiftStart: string | null
  /** ISO; null without a start time. The end is start + planned hours. */
  shiftFrom: string | null
  shiftTo: string | null
  plannedHours: number | null
  plannedKm: number | null
  expectedOutput: number | null
  outputUnit: string | null
  operator: string | null
  secondOperator: string | null
  thirdOperator: string | null
  supervisor: string | null
  notes: string | null
  fuelingLocation: string | null
  /** A full tank, or `litresRequested` litres. */
  fullTank: boolean | null
  litresRequested: number | null
  /** Our unit's tank, litres; null when we hold no capacity for it. */
  tankLitres: number | null
  /** What the shift should burn at the register's rate: planned km ÷ km/L,
   *  or planned hours × L/h, as FactorySuite's own row works it out. */
  needLitres: number | null
  /** The register's word for the machine ("Broken down"), and why. */
  flags: string[]
  downReason: string | null
  /** This line's fuel request and what the pump has issued against it;
   *  null when FactorySuite holds no request for it. */
  pump: LinePump | null
  vehicleId: string | null
  plate: string | null
  fenceId: string | null
}

export interface MapWorkPlan {
  id: string
  planCode: string
  department: string
  status: string
  title: string | null
  day: string
  submittedBy: string | null
  /** FactorySuite's local wall clock, offsetless ("2026-11-13T13:35:12"). */
  submittedAt: string | null
  reviewedBy: string | null
  reviewedAt: string | null
  lines: MapWorkPlanLine[]
}

export interface MapWorkPlans {
  day: string
  factory: string
  plans: MapWorkPlan[]
  /** Every work location named on the day's plans, placed or not. */
  locations: Array<{ name: string; fenceId: string | null; fenceName: string | null }>
  /** Machines on the plans with no vehicle of ours (hired trucks, no GPS). */
  unplacedMachines: string[]
}

export interface PumpIssue {
  litres: number | null
  done: boolean
  /** When it finished, or when it started while still fuelling (local wall clock). */
  at: string | null
  tank: string | null
  /** The pump it was issued at. */
  pump: string | null
  /** The pump's own checks, as words. */
  flags: string[]
  note: string | null
}
export interface LinePump {
  /** The request's status (APPROVED, ...). */
  status: string | null
  issues: PumpIssue[]
}

const ISSUE_FLAGS: Array<[keyof RaiFactorySuiteFuelIssueRow, string]> = [
  ['operatorMismatch', 'Operator mismatch'],
  ['jobMismatch', 'Job mismatch'],
  ['deviationFromPlan', 'Off plan'],
]

export function pumpIssue(i: RaiFactorySuiteFuelIssueRow): PumpIssue {
  const done = i.completed === true || (i.completed == null && (i.fuelingEnd != null || i.quantityIssued != null))
  return {
    litres: i.quantityIssued ?? null,
    done,
    at: (done ? i.fuelingEnd : i.fuelingStart) ?? null,
    tank: i.tank ?? null,
    pump: i.location ?? null,
    flags: ISSUE_FLAGS.filter(([k]) => i[k] === true).map(([, w]) => w),
    note: i.flagNotes ?? null,
  }
}

/** A request's key: FactorySuite ties a request to its line by machine, day
 *  and shift, not by the line's id. */
export const requestKey = (machine: string, day: string, shift: number | null | undefined): string =>
  `${foldName(machine)}|${day}|${shift ?? 1}`

/** The register's status as the card says it; AVAILABLE says nothing. */
const STATUS_FLAG: Record<string, string> = { BROKEN_DOWN: 'Broken down', IN_WORKSHOP: 'In the workshop', WORKSHOP: 'In the workshop' }
function statusFlag(status: string | null | undefined): string | null {
  const s = String(status ?? '').toUpperCase()
  if (!s || s === 'AVAILABLE' || s === 'ACTIVE' || s === 'OPERATIONAL') return null
  return STATUS_FLAG[s] ?? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ')
}

/** Planned km ÷ km/L, or planned hours × L/h, in whole litres. */
export function needLitres(
  line: Pick<RaiFactorySuiteWorkPlanLine, 'plannedKm' | 'plannedHours'>,
  machine: Pick<RaiFactorySuiteMachineRow, 'consumptionBasis' | 'expectedConsumption'> | null | undefined,
): number | null {
  const rate = machine?.expectedConsumption
  if (!rate || rate <= 0) return null
  if (machine?.consumptionBasis === 'KM_PER_LITRE') return line.plannedKm ? Math.round(line.plannedKm / rate) : null
  if (machine?.consumptionBasis === 'HOUR') return line.plannedHours ? Math.round(line.plannedHours * rate) : null
  return null
}

export interface WorkPlanExtras {
  /** The machine register, for the rated use and the breakdown flag. */
  machines?: RaiFactorySuiteMachineRow[]
  /** The day's fuel requests, and the pump's issues against them. */
  requests?: RaiFactorySuiteFuelRequestRow[]
  issues?: RaiFactorySuiteFuelIssueRow[]
}

export function buildMapWorkPlans(
  day: string,
  factory: string,
  rows: RaiFactorySuiteWorkPlanRow[],
  vehicles: VehicleRef[],
  fences: FenceRef[],
  extras: WorkPlanExtras = {},
): MapWorkPlans {
  const machineByRef = new Map<string, RaiFactorySuiteMachineRow>()
  for (const m of extras.machines ?? []) if (m.reference) machineByRef.set(foldName(m.reference), m)
  const requestFor = new Map<string, RaiFactorySuiteFuelRequestRow>()
  for (const r of extras.requests ?? []) requestFor.set(requestKey(r.machine, r.planDate, r.shift), r)
  const issuesOf = new Map<string, RaiFactorySuiteFuelIssueRow[]>()
  for (const i of extras.issues ?? []) {
    if (!i.requestId) continue
    const list = issuesOf.get(i.requestId) ?? []
    list.push(i)
    issuesOf.set(i.requestId, list)
  }
  const byRef = new Map<string, VehicleRef>()
  for (const v of vehicles) if (v.equipmentReference) byRef.set(foldName(v.equipmentReference), v)
  const fenceOf = new Map<string, FenceRef | null>()
  const placeFor = (loc: string | null | undefined) => {
    const key = foldName(loc)
    if (!fenceOf.has(key)) fenceOf.set(key, fenceForLocation(loc, fences))
    return fenceOf.get(key) ?? null
  }

  const unplaced = new Set<string>()
  const locations = new Map<string, { name: string; fenceId: string | null; fenceName: string | null }>()

  const plans = rows
    .filter(p => p.startDate <= day && p.endDate >= day)
    .map((p): MapWorkPlan => ({
      id: p.id,
      planCode: p.planCode,
      department: p.department,
      status: p.status,
      title: p.title ?? null,
      day,
      submittedBy: p.submittedBy ?? null,
      submittedAt: p.submittedAt ?? null,
      reviewedBy: p.reviewedBy ?? null,
      reviewedAt: p.reviewedAt ?? null,
      lines: (p.lines ?? []).filter((l: RaiFactorySuiteWorkPlanLine) => l.active !== false).map((l): MapWorkPlanLine => {
        const v = byRef.get(foldName(l.machine)) ?? null
        if (!v) unplaced.add(l.machine)
        const f = placeFor(l.workLocation)
        if (l.workLocation && !locations.has(l.workLocation)) {
          locations.set(l.workLocation, { name: l.workLocation, fenceId: f?.id ?? null, fenceName: f?.name ?? null })
        }
        const from = shiftStartMs(day, l.shiftStart)
        const to = from != null && l.plannedHours != null ? from + l.plannedHours * 3_600_000 : null
        const m = machineByRef.get(foldName(l.machine)) ?? null
        const flag = statusFlag(m?.status)
        const request = requestFor.get(requestKey(l.machine, day, l.shiftNo)) ?? null
        return {
          id: l.id,
          taskId: l.taskId,
          machine: l.machine,
          machineName: l.machineName ?? null,
          activity: l.activity,
          workLocation: l.workLocation ?? null,
          shiftNo: l.shiftNo ?? null,
          shiftStart: l.shiftStart ?? null,
          shiftFrom: from != null ? new Date(from).toISOString() : null,
          shiftTo: to != null ? new Date(to).toISOString() : null,
          plannedHours: l.plannedHours ?? null,
          plannedKm: l.plannedKm ?? null,
          expectedOutput: l.expectedOutput ?? null,
          outputUnit: l.outputUnit ?? l.unit ?? null,
          operator: l.operator ?? null,
          secondOperator: l.secondOperator ?? null,
          thirdOperator: l.thirdOperator ?? null,
          supervisor: l.supervisor ?? null,
          notes: l.notes ?? null,
          fuelingLocation: l.fuelingLocation ?? null,
          fullTank: l.fullTank ?? null,
          litresRequested: l.litresRequested ?? null,
          tankLitres: v?.tankCapacityLitres ?? null,
          needLitres: needLitres(l, m),
          flags: flag ? [flag] : [],
          downReason: flag ? m?.downReason ?? null : null,
          pump: request ? { status: request.status ?? null, issues: (issuesOf.get(request.id) ?? []).map(pumpIssue) } : null,
          vehicleId: v?.id ?? null,
          plate: v?.registrationPlate ?? null,
          fenceId: f?.id ?? null,
        }
      }),
    }))
    .sort((a, b) => a.department.localeCompare(b.department) || a.planCode.localeCompare(b.planCode))

  return {
    day,
    factory,
    plans,
    locations: [...locations.values()].sort((a, b) => a.name.localeCompare(b.name)),
    unplacedMachines: [...unplaced].sort(),
  }
}
