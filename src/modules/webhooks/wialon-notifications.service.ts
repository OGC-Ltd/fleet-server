/**
 * Wialon notification intake.
 *
 * Wialon computes speeding, geofence entry/exit, idling, harsh driving and
 * sensor-threshold rules against each unit's OWN calibrated limits — figures
 * we do not hold. Its "Send a request" action POSTs the result to a URL, so
 * those become alerts here without us inferring anything.
 *
 * Delivery is FIRE AND FORGET: unlike RaiFactorySuite, Wialon does not retry a
 * failed request. A rejected delivery is an event lost forever, so the parsing
 * here is deliberately permissive and anything usable is kept.
 *
 * Notifications carry no stable id, so one is synthesised from the rule name,
 * unit and trigger time. That makes a duplicate POST for the same trigger
 * idempotent while still letting the same rule fire again later.
 */

import { isOnProbeHold } from '../fuel/probe-hold.js'
import { createHash } from 'crypto'
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { eventBus } from '../../lib/event-bus.js'
import { parseProviderTimeOr } from '../../lib/provider-time.js'
import { wialonDeviceId } from '../../providers/wialon/wialon.adapter.js'
import { resolveEstatePlaces } from '../../lib/zone-presence.js'
import type { WialonNotificationInput } from './webhooks.schema.js'

/**
 * Org of last resort, for a notification whose unit we cannot identify.
 *
 * NOT the org of every Wialon notification any more. The token sees eight
 * accounts, and both of our orgs have units under it — Kasulu's under
 * `bact` 30394506, Sukari's under the shared RAI GROUP account. Attributing
 * every delivery to KASULU put Sukari's alerts in another company's feed,
 * which is a tenancy leak, not just a mislabel. The vehicle the notification
 * names is the authority; this is only the fallback when there isn't one.
 */
const FALLBACK_ORG_CODE = 'KASULU'

/**
 * Severity from the rule's NAME, because Wialon sends no severity field.
 * Operators name rules descriptively ("Overspeed 80", "Geofence exit"), so
 * matching on keywords is the only signal available — anything unmatched is
 * reported as a warning rather than silently downgraded.
 */
function severityOf(name: string): 'info' | 'warning' | 'critical' {
  const n = name.toLowerCase()
  // Fuel first: a rule named "Fuel filling stop" must not be read as a "stop"
  // event, and "Fuel drain" has to outrank the generic warning default.
  if (/\b(drain|siphon|siphoning|stolen)\b/.test(n)) return 'critical'
  if (/fuel/.test(n) && /\b(theft|loss|drop|tamper)\b/.test(n)) return 'critical'
  if (/\b(fill|filling|filled|refuel|refill)\b/.test(n)) return 'info'
  if (/\b(sos|panic|emergency|crash|accident|theft|tow)\b/.test(n)) return 'critical'
  if (/\b(enter|entry|arriv|exit|left|depart|ignition|start|stop)\b/.test(n)) return 'info'
  return 'warning'
}

/** A rule about fuel leaving the tank: the two fuel lines of severityOf. */
function isFuelLossRule(name: string): boolean {
  const n = name.toLowerCase()
  return /\b(drain|siphon|siphoning|stolen)\b/.test(n) || (/fuel/.test(n) && /\b(theft|loss|drop|tamper)\b/.test(n))
}

/** "42 L" / "42.5 L" — trailing zeroes on a whole number read as false precision. */
const litres = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} L`

const orgIdCache = new Map<string, string | null>()
async function resolveOrgIdByCode(code: string): Promise<string | null> {
  const hit = orgIdCache.get(code)
  if (hit !== undefined) return hit
  const org = await prisma.organisation.findUnique({ where: { code }, select: { id: true } })
  orgIdCache.set(code, org?.id ?? null)
  return org?.id ?? null
}

export interface WialonNotifyResult { created: number; duplicate: number; skipped: number }

export async function ingestWialonNotifications(
  items: WialonNotificationInput[],
): Promise<WialonNotifyResult> {
  const out: WialonNotifyResult = { created: 0, duplicate: 0, skipped: 0 }
  const fallbackOrgId = await resolveOrgIdByCode(FALLBACK_ORG_CODE)

  for (const n of items) {
    const at = parseProviderTimeOr(n.time)

    // Resolve the vehicle by the provider's unit id where given; otherwise by
    // the unit NAME, which is what we store as the registration plate.
    //
    // The plate lookup is deliberately NOT org-scoped now: the org is what we
    // are trying to learn, so scoping by it would beg the question. Plates are
    // not guaranteed unique across orgs, so an ambiguous match resolves to no
    // vehicle at all rather than to an arbitrary one.
    let vehicle: { id: string; registrationPlate: string; organisationId: string } | null = null
    if (n.unitId != null) {
      vehicle = await prisma.vehicle.findUnique({
        where:  { deviceId: wialonDeviceId(Number(n.unitId)) },
        select: { id: true, registrationPlate: true, organisationId: true },
      })
    } else if (n.unit) {
      const matches = await prisma.vehicle.findMany({
        where:  { registrationPlate: n.unit.trim() },
        select: { id: true, registrationPlate: true, organisationId: true },
        take:   2,
      })
      if (matches.length === 1) vehicle = matches[0]!
      else if (matches.length > 1) {
        logger.warn({ plate: n.unit.trim() }, 'Wialon notification names a plate held by more than one org — not linking it to a vehicle')
      }
    }

    // The vehicle's own org, falling back only when we could not identify it.
    const organisationId = vehicle?.organisationId ?? fallbackOrgId
    if (!organisationId) {
      logger.warn(`Organisation ${FALLBACK_ORG_CODE} not found and unit unidentified — Wialon notification dropped`)
      out.skipped++
      continue
    }

    // Same rule + unit + trigger time = the same event, however many times it
    // is delivered. Minute precision, since templates rarely carry seconds.
    const externalId = 'wialon:notify:' + createHash('sha1')
      .update(`${n.notification}|${n.unit ?? n.unitId ?? '?'}|${Math.floor(at.getTime() / 60_000)}`)
      .digest('hex').slice(0, 24)

    // Probe hold: a fuel-drain rule firing on a unit flagged for a fuel probe
    // repair is kept, as a warning rather than critical (fuel/probe-hold).
    const severity = severityOf(n.notification) === 'critical' && isFuelLossRule(n.notification)
      && vehicle?.id && await isOnProbeHold(vehicle.id)
      ? 'warning' as const
      : severityOf(n.notification)
    const plate = vehicle?.registrationPlate ?? (n.unit?.trim() || null)

    // CALIBRATE THE PLACE AGAINST OUR OWN OVERLAY.
    //
    // `%ZONE%` is the zone WIALON's rule fired against, and in this account
    // that is nearly always one of the 67 `VES` sample circles — 1 km rings
    // bulk-imported from the provider, overlapping, and meaningless to anyone
    // reading the feed. The coordinate is the fact underneath it, so it is
    // re-resolved against the estate features actually drawn on the map and
    // the alert names the boundary an operator recognises.
    //
    // The provider's own label is not lost: the whole notification is kept in
    // `raw`, so what Wialon said remains auditable.
    const place = (n.lat != null && n.lng != null)
      ? await resolveEstatePlaces(organisationId, n.lat, n.lng)
      : []

    // Most specific first, and at most two — "FARM#212 · 2500 Ha Area" reads;
    // the full containment list does not.
    const ourPlace = place.length > 0
      ? place.slice(0, 2).map(p => p.name).join(' · ')
      // Outside every estate feature. `%LOCATION%` is Wialon's reverse-geocoded
      // address, which is a real place rather than one of its zone names, so it
      // still stands in. The zone name never does.
      : n.location?.trim() || null

    // The provider's zone rides along as a CROSS-REFERENCE, never as the place.
    // It is what their rule actually fired against, so quoting it lets someone
    // match our alert to the one in Controltech — but it is a 1 km sample
    // circle, so it is not what we claim the vehicle arrived AT.
    const placeLabel = ourPlace && n.zone?.trim()
      ? `${ourPlace}, near ${n.zone.trim()}`
      : ourPlace

    // A template that authors its own sentence wins — those are the operator's
    // words. But if it substituted `%ZONE%` into them, that provider zone name
    // is the very thing being calibrated away, so the one exact occurrence is
    // swapped for our boundary. Verbatim match only: no parsing, and if the
    // coordinate resolved to nothing the sentence is left exactly as sent.
    const authored = n.text?.trim()
    const message = authored
      ? (n.zone && place.length > 0 ? authored.split(n.zone).join(placeLabel!) : authored)
      : [
          n.notification,
          plate ? `— ${plate}` : null,
          n.driver ? `(${n.driver})` : null,
          placeLabel ? `${place.length > 0 ? 'at' : 'near'} ${placeLabel}` : null,
          // The amount is the whole point of a fuel alert — "possible theft" is
          // actionable at 80 L and noise at 2 L. Rendered only when the rule's
          // template actually sent it; nothing is derived from the tank level.
          n.volumeL != null ? litres(n.volumeL) : null,
          n.fuelLevelL != null ? `(tank ${litres(n.fuelLevelL)})` : null,
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
        // The delivery exactly as sent, plus what its coordinate resolved to on
        // our overlay. Keeping both makes the calibration auditable: whether a
        // "VES 104" alert became "FARM#212" is answerable from the row itself.
        raw: {
          ...n,
          _estateZones:  place.map(p => p.name),
          _providerZone: n.zone ?? null,
        } as unknown as object,
      },
    })
    out.created++

    // Feed + banner + Web Push all fan out from notification.worker — see
    // raifactorysuite-alerts.service for why this no longer emits directly.
    // Only genuinely NEW rows get here (the dedupe above returns early), so
    // `notify` is always on: a Wialon notification is a rule the operator
    // deliberately configured, and it is delivered once with no retry.
    eventBus.publish('provider:alert', {
      orgId:     organisationId,
      id:        `wn-${row.id}`,
      source:    'wialon',
      alertType: n.notification.trim(),
      severity,
      text:      message,
      at,
      plate,
      vehicleId: vehicle?.id ?? null,
      notify:    true,
    })
  }

  return out
}
