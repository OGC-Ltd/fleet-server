/**
 * The Fuel page's Probe used column (operator, 20 Nov 2026: "add the column
 * for probe calculated fuel", then "Fuel used per the probe"): for each
 * machine, the fuel its probe says it burned over its planned shifts in the
 * range, with the engine hours and kilometres it ran in them.
 *
 *   used = level at the shift's start + probe fills - siphon drains - level at its end
 *
 * A shift at a time, the way fuel-balance works out any period (balanceFrom:
 * the middle of the first and the last 7 tank readings, the ledger's fills
 * and thefts in between), up to now while the shift runs; each fill at the
 * litres the probe recorded, as the table's Probe filled shows it (shiftUse). A shift that has
 * not started counts nothing yet. A machine's shifts that overlap (two plan
 * lines at once, as EX-16's two night lines on 20 Nov) are merged first, so
 * no litre and no hour is counted twice. Plans that put nobody to work
 * (cancelled, rejected, withdrawn) are left out.
 *
 * Hours are the tracker's engine-hours meter, last fix less first fix in the
 * shift; kilometres the tracker's odometer the same way. A meter that runs
 * backwards gives nothing rather than a negative.
 *
 * Pure; work-plans.service factoryFuelShiftsFor reads each window's edges in
 * one query and the units' fuel ledger.
 */

import { balanceFrom, edgeLevelL, type BalanceDrain, type BalanceFilling } from '../fuel/fuel-balance.js'
import type { FactoryFuel } from './factory-fuel.js'
import { lineWindow } from './factory-supervisors.js'
import { foldName } from './work-plan-match.js'

/** Plans that put nobody to work. */
const OFF = /CANCEL|REJECT|WITHDRAW/i
/** Fewer engine hours than this, or kilometres, and a rate per hour or per km says nothing. */
const MIN_HOURS = 0.1
const MIN_KM = 1
/**
 * The tank before the day's work is read over a shift's first ten minutes
 * (operator 2026-11-23: "we need to capture the fuel level first 10 minutes of
 * work"): the middle of the readings then, so one slosh does not set it.
 */
export const FIRST_TEN_MS = 10 * 60_000
/**
 * A shift that ended while its tracker was silent (operator 2026-11-23, EX-17:
 * nothing from 19:30 to 22:30 EAT with the engine on, its shift ending at
 * 22:00): when the last tank reading in the window is more than END_GAP_MS
 * before its end, the end is read from the first readings once the tracker
 * came back, up to AFTER_GAP_REACH_MS later, tank, hours and km alike. The
 * work done in the gap is then counted; so is any done after the shift
 * before the tracker returned.
 */
export const END_GAP_MS = 30 * 60_000
export const AFTER_GAP_REACH_MS = 6 * 3_600_000
/** The meters at a gap's end: the highest in this long after the tracker's first fix back (its first fixes can carry the old meter). */
export const AFTER_GAP_METER_MS = 15 * 60_000

/** One stretch of a machine's planned work: one plan line, or several that overlap. */
export interface ShiftWindow {
  /** `<machine>#<n>`: unique in a read. */
  key: string
  machine: string
  vehicleId: string | null
  start: Date
  /** The planned end; measuring stops at now while it is ahead. */
  end: Date
  lineIds: string[]
}

/** What the tracker holds at a window's two ends. */
export interface WindowEdges {
  /** Up to 7 tank levels (ml) from the start, and up to 7 back from the end. */
  first: number[]
  last: number[]
  /** Every tank level (ml) in the first FIRST_TEN_MS of work: from the engine coming on (workAt), else the window's start. */
  firstTen?: number[]
  /** When the engine came on for the shift's work; null when the tracker gives no ignition. */
  workAt?: Date | null
  /** The last tank reading's time in the window, and the first readings after it ended (END_GAP_MS). */
  lastAt?: Date | null
  after?: number[]
  afterAt?: Date | null
  hoursAfter?: number | null
  kmAfter?: number | null
  /** The engine-hours meter at the first and last fix that carried it. */
  hoursFirst: number | null
  hoursLast: number | null
  /** The odometer, in km, the same way. */
  kmFirst: number | null
  kmLast: number | null
}

export interface ShiftUse {
  start: string
  end: string
  /** Still running: measured up to now. */
  open: boolean
  /** Not started yet: nothing measured. */
  ahead: boolean
  usedL: number | null
  startL: number | null
  /**
   * The tank over the first ten minutes of work (FIRST_TEN_MS), from the
   * engine coming on, as FactorySuite's Fuel per shift reads it: the Fuel
   * page's Fuel before. `firstTenAt` is when those ten minutes began, and
   * `firstTenFrom` whether that was the engine ('engine') or, with no ignition
   * on the tracker, the planned start ('shift').
   */
  firstTenL: number | null
  firstTenAt: string | null
  firstTenFrom: 'engine' | 'shift' | null
  /** When `endL` was read: the window's end, now, or the tracker's first reading after a gap (`endGap`). */
  endAt: string | null
  endGap: boolean
  endL: number | null
  filledL: number
  theftL: number
  hours: number | null
  km: number | null
}

export interface MachineShiftUse {
  machine: string
  /** One of our units, read for this caller. */
  tracked: boolean
  /** Planned stretches in the range (overlapping lines merged), and how many the probe measured. */
  shifts: number
  measured: number
  /** A stretch is still running: the figures run to now. */
  open: boolean
  /** Over the measured stretches; null when none was measured. */
  usedL: number | null
  filledL: number
  theftL: number
  /** Over the same stretches, where the meter reported. */
  hours: number | null
  km: number | null
  /** Litres an engine hour, and kilometres a litre, over the stretches that have both figures. */
  perHour: number | null
  kmPerL: number | null
  windows: ShiftUse[]
}

const r1 = (v: number) => Math.round(v * 10) / 10
const r2 = (v: number) => Math.round(v * 100) / 100

/** The middle of every tank reading given (ml, a tank at 1 L and up), in litres; null with none. */
export function middleL(mls: number[]): number | null {
  const v = mls.filter(x => Number.isFinite(x) && x >= 1000).sort((a, b) => a - b)
  if (!v.length) return null
  const m = v.length >> 1
  return r1((v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2) / 1000)
}

/**
 * The planned stretches of each machine in `fuel`, in time order: a window per
 * plan line (lineWindow: its day, shift start and planned hours), overlapping
 * ones merged. A line with no planned hours has no window.
 */
export function shiftWindows(fuel: FactoryFuel): ShiftWindow[] {
  const unitOf = new Map(fuel.machines.map(m => [foldName(m.reference), m.vehicleId ?? null]))
  const byMachine = new Map<string, { machine: string; spans: Array<{ start: Date; end: Date; lineId: string }> }>()
  for (const l of fuel.lines) {
    if (OFF.test(String(l.planStatus ?? ''))) continue
    const w = lineWindow(l.day, l.shiftStart, l.plannedHours)
    if (!w) continue
    const k = foldName(l.machine)
    if (!byMachine.has(k)) byMachine.set(k, { machine: l.machine, spans: [] })
    byMachine.get(k)!.spans.push({ ...w, lineId: l.lineId })
  }
  const out: ShiftWindow[] = []
  for (const [k, { machine, spans }] of byMachine) {
    spans.sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime())
    const merged: Array<{ start: Date; end: Date; lineIds: string[] }> = []
    for (const s of spans) {
      const last = merged.at(-1)
      if (last && s.start.getTime() < last.end.getTime()) {
        if (s.end.getTime() > last.end.getTime()) last.end = s.end
        last.lineIds.push(s.lineId)
      } else {
        merged.push({ start: s.start, end: s.end, lineIds: [s.lineId] })
      }
    }
    merged.forEach((m, i) => out.push({ key: `${k}#${i}`, machine, vehicleId: unitOf.get(k) ?? null, ...m }))
  }
  return out
}

/** The span a window is measured over: its start to its end or now, whichever comes first; null before it starts. */
export function measureSpan(w: Pick<ShiftWindow, 'start' | 'end'>, now: Date): { from: Date; to: Date } | null {
  const to = Math.min(w.end.getTime(), now.getTime())
  return w.start.getTime() < to ? { from: w.start, to: new Date(to) } : null
}

/** A meter's run over a window: last less first, never below nothing; null when either end is missing. */
const run = (first: number | null, last: number | null) =>
  first != null && last != null && Number.isFinite(first) && Number.isFinite(last) && last >= first ? last - first : null

/** The first ten minutes of work's tank level, and where those minutes began. */
function firstTen(w: ShiftWindow, edges: WindowEdges): Pick<ShiftUse, 'firstTenL' | 'firstTenAt' | 'firstTenFrom'> {
  const firstTenL = middleL(edges.firstTen ?? [])
  if (firstTenL == null) return { firstTenL: null, firstTenAt: null, firstTenFrom: null }
  const at = edges.workAt ?? null
  return { firstTenL, firstTenAt: (at ?? w.start).toISOString(), firstTenFrom: at ? 'engine' : 'shift' }
}

/**
 * The shift has ended, its last tank reading came more than END_GAP_MS before
 * the end, and the tracker sent readings after it (within AFTER_GAP_REACH_MS).
 */
export function endedInGap(w: Pick<ShiftWindow, 'end'>, edges: WindowEdges, to: Date): boolean {
  if (to.getTime() < w.end.getTime()) return false
  if (!edges.after?.length || !edges.afterAt) return false
  const lastAt = edges.lastAt?.getTime()
  return lastAt == null || w.end.getTime() - lastAt > END_GAP_MS
}

/** One window's figures from its edges and the unit's ledger. */
export function shiftUse(
  w: ShiftWindow, edges: WindowEdges | null, fillings: BalanceFilling[], drains: BalanceDrain[], now: Date,
): ShiftUse {
  const span = measureSpan(w, now)
  const base = { start: w.start.toISOString(), end: w.end.toISOString(), open: w.end.getTime() > now.getTime(), ahead: span == null }
  if (!span || !edges) return { ...base, usedL: null, startL: null, firstTenL: null, firstTenAt: null, firstTenFrom: null, endL: null, endAt: null, endGap: false, filledL: 0, theftL: 0, hours: null, km: null }
  // Ended in a tracker gap: the end from the first readings after it.
  const gap = endedInGap(w, edges, span.to)
  const endAt = gap ? edges.afterAt! : span.to
  const hours = run(edges.hoursFirst, gap ? edges.hoursAfter ?? edges.hoursLast : edges.hoursLast)
  const km = run(edges.kmFirst, gap ? edges.kmAfter ?? edges.kmLast : edges.kmLast)
  // A fill counts as the probe recorded it (its own level before and after,
  // the table's Probe filled), not the verifier's later rise. The verifier
  // reads its baseline from the 20 minutes before the fill's timestamp, which
  // on a long fill stamped mid-way already holds half the rise: EX-21, 20 Nov,
  // a 21-minute fill stamped 08:02, 284.3 L recorded and 209.6 L "observed",
  // which left the shift's balance 60 L short. A fill ruled fuel moving in the
  // tank (REDISTRIBUTION) is still left out by its verdict.
  const recorded = fillings.map(f => ({ ...f, observedRiseMl: null }))
  const bal = balanceFrom({
    startL: edgeLevelL(edges.first), endL: edgeLevelL(gap ? edges.after! : edges.last), distanceKm: km ?? 0,
    fillings: recorded, drains, from: span.from.getTime(), to: endAt.getTime(),
  })
  // The tank ended fuller than the recorded fills explain while the machine
  // worked: fuel went in that the ledger does not know of, so 0 L is a figure
  // nobody can believe (fuel-balance reportableConsumptionL, the same rule).
  const worked = (hours ?? 0) >= MIN_HOURS || (km ?? 0) >= MIN_KM
  const usedL = bal.consumedL === 0 && (bal.unrecordedL ?? 0) > 0 && worked ? null : bal.consumedL
  return {
    ...base, usedL, startL: bal.startL, ...firstTen(w, edges), endL: bal.endL, endAt: endAt.toISOString(), endGap: gap, filledL: bal.filledL, theftL: bal.theftL,
    hours: hours == null ? null : r2(hours), km: km == null ? null : r1(km),
  }
}

/**
 * Each machine's planned stretches added up. `edges` by window key (a window
 * of an untracked machine has none); `ledger` by unit: its fills and drains
 * over the range.
 */
export function machineShiftUse(
  windows: ShiftWindow[],
  edges: Map<string, WindowEdges>,
  ledger: Map<string, { fillings: BalanceFilling[]; drains: BalanceDrain[] }>,
  now: Date,
): MachineShiftUse[] {
  const byMachine = new Map<string, ShiftWindow[]>()
  for (const w of windows) {
    const k = foldName(w.machine)
    byMachine.set(k, [...(byMachine.get(k) ?? []), w])
  }
  const out: MachineShiftUse[] = []
  for (const ws of byMachine.values()) {
    const vehicleId = ws[0]!.vehicleId
    const book = vehicleId ? ledger.get(vehicleId) : undefined
    const uses = ws.map(w => shiftUse(w, vehicleId ? edges.get(w.key) ?? null : null, book?.fillings ?? [], book?.drains ?? [], now))
    const measured = uses.filter(u => u.usedL != null)
    const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)
    const usedL = measured.length ? r1(sum(measured.map(u => u.usedL!))) : null
    const timed = uses.filter(u => u.hours != null)
    const hours = timed.length ? r2(sum(timed.map(u => u.hours!))) : null
    const driven = uses.filter(u => u.km != null)
    const km = driven.length ? r1(sum(driven.map(u => u.km!))) : null
    // The rates over the stretches that have both figures, so a stretch the
    // probe missed does not lower them.
    const both = measured.filter(u => u.hours != null)
    const bothL = sum(both.map(u => u.usedL!)), bothH = sum(both.map(u => u.hours!))
    const moved = measured.filter(u => u.km != null)
    const movedL = sum(moved.map(u => u.usedL!)), movedKm = sum(moved.map(u => u.km!))
    out.push({
      machine: ws[0]!.machine,
      tracked: vehicleId != null,
      shifts: ws.length,
      measured: measured.length,
      open: uses.some(u => u.open && !u.ahead),
      usedL,
      filledL: r1(sum(uses.map(u => u.filledL))),
      theftL: r1(sum(uses.map(u => u.theftL))),
      hours,
      km,
      perHour: bothH >= MIN_HOURS ? r1(bothL / bothH) : null,
      kmPerL: movedKm >= MIN_KM && movedL > 0 ? r2(movedKm / movedL) : null,
      windows: uses,
    })
  }
  return out.sort((a, b) => a.machine.localeCompare(b.machine, undefined, { numeric: true }))
}
