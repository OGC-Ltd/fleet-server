/**
 * Wialon fuel REPORTS → fuel fillings and drains.
 *
 * The live poller reads a fuel LEVEL: a number that goes up and down. Turning
 * that into "someone put in 40 L" or "80 L left this tank while it was parked"
 * is a different job, and Wialon already does it — its report engine applies
 * the probe's own filtering, ignores sloshing and settling, and emits discrete
 * filling and drain events with volumes, times and places. Re-deriving those
 * from our 2-minute samples would be inventing thresholds against known-noisy
 * probes; this reads the provider's answer instead.
 *
 * ## Shape, measured against the live account (2026-08-02)
 *
 * `report/exec_report` returns `reportResult.tables[]`, and each table's rows
 * are fetched separately with `report/select_result_rows`. Two facts drove the
 * design here, both learned by probing rather than from the docs:
 *
 *   1. **Table order is not stable.** For "Advanced Fuel Analysis" one unit
 *      returned trips/fillings/thefts at indexes 0/1/2 and another returned
 *      fillings alone at index 0, because a table with no rows is omitted
 *      entirely. So tables are located by `name` (`unit_fillings`,
 *      `unit_thefts`), never by position.
 *   2. **Column order differs per template.** The Kasulu and Sukari templates
 *      are separate objects maintained by the operator, and the thefts table
 *      in one carries "Initial speed" while the standalone theft template does
 *      not. So cells are located by HEADER LABEL, never by index.
 *
 * Cells are either a plain string ("80.83 l", "0.01 km", "") or an object
 * `{ t, v, x, y }` where `t` is the display text, `v` a unix timestamp and
 * `x`/`y` the coordinates.
 */

import type { WialonClient } from './wialon.client.js'

// ─── raw response shapes ───────────────────────────────────────────────────

export interface ReportCellObject { t?: string; v?: number; x?: number; y?: number }
export type ReportCell = string | number | ReportCellObject | null

export interface ReportRow { c?: ReportCell[] }

export interface ReportTable {
  name?:   string
  label?:  string
  rows?:   number
  header?: string[]
}

/** Tables we know how to read. Anything else in a template is ignored. */
export const FILLINGS_TABLE = 'unit_fillings'
export const THEFTS_TABLE   = 'unit_thefts'

// ─── cell readers ──────────────────────────────────────────────────────────

const isCellObject = (c: ReportCell): c is ReportCellObject =>
  typeof c === 'object' && c !== null

/** Display text of a cell, whichever form it arrived in. */
export function cellText(c: ReportCell): string | null {
  if (c == null) return null
  if (typeof c === 'string') return c.trim() || null
  if (typeof c === 'number') return String(c)
  return c.t?.trim() || null
}

/**
 * Leading number out of a measurement cell: "80.83 l" → 80.83, "0.01 km" → 0.01.
 *
 * Returns null for the blanks Wialon uses for "not applicable" — "", " " and
 * "-----" all appear in live rows. A blank is not a zero: a filling row with no
 * mileage means the odometer was not reported, and recording 0 km would be a
 * measurement we never took.
 */
export function cellNumber(c: ReportCell): number | null {
  const text = cellText(c)
  if (text == null) return null
  const m = /^-?\d+(?:[.,]\d+)?/.exec(text.replace(/\s+/g, ''))
  if (!m) return null
  const n = Number(m[0].replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/** Unix-seconds timestamp of a time cell, as a Date. */
export function cellDate(c: ReportCell): Date | null {
  if (!isCellObject(c) || typeof c.v !== 'number' || !Number.isFinite(c.v)) return null
  const d = new Date(c.v * 1000)
  return Number.isNaN(d.getTime()) ? null : d
}

const toMl = (litres: number | null): number | null =>
  litres == null ? null : Math.round(litres * 1000)

// ─── header-driven column lookup ───────────────────────────────────────────

/**
 * Find a column by matching its header against patterns, in order.
 *
 * Header labels are operator-authored ("Drained" in one template, "Stolen" in
 * another; "Beginning" vs "Start Time"), so each field lists every spelling
 * seen on the account and takes the first that matches.
 */
export function columnIndex(header: string[] | undefined, patterns: RegExp[]): number {
  if (!header) return -1
  for (const p of patterns) {
    const i = header.findIndex(h => p.test((h ?? '').trim()))
    if (i >= 0) return i
  }
  return -1
}

const at = (row: ReportRow, i: number): ReportCell => (i >= 0 ? row.c?.[i] ?? null : null)

// ─── mapped events ─────────────────────────────────────────────────────────

export interface FuelFillingEvent {
  filledAt:           Date
  filledMl:           number
  initialFuelLevelMl: number | null
  finalFuelLevelMl:   number | null
  location:           string | null
  mileageAtFillKm:    number | null
}

export interface FuelTheftEvent {
  beganAt:            Date
  detectedAt:         Date
  stolenMl:           number
  initialFuelLevelMl: number | null
  finalFuelLevelMl:   number | null
  initialLocation:    string | null
  initialSpeedKmh:    number | null
}

/**
 * `unit_fillings` rows → filling events.
 *
 * A row without a time or without a volume is dropped rather than defaulted:
 * both are the substance of the record, and a filling of "0 L at some point"
 * is not a fact worth storing.
 */
export function mapFillings(table: ReportTable, rows: ReportRow[]): FuelFillingEvent[] {
  const h = table.header
  const iTime    = columnIndex(h, [/^time$/i, /time/i])
  const iInitial = columnIndex(h, [/^initial fuel level$/i, /initial.*level/i])
  const iFilled  = columnIndex(h, [/^filled$/i, /filled/i, /^filling/i])
  const iFinal   = columnIndex(h, [/^final fuel level$/i, /final.*level/i])
  const iPlace   = columnIndex(h, [/^location$/i, /location/i])
  const iMileage = columnIndex(h, [/^mileage$/i])

  const out: FuelFillingEvent[] = []
  for (const row of rows) {
    const filledAt = cellDate(at(row, iTime))
    const filledMl = toMl(cellNumber(at(row, iFilled)))
    if (!filledAt || filledMl == null || filledMl <= 0) continue

    out.push({
      filledAt,
      filledMl,
      initialFuelLevelMl: toMl(cellNumber(at(row, iInitial))),
      finalFuelLevelMl:   toMl(cellNumber(at(row, iFinal))),
      location:           cellText(at(row, iPlace)),
      mileageAtFillKm:    cellNumber(at(row, iMileage)),
    })
  }
  return out
}

/**
 * `unit_thefts` rows → drain events.
 *
 * Both templates on the account name the columns differently — "Beginning" /
 * "Drained" on the standalone theft report, "Start Time" / "Stolen" inside
 * Advanced Fuel Analysis — hence the alternatives. `detectedAt` falls back to
 * the start time: some drains are instantaneous and both stamps are equal.
 */
export function mapThefts(table: ReportTable, rows: ReportRow[]): FuelTheftEvent[] {
  const h = table.header
  const iBegan   = columnIndex(h, [/^beginning$/i, /^start time$/i, /^begin/i, /start.*time/i])
  const iEnd     = columnIndex(h, [/^time$/i, /^end time$/i])
  const iPlace   = columnIndex(h, [/^initial location$/i, /^start location$/i, /initial.*location/i, /start.*location/i])
  const iStolen  = columnIndex(h, [/^drained$/i, /^stolen$/i, /drained/i, /stolen/i])
  const iInitial = columnIndex(h, [/^initial fuel level$/i, /initial.*level/i])
  const iFinal   = columnIndex(h, [/^final fuel level$/i, /final.*level/i])
  const iSpeed   = columnIndex(h, [/^initial speed$/i, /initial.*speed/i])

  const out: FuelTheftEvent[] = []
  for (const row of rows) {
    const beganAt  = cellDate(at(row, iBegan))
    const stolenMl = toMl(cellNumber(at(row, iStolen)))
    if (!beganAt || stolenMl == null || stolenMl <= 0) continue

    const finalMl   = toMl(cellNumber(at(row, iFinal)))
    // The standalone theft template reports the level AFTER the drain but not
    // before, so the initial level is reconstructed from the two figures it
    // does give. Arithmetic on the provider's own numbers, not an estimate.
    const initialMl = toMl(cellNumber(at(row, iInitial)))
      ?? (finalMl != null ? finalMl + stolenMl : null)

    out.push({
      beganAt,
      detectedAt:         cellDate(at(row, iEnd)) ?? beganAt,
      stolenMl,
      initialFuelLevelMl: initialMl,
      finalFuelLevelMl:   finalMl,
      initialLocation:    cellText(at(row, iPlace)),
      initialSpeedKmh:    cellNumber(at(row, iSpeed)),
    })
  }
  return out
}

// ─── execution ─────────────────────────────────────────────────────────────

export interface ReportTemplate { id: number; n?: string; ct?: string }
export interface WialonResource { id: number; nm?: string; rep?: Record<string, ReportTemplate> }

/**
 * Report templates on a resource.
 *
 * All 32 data flags are requested: resources number eight on this account, so
 * the payload is trivial, and the published flag tables have already proved
 * unreliable here (0x200000/`netconn` had to be found by probing).
 */
export async function listReportTemplates(client: WialonClient, resourceId: number): Promise<ReportTemplate[]> {
  const res = await client.call<{ items?: WialonResource[] }>('core/search_items', {
    spec: { itemsType: 'avl_resource', propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' },
    force: 1,
    flags: 0xFFFFFFFF,
    from: 0,
    to: 0xFFFFFFFF,
  })
  const resource = (res.items ?? []).find(r => r.id === resourceId)
  return Object.values(resource?.rep ?? {})
}

export interface UnitFuelEvents {
  fillings: FuelFillingEvent[]
  thefts:   FuelTheftEvent[]
}

/**
 * Run one per-unit fuel report and return its filling and drain events.
 *
 * `cleanup_result` runs even on failure — an abandoned result stays allocated
 * on Wialon's side, and this is called once per vehicle per night.
 */
export async function fetchUnitFuelEvents(
  client: WialonClient,
  opts: { resourceId: number; templateId: number; unitId: number; from: Date; to: Date; maxRows?: number },
): Promise<UnitFuelEvents> {
  const out: UnitFuelEvents = { fillings: [], thefts: [] }
  const maxRows = opts.maxRows ?? 5000

  try {
    const res = await client.call<{ reportResult?: { tables?: ReportTable[] } }>('report/exec_report', {
      reportResourceId:  opts.resourceId,
      reportTemplateId:  opts.templateId,
      reportObjectId:    opts.unitId,
      reportObjectSecId: 0,
      interval: {
        from:  Math.floor(opts.from.getTime() / 1000),
        to:    Math.floor(opts.to.getTime() / 1000),
        flags: 0,     // absolute range
      },
    })

    const tables = res.reportResult?.tables ?? []
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i]!
      const name  = table.name ?? ''
      if (name !== FILLINGS_TABLE && name !== THEFTS_TABLE) continue
      const count = Math.min(table.rows ?? 0, maxRows)
      if (count <= 0) continue

      const rows = await client.call<ReportRow[]>('report/select_result_rows', {
        tableIndex: i,
        config: { type: 'range', data: { from: 0, to: count - 1, level: 0 } },
      })
      const list = Array.isArray(rows) ? rows : []

      if (name === FILLINGS_TABLE) out.fillings.push(...mapFillings(table, list))
      else                         out.thefts.push(...mapThefts(table, list))
    }
  } finally {
    await client.call('report/cleanup_result', {}).catch(() => { /* best effort */ })
  }

  return out
}
