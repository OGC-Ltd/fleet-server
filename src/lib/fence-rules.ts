/**
 * Geofence rules: who may not use a fence, and what alert fires when they do
 * (operator, 2026-11-11: purpose = no-go zone; rule = tankers must not use
 * this route; when a tanker does, a no-go zone alert is raised).
 *
 * One rule per fence, kept on the fence (`geofences.rule`, JSON). The purpose
 * says what a fence IS; the rule says what is not allowed there. Evaluated on
 * every live frame by lib/zone-presence, on the same containment test the
 * live feed's arrivals use.
 *
 * Pure: no database, no clock of its own. The words here are the ones the
 * geofence form shows (new-ui lib/fenceRule keeps the same sentence).
 */

import { z } from 'zod'

export const RULE_TRIGGERS = ['enter', 'inside'] as const
export type RuleTrigger = typeof RULE_TRIGGERS[number]

export const RULE_ALERT_TYPES = ['nogo'] as const
export type RuleAlertType = typeof RULE_ALERT_TYPES[number]

export const RULE_SEVERITIES = ['critical', 'warning'] as const
export type RuleSeverity = typeof RULE_SEVERITIES[number]

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time is HH:MM')

/**
 * The rule as stored and as the API takes it.
 *
 *   trigger      'enter'  — fires on the frame a unit is seen crossing in.
 *                'inside' — fires whenever a unit is found inside, including
 *                           one that was already there when the rule (or its
 *                           hours) began.
 *   vehicleTypes Wialon classes (vehicles.vehicle_type), compared without case.
 *   fleets       Names of the fleets picked on the form (Menengai's lists live
 *                in new-ui data/fleetGroups), kept for the sentence only. The
 *                form turns each into its units, which go in vehicleIds.
 *   vehicleIds   The picked fleets' units, by id.
 *   units        Units picked one by one on the form: id, and the plate the
 *                sentence names them by.
 *                A unit matches when its type or its id is listed. All lists
 *                empty = every unit.
 *   hours        When the rule holds, on the fleet's clock (Nairobi). `from`
 *                after `to` runs overnight. Null = always.
 *   alert        What it raises.
 */
export const fenceRuleSchema = z.object({
  trigger:      z.enum(RULE_TRIGGERS).default('enter'),
  vehicleTypes: z.array(z.string().trim().min(1).max(60)).max(40).default([]),
  fleets:       z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  vehicleIds:   z.array(z.string().min(1).max(40)).max(2000).default([]),
  units:        z.array(z.object({
    id:    z.string().min(1).max(40),
    plate: z.string().trim().min(1).max(80),
  })).max(500).default([]),
  hours:       z.object({ from: clock, to: clock }).refine((h) => h.from !== h.to, 'From and to are the same time').nullable().default(null),
  alert:        z.object({
    type:     z.enum(RULE_ALERT_TYPES).default('nogo'),
    severity: z.enum(RULE_SEVERITIES).default('critical'),
  }).default({ type: 'nogo', severity: 'critical' }),
})

export type FenceRule = z.infer<typeof fenceRuleSchema>

/** A stored rule, or null when the column holds nothing usable. */
export function readRule(raw: unknown): FenceRule | null {
  if (raw == null) return null
  const r = fenceRuleSchema.safeParse(raw)
  return r.success ? r.data : null
}

const norm = (s: string) => s.trim().toUpperCase()

/** A rule with its lists turned into sets, made once per zone load. */
export interface CompiledRule extends FenceRule {
  types: Set<string>
  ids: Set<string>
  everyone: boolean
}

export function compileRule(rule: FenceRule): CompiledRule {
  const types = new Set(rule.vehicleTypes.map(norm))
  const ids = new Set([...rule.vehicleIds, ...rule.units.map((u) => u.id)])
  return { ...rule, types, ids, everyone: types.size === 0 && ids.size === 0 && rule.fleets.length === 0 }
}

/** Does the rule cover this unit? */
export function ruleCovers(rule: CompiledRule, vehicle: { id: string; vehicleType: string | null | undefined }): boolean {
  if (rule.everyone) return true
  if (rule.ids.has(vehicle.id)) return true
  return vehicle.vehicleType != null && rule.types.has(norm(vehicle.vehicleType))
}

const FLEET_OFFSET_MIN = 3 * 60   // Nairobi, UTC+3 all year
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** Is the rule in force at this moment? */
export function ruleActiveAt(rule: Pick<FenceRule, 'hours'>, atMs: number): boolean {
  if (!rule.hours) return true
  const d = new Date(atMs)
  const local = (d.getUTCHours() * 60 + d.getUTCMinutes() + FLEET_OFFSET_MIN) % 1440
  const from = minutesOf(rule.hours.from)
  const to = minutesOf(rule.hours.to)
  return from < to ? local >= from && local < to : local >= from || local < to
}

const ALERT_NAMES: Record<RuleAlertType, string> = { nogo: 'no-go zone' }

/** Units picked one by one are named up to this many; more are counted. */
const NAMED_UNITS = 3

/** "Tankers", "Tankers and LORRY units", "KCT 507W and KCN 901F", "No unit". */
export function whoWords(rule: Pick<FenceRule, 'vehicleTypes' | 'fleets' | 'vehicleIds'> & { units?: FenceRule['units'] }): string {
  const units = rule.units ?? []
  const parts = [
    ...rule.fleets,
    ...rule.vehicleTypes.map((t) => `${t.trim().toUpperCase()} units`),
    ...(units.length <= NAMED_UNITS ? units.map((u) => u.plate) : [`${units.length} chosen units`]),
  ]
  // Ids with no fleet or plate to name them by (a rule written through the API)
  const loose = new Set(rule.fleets.length ? [] : rule.vehicleIds)
  if (loose.size) parts.push(`${loose.size} chosen ${loose.size === 1 ? 'unit' : 'units'}`)
  if (!parts.length) return 'No unit'
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

/**
 * The rule in plain words, as the form shows it:
 * "Tankers must not enter. Raise a no-go alert." With hours:
 * "Tankers must not enter between 18:00 and 06:00. Raise a no-go alert."
 */
export function ruleWords(rule: FenceRule): string {
  const who = whoWords(rule)
  const none = who === 'No unit'
  const verb = rule.trigger === 'enter'
    ? (none ? 'may enter' : 'must not enter')
    : (none ? 'may be inside' : 'must not be inside')
  const when = rule.hours ? ` between ${rule.hours.from} and ${rule.hours.to}` : ''
  const level = rule.alert.severity === 'critical' ? '' : ' (warning)'
  return `${who} ${verb}${when}. Raise a ${ALERT_NAMES[rule.alert.type].replace(' zone', '')} alert${level}.`
}

/** The alert's own sentence: "KCT 507W entered TANKER NO-GO ROAD, a no-go zone for Tankers." */
export function breachWords(
  rule: FenceRule, who: string, zoneName: string, entered: boolean,
): string {
  const how = entered ? 'entered' : 'is inside'
  return `${who} ${how} ${zoneName}, a ${ALERT_NAMES[rule.alert.type]} for ${whoWords(rule).replace(/^No unit$/, 'every unit')}.`
}

export const RULE_ALERT_TITLE: Record<RuleAlertType, string> = { nogo: 'No-go zone' }
