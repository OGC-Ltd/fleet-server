/**
 * The Fuel page's rows (operator 2026-11-14): FactorySuite's fuel module for
 * a range of days — every machine-shift its work plans asked fuel for, the
 * request each became, and every fuelling at the pump — joined to the machine
 * register and to our units. Pure, so it is tested without FactorySuite; the
 * page adds the rows up per machine and per day itself.
 *
 * FactorySuite ties a request to its plan line by machine, day and shift
 * (requestKey), and an issue to its request by `requestId`. An issue whose
 * request is not on any plan line in the range is kept: the pump fuelled the
 * machine, and the page lists it with the machine all the same.
 */

import type {
  RaiFactorySuiteFuelIssueRow,
  RaiFactorySuiteFuelRequestRow,
  RaiFactorySuiteMachineRow,
  RaiFactorySuiteWorkPlanRow,
} from '../../providers/raifactorysuite/raifactorysuite.client.js'
import { foldName, needLitres, pumpIssue, requestKey, type PumpIssue } from './work-plan-match.js'

export interface FuelUnitRef {
  id: string
  registrationPlate: string | null
  equipmentReference: string | null
  tankCapacityLitres?: number | null
}

/** One machine-shift on a plan, with what it asked for and what it got. */
export interface FuelPlanLine {
  lineId: string
  taskId: string
  planId: string
  planCode: string
  planStatus: string
  department: string
  day: string
  machine: string
  activity: string
  workLocation: string | null
  fuelingLocation: string | null
  operator: string | null
  /** Every operator on the line, first seat first (operator, second, third). */
  operators: string[]
  supervisor: string | null
  shiftNo: number | null
  shiftStart: string | null
  plannedHours: number | null
  plannedKm: number | null
  fullTank: boolean
  litresRequested: number | null
  needLitres: number | null
  /** The fuel request's status, or null while the line has none. */
  requestStatus: string | null
  requestId: string | null
  /**
   * Litres on the fuel request. A full-tank line carries none, but its request
   * does (EX-17, 19 Nov: 650 L; 63 of 66 full-tank requests that day), so
   * this is the planned figure for a full tank.
   */
  requestLitres: number | null
  /** Litres the pump issued against this line's request. */
  issuedLitres: number
}

export interface FuelIssue extends PumpIssue {
  id: string
  machine: string
  day: string
  department: string | null
  operator: string | null
  activity: string | null
  minutes: number | null
  /** The meter at the pump: before, as estimated, as read. */
  readings: { previous: number | null; estimated: number | null; physical: number | null }
  requestId: string | null
  /** When the nozzle went in (local wall clock); `at` is when it came out once done. */
  startedAt: string | null
  /** The fuel voucher, "SIV-000027". */
  siv: string | null
  /** FactorySuite's own probe check of the fuelling; null when it made none. */
  sensor: FuelIssueSensor | null
}

/** FactorySuite's probe check of one fuelling (RaiFactorySuiteFuelIssueRow sensor*). */
export interface FuelIssueSensor {
  /** MATCH, MISMATCH or NO_SENSOR. */
  check: string | null
  beforeL: number | null
  beforeAt: string | null
  afterL: number | null
  afterAt: string | null
  riseL: number | null
  gapPercent: number | null
}

export interface FuelMachine {
  reference: string
  name: string | null
  category: string | null
  /** The register's rate: km per litre, or litres per hour. */
  basis: string | null
  rate: number | null
  /** The register's status when it is not plain AVAILABLE ("BROKEN_DOWN"). */
  status: string | null
  downReason: string | null
  tankLitres: number | null
  vehicleId: string | null
  plate: string | null
}

/**
 * A fuel request no plan line asked for: FactorySuite's vehicle requests
 * (Transport's buses and hired vehicles, Security, 25 Nov 2026: 24 of 190).
 * Kept apart from `lines`, so the Fuel page counts plan lines as FactorySuite
 * does; the Fuelling Plan report counts them as planned (operator 2026-11-27,
 * after FactorySuite's own "plan vs actual": "approved work plan or vehicle
 * request").
 */
export interface FuelVehicleRequest {
  requestId: string
  day: string
  machine: string
  department: string | null
  shiftNo: number | null
  status: string | null
  fullTank: boolean
  litresRequested: number | null
  /** Litres the pump issued against this request. */
  issuedLitres: number
}

export interface FactoryFuel {
  factory: string
  from: string
  to: string
  lines: FuelPlanLine[]
  issues: FuelIssue[]
  machines: FuelMachine[]
  vehicleRequests: FuelVehicleRequest[]
}

const QUIET_STATUS = new Set(['', 'AVAILABLE', 'ACTIVE', 'OPERATIONAL'])
/** Which of two requests for one machine-shift stands: approved over pending over the rest. */
const REQUEST_RANK: Record<string, number> = { APPROVED: 3, ISSUED: 3, FULFILLED: 3, COMPLETED: 3, PENDING: 2, REJECTED: 0, CANCELLED: 0, WITHDRAWN: 0 }

export function buildFactoryFuel(
  factory: string,
  from: string,
  to: string,
  plans: RaiFactorySuiteWorkPlanRow[],
  requests: RaiFactorySuiteFuelRequestRow[],
  issueRows: RaiFactorySuiteFuelIssueRow[],
  register: RaiFactorySuiteMachineRow[],
  units: FuelUnitRef[],
): FactoryFuel {
  const machineByRef = new Map<string, RaiFactorySuiteMachineRow>()
  for (const m of register) if (m.reference) machineByRef.set(foldName(m.reference), m)
  const unitByRef = new Map<string, FuelUnitRef>()
  for (const u of units) if (u.equipmentReference) unitByRef.set(foldName(u.equipmentReference), u)
  const requestFor = new Map<string, RaiFactorySuiteFuelRequestRow>()
  // Two requests for one machine-shift: the one that stands wins (DG-03, 25 Nov:
  // a rejected request, then an approved one the pump filled).
  const standing = (r: RaiFactorySuiteFuelRequestRow) => REQUEST_RANK[String(r.status ?? '').toUpperCase()] ?? 1
  for (const r of requests) {
    const k = requestKey(r.machine, r.planDate, r.shift)
    const had = requestFor.get(k)
    if (!had || standing(r) >= standing(had)) requestFor.set(k, r)
  }
  const issuedFor = new Map<string, number>()
  for (const i of issueRows) {
    if (i.requestId && i.quantityIssued != null) issuedFor.set(i.requestId, (issuedFor.get(i.requestId) ?? 0) + i.quantityIssued)
  }

  const lines: FuelPlanLine[] = []
  for (const p of plans) {
    // A plan is for one day today; a range is walked day by day in case one
    // ever covers more, so each line-day stands alone.
    for (let day = p.startDate; day <= p.endDate; day = nextDay(day)) {
      if (day < from || day > to) continue
      for (const l of p.lines ?? []) {
        if (l.active === false) continue
        const req = requestFor.get(requestKey(l.machine, day, l.shiftNo)) ?? null
        lines.push({
          lineId: l.id,
          taskId: l.taskId,
          planId: p.id,
          planCode: p.planCode,
          planStatus: p.status,
          department: p.department,
          day,
          machine: l.machine,
          activity: l.activity,
          workLocation: l.workLocation ?? null,
          fuelingLocation: l.fuelingLocation ?? null,
          operator: l.operator ?? null,
          operators: [l.operator, l.secondOperator, l.thirdOperator]
            .map(o => String(o ?? '').trim()).filter(Boolean),
          supervisor: l.supervisor?.trim() || null,
          shiftNo: l.shiftNo ?? null,
          shiftStart: l.shiftStart ?? null,
          plannedHours: l.plannedHours ?? null,
          plannedKm: l.plannedKm ?? null,
          fullTank: l.fullTank === true,
          litresRequested: l.fullTank ? null : l.litresRequested ?? null,
          needLitres: needLitres(l, machineByRef.get(foldName(l.machine))),
          requestStatus: req?.status ?? null,
          requestId: req?.id ?? null,
          requestLitres: req?.litresRequested ?? null,
          issuedLitres: req ? issuedFor.get(req.id) ?? 0 : 0,
        })
      }
    }
  }
  lines.sort((a, b) => b.day.localeCompare(a.day) || a.machine.localeCompare(b.machine, undefined, { numeric: true }) || (a.shiftNo ?? 1) - (b.shiftNo ?? 1))

  const onLines = new Set(lines.map(l => requestKey(l.machine, l.day, l.shiftNo)))
  const vehicleRequests: FuelVehicleRequest[] = requests
    .filter(r => r.planDate >= from && r.planDate <= to && !onLines.has(requestKey(r.machine, r.planDate, r.shift)))
    .map(r => ({
      requestId: r.id,
      day: r.planDate,
      machine: r.machine,
      department: r.department ?? null,
      shiftNo: r.shift ?? null,
      status: r.status ?? null,
      fullTank: r.fullTank === true,
      litresRequested: r.litresRequested ?? null,
      issuedLitres: issuedFor.get(r.id) ?? 0,
    }))
    .sort((a, b) => b.day.localeCompare(a.day) || a.machine.localeCompare(b.machine, undefined, { numeric: true }) || (a.shiftNo ?? 1) - (b.shiftNo ?? 1))

  const issues: FuelIssue[] = issueRows
    .filter(i => i.issueDate >= from && i.issueDate <= to)
    .map(i => ({
      ...pumpIssue(i),
      id: i.id,
      machine: i.machine,
      day: i.issueDate,
      department: i.department ?? null,
      operator: i.operator ?? null,
      activity: i.activity ?? null,
      minutes: i.fuelingMinutes ?? null,
      readings: { previous: i.previousReading ?? null, estimated: i.estimatedReading ?? null, physical: i.physicalReading ?? null },
      requestId: i.requestId ?? null,
      startedAt: i.fuelingStart ?? null,
      siv: i.siv?.trim() || null,
      sensor: issueSensor(i),
    }))
    .sort((a, b) => String(b.at ?? b.day).localeCompare(String(a.at ?? a.day)))

  const refs = new Map<string, string>()
  for (const r of [...lines.map(l => l.machine), ...issues.map(i => i.machine), ...vehicleRequests.map(v => v.machine)]) {
    const k = foldName(r)
    if (!refs.has(k)) refs.set(k, r)
  }
  const machines: FuelMachine[] = [...refs.entries()].map(([k, reference]) => {
    const m = machineByRef.get(k)
    const u = unitByRef.get(k)
    const status = String(m?.status ?? '').toUpperCase()
    return {
      reference,
      name: m?.name ?? null,
      category: m?.category ?? null,
      basis: m?.consumptionBasis ?? null,
      rate: m?.expectedConsumption ?? null,
      status: QUIET_STATUS.has(status) ? null : status,
      downReason: QUIET_STATUS.has(status) ? null : m?.downReason ?? null,
      tankLitres: u?.tankCapacityLitres ?? null,
      vehicleId: u?.id ?? null,
      plate: u?.registrationPlate ?? null,
    }
  }).sort((a, b) => a.reference.localeCompare(b.reference, undefined, { numeric: true }))

  return { factory, from, to, lines, issues, machines, vehicleRequests }
}

function issueSensor(i: RaiFactorySuiteFuelIssueRow): FuelIssueSensor | null {
  const check = i.sensorCheck?.trim().toUpperCase() || null
  if (!check && i.sensorBeforeLitres == null && i.sensorAfterLitres == null) return null
  return {
    check,
    beforeL: i.sensorBeforeLitres ?? null,
    beforeAt: i.sensorBeforeAt ?? null,
    afterL: i.sensorAfterLitres ?? null,
    afterAt: i.sensorAfterAt ?? null,
    riseL: i.sensorRiseLitres ?? null,
    gapPercent: i.sensorGapPercent ?? null,
  }
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
