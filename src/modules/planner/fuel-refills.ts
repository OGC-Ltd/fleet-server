/**
 * The Fuel page machine panel's refills (operator, 19 Nov 2026, after the
 * EX-17 test of that day): seven figures for each fuelling at the pump.
 *
 *   1 fuel before the refill   } the probe's fill (fuel/fillings), else
 *   2 fuel after the refill    } FactorySuite's own probe check; on the page
 *   3 consumed                 the tank's balance over the shift the fuelling
 *                              was for, here
 *   4 planned                  the plan line (FactorySuite)
 *   5 meter before the refill  the tracker's meter at its last fix before the
 *                              nozzle went in, here
 *   6 meter after the refill   read at the pump (FactorySuite), with the
 *                              tracker's first fix after the nozzle came out,
 *                              here, to compare
 *   7 issued                   litres the pump put in (FactorySuite)
 *
 * The meter is engine hours (Wialon `cneh`), or the odometer in km on a
 * km-rated machine. Consumed is fuel-balance's figure, the one Vehicle
 * analytics and the reports print (start + filled - theft - end over the
 * shift), with the engine hours run in it; up to now while the shift runs.
 *
 * Pure; work-plans.service factoryFuelRefillsFor reads the telemetry.
 */

import { fuelBalance, type BalanceDrain, type BalanceFilling, type BalanceReading } from '../fuel/fuel-balance.js'
import type { FactoryFuel, FuelMachine } from './factory-fuel.js'
import { lineWindow } from './factory-supervisors.js'
import { foldName } from './work-plan-match.js'

/** How far from a fuelling a tracker fix still gives the meter then. */
export const METER_REACH_MS = 2 * 3_600_000
/** FactorySuite's pump times are Mufindi's wall clock (EAT) with no offset. */
const PUMP_OFFSET = '+03:00'

export interface RefillWindow {
  issueId: string
  /** Km-rated: the meter is the odometer, in km. Otherwise engine hours. */
  km: boolean
  fuelStart: Date | null
  fuelEnd: Date | null
  /** The shift the fuelling was for: its plan line's window. */
  shift: { lineId: string; start: Date; end: Date } | null
}

/** One tracker fix, as fuel-balance reads it, with both meters. */
export interface RefillReading extends BalanceReading {
  engineHours: number | null
  odometerKm: number | null
}

export interface MeterAt { value: number; at: string }

export interface ShiftUse {
  start: string
  end: string
  /** The shift has not ended: the figures run to now. */
  open: boolean
  /** Not started yet: nothing to measure. */
  ahead: boolean
  consumedL: number | null
  startL: number | null
  endL: number | null
  filledL: number
  theftL: number
  /** Engine hours run in the shift, off the hours meter. */
  engineHours: number | null
}

export interface MachineRefill {
  issueId: string
  /** The machine is one of our units with telemetry in reach. */
  tracked: boolean
  meterBefore: MeterAt | null
  meterAfter: MeterAt | null
  shift: ShiftUse | null
}

export interface MachineRefills {
  factory: string
  from: string
  to: string
  machine: string
  basis: string | null
  refills: MachineRefill[]
}

/** FactorySuite's offsetless pump time as an instant; a time with a zone stands as it is. */
export function wallClock(s: string | null | undefined): Date | null {
  if (!s) return null
  const v = String(s).trim().replace(' ', 'T')
  const t = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}${PUMP_OFFSET}`)
  return Number.isNaN(t.getTime()) ? null : t
}

/** The machine `reference` names and a window for each of its finished fuellings in the read. */
export function refillWindows(fuel: FactoryFuel, reference: string): { machine: FuelMachine | null; windows: RefillWindow[] } {
  const k = foldName(reference)
  const machine = fuel.machines.find(m => foldName(m.reference) === k) ?? null
  const lineOf = new Map(fuel.lines.filter(l => l.requestId && foldName(l.machine) === k).map(l => [l.requestId!, l]))
  const windows = fuel.issues
    .filter(i => i.done && foldName(i.machine) === k)
    .map((i): RefillWindow => {
      const line = i.requestId ? lineOf.get(i.requestId) : undefined
      const w = line ? lineWindow(line.day, line.shiftStart, line.plannedHours) : null
      const start = wallClock(i.startedAt)
      const end = wallClock(i.at)
      return {
        issueId: i.id,
        km: machine?.basis === 'KM_PER_LITRE',
        fuelStart: start ?? end,
        fuelEnd: end ?? start,
        shift: line && w ? { lineId: line.lineId, ...w } : null,
      }
    })
  return { machine, windows }
}

/** The stretch of telemetry a window needs, cut at now; null when it needs none. */
export function refillSpan(w: RefillWindow, now: Date): { from: Date; to: Date } | null {
  const ends: number[] = []
  if (w.fuelStart) ends.push(w.fuelStart.getTime() - METER_REACH_MS)
  if (w.fuelEnd) ends.push(w.fuelEnd.getTime() + METER_REACH_MS)
  if (w.shift) ends.push(w.shift.start.getTime(), w.shift.end.getTime())
  if (!ends.length) return null
  const from = Math.min(...ends)
  const to = Math.min(Math.max(...ends), now.getTime())
  return from < to ? { from: new Date(from), to: new Date(to) } : null
}

const r1 = (v: number) => Math.round(v * 10) / 10
const iso = (t: number) => new Date(t).toISOString()

/**
 * One fuelling's figures from the tracker. `readings` are the unit's fixes over
 * refillSpan in time order; `fillings` and `drains` its fuel ledger around it.
 */
export function refillFigures(
  w: RefillWindow,
  readings: RefillReading[] | null,
  fillings: BalanceFilling[],
  drains: BalanceDrain[],
  now: Date,
): MachineRefill {
  const meterOf = (r: RefillReading) => (w.km ? r.odometerKm : r.engineHours)
  const metered = (readings ?? []).filter(r => meterOf(r) != null && Number.isFinite(meterOf(r)))

  let meterBefore: MeterAt | null = null
  if (w.fuelStart) {
    const t = w.fuelStart.getTime()
    const r = metered.filter(x => x.t <= t && x.t >= t - METER_REACH_MS).at(-1)
    if (r) meterBefore = { value: r1(meterOf(r)!), at: iso(r.t) }
  }
  let meterAfter: MeterAt | null = null
  if (w.fuelEnd) {
    const t = w.fuelEnd.getTime()
    const r = metered.find(x => x.t >= t && x.t <= t + METER_REACH_MS)
    if (r) meterAfter = { value: r1(meterOf(r)!), at: iso(r.t) }
  }

  let shift: ShiftUse | null = null
  if (w.shift) {
    const start = w.shift.start.getTime()
    const end = Math.min(w.shift.end.getTime(), now.getTime())
    const open = w.shift.end.getTime() > now.getTime()
    const ahead = start >= now.getTime()
    const base = { start: iso(start), end: w.shift.end.toISOString(), open, ahead }
    if (ahead || !readings) {
      shift = { ...base, consumedL: null, startL: null, endL: null, filledL: 0, theftL: 0, engineHours: null }
    } else {
      const bal = fuelBalance({ readings, fillings, drains, from: start, to: end })
      const hours = readings.filter(r => r.t >= start && r.t < end && r.engineHours != null && Number.isFinite(r.engineHours))
        .map(r => r.engineHours!)
      shift = {
        ...base,
        consumedL: bal.consumedL,
        startL: bal.startL,
        endL: bal.endL,
        filledL: bal.filledL,
        theftL: bal.theftL,
        engineHours: hours.length >= 2 ? r1(Math.max(...hours) - Math.min(...hours)) : null,
      }
    }
  }

  return { issueId: w.issueId, tracked: readings != null && readings.length > 0, meterBefore, meterAfter, shift }
}
