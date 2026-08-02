/**
 * Persists the durable outcomes of the Sukari logistics simulation.
 *
 * The simulator emits one-shot lifecycle events (a completed haul, a fuel-theft
 * incident, an emergency refuel, a completed service, a garage visit) on the
 * telemetry frame's `_sim.events`. The poller hands each frame here so those
 * events become real domain rows:
 *
 *   • completed trip     → Trip (+ CargoManifest)
 *   • suspected theft    → FuelTheft
 *   • self-heal refuel   → FuelFilling
 *   • completed service  → VehicleServiceRecord
 *   • garage visit       → VehicleGarageVisit (+ an inbox notification)
 *
 * Every event row must reference a ReportingPeriod, so we lazily find-or-create
 * the DAILY period covering "now" (cached per org, deduped across the concurrent
 * poll workers).
 */

import { prisma } from './prisma.js'
import { logger } from './logger.js'
import { emitDashboardNotice } from './sse.js'
import type { TripEvent, TheftEvent, RefuelEvent, ServiceEvent, GarageVisitEvent } from '../providers/raifactorysuite/raifactorysuite.simulator.js'

export interface SimEvents {
  tripCompleted:       TripEvent | null
  fuelTheft:           TheftEvent | null
  refuel:              RefuelEvent | null
  serviceCompleted:    ServiceEvent | null
  garageVisitCompleted: GarageVisitEvent | null
}

// The period find-or-create moved to lib/reporting-period, so the live path
// and the Wialon fuel backfill share one implementation — the backfill needs
// the period covering the EVENT, which the now-only version here could not
// express. Re-exported because callers already import it from this module.
import { getOrCreateCurrentPeriod } from './reporting-period.js'
export { getOrCreateCurrentPeriod }

const round1 = (n: number) => Math.round(n * 10) / 10

// ─── driver rating (persisted, self-healing) ───────────────────────────────
//
// Overspeeding is scored per-trip rather than as a flat per-alert deduction:
// a trip with more than OVERSPEED_TRIP_THRESHOLD overspeed ticks costs the
// driver OVERSPEED_PENALTY_PER_EXCESS for every tick past the threshold
// (linear in the excess count). Any trip that stays at or under the threshold
// is "clean" and heals the score a little instead — this is what lets a
// driver recover rating over time rather than being stuck with a rolling
// average. The other alert types (fuelInconsistency, outsideGeofence,
// lowFuel) are NOT part of this score — they stay on the flat, rolling
// 90-day deduction computed in telemetry.repository.ts's findAlertHistoryCounts.
//
// The per-trip overspeed tally comes straight from the simulator's
// TripEvent.overspeedTicks rather than counting VehicleAlert rows: the sim
// clock fast-forwards through many simulated hours per poll cycle, so only
// the LAST tick of a haul actually gets checked against the alert threshold —
// counting alert rows would silently miss almost every in-transit overspeed.
const OVERSPEED_TRIP_THRESHOLD = 5     // ticks over the limit before a trip counts as an overspeeding case
const OVERSPEED_CASE_PENALTY   = 0.15  // flat deduction per overspeeding case
const CLEAN_TRIP_HEAL          = 0.02
const RATING_MAX = 5.0
const RATING_MIN = 1.0

// Fuel theft costs the driver 0.76 rating points PERMANENTLY: the score drops
// immediately when the theft is persisted, and the clean-trip heal below can
// never climb back above (5.0 − 0.76 × lifetime thefts), so the deduction is
// not slowly healed away.
const FUEL_THEFT_PENALTY = 0.76

async function updateDriverRatingForTrip(driverId: string | null, overspeedTicks: number): Promise<void> {
  if (!driverId) return

  // An overspeeding case (a trip with sustained speeding) costs a flat 0.15;
  // a clean trip heals a little — but never above the theft-capped ceiling.
  const delta = overspeedTicks > OVERSPEED_TRIP_THRESHOLD
    ? -OVERSPEED_CASE_PENALTY
    : CLEAN_TRIP_HEAL

  // Ceiling = RATING_MAX minus the driver's permanent theft penalties, so a
  // heal can recover overspeed dings but never a fuel-theft deduction.
  // ::float8 casts are load-bearing: next to count(*) (bigint), Postgres
  // would otherwise infer the untyped params as bigint and reject "0.76".
  await prisma.$executeRaw`
    UPDATE users u
       SET driver_rating_score = GREATEST(0, LEAST(
             ${RATING_MAX}::float8 - ${FUEL_THEFT_PENALTY}::float8 * (SELECT count(*) FROM fuel_thefts ft WHERE ft.driver_id = u.id),
             GREATEST(${RATING_MIN}::float8, driver_rating_score + ${delta}::float8)))
     WHERE id = ${driverId}
  `
}

/** Immediate, permanent −0.76 for a persisted fuel-theft incident. */
async function applyFuelTheftRatingPenalty(driverId: string | null): Promise<void> {
  if (!driverId) return
  await prisma.$executeRaw`
    UPDATE users
       SET driver_rating_score = GREATEST(0, driver_rating_score - ${FUEL_THEFT_PENALTY})
     WHERE id = ${driverId}
  `
}

// ─── event persistence ──────────────────────────────────────────────────────

export async function persistSimEvents(
  orgId: string,
  vehicleId: string,
  events: SimEvents | undefined,
  vehicleMeta?: { plate: string; vehicleName: string; driverId?: string | null },
): Promise<void> {
  if (!events) return
  const { tripCompleted, fuelTheft, refuel, serviceCompleted, garageVisitCompleted } = events
  if (!tripCompleted && !fuelTheft && !refuel && !serviceCompleted && !garageVisitCompleted) return

  const reportingPeriodId = await getOrCreateCurrentPeriod(orgId)

  if (tripCompleted) {
    const t = tripCompleted

    // driverId comes from the poller's cached device meta (resolved once per
    // 5-min cache refresh) rather than a fresh lookup here — persistSimEvents
    // used to re-query vehicleAssignment on every trip completion, duplicating
    // the same lookup processTelemetry already made for this frame.
    const driverId = vehicleMeta?.driverId ?? null
    const beganAt  = new Date(t.beganAtMs)
    const endedAt  = new Date(t.endedAtMs)

    const trip = await prisma.trip.create({
      data: {
        vehicleId,
        driverId,
        reportingPeriodId,
        beganAt,
        endedAt,
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

    await updateDriverRatingForTrip(driverId, t.overspeedTicks)

    // Sukari hauls are bulk loads; Aquamist hauls are packaged bottled product
    // (still water, sparkling water, juice) with the product carried on the
    // event's cargoDesc.
    const bulk = t.cargoType === 'SUGARCANE' || t.cargoType === 'PROCESSED_SUGAR'
    await prisma.cargoManifest.create({
      data: {
        tripId:            trip.id,
        cargoType:         bulk ? 'BULK' : 'PACKAGED',
        description:       t.cargoDesc
                             ?? (t.cargoType === 'SUGARCANE' ? 'Raw sugarcane' : 'Processed sugar'),
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
    // Attribute the theft to the assigned driver (same cached meta the trip
    // path uses) — without it the Drivers page can never count the incident,
    // and the rating penalty below has no one to charge.
    const driverId = vehicleMeta?.driverId ?? null
    await prisma.fuelTheft.create({
      data: {
        vehicleId,
        driverId,
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
    await applyFuelTheftRatingPenalty(driverId)
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
    emitDashboardNotice(orgId, {
      noticeType:  'refueled',
      vehicleId,
      plate:       vehicleMeta?.plate       ?? vehicleId,
      vehicleName: vehicleMeta?.vehicleName ?? vehicleId,
      filledMl:    r.filledMl,
      location:    r.loc,
      capturedAt:  new Date(r.atMs).toISOString(),
    })
  }

  if (serviceCompleted) {
    const sc = serviceCompleted

    // The odometer of this vehicle's most recent prior service (if any) —
    // read fresh rather than tracked in the simulator's in-memory state, so
    // it's correct even across a server restart.
    const lastService = await prisma.vehicleServiceRecord.findFirst({
      where: { vehicleId },
      orderBy: { servicedAt: 'desc' },
      select: { odometerKm: true },
    })

    await prisma.vehicleServiceRecord.create({
      data: {
        vehicleId,
        servicedAt:           new Date(sc.completedAtMs),
        odometerKm:           round1(sc.odometerKm),
        previousServiceOdoKm: lastService ? round1(lastService.odometerKm) : null,
        nextServiceOdoKm:     round1(sc.nextServiceOdoKm),
      },
    })
  }

  if (garageVisitCompleted) {
    const gv = garageVisitCompleted
    const durationMinutes = Math.round((gv.exitedAtMs - gv.enteredAtMs) / 60_000)

    await prisma.vehicleGarageVisit.create({
      data: {
        vehicleId,
        garageName:      gv.garageName,
        garageLat:       gv.garageLat,
        garageLng:       gv.garageLng,
        enteredAt:       new Date(gv.enteredAtMs),
        exitedAt:        new Date(gv.exitedAtMs),
        durationMinutes,
        odometerKm:      round1(gv.odometerKm),
        severityScore:   Math.round(gv.severityScore * 100) / 100,
        itemsFixed:      JSON.parse(JSON.stringify(gv.itemsFixed)),
      },
    })

    const replaced = gv.itemsFixed.filter(i => i.replaced).map(i => i.name)
    const serviced = gv.itemsFixed.filter(i => !i.replaced).map(i => i.name)
    const summary = [
      replaced.length ? `Replaced: ${replaced.join(', ')}` : null,
      serviced.length ? `Serviced: ${serviced.join(', ')}` : null,
    ].filter(Boolean).join(' · ')

    emitDashboardNotice(orgId, {
      noticeType:  'garageService',
      vehicleId,
      plate:       vehicleMeta?.plate       ?? vehicleId,
      vehicleName: vehicleMeta?.vehicleName ?? vehicleId,
      garageName:  gv.garageName,
      durationMinutes,
      itemsFixed:  gv.itemsFixed,
      summary,
      capturedAt:  new Date(gv.exitedAtMs).toISOString(),
    })
  }
}
