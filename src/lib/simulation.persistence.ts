/**
 * Persists the durable outcomes of the Sukari logistics simulation.
 *
 * The simulator emits one-shot lifecycle events (a completed haul, a fuel-theft
 * incident, an emergency refuel) on the telemetry frame's `_sim.events`. The
 * poller hands each frame here so those events become real domain rows:
 *
 *   • completed trip   → Trip (+ CargoManifest)
 *   • suspected theft   → FuelTheft
 *   • self-heal refuel  → FuelFilling
 *
 * Every event row must reference a ReportingPeriod, so we lazily find-or-create
 * the DAILY period covering "now" (cached per org, deduped across the concurrent
 * poll workers).
 */

import { prisma } from './prisma.js'
import { logger } from './logger.js'
import type { TripEvent, TheftEvent, RefuelEvent } from '../providers/controltech/controltech.simulator.js'

export interface SimEvents {
  tripCompleted: TripEvent | null
  fuelTheft:     TheftEvent | null
  refuel:        RefuelEvent | null
}

// ─── current reporting period (find-or-create, cached + de-duped) ───────────

const periodCache   = new Map<string, { id: string; endMs: number }>()
const periodPending = new Map<string, Promise<string>>()

async function resolvePeriod(orgId: string): Promise<string> {
  const now = new Date()

  const existing = await prisma.reportingPeriod.findFirst({
    where: { organisationId: orgId, periodStart: { lte: now }, periodEnd: { gte: now } },
    orderBy: { periodStart: 'desc' },
    select: { id: true, periodEnd: true },
  })
  if (existing) {
    periodCache.set(orgId, { id: existing.id, endMs: existing.periodEnd.getTime() })
    return existing.id
  }

  const start = new Date(now); start.setHours(0, 0, 0, 0)
  const end   = new Date(now); end.setHours(23, 59, 59, 999)
  const label = `Live ${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`

  const created = await prisma.reportingPeriod.create({
    data: { organisationId: orgId, label, periodStart: start, periodEnd: end, periodType: 'DAILY' },
    select: { id: true },
  })
  periodCache.set(orgId, { id: created.id, endMs: end.getTime() })
  return created.id
}

/** Return the id of the reporting period covering now, creating a DAILY one if
 *  none exists. Concurrent callers for the same org share one round trip. */
export async function getOrCreateCurrentPeriod(orgId: string): Promise<string> {
  const cached = periodCache.get(orgId)
  if (cached && Date.now() < cached.endMs) return cached.id

  let pending = periodPending.get(orgId)
  if (!pending) {
    pending = resolvePeriod(orgId).finally(() => periodPending.delete(orgId))
    periodPending.set(orgId, pending)
  }
  return pending
}

const round1 = (n: number) => Math.round(n * 10) / 10

// ─── event persistence ──────────────────────────────────────────────────────

export async function persistSimEvents(
  orgId: string,
  vehicleId: string,
  events: SimEvents | undefined,
): Promise<void> {
  if (!events) return
  const { tripCompleted, fuelTheft, refuel } = events
  if (!tripCompleted && !fuelTheft && !refuel) return

  const reportingPeriodId = await getOrCreateCurrentPeriod(orgId)

  if (tripCompleted) {
    const t = tripCompleted
    const trip = await prisma.trip.create({
      data: {
        vehicleId,
        reportingPeriodId,
        beganAt:            new Date(t.beganAtMs),
        endedAt:            new Date(t.endedAtMs),
        initialLocation:    t.fromLoc,
        finalLocation:      t.toLoc,
        durationSeconds:    Math.max(1, Math.round((t.endedAtMs - t.beganAtMs) / 1000)),
        mileageKm:          round1(t.distanceKm),
        avgSpeedKmh:        round1(t.avgSpeedKmh),
        maxSpeedKmh:        round1(t.maxSpeedKmh),
        consumedMl:         Math.round(t.consumedMl),
        initialFuelLevelMl: t.startFuelMl,
        finalFuelLevelMl:   t.endFuelMl,
      },
      select: { id: true },
    })

    await prisma.cargoManifest.create({
      data: {
        tripId:            trip.id,
        cargoType:         'BULK',
        description:       t.cargoType === 'SUGARCANE' ? 'Raw sugarcane' : 'Processed sugar',
        declaredWeightKg:  t.cargoWeightKg,
        departureWeightKg: t.cargoWeightKg,
        arrivalWeightKg:   t.cargoWeightKg,
        weightVarianceKg:  0,
      },
    })

    // A successful processed-sugar delivery adds its load to the destination
    // depot's stock — this is what drives the "sugar in storage" KPI. Capped at
    // the depot's capacity.
    if (t.cargoType === 'PROCESSED_SUGAR' && t.cargoWeightKg > 0) {
      await prisma.$executeRaw`
        UPDATE silos
           SET stored_tonnes = LEAST(capacity_tonnes, stored_tonnes + ${t.cargoWeightKg / 1000})
         WHERE organisation_id = ${orgId} AND name = ${t.toLoc}
      `
    }
  }

  if (fuelTheft) {
    const f = fuelTheft
    await prisma.fuelTheft.create({
      data: {
        vehicleId,
        reportingPeriodId,
        beganAt:            new Date(f.atMs),
        detectedAt:         new Date(f.atMs),
        initialLocation:    f.loc,
        initialFuelLevelMl: f.startFuelMl,
        finalFuelLevelMl:   f.endFuelMl,
        stolenMl:           f.stolenMl,
        initialSpeedKmh:    round1(f.speedKmh),
        finalSpeedKmh:      round1(f.speedKmh),
      },
    })
  }

  if (refuel) {
    const r = refuel
    await prisma.fuelFilling.create({
      data: {
        vehicleId,
        reportingPeriodId,
        filledAt:           new Date(r.atMs),
        location:           r.loc,
        initialFuelLevelMl: r.startFuelMl,
        filledMl:           r.filledMl,
        finalFuelLevelMl:   r.endFuelMl,
      },
    })
  }
}
