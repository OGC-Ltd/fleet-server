/**
 * FactorySuite Auto Workshop rows → what our repair workflow needs. Pure: no
 * database, so the mapping is tested on its own (tests/unit/factorysuite-workshop.test.ts).
 * The sync that writes it is modules/repairs/factorysuite-workshop.sync.ts.
 */

import type { FaultCategory } from '../../modules/repairs/repairs.workflow.schema.js'
import type {
  RaiFactorySuiteBreakdownRow, RaiFactorySuiteJobCardRow, RaiFactorySuitePartRow,
} from './raifactorysuite.client.js'

/**
 * FactorySuite's workshop times carry no offset. They are the factory's wall
 * clock, East Africa Time (UTC+3, no daylight saving): measured 2026-11-18,
 * check-ins and releases run 06:00–19:00 with the peak at 07:00, the start of
 * the working day. Read as UTC they would put the peak at 10:00 local and
 * work going on at 22:00. A value that does carry a zone is taken as written.
 */
export function parseFsTime(value: string | null | undefined): Date | null {
  if (!value) return null
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(value)
  const d = new Date(hasZone ? value : `${value}+03:00`)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Our fault category from the card's free text. The workshop types the fault
 * as it likes ("PUNCTURE", "Tire busted", "LOW LEVEL OF ENGINE OIL"), so this
 * is keywords, most specific first: a "brake pipe leak" is brakes, not
 * hydraulics, and a "hydraulic oil leak" is hydraulics, not engine oil.
 * Routine work (greasing, inspections, a service) is 'other' unless it names
 * a system. Never 'fuel_probe': that category makes a probe job, which Fuel
 * Audit and the "Probe reported" mark key on, and a workshop card is not a
 * probe fault found by Fuel Audit.
 */
const RULES: [RegExp, FaultCategory][] = [
  // A lamp, not the brakes: "Brake lights are not functioning".
  [/(brake|tail|head|reverse|indicator|side) ?lights?/i, 'electrical'],
  [/\bgps\b/i, 'gps'],
  [/tracker/i, 'tracker'],
  [/(fuel )?level sensor|\bsensor\b|\bprobe\b/i, 'sensor'],
  [/brake|braker/i, 'brakes'],
  [/tyre|tire|puncture|punctutre|wheel nut|wheel stud|stud loosen|wheel bearing|wheel balance/i, 'tyres'],
  [/hydraulic|bucket|breaker|cylinder|\brams?\b|ripper|riper|boom|lift(ing)? hook/i, 'hydraulics'],
  [/transmission|transimission|gear|clutch|release bearing|final drive|differential|\bdiff\b|drive ?shaft|track ?chain|chain broken|\bchain\b|roller/i, 'transmission'],
  [/spring|shock|steering|suspension/i, 'suspension_steering'],
  [/electric|battery|batteries|alternator|starter|stator|wiper|light|dashboard|ignition|blower|\bac\b|fuse|horn|display/i, 'electrical'],
  [/mirror|door|bumper|bon+et|mudguard|guard|body|cab\b|seat|glass|windscreen|drawbar|lowbed|steep|coupling/i, 'body'],
  [/engine|eng\b|oil|coolant|cooling|radiator|water (pump|outer|outlet|pipe)|fuel|diesel|injector|turbo|air (cle\w*ne?r|filter|clamp|pipe|leak|conector|connector)|fan belt|misfir|starting|stsrting|not start|switching off|exhaust|valve|filter|air volume/i, 'engine'],
]

export function categoryFor(fault: string | null | undefined, diagnosis?: string | null): FaultCategory {
  for (const text of [fault, diagnosis]) {
    if (!text?.trim()) continue
    for (const [re, cat] of RULES) if (re.test(text)) return cat
  }
  return 'other'
}

/** The workflow stages a card can put its job on, in the order a job moves. */
export type CardStage = 'in_workshop' | 'fixing' | 'spare_outsourced' | 'completed' | 'void'

/**
 * Where the card says the job is. Only RELEASED is completed: the workshop
 * has signed the machine out. A card can say "work completed" and still wait
 * on parts (DZ-03, 17 Nov), so the status decides before the timestamps do.
 */
export function cardStage(card: Pick<RaiFactorySuiteJobCardRow,
  'status' | 'repairStartedAt' | 'partsRequestedAt' | 'partsReceivedAt'>): CardStage {
  const status = (card.status ?? '').toUpperCase()
  if (status === 'CANCELLED' || status === 'CANCELED' || status === 'VOID') return 'void'
  if (status === 'RELEASED' || status === 'CLOSED') return 'completed'
  if (status === 'AWAITING_PARTS') return 'spare_outsourced'
  if (card.partsRequestedAt && !card.partsReceivedAt) return 'spare_outsourced'
  if (card.repairStartedAt) return 'fixing'
  return 'in_workshop'
}

/**
 * How far along a stage is, for "never move a job backwards". Fixing and
 * waiting on parts are one rank: a job goes back and forth between them.
 */
const RANK: Record<string, number> = {
  pending: 0, forwarded: 0, remote_fix: 0, awaiting_assessment: 0, booked: 0, towing: 0,
  field_inspection: 1, in_workshop: 1, fixing: 2, spare_outsourced: 2, completed: 3,
}
export function stageRank(stage: string): number {
  return RANK[stage] ?? -1
}

/** Stages at which a flagged job is waiting for the unit to reach the workshop. */
export const AWAITING_ARRIVAL = ['pending', 'forwarded', 'awaiting_assessment', 'booked', 'towing'] as const

const priority = (p: string | null | undefined) => {
  const v = p?.trim().toLowerCase()
  if (!v) return null
  if (v.startsWith('urg')) return 'Urgent'
  if (v.startsWith('no')) return 'Normal' // NORMAL, normal, NOEMAL
  return p!.trim()
}

/** The mirror row's columns for a job card. */
export function jobCardColumns(row: RaiFactorySuiteJobCardRow, orgId: string, vehicleId: string | null) {
  return {
    organisationId:   orgId,
    factoryCode:      row.factoryCode,
    cardNumber:       row.cardNumber,
    machine:          row.machine.trim(),
    vehicleId,
    status:           row.status,
    source:           row.source ?? null,
    priority:         priority(row.priority),
    category:         row.category ?? null,
    reportedFault:    row.reportedFault?.trim() || null,
    diagnosis:        row.diagnosis?.trim() || null,
    checkedInAt:      parseFsTime(row.checkedInAt),
    confirmedDownAt:  parseFsTime(row.confirmedDownAt),
    repairStartedAt:  parseFsTime(row.repairStartedAt),
    partsRequestedAt: parseFsTime(row.partsRequestedAt),
    partsReceivedAt:  parseFsTime(row.partsReceivedAt),
    workCompletedAt:  parseFsTime(row.workCompletedAt),
    releasedAt:       parseFsTime(row.releasedAt),
    isService:        row.service === true,
    serviceType:      row.serviceType ?? null,
    meterIn:          row.meterReadingIn ?? null,
    meterOut:         row.meterReadingOut ?? null,
    fuelIn:           row.fuelLevelIn ?? null,
    fuelOut:          row.fuelLevelOut ?? null,
    fuelSourceIn:     row.fuelSourceIn ?? null,
    fuelSourceOut:    row.fuelSourceOut ?? null,
    fuelDiscrepancy:  row.fuelDiscrepancy === true,
    labourCost:       row.labourCost ?? null,
    partsCost:        row.partsCost ?? null,
  }
}

export function breakdownColumns(row: RaiFactorySuiteBreakdownRow, orgId: string, vehicleId: string | null) {
  return {
    organisationId: orgId,
    factoryCode:    row.factoryCode,
    machine:        row.machine.trim(),
    vehicleId,
    reportedFault:  row.reportedFault?.trim() || null,
    location:       row.location?.trim() || null,
    status:         row.status,
    reportedAt:     parseFsTime(row.reportedAt),
    decidedAt:      parseFsTime(row.decidedAt),
    decisionNote:   row.decisionNote ?? null,
    jobCardNumber:  row.jobCardNumber ?? null,
  }
}

export function partColumns(row: RaiFactorySuitePartRow, orgId: string) {
  return {
    organisationId: orgId,
    factoryCode:    row.factoryCode,
    partNumber:     row.partNumber.trim(),
    description:    row.description?.trim() || null,
    unit:           row.unit ?? null,
    quantityOnHand: row.quantityOnHand ?? null,
    minimumLevel:   row.minimumLevel ?? null,
    unitCost:       row.unitCost ?? null,
    supplier:       row.supplier ?? null,
    active:         row.active !== false,
  }
}

// ── Unchanged rows (2026-11-18) ─────────────────────────────────────────────
// Every pass re-reads the whole feed: ~250 cards every 5 minutes, 1,000 parts
// an hour. Writing each one back, a transaction per card, kept the reconcile
// past its 5-minute watchdog on the first live day. A row is written only when
// it differs from what is stored; the rest only get their synced_at touched.

/** JSON with object keys sorted: jsonb hands keys back in its own order. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

/**
 * A card that needs nothing this pass: stored before with the same feed row
 * and the same unit, and its job already at the card's stage (or no job is due:
 * no tracked unit, or a card cancelled before we saw it). Anything else goes
 * through the full sync, as before.
 */
export function cardUnchanged(
  prev: { raw: unknown; vehicleId: string | null; repairItemId: string | null; appliedStage: string | null } | undefined,
  row: unknown, vehicleId: string | null, stage: string,
): boolean {
  if (!prev || prev.vehicleId !== vehicleId || stableJson(prev.raw) !== stableJson(row)) return false
  if (prev.repairItemId) return prev.appliedStage === stage
  return !vehicleId || stage === 'void'
}

/** Every column the feed sets, stored as given. */
export function partUnchanged(prev: Record<string, unknown> | undefined, cols: ReturnType<typeof partColumns>): boolean {
  if (!prev) return false
  return (Object.keys(cols) as (keyof typeof cols)[]).every((k) => (prev[k] ?? null) === (cols[k] ?? null))
}

/** The machine's name on a card's job: what the workshop wrote, then the card. */
export function suspectedFaultOf(card: { reportedFault: string | null; isService: boolean; serviceType: string | null; cardNumber: string }) {
  if (card.reportedFault) return card.reportedFault
  if (card.isService) return card.serviceType ? `Service (${card.serviceType})` : 'Scheduled service'
  return `Workshop job card ${card.cardNumber}`
}

const EAT_MS = 3 * 3_600_000
const DAY_MS = 86_400_000

/** Midnight East Africa time, `back` days before the day `now` falls on. */
export function eatDayStart(now: Date, back = 0) {
  return new Date(Math.floor((now.getTime() + EAT_MS) / DAY_MS) * DAY_MS - EAT_MS - back * DAY_MS)
}

/**
 * Cards checked in and released per East Africa day, oldest first, today last;
 * days with none are 0. Days before `feedStart` (the feed's first card) are
 * left out: FactorySuite was not sending then, so they are not quiet days.
 */
export function boardDays(days: number, opened: Date[], released: Date[], now = new Date(), feedStart: Date | null = null) {
  const dayOf = (d: Date) => new Date(d.getTime() + EAT_MS).toISOString().slice(0, 10)
  const out = new Map<string, { day: string; opened: number; released: number }>()
  for (let i = days - 1; i >= 0; i--) {
    const day = dayOf(new Date(now.getTime() - i * DAY_MS))
    out.set(day, { day, opened: 0, released: 0 })
  }
  for (const d of opened) { const r = out.get(dayOf(d)); if (r) r.opened++ }
  for (const d of released) { const r = out.get(dayOf(d)); if (r) r.released++ }
  const from = feedStart ? dayOf(feedStart) : ''
  return [...out.values()].filter((r) => r.day >= from)
}
