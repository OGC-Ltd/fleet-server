/**
 * Wialon notification intake.
 *
 * Wialon computes speeding, geofence entry/exit, idling, harsh driving and
 * sensor-threshold rules against each unit's OWN calibrated limits — figures
 * we do not hold. Its "Send a request" action POSTs the result to a URL, so
 * those become alerts here without us inferring anything.
 *
 * Delivery is FIRE AND FORGET: unlike Controltech, Wialon does not retry a
 * failed request. A rejected delivery is an event lost forever, so the parsing
 * here is deliberately permissive and anything usable is kept.
 *
 * Notifications carry no stable id, so one is synthesised from the rule name,
 * unit and trigger time. That makes a duplicate POST for the same trigger
 * idempotent while still letting the same rule fire again later.
 */

import { createHash } from 'crypto'
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { emitDashboardFeed, emitDashboardAlert } from '../../lib/sse.js'
import { parseProviderTimeOr } from '../../lib/provider-time.js'
import { wialonDeviceId } from '../../providers/wialon/wialon.adapter.js'
import type { WialonNotificationInput } from './webhooks.schema.js'

/** Wialon notifications belong to the org its units are registered under. */
const ORG_CODE = 'KASULU'

/**
 * Severity from the rule's NAME, because Wialon sends no severity field.
 * Operators name rules descriptively ("Overspeed 80", "Geofence exit"), so
 * matching on keywords is the only signal available — anything unmatched is
 * reported as a warning rather than silently downgraded.
 */
function severityOf(name: string): 'info' | 'warning' | 'critical' {
  const n = name.toLowerCase()
  if (/\b(sos|panic|emergency|crash|accident|theft|tow)\b/.test(n)) return 'critical'
  if (/\b(enter|entry|arriv|exit|left|depart|ignition|start|stop)\b/.test(n)) return 'info'
  return 'warning'
}

let orgIdCache: string | null = null
async function resolveOrgId(): Promise<string | null> {
  if (orgIdCache) return orgIdCache
  const org = await prisma.organisation.findUnique({ where: { code: ORG_CODE }, select: { id: true } })
  orgIdCache = org?.id ?? null
  return orgIdCache
}

const FLEET_TZ = 'Africa/Nairobi'
const clockFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: FLEET_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
})

export interface WialonNotifyResult { created: number; duplicate: number; skipped: number }

export async function ingestWialonNotifications(
  items: WialonNotificationInput[],
): Promise<WialonNotifyResult> {
  const out: WialonNotifyResult = { created: 0, duplicate: 0, skipped: 0 }
  const organisationId = await resolveOrgId()
  if (!organisationId) {
    logger.warn(`Organisation ${ORG_CODE} not found — Wialon notifications dropped`)
    out.skipped = items.length
    return out
  }

  for (const n of items) {
    const at = parseProviderTimeOr(n.time)

    // Resolve the vehicle by the provider's unit id where given; otherwise by
    // the unit NAME, which is what we store as the registration plate.
    const vehicle = n.unitId != null
      ? await prisma.vehicle.findUnique({
          where:  { deviceId: wialonDeviceId(Number(n.unitId)) },
          select: { id: true, registrationPlate: true },
        })
      : n.unit
        ? await prisma.vehicle.findFirst({
            where:  { organisationId, registrationPlate: n.unit.trim() },
            select: { id: true, registrationPlate: true },
          })
        : null

    // Same rule + unit + trigger time = the same event, however many times it
    // is delivered. Minute precision, since templates rarely carry seconds.
    const externalId = 'wialon:notify:' + createHash('sha1')
      .update(`${n.notification}|${n.unit ?? n.unitId ?? '?'}|${Math.floor(at.getTime() / 60_000)}`)
      .digest('hex').slice(0, 24)

    const severity = severityOf(n.notification)
    const plate = vehicle?.registrationPlate ?? (n.unit?.trim() || null)
    const message = n.text?.trim() || [
      n.notification,
      plate ? `— ${plate}` : null,
      n.driver ? `(${n.driver})` : null,
      n.zone ? `at ${n.zone}` : n.location ? `near ${n.location}` : null,
      n.speed != null ? `${n.speed} km/h` : null,
    ].filter(Boolean).join(' ')

    const existing = await prisma.providerAlert.findUnique({ where: { externalId }, select: { id: true } })
    if (existing) { out.duplicate++; continue }

    const row = await prisma.providerAlert.create({
      data: {
        externalId,
        organisationId,
        vehicleId: vehicle?.id ?? null,
        type:      n.notification.trim(),
        severity,
        message,
        plate,
        createdAt: at,
        source:    'wialon',
        raw:       n as unknown as object,
      },
    })
    out.created++

    emitDashboardFeed(organisationId, {
      id:        `wn-${row.id}`,
      time:      clockFmt.format(at),
      ts:        at.toISOString(),
      type:      severity,
      text:      message,
      source:    'wialon',
      alertType: n.notification.trim(),
      plate,
      vehicleId: vehicle?.id ?? null,
    })

    if (severity === 'critical') {
      emitDashboardAlert(organisationId, {
        alertType: n.notification.trim(), severity: 'CRITICAL', title: message,
        plate, vehicleId: vehicle?.id ?? null, triggeredAt: at.toISOString(), source: 'wialon',
      })
    }
  }

  return out
}
