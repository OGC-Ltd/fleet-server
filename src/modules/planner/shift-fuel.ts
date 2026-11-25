/**
 * Each planned shift's fuel, shift by shift (operator 2026-11-26):
 *
 * - Issued: "issued goes to the shift when the issued happened". FactorySuite
 *   ties a double-shift day's one fuelling to one shift's request (EX-17, 23
 *   Nov: 576 L at 16:09, during shift 2, on shift 1's request), so the request
 *   is not used. Each fuelling goes whole, by when the nozzle went in, to the
 *   shift running then (the later where two overlap), else the next to start
 *   that day (East Africa), else the last of that day already over.
 * - Probe filled: "the amount of fuel filled into the tank and measured 10
 *   minutes after refill either into work or not", the tank 10 min after the
 *   nozzle less 10 min before (fuel-refills refillTank), added up over the
 *   shift's fuellings.
 * - Consumed: "(fuel start - fuel end) + issued on the individual shift": the
 *   shift's Fuel before (else the first 10 minutes of work, else its opening
 *   readings) less its end level, plus its Issued. Below nothing the readings
 *   contradict each other: no figure, `consumedWhy` "negative".
 * - Probe used: "the total hours worked * burn rate, then we handle the
 *   individual shift": the shift's engine hours × the register's L/h, or its
 *   km ÷ km/L on a km-rated machine.
 *
 * A machine's row adds its shifts up. Pure; work-plans.service reads the
 * tank figures and fuel-befores keeps the result once the shift settles.
 */

import type { FactoryFuel } from './factory-fuel.js'
import { hourRated, wallClock, type RefillTank } from './fuel-refills.js'
import type { MachineShiftUse, ShiftUse } from './fuel-shifts.js'
import { foldName } from './work-plan-match.js'

/** One fuelling placed on a shift. */
export interface ShiftFuelling {
  issueId: string
  siv: string | null
  litres: number | null
  /** When the nozzle went in (ISO). */
  at: string | null
  probeFilledL: number | null
}

/** What ShiftUse gains here. */
export interface ShiftFuel {
  issuedL: number
  fuellings: ShiftFuelling[]
  /** Over the fuellings the probe measured; null when it measured none. */
  probeFilledL: number | null
  shiftStartL: number | null
  shiftStartAt: string | null
  /** What shiftStartL is: before work, before its refill, the first 10 min of work, or the opening readings. */
  shiftStartBy: 'before' | 'refill' | 'first-ten' | 'start' | null
  consumedL: number | null
  consumedWhy: 'no-probe' | 'negative' | null
  /** The engine hours (h) or km run, the register's rate, and the two at the standard. */
  runUnit: 'h' | 'km'
  run: number | null
  rate: number | null
  probeUsedL: number | null
}

const r2 = (v: number) => Math.round(v * 100) / 100
const DAY_MS = 86_400_000
const eatDay = (t: number) => new Date(t + 3 * 3_600_000).toISOString().slice(0, 10)

/** Which of `spans` (in start order) a fuelling at `t` goes to; -1 on a day with no shift. */
export function placeFuelling(spans: Array<{ from: number; to: number }>, t: number | null): number {
  if (t == null) return -1
  const day = eatDay(t)
  let running = -1
  for (let i = 0; i < spans.length; i++) if (spans[i]!.from <= t && t < spans[i]!.to) running = i
  if (running >= 0) return running
  const next = spans.findIndex(s => s.from > t && s.from - t < DAY_MS && eatDay(s.from) === day)
  if (next >= 0) return next
  for (let i = spans.length - 1; i >= 0; i--) if (spans[i]!.from <= t && eatDay(spans[i]!.from) === day) return i
  return -1
}

/** One shift's consumed, from its own readings and its issued litres. */
export function shiftConsumed(u: ShiftUse, issuedL: number): Pick<ShiftFuel, 'shiftStartL' | 'shiftStartAt' | 'shiftStartBy' | 'consumedL' | 'consumedWhy'> {
  const startL = u.beforeL ?? u.firstTenL ?? u.startL ?? null
  const shiftStartBy = u.ahead ? null : u.beforeL != null ? (u.beforeBy === 'refill' ? 'refill' : 'before') : u.firstTenL != null ? 'first-ten' : u.startL != null ? 'start' : null
  const shiftStartAt = u.beforeL != null ? u.beforeAt ?? u.start : u.firstTenL != null ? u.firstTenAt ?? u.start : u.startL != null ? u.start : null
  if (u.ahead || startL == null || u.endL == null) return { shiftStartL: startL, shiftStartAt, shiftStartBy, consumedL: null, consumedWhy: u.ahead ? null : 'no-probe' }
  const used = r2(startL - u.endL + issuedL)
  return used < 0
    ? { shiftStartL: startL, shiftStartAt, shiftStartBy, consumedL: null, consumedWhy: 'negative' }
    : { shiftStartL: startL, shiftStartAt, shiftStartBy, consumedL: used, consumedWhy: null }
}

/**
 * Every window of `machines` with its ShiftFuel. `fuel` gives the pump's
 * fuellings and each machine's rate; `tanks` the tank either side of each
 * fuelling by issue id (null or missing: not measured).
 */
export function withShiftFuel(
  machines: MachineShiftUse[], fuel: Pick<FactoryFuel, 'issues' | 'machines'>, tanks: ReadonlyMap<string, RefillTank | null | undefined>,
): Array<Omit<MachineShiftUse, 'windows'> & { windows: Array<ShiftUse & ShiftFuel> }> {
  const machineOf = new Map(fuel.machines.map(m => [foldName(m.reference), m]))
  const issuesOf = new Map<string, FactoryFuel['issues']>()
  for (const i of fuel.issues) {
    if (!i.done) continue
    const k = foldName(i.machine)
    issuesOf.set(k, [...(issuesOf.get(k) ?? []), i])
  }
  return machines.map(m => {
    const k = foldName(m.machine)
    const reg = machineOf.get(k)
    const byKm = !hourRated(reg?.basis)
    const rate = reg?.rate != null && reg.rate > 0 ? reg.rate : null
    const order = m.windows.map((u, i) => ({ i, from: Date.parse(u.start), to: Date.parse(u.end) })).sort((a, b) => a.from - b.from)
    const placed: ShiftFuelling[][] = m.windows.map(() => [])
    for (const i of issuesOf.get(k) ?? []) {
      const at = wallClock(i.startedAt) ?? wallClock(i.at)
      const n = placeFuelling(order, at?.getTime() ?? null)
      if (n < 0) continue
      placed[order[n]!.i]!.push({
        issueId: i.id, siv: i.siv ?? null, litres: i.litres ?? null, at: at?.toISOString() ?? null,
        probeFilledL: tanks.get(i.id)?.filledL ?? null,
      })
    }
    return {
      ...m,
      windows: m.windows.map((u, n) => {
        const fuellings = placed[n]!.sort((a, b) => String(a.at).localeCompare(String(b.at)))
        const issuedL = r2(fuellings.reduce((s, f) => s + (f.litres ?? 0), 0))
        const probed = fuellings.filter(f => f.probeFilledL != null)
        const run = byKm ? u.km : u.hours
        return {
          ...u,
          issuedL,
          fuellings,
          probeFilledL: probed.length ? r2(probed.reduce((s, f) => s + f.probeFilledL!, 0)) : null,
          ...shiftConsumed(u, issuedL),
          runUnit: byKm ? 'km' as const : 'h' as const,
          run: run ?? null,
          rate,
          probeUsedL: run == null || rate == null ? null : r2(byKm ? run / rate : run * rate),
        }
      }),
    }
  })
}
