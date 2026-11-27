/**
 * Fuel performance review — every unit's refills judged against its standard.
 *
 * The method is the operator's own (Kasulu "Fuel Issuance – Performance
 * Review", 2026-10-08). Since FactorySuite's pump issues are kept
 * (factorysuite_fuel_issues; operator 2026-11-28: "now that we are getting the
 * actual fuel getting into tanks and usage we should utilise those values",
 * and "for the days we don't have value the previous days we use the fuel
 * probes"):
 *
 *   - Fuel put in is the litres the PUMP issued (the SIV), with the tank's
 *     rise off the probe beside it. Telemetry refills count only where there
 *     is no pump record: the days before the pump records start, and units
 *     the pumps never fuel.
 *   - The work behind a pump refill is the issue's own meter step (this
 *     reading − the previous fuelling's), as the operator's sheet; telemetry
 *     hours or km only where the issue has no usable reading.
 *
 * The rest is the document's:
 *
 *   - Each refill is compared with the fuel its standard allows for the work
 *     logged since the PREVIOUS refill: rate × hours (L/h machines) or
 *     km ÷ rate (km/L vehicles). 100% = on standard; higher is worse.
 *   - A unit's figure is its MEDIAN refill, so one bad reading cannot move it.
 *   - Refills above 5× or below one-tenth of standard are reading errors, not
 *     consumption, and are left out of the median and the excess.
 *   - Excess litres = fuel put in above standard across the usable refills.
 *   - A unit is judged on at least 5 usable refills (3 for CASE tractors,
 *     which refill rarely).
 *
 * Pure: the service reads the rows, this file does the arithmetic, so the
 * whole method is testable without a database.
 */

import { wallClock } from '../planner/fuel-refills.js'
import type { RaiFactorySuiteFuelIssueRow } from '../../providers/raifactorysuite/raifactorysuite.client.js'

export type RateBasis = 'HOURS' | 'DISTANCE'

export interface ReviewVehicle {
  id: string
  name: string
  category: string | null
  /** L/h for HOURS, km/L for DISTANCE. */
  rate: number | null
  basis: RateBasis | null
}

export type FillSource = 'pump' | 'probe'

export interface ReviewFill {
  at: Date
  litres: number
  /** 'probe' (a telemetry REFILL) when left out. */
  source?: FillSource
  /** Pump issues: the meter step the issue records (hours or km since the previous fuelling). */
  meterWork?: number | null
  /** Pump issues: what the tank rose by on the probe (FactorySuite's sensor check), when it read. */
  tankL?: number | null
  /** Pump issues: FactorySuite's MATCH / MISMATCH / NO_SENSOR / NO_READING. */
  check?: string | null
  siv?: string | null
}

/** One fleet day of work. `day` is the fleet-day key, YYYY-MM-DD. */
export interface ReviewDay {
  day: string
  /** Engine-hours meter reading at the end of the day, when the tracker sends one. */
  meter: number | null
  /** Seconds the engine ran, integrated from fixes. */
  engineSeconds: number | null
  distanceKm: number | null
}

/** How far a single refill's record can be trusted, as the document counts them. */
export type RecordClass = 'near' | 'over' | 'implausible' | 'missing'

export interface ReviewRefill {
  at: string
  litres: number
  source: FillSource
  /** Tank rise on the probe for a pump issue; null where it did not read. */
  tankL: number | null
  check: string | null
  siv: string | null
  /** Hours or km since the previous refill. */
  work: number
  /** Where `work` came from: the issue's meter, or telemetry. */
  workFrom: 'meter' | 'telemetry'
  standardL: number | null
  /** litres ÷ standard; null where there is no standard or no work. */
  ratio: number | null
  record: RecordClass
}

export type UnitStatus = 'over' | 'slightly-over' | 'within' | 'unassessed'

export interface ReviewUnit {
  id: string
  name: string
  /** Short reference, e.g. "EX 08", read off the name. */
  ref: string
  group: string
  rate: number | null
  basis: RateBasis | null
  /** Litres put in over the period (every refill, the first included). */
  litres: number
  /** Of `litres`, issued at the pump / seen as telemetry refills. */
  pumpL: number
  probeL: number
  /** Tank rise on the probe over the pump issues it read, and the litres those issues gave. */
  tankL: number
  issuedWithTankL: number
  refills: number
  usableRefills: number
  /** Median refill as a share of standard (1 = 100%); null when not judged. */
  ratio: number | null
  excessL: number
  /** Hours (HOURS) or km (DISTANCE) logged over the period; with pump meters, from refill to refill. */
  work: number
  status: UnitStatus
  /** Refills logged against next to no work — the "meter readings to correct" list. */
  nearZeroWork: number
  /** Present only when asked for (single-unit drill-down). */
  refillRows?: ReviewRefill[]
}

export interface ReviewGroup {
  group: string
  units: number
  assessed: number
  litres: number
  share: number
  excessL: number
  overCount: number
  /** Median of the assessed units' ratios. */
  ratio: number | null
  worst: string | null
  best: string | null
  /** The unit with the most litres in the group. */
  busiest: string | null
}

export interface ReviewMonth {
  month: string
  /** Days of the period that fall in this month. */
  days: number
  litres: number
  pumpL: number
  tankL: number
  perDay: number
}

export interface PerformanceReview {
  from: string
  to: string
  days: number
  /** Days from the first refill on record (or `from`) to `to`. */
  coveredDays: number
  /** 'pump' when every refill is a pump issue, 'telemetry' when none is. */
  source: 'pump' | 'telemetry' | 'mixed'
  /** The first day with a pump issue in the period; null without any. */
  pumpFrom: string | null
  totals: {
    litres: number
    pumpL: number
    probeL: number
    tankL: number
    issuedWithTankL: number
    /** Pump issues by FactorySuite's probe check. */
    checks: { match: number; mismatch: number; noSensor: number; noReading: number }
    refills: number
    units: number
    unitsWithStandard: number
    assessedUnits: number
    excessL: number
    excessShare: number
    perDay: number
    /** perDay × 30, the "typical month" the document quotes. */
    perMonth: number
  }
  months: ReviewMonth[]
  groups: ReviewGroup[]
  records: Record<RecordClass, number>
  units: ReviewUnit[]
}

export const OVER = 1.10
export const ERROR_HIGH = 5
export const ERROR_LOW = 0.1
/** Above this a refill is "plausible, well over standard" (the source data's flag). */
export const WELL_OVER = 2
export const MIN_REFILLS = 5
export const MIN_REFILLS_TRACTOR = 3
/** Hours or km below which a refill was logged against next to no work. */
const NEAR_ZERO = { HOURS: 0.5, DISTANCE: 1 } as const
/** A meter step beyond this a day (since the previous refill) is a keying slip, not work. */
const MAX_METER_A_DAY = { HOURS: 24, DISTANCE: 1500 } as const
/** The days allowed a refill with no earlier one in the period to time it from. */
const MAX_METER_UNTIMED_DAYS = 14
/** A day's meter step outside this is a reset or a swap, not work. */
const MAX_METER_STEP_H = 24

const DAY_MS = 86_400_000
/** Fleet days are Kenyan (UTC+3), see lib/provider-time. */
const EAT_MS = 3 * 3_600_000

/**
 * The document's equipment groups, from the register's 49 messy categories
 * and, where it has none, the plate's family prefix (EX, DZ, FT…).
 */
export function equipmentGroup(category: string | null, name: string): string {
  const c = (category ?? '').toLowerCase()
  const ref = unitRef(name).toUpperCase()
  if (/excavat/.test(c) || /^EX\b/.test(ref)) return 'Excavators'
  if (/dozer/.test(c) || /^DZ\b/.test(ref)) return 'Bulldozers'
  if (/generator/.test(c) || /^DG\b/.test(ref)) return 'Diesel generators'
  if (/^case\b/.test(c)) return 'CASE tractors'
  if (/challenger/.test(c) || /^FES\s*\d/.test(ref)) return 'Challenger tractors'
  if (/tractor/.test(c) || /^CTR\b/.test(ref)) return 'Other tractors'
  if (/truck/.test(c) || /^(FTT?|DB|HFT|HPT|HST)\b/.test(ref)) return 'Trucks'
  if (/loader/.test(c) || /^WL\b/.test(ref)) return 'Wheel loaders'
  if (/grader/.test(c) || /^GR\b/.test(ref)) return 'Graders'
  if (/lmv/.test(c) || /^LMV\b/.test(ref)) return 'Light vehicles'
  return 'Other equipment'
}

/**
 * The unit's own reference, after every prefix: "MUFINDI: EX 08" → "EX 08",
 * "CIVIL - Menengai - KBY 679F" → "KBY 679F" (Menengai names carry a
 * department AND the org). A separator is a colon, or a dash with a space on
 * at least one side, so a reference like "FT-07" is never split.
 */
export function unitRef(name: string): string {
  const parts = name.split(/\s*:\s*|\s+[-–]\s*|\s*[-–]\s+/).map(p => p.trim()).filter(Boolean)
  return parts.at(-1) ?? name.trim()
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

export function classify(ratio: number | null): RecordClass {
  if (ratio == null) return 'missing'
  if (ratio > ERROR_HIGH || ratio < ERROR_LOW) return 'implausible'
  if (ratio > WELL_OVER) return 'over'
  return 'near'
}

export function statusOf(ratio: number | null): UnitStatus {
  if (ratio == null) return 'unassessed'
  if (ratio >= OVER) return 'over'
  if (ratio > 1) return 'slightly-over'
  return 'within'
}

const dayStartMs = (key: string) => Date.parse(`${key}T00:00:00.000Z`) - EAT_MS
const dayKeyOf = (ms: number) => new Date(ms + EAT_MS).toISOString().slice(0, 10)

/**
 * Work done on each day — hours from the meter's step where it is sane, the
 * integrated engine time otherwise; km from distance.
 */
export function dailyWork(days: ReviewDay[], basis: RateBasis): Map<string, number> {
  const out = new Map<string, number>()
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day))
  let prevMeter: number | null = null
  let prevKey: string | null = null
  for (const d of sorted) {
    let w = 0
    if (basis === 'DISTANCE') {
      w = Math.max(0, d.distanceKm ?? 0)
    } else {
      const consecutive = prevKey != null && dayStartMs(d.day) - dayStartMs(prevKey) === DAY_MS
      const step = d.meter != null && prevMeter != null && consecutive ? d.meter - prevMeter : null
      w = step != null && step >= 0 && step <= MAX_METER_STEP_H
        ? step
        : Math.max(0, (d.engineSeconds ?? 0) / 3600)
    }
    out.set(d.day, w)
    if (d.meter != null) { prevMeter = d.meter; prevKey = d.day } else { prevMeter = null; prevKey = null }
  }
  return out
}

/**
 * Work logged between two instants, spreading each day's work evenly over
 * the day. Coarse inside a day, but refills are usually a day or more apart
 * and the median absorbs the rest.
 */
export function workBetween(work: Map<string, number>, fromMs: number, toMs: number): number {
  if (toMs <= fromMs) return 0
  let total = 0
  for (let t = dayStartMs(dayKeyOf(fromMs)); t < toMs; t += DAY_MS) {
    const w = work.get(dayKeyOf(t)) ?? 0
    if (!w) continue
    const overlap = Math.min(toMs, t + DAY_MS) - Math.max(fromMs, t)
    if (overlap > 0) total += w * (overlap / DAY_MS)
  }
  return total
}

/**
 * The work a pump issue records: its meter step, when the step is positive and
 * no more than a day's work for each day since the previous refill (two weeks
 * at most when there is none in the period). Null otherwise: telemetry then.
 */
export function meterStep(f: ReviewFill, prev: ReviewFill | null, basis: RateBasis): number | null {
  const w = f.meterWork
  if (f.source !== 'pump' || w == null || !Number.isFinite(w) || w <= 0) return null
  const days = prev ? Math.max(1, Math.ceil((f.at.getTime() - prev.at.getTime()) / DAY_MS)) : MAX_METER_UNTIMED_DAYS
  return w <= MAX_METER_A_DAY[basis] * days ? w : null
}

export function reviewUnit(
  v: ReviewVehicle, fills: ReviewFill[], days: ReviewDay[], opts: { withRefills?: boolean } = {},
): ReviewUnit {
  const ref = unitRef(v.name)
  const group = equipmentGroup(v.category, v.name)
  const sorted = [...fills].sort((a, b) => a.at.getTime() - b.at.getTime())
  const litres = sorted.reduce((s, f) => s + f.litres, 0)
  const basis = v.basis
  const rate = v.rate != null && v.rate > 0 ? v.rate : null
  const work = basis ? dailyWork(days, basis) : new Map<string, number>()
  const totalWork = [...work.values()].reduce((s, w) => s + w, 0)

  const rows: ReviewRefill[] = []
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i]!
    const prev = i > 0 ? sorted[i - 1]! : null
    const meter = basis ? meterStep(f, prev, basis) : null
    // The first refill has nothing to measure from, unless the pump recorded
    // the meter at the fuelling before it.
    if (!prev && meter == null) continue
    const w = meter ?? (basis && prev ? workBetween(work, prev.at.getTime(), f.at.getTime()) : 0)
    const std = rate && basis && w > 0 ? (basis === 'HOURS' ? rate * w : w / rate) : null
    const ratio = std ? f.litres / std : null
    rows.push({
      at: f.at.toISOString(), litres: f.litres, source: f.source ?? 'probe',
      tankL: f.tankL ?? null, check: f.check ?? null, siv: f.siv ?? null,
      work: w, workFrom: meter != null ? 'meter' : 'telemetry', standardL: std, ratio, record: classify(ratio),
    })
  }
  const pumpFills = sorted.filter(f => f.source === 'pump')
  const read = pumpFills.filter(f => f.tankL != null)

  const usable = rows.filter(r => r.record === 'near' || r.record === 'over')
  const min = group === 'CASE tractors' ? MIN_REFILLS_TRACTOR : MIN_REFILLS
  const ratio = usable.length >= min ? median(usable.map(r => r.ratio!)) : null
  const excessL = usable.reduce((s, r) => s + Math.max(0, r.litres - r.standardL!), 0)
  const nearZero = basis ? rows.filter(r => r.work < NEAR_ZERO[basis]).length : 0

  return {
    id: v.id, name: v.name, ref, group, rate, basis,
    litres,
    pumpL: pumpFills.reduce((s, f) => s + f.litres, 0),
    probeL: sorted.filter(f => f.source !== 'pump').reduce((s, f) => s + f.litres, 0),
    tankL: read.reduce((s, f) => s + f.tankL!, 0),
    issuedWithTankL: read.reduce((s, f) => s + f.litres, 0),
    refills: sorted.length, usableRefills: usable.length,
    ratio, excessL,
    // Pump meters cover refill to refill; telemetry covers the whole period.
    work: rows.some(r => r.workFrom === 'meter') ? rows.reduce((s, r) => s + r.work, 0) : totalWork, status: statusOf(ratio), nearZeroWork: nearZero,
    ...(opts.withRefills ? { refillRows: rows } : {}),
  }
}

/** One pump issue as a refill: the litres issued, when it ended, its meter step and the tank's rise. */
export function pumpFill(i: RaiFactorySuiteFuelIssueRow, day: string): ReviewFill | null {
  const litres = Number(i.quantityIssued)
  if (!Number.isFinite(litres) || litres <= 0 || i.completed === false) return null
  const at = wallClock(i.fuelingEnd) ?? wallClock(i.fuelingStart) ?? new Date(`${day}T12:00:00+03:00`)
  const prev = i.previousReading, now = i.physicalReading
  const rise = i.sensorRiseLitres
  return {
    at, litres, source: 'pump',
    meterWork: prev != null && now != null ? now - prev : null,
    tankL: rise != null && Number.isFinite(rise) ? rise : null,
    check: i.sensorCheck ?? null,
    siv: i.siv ?? null,
  }
}

export interface ReviewInput {
  from: string
  to: string
  vehicles: ReviewVehicle[]
  fills: Map<string, ReviewFill[]>
  days: Map<string, ReviewDay[]>
}

/** `from`/`to` are fleet-day keys, both inclusive. */
export function buildPerformanceReview(input: ReviewInput): PerformanceReview {
  const units: ReviewUnit[] = []
  const records: Record<RecordClass, number> = { near: 0, over: 0, implausible: 0, missing: 0 }
  for (const v of input.vehicles) {
    const fills = input.fills.get(v.id) ?? []
    if (!fills.length) continue
    const u = reviewUnit(v, fills, input.days.get(v.id) ?? [], { withRefills: true })
    for (const r of u.refillRows!) records[r.record]++
    delete u.refillRows
    units.push(u)
  }

  const nDays = Math.round((dayStartMs(input.to) - dayStartMs(input.from)) / DAY_MS) + 1
  const litres = units.reduce((s, u) => s + u.litres, 0)
  const excessL = units.reduce((s, u) => s + u.excessL, 0)
  const pumpL = units.reduce((s, u) => s + u.pumpL, 0)

  // Litres by calendar month, over the days of the period that fall in it.
  const monthDays = new Map<string, number>()
  for (let i = 0; i < nDays; i++) {
    const m = dayKeyOf(dayStartMs(input.from) + i * DAY_MS).slice(0, 7)
    monthDays.set(m, (monthDays.get(m) ?? 0) + 1)
  }
  const monthLitres = new Map<string, { litres: number; pumpL: number; tankL: number }>()
  const checks = { match: 0, mismatch: 0, noSensor: 0, noReading: 0 }
  let firstPump = Infinity
  for (const fills of input.fills.values()) {
    for (const f of fills) {
      if (f.source === 'pump') {
        firstPump = Math.min(firstPump, f.at.getTime())
        const c = String(f.check ?? '').toUpperCase()
        if (c === 'MATCH') checks.match++
        else if (c === 'MISMATCH') checks.mismatch++
        else if (c === 'NO_SENSOR') checks.noSensor++
        else checks.noReading++
      }
      const m = dayKeyOf(f.at.getTime()).slice(0, 7)
      if (!monthDays.has(m)) continue
      const t = monthLitres.get(m) ?? { litres: 0, pumpL: 0, tankL: 0 }
      t.litres += f.litres
      if (f.source === 'pump') { t.pumpL += f.litres; t.tankL += f.tankL ?? 0 }
      monthLitres.set(m, t)
    }
  }
  const months = [...monthDays].map(([month, days]) => {
    const t = monthLitres.get(month) ?? { litres: 0, pumpL: 0, tankL: 0 }
    return { month, days, ...t, perDay: t.litres / days }
  })

  const byGroup = new Map<string, ReviewUnit[]>()
  for (const u of units) byGroup.set(u.group, [...(byGroup.get(u.group) ?? []), u])
  const groups: ReviewGroup[] = [...byGroup].map(([group, us]) => {
    const assessed = us.filter(u => u.ratio != null).sort((a, b) => b.ratio! - a.ratio!)
    const gl = us.reduce((s, u) => s + u.litres, 0)
    return {
      group, units: us.length, assessed: assessed.length, litres: gl,
      share: litres ? gl / litres : 0,
      excessL: us.reduce((s, u) => s + u.excessL, 0),
      overCount: assessed.filter(u => u.status === 'over').length,
      ratio: median(assessed.map(u => u.ratio!)),
      worst: assessed[0]?.ref ?? null,
      best: assessed.at(-1)?.ref ?? null,
      busiest: [...us].sort((a, b) => b.litres - a.litres)[0]?.ref ?? null,
    }
  }).sort((a, b) => b.litres - a.litres)

  // Litres a day over the days the ledger COVERS: a period that starts before
  // the first refill on record (Kasulu's ledger opens on 1 July) would
  // otherwise average empty days in and understate the typical month.
  let firstFill = Infinity
  for (const fills of input.fills.values()) for (const f of fills) firstFill = Math.min(firstFill, f.at.getTime())
  const coveredDays = Number.isFinite(firstFill)
    ? Math.min(nDays, Math.round((dayStartMs(input.to) - dayStartMs(dayKeyOf(firstFill))) / DAY_MS) + 1)
    : nDays
  const perDay = coveredDays > 0 ? litres / coveredDays : 0
  return {
    from: input.from, to: input.to, days: nDays, coveredDays,
    source: pumpL === 0 ? 'telemetry' : pumpL === litres ? 'pump' : 'mixed',
    pumpFrom: Number.isFinite(firstPump) ? dayKeyOf(firstPump) : null,
    totals: {
      litres,
      pumpL,
      probeL: litres - pumpL,
      tankL: units.reduce((s, u) => s + u.tankL, 0),
      issuedWithTankL: units.reduce((s, u) => s + u.issuedWithTankL, 0),
      checks,
      refills: units.reduce((s, u) => s + u.refills, 0),
      units: units.length,
      unitsWithStandard: units.filter(u => u.rate != null && u.basis != null).length,
      assessedUnits: units.filter(u => u.ratio != null).length,
      excessL,
      excessShare: litres ? excessL / litres : 0,
      perDay,
      perMonth: perDay * 30,
    },
    months, groups, records,
    units: units.sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1)),
  }
}
