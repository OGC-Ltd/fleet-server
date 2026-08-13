/**
 * Persist each vehicle's fuel day, so slosh can be TRENDED.
 *
 * Asked for by the operator: *"during motion we tend to have fluctuation in
 * fuel either drops or fills, but these for the most part are often slosh
 * artefact which we need to use the data to maintain a moving average but not
 * for theft detection but for trend logging."*
 *
 * A moving average has to be KEPT to be a trend. The FSL table computes
 * turbulence per request and throws it away, so nothing can be compared across
 * days — and a probe whose slosh drifts upward over weeks, which is the thing
 * worth knowing about a mounting or a baffle, is invisible. This writes one row
 * per vehicle per fleet day.
 *
 * ## It feeds nothing that judges
 *
 * `modules/fuel/fuel-adjudication` does not read `fuel_daily_trends` and must
 * not. The drain rules already have a probe instrument — `getProbeProfile`,
 * measured while PARKED — which answers a different question of different
 * readings. A motion-slosh average reaching a theft verdict would let a machine
 * excuse its own drains by working rough ground, which is precisely the
 * inversion the operator was guarding against.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { fleetDayStart } from '../../lib/provider-time.js'
import { getFleetTankState } from './fuel-tank-state.service.js'

export interface TrendOutcome {
  day:      string
  vehicles: number
  written:  number
  /** Rows carrying a turbulence figure — the rest never moved that day. */
  withTurbulence: number
}

/**
 * Write the trend rows for the fleet day containing `asOf`, for every org.
 *
 * Idempotent: upserts on (vehicleId, day), so re-running a day corrects it
 * rather than duplicating it. That matters because the daily job may be re-run
 * by hand after a backfill, and because a day recomputed once more telemetry
 * has landed is a better row than the one written at 04:00.
 */
export async function recordFuelTrends(asOf = new Date()): Promise<TrendOutcome[]> {
  const dayStart = fleetDayStart(asOf)
  // DATE column: the fleet day's own calendar date, not a UTC instant.
  const day = new Date(Date.UTC(
    dayStart.getUTCFullYear(), dayStart.getUTCMonth(), dayStart.getUTCDate(),
  ))
  // A day is only worth recording once it is over — mid-day figures would be
  // overwritten anyway, and a half-day turbulence average is not a trend point.
  const asOfBounded = new Date(Math.min(asOf.getTime(), dayStart.getTime() + 86_400_000 - 1))

  const orgs = await prisma.organisation.findMany({ select: { id: true, code: true } })
  const out: TrendOutcome[] = []

  for (const org of orgs) {
    const rows = await getFleetTankState(org.id, asOfBounded)
    let written = 0, withTurbulence = 0

    for (const r of rows) {
      // Nothing measured at all is not a trend point; writing zeroes would put
      // a flat line through every silent unit and make the chart lie. A row
      // needs at least one real level — an opening or a closing — to be worth
      // keeping, and a unit that went silent mid-day keeps its opening so the
      // gap in the series is visible rather than absent.
      if (r.initialMl == null && r.currentMl == null) continue
      await prisma.fuelDailyTrend.upsert({
        where:  { vehicleId_day: { vehicleId: r.vehicleId, day } },
        create: {
          vehicleId: r.vehicleId, day,
          openingMl: r.initialMl, closingMl: r.currentMl, consumedMl: r.consumedMl,
          turbulenceMl: r.turbulenceMl, stopsAveraged: r.stopsAveraged,
          computedAt: new Date(),
        },
        update: {
          openingMl: r.initialMl, closingMl: r.currentMl, consumedMl: r.consumedMl,
          turbulenceMl: r.turbulenceMl, stopsAveraged: r.stopsAveraged,
          computedAt: new Date(),
        },
      })
      written++
      if (r.turbulenceMl != null) withTurbulence++
    }

    out.push({ day: day.toISOString().slice(0, 10), vehicles: rows.length, written, withTurbulence })
    logger.info({ org: org.code, day: day.toISOString().slice(0, 10), written, withTurbulence },
      'Fuel daily trend recorded')
  }

  return out
}
