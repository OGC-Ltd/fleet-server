/**
 * Harsh-driving worker — subscribes to 'driving:harsh' and records each harsh
 * acceleration and harsh braking a tracker reports as a WARNING alert
 * (operator, 2026-10-21: "hard accelerations and hard brakes … need to be under
 * warning and captured and also listed under safety").
 *
 * The trackers have always sent these (Teltonika Green Driving, io_253/io_254)
 * but nothing read them: they arrive inside ordinary messages, and no Wialon
 * notification rule was set up to call them out. The Wialon adapter now reads
 * every message for them; this writes the row and hands it to the same fan-out
 * every other provider alert takes (notification.worker: feed, history, push).
 *
 * Harsh cornering is reported by the same trackers but is not recorded: it was
 * not asked for, and it is the noisiest of the three on rough estate roads.
 *
 * Idempotent: one row per unit, kind and second, keyed by `externalId`, so the
 * sweep re-reading a unit's last message after a restart writes nothing twice.
 */

import { prisma }        from '../prisma.js'
import { eventBus, type HarshDrivingEvent } from '../event-bus.js'
import { logger }        from '../logger.js'
import { createLimiter } from '../concurrency.js'
import { resolveEstatePlaces } from '../zone-presence.js'

const limit = createLimiter(2)

/** The kinds recorded, as the alert type and the words the feed reads. */
export const HARSH_ALERTS = {
  ACCELERATION: { type: 'HARSH_ACCELERATION', words: 'Harsh acceleration' },
  BRAKING:      { type: 'HARSH_BRAKING',      words: 'Harsh braking' },
} as const

/** The sentence the feed shows: what, which unit, where, how fast, how hard. */
export function harshMessage(
  words: string,
  plate: string,
  place: string | null,
  speedKmh: number | null,
  ms2: number | null,
): string {
  return [
    `${words} — ${plate}`,
    place ? `at ${place}` : null,
    speedKmh != null && speedKmh > 0 ? `${Math.round(speedKmh)} km/h` : null,
    ms2 != null ? `(${ms2.toFixed(1)} m/s²)` : null,
  ].filter(Boolean).join(' ')
}

export async function recordHarshEvent(e: HarshDrivingEvent): Promise<void> {
  const what = e.kind === 'CORNERING' ? null : HARSH_ALERTS[e.kind]
  if (!what) return

  const externalId = `harsh:${e.deviceId}:${what.type}:${Math.floor(e.at.getTime() / 1000)}`
  const existing = await prisma.providerAlert.findUnique({ where: { externalId }, select: { id: true } })
  if (existing) return

  const vehicle = await prisma.vehicle.findUnique({
    where:  { deviceId: e.deviceId },
    select: { id: true, registrationPlate: true, organisationId: true },
  })
  // A unit we do not hold has no organisation to tell.
  if (!vehicle) return

  const places = e.lat != null && e.lng != null
    ? await resolveEstatePlaces(vehicle.organisationId, e.lat, e.lng).catch(() => [])
    : []
  const place = places.length ? places.slice(0, 2).map(p => p.name).join(' · ') : null
  const plate = vehicle.registrationPlate || e.unitName
  const message = harshMessage(what.words, plate, place, e.speedKmh, e.ms2)

  let row
  try {
    row = await prisma.providerAlert.create({
      data: {
        externalId,
        organisationId: vehicle.organisationId,
        vehicleId:      vehicle.id,
        type:           what.type,
        severity:       'warning',
        message,
        plate,
        createdAt:      e.at,
        source:         'wialon',
        raw: { ...e, at: e.at.toISOString(), _estateZones: places.map(p => p.name) } as unknown as object,
      },
    })
  } catch (err) {
    // A second writer got there first: already recorded.
    if ((err as { code?: string })?.code === 'P2002') return
    throw err
  }

  eventBus.publish('provider:alert', {
    orgId:     vehicle.organisationId,
    id:        `wn-${row.id}`,
    source:    'wialon',
    alertType: what.type,
    severity:  'warning',
    text:      message,
    at:        e.at,
    plate,
    vehicleId: vehicle.id,
    notify:    true,
  })
}

export function startHarshDrivingWorker(): () => void {
  const unsub = eventBus.subscribe('driving:harsh', (e) => {
    void limit(() => recordHarshEvent(e)).catch(
      err => logger.warn({ err, deviceId: e.deviceId, kind: e.kind }, 'harsh-driving.worker: write failed'),
    )
  })
  logger.info('Harsh-driving worker started')
  return unsub
}
