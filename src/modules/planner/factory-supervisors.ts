/**
 * The Drivers page Scorecard's Supervisors view (operator 2026-11-19: "work on
 * the supervisor alignment to the machines they have assigned and the shift
 * they have assigned — the goal is to derive the performing supervisors";
 * first step, "populate the supervisors records on the score card").
 *
 * A FactorySuite work plan line puts a machine on a shift under a supervisor:
 * "EX-01, Shift 2 from 18:00, 10 h, Supervisors: Sarah Mbago". Each line is a
 * window, from the shift start for the planned hours, and the machine's own
 * telemetry says how much of it the machine actually ran (LineRun, read by
 * work-plans.service factorySupervisorsFor). A supervisor's record is their
 * lines: the machines and shifts they had, the hours planned and the hours
 * run, the machines that never ran, and the late starts.
 *
 * Only APPROVED and SUBMITTED plans count. A DRAFT was never released to the
 * field and a CANCELLED one was withdrawn; both are counted in `skipped` so
 * the page can say so.
 *
 * Pure, built from the Fuel page's FactoryFuel so all three share one read of
 * FactorySuite.
 */

import type { FactoryFuel, FuelMachine, FuelPlanLine } from './factory-fuel.js'

/** Plans whose lines are left out, and the counter each lands in. */
const SKIPPED_STATUS: Record<string, 'draft' | 'cancelled'> = { DRAFT: 'draft', CANCELLED: 'cancelled' }

/** Run hours below this mean the machine did not work its shift. */
export const NOT_RUN_HOURS = 0.25
/** A first working fix this long after the shift start is a late start. */
export const LATE_START_MINUTES = 60
/** The shift start when a line names none. */
const DEFAULT_SHIFT_START = '06:00:00'
/** Mufindi is in Tanzania, EAT all year. Plan times are its wall clock. */
const PLAN_OFFSET = '+03:00'

/** The window a line plans its machine for. Null without planned hours. */
export function lineWindow(day: string, shiftStart: string | null, plannedHours: number | null): { start: Date; end: Date } | null {
  if (!(plannedHours != null && plannedHours > 0)) return null
  const hms = /^\d{2}:\d{2}(:\d{2})?$/.test(shiftStart ?? '') ? (shiftStart!.length === 5 ? `${shiftStart}:00` : shiftStart!) : DEFAULT_SHIFT_START
  const start = new Date(`${day}T${hms}${PLAN_OFFSET}`)
  if (Number.isNaN(start.getTime())) return null
  return { start, end: new Date(start.getTime() + plannedHours * 3_600_000) }
}

/** What the machine's telemetry says about one line's window. */
export interface LineRun {
  /** Fixes the tracker sent inside the window. */
  samples: number
  /** Engine hours run inside the window: the hours meter where it reports, else engine-on time. */
  hours: number | null
  /** The first fix with the machine working, from an hour before the start. */
  firstWorkAt: Date | null
}

export const runKey = (lineId: string, day: string): string => `${lineId}|${day}`

/**
 * How a line went:
 *   ran        the machine ran at least NOT_RUN_HOURS of its window
 *   not-run    the tracker reported and the machine did not work
 *   silent     the machine has a tracker that sent nothing in the window
 *   untracked  the machine is not one of our units
 *   no-hours   the line plans no hours, so there is no window
 *   open       the window has not ended yet
 */
export type LineState = 'ran' | 'not-run' | 'silent' | 'untracked' | 'no-hours' | 'open'

export interface SupervisorLine {
  lineId: string
  day: string
  planCode: string
  planStatus: string
  department: string
  shiftNo: number | null
  shiftStart: string | null
  machine: string
  machineName: string | null
  plate: string | null
  activity: string
  workLocation: string | null
  operators: string[]
  plannedHours: number | null
  start: string | null
  end: string | null
  state: LineState
  runHours: number | null
  firstWorkAt: string | null
  /** Minutes after the shift start the machine first worked; null when it did not, or started on time or early. */
  lateMinutes: number | null
}

export interface SupervisorMachine {
  reference: string
  name: string | null
  plate: string | null
  lines: number
}

export interface SupervisorRecord {
  key: string
  name: string
  lines: number
  days: number
  firstDay: string | null
  lastDay: string | null
  departments: string[]
  machines: SupervisorMachine[]
  operators: string[]
  shifts: Array<{ shiftNo: number | null; shiftStart: string | null; lines: number }>
  plannedHours: number
  /** Lines whose window ended with the tracker reporting: the ones run hours can judge. */
  judged: number
  judgedPlannedHours: number
  runHours: number
  /** runHours ÷ judgedPlannedHours as a percentage; null with nothing judged. */
  deliveredPct: number | null
  ran: number
  notRun: number
  lateStarts: number
  silent: number
  untracked: number
  open: number
  history: SupervisorLine[]
}

export interface FactorySupervisors {
  factory: string
  from: string
  to: string
  supervisors: SupervisorRecord[]
  skipped: { draft: number; cancelled: number }
  rules: { notRunHours: number; lateStartMinutes: number }
}

const round1 = (n: number) => Math.round(n * 10) / 10

/** Case and spacing folded: "Elia hangaiko" and "ELIA  HANGAIKO" are one person. */
export const supervisorKey = (name: string | null): string =>
  String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase() || '—'

/** A line's state and figures, from its window and its run. */
export function judgeLine(
  l: Pick<FuelPlanLine, 'day' | 'shiftStart' | 'plannedHours'>,
  machine: Pick<FuelMachine, 'vehicleId'> | undefined,
  run: LineRun | undefined,
  now: Date,
): { state: LineState; start: Date | null; end: Date | null; runHours: number | null; firstWorkAt: Date | null; lateMinutes: number | null } {
  const w = lineWindow(l.day, l.shiftStart, l.plannedHours)
  const base = { start: w?.start ?? null, end: w?.end ?? null, runHours: null, firstWorkAt: null, lateMinutes: null }
  if (!w) return { ...base, state: 'no-hours' }
  if (!machine?.vehicleId) return { ...base, state: 'untracked' }
  if (w.end > now) return { ...base, state: 'open' }
  if (!run || run.samples === 0) return { ...base, state: 'silent' }
  const windowHours = (w.end.getTime() - w.start.getTime()) / 3_600_000
  const hours = round1(Math.min(Math.max(run.hours ?? 0, 0), windowHours))
  const late = run.firstWorkAt ? Math.round((run.firstWorkAt.getTime() - w.start.getTime()) / 60_000) : null
  return {
    ...base,
    state: hours >= NOT_RUN_HOURS ? 'ran' : 'not-run',
    runHours: hours,
    firstWorkAt: run.firstWorkAt,
    lateMinutes: hours >= NOT_RUN_HOURS && late != null && late > 0 ? late : null,
  }
}

export function buildFactorySupervisors(fuel: FactoryFuel, runs: Map<string, LineRun>, now = new Date()): FactorySupervisors {
  const machineOf = new Map(fuel.machines.map(m => [m.reference.toUpperCase(), m]))
  const skipped = { draft: 0, cancelled: 0 }
  const byKey = new Map<string, { name: string; lines: SupervisorLine[] }>()

  for (const l of fuel.lines) {
    const skip = SKIPPED_STATUS[String(l.planStatus).toUpperCase()]
    if (skip) { skipped[skip] += 1; continue }
    const m = machineOf.get(l.machine.toUpperCase())
    const j = judgeLine(l, m, runs.get(runKey(l.lineId, l.day)), now)
    const key = supervisorKey(l.supervisor)
    const rec = byKey.get(key) ?? { name: l.supervisor?.trim().replace(/\s+/g, ' ') || 'Not named', lines: [] }
    byKey.set(key, rec)
    rec.lines.push({
      lineId: l.lineId, day: l.day, planCode: l.planCode, planStatus: l.planStatus, department: l.department,
      shiftNo: l.shiftNo, shiftStart: l.shiftStart, machine: l.machine, machineName: m?.name ?? null, plate: m?.plate ?? null,
      activity: l.activity, workLocation: l.workLocation, operators: l.operators, plannedHours: l.plannedHours,
      start: j.start?.toISOString() ?? null, end: j.end?.toISOString() ?? null, state: j.state,
      runHours: j.runHours, firstWorkAt: j.firstWorkAt?.toISOString() ?? null, lateMinutes: j.lateMinutes,
    })
  }

  const supervisors: SupervisorRecord[] = [...byKey.entries()].map(([key, { name, lines }]) => {
    lines.sort((a, b) => b.day.localeCompare(a.day) || String(a.shiftStart).localeCompare(String(b.shiftStart)) || a.machine.localeCompare(b.machine, undefined, { numeric: true }))
    const days = [...new Set(lines.map(x => x.day))].sort()
    const machines = new Map<string, SupervisorMachine>()
    const shifts = new Map<string, { shiftNo: number | null; shiftStart: string | null; lines: number }>()
    const count = (s: LineState) => lines.filter(x => x.state === s).length
    for (const x of lines) {
      const mk = x.machine.toUpperCase()
      const m = machines.get(mk) ?? { reference: x.machine, name: x.machineName, plate: x.plate, lines: 0 }
      m.lines += 1
      machines.set(mk, m)
      const sk = `${x.shiftNo ?? ''}@${x.shiftStart ?? ''}`
      const s = shifts.get(sk) ?? { shiftNo: x.shiftNo, shiftStart: x.shiftStart, lines: 0 }
      s.lines += 1
      shifts.set(sk, s)
    }
    const judged = lines.filter(x => x.state === 'ran' || x.state === 'not-run')
    const judgedPlannedHours = judged.reduce((s, x) => s + (x.plannedHours ?? 0), 0)
    const runHours = round1(judged.reduce((s, x) => s + (x.runHours ?? 0), 0))
    return {
      key, name,
      lines: lines.length,
      days: days.length,
      firstDay: days[0] ?? null,
      lastDay: days[days.length - 1] ?? null,
      departments: [...new Set(lines.map(x => x.department).filter(Boolean))].sort(),
      machines: [...machines.values()].sort((a, b) => b.lines - a.lines || a.reference.localeCompare(b.reference, undefined, { numeric: true })),
      operators: [...new Set(lines.flatMap(x => x.operators.map(o => o.split(' - ')[0].trim())))].sort(),
      shifts: [...shifts.values()].sort((a, b) => b.lines - a.lines),
      plannedHours: round1(lines.reduce((s, x) => s + (x.plannedHours ?? 0), 0)),
      judged: judged.length,
      judgedPlannedHours: round1(judgedPlannedHours),
      runHours,
      deliveredPct: judgedPlannedHours > 0 ? Math.round((100 * runHours) / judgedPlannedHours) : null,
      ran: count('ran'),
      notRun: count('not-run'),
      lateStarts: lines.filter(x => x.lateMinutes != null && x.lateMinutes > LATE_START_MINUTES).length,
      silent: count('silent'),
      untracked: count('untracked'),
      open: count('open'),
      history: lines,
    }
  }).sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name))

  return {
    factory: fuel.factory, from: fuel.from, to: fuel.to, supervisors, skipped,
    rules: { notRunHours: NOT_RUN_HOURS, lateStartMinutes: LATE_START_MINUTES },
  }
}
