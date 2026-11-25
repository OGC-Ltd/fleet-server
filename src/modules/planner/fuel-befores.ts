/**
 * Fuel before, kept (2026-11-25, operator: "prefill the previous days and
 * persist that data").
 *
 * Each plan line's Fuel before (fuel-shifts BEFORE_TEN_MS: the tank over the
 * ten minutes before its shift's work began, or before a refill that came
 * first) is written to `factorysuite_fuel_befores` once its shift has settled,
 * and from then on the stored figure is what the Fuel page shows. A later
 * re-judged fill, a pump issue keyed in after the fact or telemetry arriving
 * late no longer moves a finished day's figure.
 *
 * Settled: the shift's planned end was KEEP_SETTLE_MS ago, and its day is
 * before today (EAT). Today's shifts stay live. A line with no shift window
 * (no planned hours, a cancelled plan) is kept too, with nothing measured, so
 * its day counts as done.
 *
 * A stored line is read again when its plan line changed after it was kept
 * (the work plan watch's edit or status change), or when the shift's window
 * no longer starts and ends where it did. work-plans.service keepFuelBefores
 * walks the days back to the first kept plan day, a few a pass, so the earlier
 * days fill in on their own.
 */
import type { FuelPlanLine } from './factory-fuel.js'
import type { MachineShiftUse, ShiftUse, ShiftWindow } from './fuel-shifts.js'

/** How long after a shift's planned end its Fuel before is kept. */
export const KEEP_SETTLE_MS = 2 * 3_600_000
/** Days read in one pass of the keep job. */
export const KEEP_DAYS_PER_PASS = 3
/** How often the keep job looks for days once it has caught up. */
export const KEEP_INTERVAL_MS = 60 * 60_000

export interface KeptBefore {
  /** "<factory>|<line id>", as factorysuite_work_plan_items. */
  id: string
  organisationId: string
  factoryCode: string
  day: string
  machine: string
  lineId: string
  vehicleId: string | null
  windowStart: Date | null
  windowEnd: Date | null
  beforeL: number | null
  beforeAt: Date | null
  beforeBy: 'work' | 'refill' | null
  beforeReadAt: Date | null
}

/**
 * The rows to keep for `day`: each line of that day whose shift has settled,
 * with its window's Fuel before. `pending` when a line of the day has not
 * settled yet, so the day is read again on a later pass.
 */
export function keepRows(
  factory: string, orgId: string, day: string, today: string,
  lines: Pick<FuelPlanLine, 'lineId' | 'day' | 'machine'>[], windows: ShiftWindow[], machines: MachineShiftUse[], now: Date,
): { rows: KeptBefore[]; pending: boolean } {
  if (day >= today) return { rows: [], pending: true }
  const useOf = new Map<string, ShiftUse>()
  for (const m of machines) for (const u of m.windows) for (const id of u.lineIds) useOf.set(id, u)
  const windowOf = new Map<string, ShiftWindow>()
  for (const w of windows) for (const id of w.lineIds) windowOf.set(id, w)
  const rows: KeptBefore[] = []
  let pending = false
  const seen = new Set<string>()
  for (const l of lines) {
    if (l.day !== day || seen.has(l.lineId)) continue
    seen.add(l.lineId)
    const w = windowOf.get(l.lineId)
    if (w && w.end.getTime() + KEEP_SETTLE_MS > now.getTime()) { pending = true; continue }
    const u = w ? useOf.get(l.lineId) : undefined
    rows.push({
      id: `${factory}|${l.lineId}`, organisationId: orgId, factoryCode: factory, day, machine: l.machine, lineId: l.lineId,
      vehicleId: w?.vehicleId ?? null, windowStart: w?.start ?? null, windowEnd: w?.end ?? null,
      beforeL: u?.beforeL ?? null, beforeAt: u?.beforeAt ? new Date(u.beforeAt) : null, beforeBy: u?.beforeBy ?? null,
      beforeReadAt: u?.beforeReadAt ? new Date(u.beforeReadAt) : null,
    })
  }
  return { rows, pending }
}

/**
 * The kept figures over the measured ones: a window whose first line is kept
 * for the same window start and end takes its stored Fuel before. Marks it
 * `beforeKept`.
 */
export function applyKept(
  machines: MachineShiftUse[],
  kept: ReadonlyMap<string, Pick<KeptBefore, 'windowStart' | 'windowEnd' | 'beforeL' | 'beforeAt' | 'beforeBy' | 'beforeReadAt'>>,
): MachineShiftUse[] {
  if (!kept.size) return machines
  return machines.map(m => ({
    ...m,
    windows: m.windows.map(u => {
      const k = u.lineIds.length ? kept.get(u.lineIds[0]!) : undefined
      if (!k || k.windowStart?.toISOString() !== u.start || k.windowEnd?.toISOString() !== u.end) return u
      return {
        ...u, beforeKept: true,
        beforeL: k.beforeL, beforeAt: k.beforeAt?.toISOString() ?? null, beforeBy: k.beforeBy,
        beforeReadAt: k.beforeReadAt?.toISOString() ?? null,
      }
    }),
  }))
}
