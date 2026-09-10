/**
 * The weighbridge day, as the page reads it.
 *
 * The grid shows one centre at a time, but three of the things on it are
 * statements about the DAY and would be wrong if computed from the visible
 * rows: the stats strip says "across all bridges", the tab counts have to be
 * right for tabs you are not looking at, and a lorry's ticket sequence belongs
 * to the lorry rather than to the bridge. So the whole day is read once and
 * narrowed last — see the repository.
 */

import { BadRequestError } from '../../core/errors/errors.js'
import { fleetDayBounds, fleetDayKey } from '../../lib/provider-time.js'
import { knownCentres } from './weighment.ingest.js'
import * as repo from './weighment.repository.js'
import type { WeighmentRow } from './weighment.repository.js'
import type { WeighmentQuery } from './weighment.schema.js'

/** One ticket, with the two things the row cannot know about itself. */
export interface WeighmentDto {
  id:            string
  category:      'CANE_DELIVERY' | 'CANE_TRANSFER'
  /** The scale's ticket number, as a STRING: token numbers are ten digits and
   *  climbing, and JSON numbers stop being exact well before a database
   *  bigint does. The page treats it as an identifier, never as a number. */
  token:         string
  tokenAt:       string
  vehicleNo:     string
  vehiclePlate:  string
  /** Our vehicle, when the plate is one we track. Null for the contractors'
   *  lorries and farmers' tractors that make up most of this traffic. */
  vehicleId:     string | null
  driverName:    string
  centerCode:    number
  centerName:    string

  grossWeightKg: number | null
  grossAt:       string | null
  grossOperator: string | null
  grossBridgeNo: number | null
  tareWeightKg:  number | null
  tareAt:        string | null
  tareOperator:  string | null
  tareBridgeNo:  number | null
  netWeightKg:   number | null

  factoryGrossWeightKg: number | null
  factoryGrossAt:       string | null
  factoryGrossOperator: string | null
  factoryGrossBridgeNo: number | null
  factoryTareWeightKg:  number | null
  factoryTareAt:        string | null
  factoryTareOperator:  string | null
  factoryTareBridgeNo:  number | null
  factoryNetWeightKg:   number | null
  productName:          string | null

  /** How long the lorry was on the ground between its tare and its gross —
   *  the loading time, when both stamps exist. */
  turnaroundMs:  number | null
  /** Where this ticket sits in that lorry's day: 1 for its first, 2 for its
   *  second. Counted ACROSS bridges, because the lorry does not start its day
   *  again when it drives to another one. */
  seq:           number
  /** Tickets that lorry did in the whole day — the same number on each of its
   *  rows, so the grid can say "3rd of 4" without a second query. */
  vehicleTickets: number
  /** Since that lorry's PREVIOUS ticket. Null on its first — which is the
   *  honest answer, not zero: there is no earlier ticket to measure from. */
  sincePreviousMs: number | null
}

export interface WeighmentDayStats {
  /** Tickets raised in the day, every bridge. A ticket is the unit here, not a
   *  trip over a scale: a delivery is weighed twice and a transfer four times,
   *  and nobody at a bridge counts those separately. */
  weighments:     number
  /** Distinct lorries, matched on the normalised plate so "KTCC 849B" and
   *  "KTCC849B" are one machine rather than two. */
  uniqueVehicles: number
  /** The largest net load recorded anywhere that day, and which ticket it was
   *  — a number with no ticket behind it cannot be checked. */
  heaviestNetKg:  number | null
  heaviest:       { token: string; vehicleNo: string; centerName: string; netWeightKg: number; at: string } | null
  /** Everything weighed in, for the strip's tooltip. */
  totalNetKg:     number
}

export interface WeighmentDayResult {
  day:      string
  centres:  { code: number; name: string; count: number }[]
  stats:    WeighmentDayStats
  rows:     WeighmentDto[]
  /** Rows in the day before the centre and search filters — so the page can
   *  say "nothing matched" rather than "nothing happened". */
  matched:  number
  total:    number
  /** The span we actually hold tickets for, so the date picker can bound
   *  itself to it instead of offering a calendar that is mostly empty. */
  captured: { first: string; last: string } | null
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

/**
 * Loading time for one ticket.
 *
 * The order is not assumed. Most of this fleet weighs empty first and comes
 * back loaded (715 of 729 tickets on 2026-09-09), but 14 did the opposite, and
 * a subtraction written the wrong way round would report those as negative
 * hours rather than as what they are.
 */
function turnaround(row: WeighmentRow): number | null {
  if (!row.grossAt || !row.tareAt) return null
  return Math.abs(row.grossAt.getTime() - row.tareAt.getTime())
}

function toDto(row: WeighmentRow, seq: number, vehicleTickets: number, sincePreviousMs: number | null): WeighmentDto {
  return {
    id:            row.id,
    category:      row.category,
    token:         row.tokenNumber.toString(),
    tokenAt:       row.tokenAt.toISOString(),
    vehicleNo:     row.vehicleNo,
    vehiclePlate:  row.vehiclePlate,
    vehicleId:     row.vehicleId,
    driverName:    row.driverName,
    centerCode:    row.centerCode,
    centerName:    row.centerName,
    grossWeightKg: row.grossWeightKg,
    grossAt:       iso(row.grossAt),
    grossOperator: row.grossOperator,
    grossBridgeNo: row.grossBridgeNo,
    tareWeightKg:  row.tareWeightKg,
    tareAt:        iso(row.tareAt),
    tareOperator:  row.tareOperator,
    tareBridgeNo:  row.tareBridgeNo,
    netWeightKg:   row.netWeightKg,
    factoryGrossWeightKg: row.factoryGrossWeightKg,
    factoryGrossAt:       iso(row.factoryGrossAt),
    factoryGrossOperator: row.factoryGrossOperator,
    factoryGrossBridgeNo: row.factoryGrossBridgeNo,
    factoryTareWeightKg:  row.factoryTareWeightKg,
    factoryTareAt:        iso(row.factoryTareAt),
    factoryTareOperator:  row.factoryTareOperator,
    factoryTareBridgeNo:  row.factoryTareBridgeNo,
    factoryNetWeightKg:   row.factoryNetWeightKg,
    productName:          row.productName,
    turnaroundMs:   turnaround(row),
    seq,
    vehicleTickets,
    sincePreviousMs,
  }
}

/**
 * One fleet day of weighbridge tickets.
 *
 * `day` is a fleet day in Africa/Nairobi, not a UTC one: the bridges start
 * before dawn — the earliest ticket on the day measured was 00:02 — so a UTC
 * day boundary would file the first three hours of every shift under
 * yesterday.
 */
export async function getWeighmentDay(organisationId: string, q: WeighmentQuery): Promise<WeighmentDayResult> {
  const day    = q.day ?? fleetDayKey().toISOString().slice(0, 10)
  const bounds = fleetDayBounds(day)
  if (!bounds) throw new BadRequestError('`day` must be YYYY-MM-DD')

  const all = await repo.findDay(organisationId, bounds.from, bounds.to)

  // ── the lorry's day, computed before any filter narrows it ────────────────
  // Keyed on the NORMALISED plate: the scale operators type the same lorry
  // both ways, and a sequence split across two spellings would report every
  // ticket as a first one with no gap behind it.
  const byVehicle = new Map<string, WeighmentRow[]>()
  for (const row of all) {
    const list = byVehicle.get(row.vehiclePlate)
    if (list) list.push(row)
    else byVehicle.set(row.vehiclePlate, [row])
  }

  const seqOf     = new Map<string, number>()
  const gapOf     = new Map<string, number | null>()
  const ticketsOf = new Map<string, number>()
  for (const [, list] of byVehicle) {
    // `findDay` returns the day in ticket order already, so this is the order
    // the lorry actually worked in.
    list.forEach((row, i) => {
      seqOf.set(row.id, i + 1)
      ticketsOf.set(row.id, list.length)
      gapOf.set(row.id, i === 0 ? null : row.tokenAt.getTime() - list[i - 1]!.tokenAt.getTime())
    })
  }

  // ── the day's stats, every bridge ─────────────────────────────────────────
  let heaviest: WeighmentRow | null = null
  let totalNetKg = 0
  for (const row of all) {
    const net = row.netWeightKg
    if (net == null) continue
    totalNetKg += net
    if (!heaviest || net > (heaviest.netWeightKg ?? -Infinity)) heaviest = row
  }

  const stats: WeighmentDayStats = {
    weighments:     all.length,
    uniqueVehicles: byVehicle.size,
    heaviestNetKg:  heaviest?.netWeightKg ?? null,
    heaviest: heaviest && heaviest.netWeightKg != null
      ? {
          token:       heaviest.tokenNumber.toString(),
          vehicleNo:   heaviest.vehicleNo,
          centerName:  heaviest.centerName,
          netWeightKg: heaviest.netWeightKg,
          at:          heaviest.tokenAt.toISOString(),
        }
      : null,
    totalNetKg,
  }

  // Every centre we know of appears, including the ones that weighed nothing:
  // a bridge with no tickets today is information — it is closed, or its feed
  // has stopped — and a tab that vanishes on a quiet day cannot say so.
  const counts = new Map<number, number>()
  const names  = new Map<number, string>()
  for (const c of knownCentres()) { counts.set(c.code, 0); names.set(c.code, c.name) }
  for (const row of all) {
    counts.set(row.centerCode, (counts.get(row.centerCode) ?? 0) + 1)
    names.set(row.centerCode, row.centerName)
  }
  const centres = [...counts.entries()]
    .map(([code, count]) => ({ code, name: names.get(code) ?? `Centre ${code}`, count }))
    .sort((a, b) => a.code - b.code)

  // ── narrow to what the grid is showing ────────────────────────────────────
  let rows = all
  if (q.centre != null) rows = rows.filter(r => r.centerCode === q.centre)
  if (q.q) {
    // Token, plate or driver — the three things somebody standing at a bridge
    // has in their hand. Matched on the normalised plate as well as the
    // written one so a search typed without the space still finds the lorry.
    const needle = q.q.trim().toUpperCase()
    const plateNeedle = needle.replace(/[^A-Z0-9]/g, '')
    rows = rows.filter(r =>
      r.tokenNumber.toString().includes(needle) ||
      r.vehicleNo.toUpperCase().includes(needle) ||
      (plateNeedle.length > 0 && r.vehiclePlate.includes(plateNeedle)) ||
      r.driverName.toUpperCase().includes(needle),
    )
  }

  // Newest first for the grid — the reverse of the order the sequence needed.
  const dto = rows
    .map(r => toDto(r, seqOf.get(r.id) ?? 1, ticketsOf.get(r.id) ?? 1, gapOf.get(r.id) ?? null))
    .reverse()

  const captured = await repo.findCapturedRange(organisationId)

  return {
    day,
    centres,
    stats,
    rows:    dto,
    matched: dto.length,
    total:   all.length,
    captured: captured
      ? { first: captured.first.toISOString(), last: captured.last.toISOString() }
      : null,
  }
}
