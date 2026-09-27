/**
 * Runs `fuel-signal-alerts` over a vehicle's stored telemetry, or over samples a
 * caller supplies, and shapes the answer for the API.
 *
 * Read-only and on demand. Nothing here writes a `fuel_thefts` row, a filling
 * or a notification: the ledger and the feed are fed by the adjudication
 * pipeline, which has been tuned against this fleet, and a second detector
 * writing into them would double-count every event the two agree on. A caller
 * that wants to act on these events does so itself.
 *
 * The arithmetic is in `fuel-signal-scan`, shared with the replay harness; this
 * file only reads the database and applies the request's limits.
 */

import { prisma } from '../../lib/prisma.js'
import { BadRequestError, NotFoundError } from '../../core/errors/errors.js'
import { getBandInputs } from './fuel-adjudication.service.js'
import { detectFuelSignals, type SignalSample } from './fuel-signal-alerts.js'
import {
  scanTelemetry, resolveProfile, shapeEvent, shapeProfile, shapeStats,
  SIGNAL_WARMUP_MS, NO_BAND_INPUTS,
} from './fuel-signal-scan.js'
import type { SignalAlertQuery, EvaluateSignalsDto } from './fuel.schema.js'

/** Longest window one request may scan. */
export const SIGNAL_MAX_WINDOW_DAYS = 7
/** Rows read per request; a busy unit writes ~3,000 a day. */
export const SIGNAL_SCAN_CAP = 50_000

/** The detector over one vehicle's stored telemetry — GET /signal-alerts/vehicles/:id. */
export async function scanVehicle(orgId: string, vehicleId: string, q: SignalAlertQuery) {
  const to = q.to ?? new Date()
  const from = q.from ?? new Date(to.getTime() - 24 * 3_600_000)
  if (from >= to) throw new BadRequestError('`from` must be before `to`')
  if (to.getTime() - from.getTime() > SIGNAL_MAX_WINDOW_DAYS * 86_400_000) {
    throw new BadRequestError(`Window may not exceed ${SIGNAL_MAX_WINDOW_DAYS} days`)
  }

  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, organisationId: orgId },
    select: { id: true, registrationPlate: true },
  })
  if (!vehicle) throw new NotFoundError('Vehicle not found')

  const bands = await getBandInputs(vehicleId, new Date())
  const rows = await prisma.vehicleTelemetry.findMany({
    where: { vehicleId, capturedAt: { gte: new Date(from.getTime() - SIGNAL_WARMUP_MS), lt: to } },
    orderBy: { capturedAt: 'asc' },
    take: SIGNAL_SCAN_CAP + 1,
    select: {
      capturedAt: true, lat: true, lng: true, speedKmh: true,
      engineOn: true, ignitionKnown: true, fuelLevelMl: true,
    },
  })
  const truncated = rows.length > SIGNAL_SCAN_CAP
  if (truncated) rows.pop()

  const { profile, events, stats } = scanTelemetry(rows, bands, from, q)
  const unit = profile.thresholds.workUnit
  return {
    vehicleId,
    plate: vehicle.registrationPlate,
    from: from.toISOString(),
    to: to.toISOString(),
    // Truncation cuts the END of the window: rows are read oldest first.
    truncated,
    lastSampleAt: rows.at(-1)?.capturedAt.toISOString() ?? null,
    profile: shapeProfile(profile),
    events: events.map(e => shapeEvent(e, unit)),
    stats: shapeStats(stats),
  }
}

/**
 * The detector over samples the caller supplies — POST /signal-alerts/evaluate.
 *
 * With a vehicle, its profile, measured consumption and tank are resolved as
 * the GET route does, and anything in the body overrides them. Without one the
 * body must name a profile.
 */
export async function evaluateSamples(orgId: string, vehicleId: string | null, body: EvaluateSignalsDto) {
  let bands = NO_BAND_INPUTS
  if (vehicleId) {
    const vehicle = await prisma.vehicle.findFirst({ where: { id: vehicleId, organisationId: orgId }, select: { id: true } })
    if (!vehicle) throw new NotFoundError('Vehicle not found')
    bands = await getBandInputs(vehicleId, new Date())
  } else if (!body.profile) {
    throw new BadRequestError('`profile` is required when no vehicle is given')
  }
  const profile = resolveProfile(bands, body)

  const samples: SignalSample[] = body.samples
    .map(s => ({ ...s, t: s.t.getTime() / 1000 }))
    .sort((a, b) => a.t - b.t)
  const { events, stats } = detectFuelSignals(samples, profile.thresholds)
  const unit = profile.thresholds.workUnit
  return {
    vehicleId,
    profile: shapeProfile(profile),
    events: events.map(e => shapeEvent(e, unit)),
    stats: shapeStats(stats),
  }
}
