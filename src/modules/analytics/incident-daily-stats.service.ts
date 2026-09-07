/**
 * Per-unit-per-day incident counts, so month-over-month outlives the detail.
 *
 * `speeding_incidents` and `sensor_fault_episodes` are pruned at 90 days, which
 * is the right window for "show me every case last month" and useless for "is
 * this fleet getting better or worse". This table keeps the counts for 400 days
 * at a few bytes a row.
 *
 * ## Rebuildable, therefore repairable
 *
 * It is a plain GROUP BY over one fleet day of the two detail tables — no
 * telemetry scan, milliseconds. So a night the job did not run can be repaired
 * by running it again for that day, for as long as the detail survives, and a
 * re-run of a day already recorded produces identical rows rather than doubling
 * them. That is the same contract `recordVehicleDailyStats` offers, and it is
 * what makes a missed cron a latency problem rather than a data-loss one.
 *
 * ## Upsert, not delete-then-insert
 *
 * `vehicle_daily_stats` clears the day first because it rebuilds every column
 * from telemetry. This table cannot: the two sources are pruned on different
 * schedules, so a rebuild after the detail has aged out would replace real
 * counts with zeroes. Upserting on (vehicleId, day) means a day whose detail is
 * gone keeps the numbers it was given while it still had them.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { fleetDayStart, fleetDayKey } from '../../lib/provider-time.js'

export interface IncidentRollupResult {
  day:     string
  written: number
}

interface Row {
  vehicleId:       string
  organisationId:  string
  speedingCount:   number
  speedingPeakKmh: number | null
  speedingSeconds: number
  speedingDistanceM: number
  faultCount:      number
  faultSeconds:    number
  faultByKind:     Record<string, number>
}

/**
 * Recompute one fleet day.
 *
 * `inDay` is any instant inside the day — pass `lastCompleteFleetDay()` from the
 * scheduler so the answer does not depend on what time the job actually fired.
 */
export async function recordIncidentDailyStats(inDay: Date): Promise<IncidentRollupResult> {
  const dayStart = fleetDayStart(inDay)
  const day      = fleetDayKey(dayStart)

  const [speeding, faults] = await Promise.all([
    prisma.speedingIncident.groupBy({
      by:     ['vehicleId', 'organisationId'],
      where:  { day },
      _count: { _all: true },
      _max:   { peakKmh: true },
      _sum:   { durationSec: true, distanceM: true },
    }),
    // Grouped by kind as well, because "which sensor keeps failing on this
    // unit" is the question the malfunction report is for; the flat count alone
    // cannot answer it once the detail is pruned.
    prisma.sensorFaultEpisode.groupBy({
      by:     ['vehicleId', 'organisationId', 'kind'],
      where:  { day },
      _count: { _all: true },
      _sum:   { durationSec: true },
    }),
  ])

  const rows = new Map<string, Row>()
  const rowFor = (vehicleId: string, organisationId: string): Row => {
    let r = rows.get(vehicleId)
    if (!r) {
      r = {
        vehicleId, organisationId,
        speedingCount: 0, speedingPeakKmh: null, speedingSeconds: 0, speedingDistanceM: 0,
        faultCount: 0, faultSeconds: 0, faultByKind: {},
      }
      rows.set(vehicleId, r)
    }
    return r
  }

  for (const g of speeding) {
    const r = rowFor(g.vehicleId, g.organisationId)
    r.speedingCount     = g._count._all
    r.speedingPeakKmh   = g._max.peakKmh ?? null
    r.speedingSeconds   = g._sum.durationSec ?? 0
    // distanceM is null on any episode measured across a gap, and Prisma sums
    // the ones that are not — so this is the distance we can actually stand
    // behind, never a total that quietly includes guesses.
    r.speedingDistanceM = g._sum.distanceM ?? 0
  }

  for (const g of faults) {
    const r = rowFor(g.vehicleId, g.organisationId)
    r.faultCount   += g._count._all
    r.faultSeconds += g._sum.durationSec ?? 0
    r.faultByKind[g.kind] = (r.faultByKind[g.kind] ?? 0) + g._count._all
  }

  let written = 0
  for (const r of rows.values()) {
    await prisma.vehicleIncidentDailyStat.upsert({
      where:  { vehicleId_day: { vehicleId: r.vehicleId, day } },
      create: {
        vehicleId: r.vehicleId, organisationId: r.organisationId, day,
        speedingCount: r.speedingCount, speedingPeakKmh: r.speedingPeakKmh,
        speedingSeconds: r.speedingSeconds, speedingDistanceM: r.speedingDistanceM,
        faultCount: r.faultCount, faultSeconds: r.faultSeconds, faultByKind: r.faultByKind,
      },
      update: {
        organisationId: r.organisationId,
        speedingCount: r.speedingCount, speedingPeakKmh: r.speedingPeakKmh,
        speedingSeconds: r.speedingSeconds, speedingDistanceM: r.speedingDistanceM,
        faultCount: r.faultCount, faultSeconds: r.faultSeconds, faultByKind: r.faultByKind,
      },
    })
    written++
  }

  const out = { day: day.toISOString().slice(0, 10), written }
  logger.info(out, 'Incident daily stats recorded')
  return out
}
