/**
 * A unit's refuels as its fuel probe saw them: Wialon's own fill report, each
 * refuel counted once. This is the "Filling as per Fuel Probes" column of
 * Aquamist's reconciliation sheet (2026-11-27: KBY 767G and KDH 451K matched
 * Wialon to within 0.5 L on 5 Dec, 6, 8 and 9 Jan).
 *
 * Wialon can report one refuel as several rows, and adding them counts the fuel
 * two or three times:
 * - a unit with two tanks gets a row per tank and one for the total, at the
 *   same moment: KBY 767G, 22 Jan 2026 09:28, 229.41, 213.00 and 253.72 L for
 *   one fill that took the tank from 106.9 to 360.6 L (the sheet printed 368 L);
 * - a long ramp is split, each part measured over the whole rise (EX-17,
 *   23 Nov 2026: 579.6 L and 231.5 L for one 576 L issue).
 * So rows within STOP_GAP_MS of each other that are at the same moment, or whose
 * before-to-after levels overlap, are one refuel, at its largest row. Fills one
 * after another (the level rose again from where the last left it) stay apart.
 *
 * Pure.
 */
import type { FuelFillingEvent } from '../../providers/wialon/wialon.reports.js'
import { STOP_GAP_MS } from './fuel-balance.js'

/** Rows this close in time are one refuel seen by several sensors. */
export const SAME_FILL_MS = 2 * 60_000

export interface ProbeFill {
  /** When Wialon stamped the refuel, ms. */
  at:      number
  litres:  number
  beforeL: number | null
  afterL:  number | null
  /** Rows of Wialon's report folded into this refuel. */
  rows:    number
}

const litres = (ml: number | null) => (ml == null || !Number.isFinite(ml) ? null : Math.round(ml) / 1000)

export function probeFillsOf(events: readonly FuelFillingEvent[]): ProbeFill[] {
  const fills: ProbeFill[] = []
  for (const e of [...events].sort((a, b) => a.filledAt.getTime() - b.filledAt.getTime())) {
    const row: ProbeFill = {
      at: e.filledAt.getTime(), litres: litres(e.filledMl) ?? 0,
      beforeL: litres(e.initialFuelLevelMl), afterL: litres(e.finalFuelLevelMl), rows: 1,
    }
    const same = fills.find(g => Math.abs(row.at - g.at) <= STOP_GAP_MS && (
      Math.abs(row.at - g.at) <= SAME_FILL_MS
      || (row.beforeL != null && row.afterL != null && g.beforeL != null && g.afterL != null
        && row.beforeL < g.afterL && g.beforeL < row.afterL)))
    if (!same) { fills.push(row); continue }
    same.rows += 1
    if (row.litres > same.litres) Object.assign(same, { at: row.at, litres: row.litres, beforeL: row.beforeL, afterL: row.afterL })
  }
  return fills.sort((a, b) => a.at - b.at)
}

/** A plate as a key: "KBY 767G", "kby767g" and "KBY-767G" are one unit. */
export const plateKey = (plate: string): string => plate.replace(/[^a-z0-9]/gi, '').toUpperCase()
