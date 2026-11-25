/**
 * Which Deliveries report, Van Sales ('vs') or Finished Goods ('fg'), a day-list
 * vehicle or a Planner plan belongs to. new-ui lib/deliveriesLists reads them
 * the same way.
 *
 * A unit can be on both lists the same day, each entry with its own stops
 * (operator, 2026-11-25: "we need the unit for that day to have its vs records,
 * but for FG it judges its own stops ... vs was planned 11 routes on vs but on
 * fg the vs car was planned 2 routes, on fg should focus and only display the
 * two routes attached to it"). Each list is judged on its own plans only.
 */
import { menengaiCategory } from '../../providers/wialon/wialon.unit-name.js'

export type DeliveryList = 'vs' | 'fg'

/** A Planner plan keyed in on the Deliveries tab (planner/keyed-plans). */
export const KEYED_SOURCE = 'manual'

/** A day-list vehicle's report: 'vs' when tagged, else FG (every list saved before the split). */
export const vehicleList = (v: { list?: string | null }): DeliveryList => (v.list === 'vs' ? 'vs' : 'fg')

/** A plate's report by its truck's fleet group: Van Sales trucks on VS, every other on FG. */
export const groupList = (plate: string): DeliveryList => (menengaiCategory(plate) === 'Van Sales' ? 'vs' : 'fg')

/** A Planner plan's report: the list it was moved to, else its truck's fleet group. */
export const planList = (p: { plate: string, list?: string | null }): DeliveryList =>
  (p.list === 'vs' || p.list === 'fg' ? p.list : groupList(p.plate))
