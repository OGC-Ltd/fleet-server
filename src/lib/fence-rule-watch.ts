/**
 * Geofence rules on live positions (lib/fence-rules says what a rule is).
 *
 * Called by lib/zone-presence on every frame, with the containment it has
 * already worked out — which fences the unit is inside now and was inside on
 * the previous frame — so no fence is tested twice and a rule sees exactly
 * the crossings the live feed sees.
 *
 * One alert per VISIT. A visit starts on the first frame inside and ends only
 * once the unit has been outside for EXIT_GRACE_MS, so a tanker running along
 * the edge of a no-go road, flicking in and out on GPS noise, is one alert,
 * not one per flicker. A rule that did not fire when the visit began (the unit
 * is not covered, or it entered outside the rule's hours) stays quiet for the
 * rest of that visit when its trigger is `enter`; an `inside` rule keeps
 * looking, so it fires when its hours begin with the unit still there.
 *
 * The alert goes where the app's other alerts go: the live feed and its
 * durable history (publishNotification, alertType NOGO_ZONE — the Alerts
 * page's Geofences view reads it there), and a push to the organisation, which
 * is also a toast in every open tab (pushService.broadcastToOrg).
 */

import { prisma } from './prisma.js'
import { logger } from './logger.js'
import { getCacheRedis } from './redis.js'
import { publishNotification } from './notifications/notification.store.js'
import { pushService } from '../modules/notifications/notifications.service.js'
import {
  RULE_ALERT_TITLE, breachWords, ruleActiveAt, ruleCovers, type CompiledRule,
} from './fence-rules.js'

/** The alertType every rule alert carries in the feed and its history. */
export const RULE_ALERT_TYPE = 'NOGO_ZONE'

/** How long outside before a visit is over and the next entry alerts again. */
export const EXIT_GRACE_MS = 3 * 60_000

/** An `inside` alert is remembered across restarts this long (or until the visit ends). */
const KEEP_S = 24 * 3600

export interface RuleZone { id: string; name: string; rule: CompiledRule }

interface Visit {
  /** Fired, or decided not to (an `enter` rule judged on its first frame). */
  settled: boolean
  /** When the unit was first seen outside again; null while inside. */
  outSince: number | null
}

/** `${vehicleId}|${zoneId}` → the visit in progress. */
const visits = new Map<string, Visit>()

// ── Vehicle types, per org, only for orgs that have rules ─────────────────────

const TYPES_TTL_MS = 10 * 60_000
const typeCache = new Map<string, { byId: Map<string, string | null>; loadedAt: number }>()

async function vehicleTypeOf(orgId: string, vehicleId: string): Promise<string | null> {
  const now = Date.now()
  let hit = typeCache.get(orgId)
  // Stale, or a unit added since the list was read (re-read at most once a minute)
  const stale = !hit || now - hit.loadedAt > TYPES_TTL_MS || (!hit.byId.has(vehicleId) && now - hit.loadedAt > 60_000)
  if (stale) {
    const rows = await prisma.vehicle.findMany({ where: { organisationId: orgId }, select: { id: true, vehicleType: true } })
    hit = { byId: new Map(rows.map((r) => [r.id, r.vehicleType])), loadedAt: now }
    typeCache.set(orgId, hit)
  }
  return hit!.byId.get(vehicleId) ?? null
}

// ── Remembered across restarts ────────────────────────────────────────────────

/** Without Redis, units found inside in the first minutes after a start were alerted before it. */
const PRIME_MS = 2 * 60_000
let startedAt = Date.now()

/** First alert for this visit? Redis across restarts; memory when Redis is down. */
async function firstAlert(key: string): Promise<boolean> {
  const redis = getCacheRedis()
  if (redis) {
    try {
      return (await redis.set(`fencerule:alerted:${key}`, '1', 'EX', KEEP_S, 'NX')) === 'OK'
    } catch { /* fall through */ }
  }
  // No Redis: units already inside when the process started are not re-alerted.
  return Date.now() - startedAt > PRIME_MS
}

function forget(key: string): void {
  const redis = getCacheRedis()
  if (redis) void redis.del(`fencerule:alerted:${key}`).catch(() => {})
}

// ── The check ────────────────────────────────────────────────────────────────

export interface RuleFrame {
  orgId: string
  vehicleId: string
  plate: string
  /** "KCT 507W · Jane Doe" — the plate with the driver when known. */
  who: string
  at: number
  lat: number
  lng: number
  /** Fences the unit is inside on this frame. */
  inside: ReadonlySet<string>
  /** Fences it was inside on the previous frame; undefined on its first frame. */
  before: ReadonlySet<string> | undefined
  /** Has it moved lately — a parked unit's drift is not a crossing (zone-presence). */
  moved: () => boolean
}

export interface RuleAlert {
  zoneId: string
  zoneName: string
  entered: boolean
  severity: 'critical' | 'warning'
  text: string
}

/** Check one frame against the org's rule fences; publish and return what fired. */
export async function checkFenceRules(f: RuleFrame, zones: readonly RuleZone[]): Promise<RuleAlert[]> {
  const fired: RuleAlert[] = []
  let vehicleType: string | null | undefined

  for (const z of zones) {
    const key = `${f.vehicleId}|${z.id}`
    const v = visits.get(key)

    if (!f.inside.has(z.id)) {
      if (!v) continue
      if (v.outSince == null) v.outSince = f.at
      else if (f.at - v.outSince >= EXIT_GRACE_MS) { visits.delete(key); forget(key) }
      continue
    }

    if (v) {
      v.outSince = null
      if (v.settled) continue
    }
    const visit: Visit = v ?? { settled: false, outSince: null }
    if (!v) visits.set(key, visit)

    const rule = z.rule
    // Seen crossing in on THIS frame: it was outside on the previous one.
    const crossed = f.before !== undefined && !f.before.has(z.id)
    if (rule.trigger === 'enter') {
      // Judged once, on the visit's first frame. A unit first seen already
      // inside (a restart, or a rule added while it was there) did not enter.
      visit.settled = true
      if (!crossed || !f.moved() || !ruleActiveAt(rule, f.at)) continue
    } else if (!ruleActiveAt(rule, f.at)) {
      continue
    }

    vehicleType ??= await vehicleTypeOf(f.orgId, f.vehicleId).catch(() => null)
    if (!ruleCovers(rule, { id: f.vehicleId, vehicleType })) { visit.settled = true; continue }
    visit.settled = true
    if (rule.trigger === 'inside' && !(await firstAlert(key))) continue

    const text = breachWords(rule, f.who, z.name, crossed)
    fired.push({ zoneId: z.id, zoneName: z.name, entered: crossed, severity: rule.alert.severity, text })
    publish(f, z, rule, crossed, text)
  }
  return fired
}

function publish(f: RuleFrame, z: RuleZone, rule: CompiledRule, entered: boolean, text: string): void {
  publishNotification({
    orgId:     f.orgId,
    id:        `fr-${f.vehicleId}-${z.id}-${f.at}`,
    source:    'geofence-rule',
    alertType: RULE_ALERT_TYPE,
    severity:  rule.alert.severity,
    text,
    at:        new Date(f.at),
    plate:     f.plate,
    vehicleId: f.vehicleId,
  })
  void pushService.broadcastToOrg(f.orgId, {
    title: `${RULE_ALERT_TITLE[rule.alert.type]} — ${f.plate}`,
    body:  text,
    data:  {
      alertType: RULE_ALERT_TYPE,
      severity:  rule.alert.severity,
      critical:  rule.alert.severity === 'critical',
      source:    'geofence-rule',
      plate:     f.plate,
      vehicleId: f.vehicleId,
      orgId:     f.orgId,
      geofenceId: z.id,
      zone:      z.name,
      entered,
      lat:       f.lat,
      lng:       f.lng,
      triggeredAt: new Date(f.at).toISOString(),
    },
    tag: `${f.orgId}:${RULE_ALERT_TYPE}:${f.vehicleId}:${z.id}`,
  }).catch((err) => logger.warn({ err, vehicleId: f.vehicleId, zone: z.id }, 'fence rule: push failed'))
}

/** Tests: forget every visit and cached type. */
export function __resetFenceRuleWatch(): void {
  visits.clear()
  typeCache.clear()
  startedAt = 0
}

/** Drop an org's cached vehicle types (a unit's type changed). */
export function invalidateRuleVehicleTypes(orgId?: string): void {
  if (orgId) typeCache.delete(orgId)
  else typeCache.clear()
}
