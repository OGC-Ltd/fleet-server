/**
 * Completed dispatches → measured Trip rows.
 *
 * ## Why the trips table was empty
 *
 * Nothing wrote it. The only writers were `simulation.persistence` — the
 * simulator retired on 2026-07-25 — and a REST create endpoint no client calls.
 * Measured 2026-08-04: 0 trips and 0 cargo manifests for both live orgs, beside
 * 2,108 real dispatches for SUKARI alone.
 *
 * Everything downstream reads that table and therefore reported zero: the whole
 * delivery half of the Analytics page (five cards and four KPI tiles, gated on
 * `totals.trips > 0` so they rendered nothing at all), the Drivers roster's
 * trips, tonnes and mileage, and the org reports.
 *
 * ## What a trip is here
 *
 * The dispatch supplies the FRAME — who, where to, when it opened, when it
 * closed. The vehicle's own fixes supply every MEASUREMENT: distance, duration,
 * speeds. Nothing is estimated from the other. A dispatch whose window contains
 * too few fixes to measure is skipped rather than written with a zero, on the
 * same principle the fuel module follows — a blank is not a zero, and
 * `mileageKm` is NOT NULL, so inventing one would put a fabricated distance
 * into the distance-covered chart.
 *
 * The skipped count is returned rather than swallowed: "we have 2,108
 * dispatches and built 1,400 trips" is a fact an operator should be able to
 * see, and it is the honest reason the delivery totals sit below the dispatch
 * totals.
 */

import { prisma } from './prisma.js'
import { logger } from './logger.js'
import { getOrCreatePeriodFor } from './reporting-period.js'
import { haversineM } from './dispatch-trip.js'
import { PLAUSIBLE_KMH } from './fix-plausibility.js'

/**
 * Consecutive fixes closer than this are treated as the vehicle standing still.
 *
 * A parked truck's fixes wander by a few metres on satellite geometry alone, and
 * summing that wander over a nineteen-hour round trip adds kilometres that were
 * never driven. 20 m is comfortably above the jitter and well below the distance
 * covered between two fixes at any speed worth recording.
 */
const JITTER_FLOOR_M = 20

/**
 * Consecutive fixes further apart than this are a coverage gap, not a leg.
 *
 * A fleet driving through a dead zone reappears somewhere else, and the
 * straight line between the two is not road it drove. Counting it would inflate
 * the trip; dropping it under-reports by the length of the gap. Under-reporting
 * a distance we did not observe is the honest side of that trade.
 */
const TELEPORT_CEILING_M = 5_000

/**
 * At or above this a fix counts as moving, for the average-speed calculation.
 * Kept in step with movement-state's constant of the same name — the two answer
 * the same question about the same frames and must not disagree.
 */
const MOVING_THRESHOLD_KMH = 1

export interface TripBuildResult {
  built:   number
  updated: number
  /** Dispatches with too few fixes in their window to measure anything. */
  skipped: number
}

export interface TripRecomputeResult {
  /** Trips whose stored avgSpeedKmh disagreed with the fixes and was rewritten. */
  corrected:   number
  /** Trips already holding the right value. */
  unchanged:   number
  /** Trips whose fixes no longer support a measurement — left untouched. */
  unmeasurable: number
}

interface Fix { capturedAt: Date; lat: number; lng: number; speedKmh: number | null }

/**
 * Mean speed WHILE MOVING, from a run of fixes — null when nothing in the run
 * was moving, which is not the same as zero and must not be stored as one.
 */
export function movingAvgSpeedKmh(fixes: readonly Fix[]): number | null {
  const moving = fixes
    .map(f => f.speedKmh)
    .filter((s): s is number => s != null && s >= MOVING_THRESHOLD_KMH)
  if (moving.length === 0) return null
  return Math.round((moving.reduce((a, b) => a + b, 0) / moving.length) * 10) / 10
}

/**
 * Distance actually driven across a run of fixes, in km.
 *
 * Three tests, and the third was added on 2026-08-27 because the first two do
 * not catch a teleport. `TELEPORT_CEILING_M` is flat, so a 2 km jump between
 * fixes 30 s apart — 240 km/h — passes it, and 34.76% of SUKARI's summed
 * distance came from hops implying over 120 km/h. The implied SPEED is the test
 * that scales with the gap, which is what a flat ceiling cannot do.
 *
 * The ceiling stays alongside it rather than being replaced: it answers a
 * different question. A vehicle that vanishes into a dead zone for an hour and
 * reappears 40 km away has an implausible-speed reading of only 40 km/h, which
 * this test passes and the ceiling correctly rejects — the straight line
 * between the two is not road it drove.
 */
export function measureKm(fixes: readonly Fix[]): number {
  let m = 0
  for (let i = 1; i < fixes.length; i++) {
    const prev = fixes[i - 1]!, cur = fixes[i]!
    const step = haversineM(
      { lat: prev.lat, lng: prev.lng },
      { lat: cur.lat,  lng: cur.lng },
    )
    if (step < JITTER_FLOOR_M || step > TELEPORT_CEILING_M) continue
    // Zero or reversed gaps imply infinite speed and are dropped with the rest.
    // Devices buffer through coverage gaps and dump a backlog out of order, so
    // this is not rare, and charging a backlog's whole distance to one instant
    // is exactly the inflation being removed.
    const dtS = (cur.capturedAt.getTime() - prev.capturedAt.getTime()) / 1000
    if (dtS <= 0 || (step / dtS) * 3.6 > PLAUSIBLE_KMH) continue
    m += step
  }
  return Math.round(m) / 1000
}

/**
 * Resolve the dispatch's driver NAME to a user in the org.
 *
 * The provider names a person; the roster keys on an id, and the Drivers page
 * cannot attribute a trip without one. Matched case-insensitively on the full
 * name and only when it is UNAMBIGUOUS — two drivers sharing a name would
 * otherwise have one of them silently credited with the other's work.
 */
async function resolveDriverId(orgId: string, driverName: string | null): Promise<string | null> {
  if (!driverName?.trim()) return null
  const matches = await prisma.user.findMany({
    where:  { organisationId: orgId, deletedAt: null, fullName: { equals: driverName.trim(), mode: 'insensitive' } },
    select: { id: true },
    take:   2,
  })
  return matches.length === 1 ? matches[0]!.id : null
}

/**
 * Build trips for every completed dispatch in the window that does not have one.
 *
 * Idempotent through `Trip.dispatchId`, so re-running over any range is safe and
 * costs only the measurement.
 */
export async function buildTripsForOrg(
  orgId: string,
  opts: { from: Date; to: Date; apply: boolean; limit?: number },
): Promise<TripBuildResult> {
  const out: TripBuildResult = { built: 0, updated: 0, skipped: 0 }

  const dispatches = await prisma.dispatch.findMany({
    where: {
      organisationId: orgId,
      vehicleId:      { not: null },
      // Only a CLOSED dispatch is a trip. An open one is a journey in progress
      // and its distance is still changing — that is the Active Trip card's job.
      actualReturnAt: { not: null, gte: opts.from, lte: opts.to },
    },
    select: {
      id: true, vehicleId: true, driverName: true, destination: true,
      dispatchedAt: true, actualReturnAt: true,
    },
    orderBy: { actualReturnAt: 'asc' },
    ...(opts.limit ? { take: opts.limit } : {}),
  })
  if (dispatches.length === 0) return out

  const existing = new Set(
    (await prisma.trip.findMany({
      where:  { dispatchId: { in: dispatches.map(d => d.id) } },
      select: { dispatchId: true },
    })).map(t => t.dispatchId!),
  )

  const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { name: true } })

  for (const d of dispatches) {
    if (existing.has(d.id)) continue

    const beganAt = d.dispatchedAt
    const endedAt = d.actualReturnAt!
    // A dispatch closed before it opened is provider data we cannot measure
    // against; it would produce a negative duration.
    if (endedAt <= beganAt) { out.skipped++; continue }

    const rows = await prisma.vehicleTelemetry.findMany({
      where:   { vehicleId: d.vehicleId!, capturedAt: { gte: beganAt, lte: endedAt } },
      select:  { capturedAt: true, lat: true, lng: true, speedKmh: true },
      orderBy: { capturedAt: 'asc' },
    })
    // A frame can carry a speed and no fix. Those cannot contribute to a
    // distance, and letting a null through would place the vehicle at 0,0.
    const fixes: Fix[] = rows.flatMap(r =>
      r.lat != null && r.lng != null
        ? [{ capturedAt: r.capturedAt, lat: r.lat, lng: r.lng, speedKmh: r.speedKmh }]
        : [])
    // Two fixes is the minimum that can describe a distance at all.
    if (fixes.length < 2) { out.skipped++; continue }

    const mileageKm       = measureKm(fixes)
    const durationSeconds = Math.round((endedAt.getTime() - beganAt.getTime()) / 1000)
    const speeds          = fixes.map(f => f.speedKmh).filter((s): s is number => s != null)
    const maxSpeedKmh     = speeds.length ? Math.max(...speeds) : null
    /**
     * Mean speed WHILE MOVING — not distance over elapsed time.
     *
     * The difference is not cosmetic, because analytics divides by this to get
     * a trip's expected transit time and calls the trip interrupted when the
     * actual duration exceeds twice it. Distance over elapsed time makes that
     * test tautological: expected = km ÷ (km ÷ hours) = hours, so duration can
     * never exceed twice itself and EVERY trip reports timely. That is exactly
     * what the first backfill produced — 428 of 428 — a KPI that had stopped
     * being a measurement.
     *
     * Averaging only the moving samples restores the intended meaning: how long
     * the run would have taken had it never stopped. A truck that spent nine of
     * nineteen hours loading then reads as interrupted, which is the whole
     * point of the metric.
     */
    const avgSpeedKmh     = movingAvgSpeedKmh(fixes)

    out.built++
    if (!opts.apply) continue

    try {
      await prisma.trip.create({
        data: {
          vehicleId:         d.vehicleId!,
          dispatchId:        d.id,
          driverId:          await resolveDriverId(orgId, d.driverName),
          reportingPeriodId: await getOrCreatePeriodFor(orgId, beganAt),
          beganAt,
          endedAt,
          // The provider records a destination and never an origin; every run on
          // this fleet starts at the org's own yard.
          initialLocation:   org?.name ?? null,
          finalLocation:     d.destination,
          durationSeconds,
          mileageKm,
          avgSpeedKmh,
          maxSpeedKmh,
        },
      })
    } catch (err) {
      // P2002 on dispatchId: the repeatable job and a hand-run backfill both
      // saw this dispatch before either had written it. The unique index is
      // doing exactly its job, and the row now exists either way — so this is
      // the expected outcome of an overlap, not a failure to report.
      if ((err as { code?: string }).code !== 'P2002') throw err
      out.built--
      out.updated++
    }
  }

  logger.info({ orgId, ...out, dispatches: dispatches.length }, 'Trip build complete')
  return out
}

/**
 * Re-measure `avgSpeedKmh` on trips ALREADY persisted.
 *
 * `buildTripsForOrg` only ever inserts — it is idempotent through
 * `Trip.dispatchId`, so a re-run skips every row it already wrote. That makes
 * the average-speed fix above invisible on its own: the rows built before it
 * keep the elapsed-time average, and the analytics timely/interrupted split
 * keeps reporting the tautology those rows encode. This pass is what actually
 * retires it.
 *
 * Narrow on purpose. Only `avgSpeedKmh` is rewritten — it is the single field
 * whose definition changed. Distance, duration and max speed are measured the
 * same way they always were, and re-deriving them here would silently fold
 * telemetry retention (fixes aged out since the trip was built) into fields
 * nobody asked to revisit. For the same reason a trip whose window no longer
 * holds a usable fix is LEFT ALONE and counted, not nulled: losing the source
 * data is not evidence the stored measurement was wrong.
 */
export async function recomputeTripSpeeds(
  orgId: string,
  opts: { from: Date; to: Date; apply: boolean; limit?: number },
): Promise<TripRecomputeResult> {
  const out: TripRecomputeResult = { corrected: 0, unchanged: 0, unmeasurable: 0 }

  const trips = await prisma.trip.findMany({
    where:   { vehicle: { organisationId: orgId }, beganAt: { gte: opts.from, lte: opts.to } },
    select:  { id: true, vehicleId: true, beganAt: true, endedAt: true, avgSpeedKmh: true },
    orderBy: { beganAt: 'asc' },
    ...(opts.limit ? { take: opts.limit } : {}),
  })

  for (const t of trips) {
    if (t.endedAt == null || t.endedAt <= t.beganAt) { out.unmeasurable++; continue }

    const rows = await prisma.vehicleTelemetry.findMany({
      where:   { vehicleId: t.vehicleId, capturedAt: { gte: t.beganAt, lte: t.endedAt } },
      select:  { capturedAt: true, lat: true, lng: true, speedKmh: true },
      orderBy: { capturedAt: 'asc' },
    })
    const fixes: Fix[] = rows.flatMap(r =>
      r.lat != null && r.lng != null
        ? [{ capturedAt: r.capturedAt, lat: r.lat, lng: r.lng, speedKmh: r.speedKmh }]
        : [])
    if (fixes.length < 2) { out.unmeasurable++; continue }

    const avgSpeedKmh = movingAvgSpeedKmh(fixes)
    if (avgSpeedKmh == null) { out.unmeasurable++; continue }
    if (t.avgSpeedKmh != null && Math.abs(t.avgSpeedKmh - avgSpeedKmh) < 0.05) { out.unchanged++; continue }

    out.corrected++
    if (!opts.apply) continue
    await prisma.trip.update({ where: { id: t.id }, data: { avgSpeedKmh } })
  }

  logger.info({ orgId, ...out, trips: trips.length }, 'Trip speed recompute complete')
  return out
}
