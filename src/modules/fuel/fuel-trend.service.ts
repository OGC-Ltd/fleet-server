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
import { fleetDayStart, fleetDayKey } from '../../lib/provider-time.js'
import { computeFleetTankState } from './fuel-tank-state.service.js'

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
  //
  // This took the UTC components of `dayStart` until 2026-08-14, and `dayStart`
  // is 21:00 the PREVIOUS evening in UTC — so every row was filed under the day
  // before the one it describes. See fleetDayKey, which is now the only place
  // this conversion happens.
  const day = fleetDayKey(asOf)
  // A day is only worth recording once it is over — mid-day figures would be
  // overwritten anyway, and a half-day turbulence average is not a trend point.
  const asOfBounded = new Date(Math.min(asOf.getTime(), dayStart.getTime() + 86_400_000 - 1))

  const orgs = await prisma.organisation.findMany({ select: { id: true, code: true } })
  const out: TrendOutcome[] = []

  for (const org of orgs) {
    // computeFleetTankState, NOT getFleetTankState: this job WRITES the rows
    // that the cached path reads, so going through the cache would make it read
    // its own previous output and write it back unchanged.
    const rows = await computeFleetTankState(org.id, asOfBounded)

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
          runSloshMl: r.runSloshMl,
          temporaryStops: r.temporaryStops, heavyStops: r.heavyStops,
          distanceM: r.distanceM, expectedBurnMl: r.expectedBurnMl,
          engineSeconds: r.engineSeconds, engineBurnMl: r.engineBurnMl,
          engineHoursMeter: r.engineHoursMeter,
          computedAt: new Date(),
        },
        update: {
          openingMl: r.initialMl, closingMl: r.currentMl, consumedMl: r.consumedMl,
          turbulenceMl: r.turbulenceMl, stopsAveraged: r.stopsAveraged,
          runSloshMl: r.runSloshMl,
          temporaryStops: r.temporaryStops, heavyStops: r.heavyStops,
          distanceM: r.distanceM, expectedBurnMl: r.expectedBurnMl,
          engineSeconds: r.engineSeconds, engineBurnMl: r.engineBurnMl,
          engineHoursMeter: r.engineHoursMeter,
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

/**
 * How far back the nightly job looks for a day it never wrote.
 *
 * A week. Long enough to survive a bad night and a weekend nobody was
 * watching, short enough that the catch-up cannot run away with the evening.
 */
const HEAL_LOOKBACK_DAYS = 7

/**
 * Record yesterday, and repair any recent day that never got written.
 *
 * ## Why this is needed
 *
 * The job is scheduled once a night with `attempts: 3` and a 60 s exponential
 * backoff, so all three tries land inside about five minutes. If the database
 * is busy for longer than that, the day is simply lost and nothing ever
 * notices. That is not hypothetical: on 2026-08-17 all three attempts failed
 * with `Query read timeout` at 21:21, 21:23 and 21:26 UTC, and the gap sat
 * there until someone went looking three days later. Every window containing it
 * quietly divided by one fewer day.
 *
 * ## Why it recomputes forward from the gap
 *
 * The turbulence average spans days — it reads previous days' stored run values
 * — so a day computed while its predecessor was missing saw less history than
 * it should have. Filling the hole alone would leave the days after it carrying
 * figures derived from an incomplete past. Recomputing from the earliest gap
 * forward is what actually repairs the series, and it is why
 * `prisma/fuel-trends.ts` walks oldest-first too.
 *
 * Bounded by HEAL_LOOKBACK_DAYS, so the worst case is a week of days rather
 * than the whole table.
 */
export async function recordFuelTrendsWithCatchUp(asOf = new Date()): Promise<TrendOutcome[]> {
  const out = await recordFuelTrends(asOf)

  const todayStart = fleetDayStart(asOf)
  // The complete days that should have rows: yesterday back HEAL_LOOKBACK_DAYS.
  const wanted: Date[] = []
  for (let d = HEAL_LOOKBACK_DAYS; d >= 1; d--) {
    wanted.push(fleetDayKey(new Date(todayStart.getTime() - (d - 1) * 86_400_000 - 1)))
  }

  const present = new Set(
    (await prisma.fuelDailyTrend.findMany({
      where:  { day: { gte: wanted[0] } },
      select: { day: true },
      distinct: ['day'],
    })).map(r => r.day.toISOString().slice(0, 10)),
  )

  const firstGap = wanted.findIndex(d => !present.has(d.toISOString().slice(0, 10)))
  if (firstGap === -1) return out

  const missing = wanted.filter(d => !present.has(d.toISOString().slice(0, 10)))
  logger.warn({
    missing: missing.map(d => d.toISOString().slice(0, 10)),
    recomputingFrom: wanted[firstGap].toISOString().slice(0, 10),
  }, 'Fuel daily trend gap found — recomputing forward from it')

  // Forward from the earliest gap to yesterday, so each day sees the ones
  // already written behind it.
  for (let i = firstGap; i < wanted.length; i++) {
    const inDay = new Date(todayStart.getTime() - (wanted.length - 1 - i) * 86_400_000 - 1)
    try {
      out.push(...await recordFuelTrends(inDay))
    } catch (err) {
      // One unrepairable day must not abandon the rest of the window.
      logger.error({ err, day: wanted[i].toISOString().slice(0, 10) },
        'Fuel daily trend catch-up failed for a day')
    }
  }

  return out
}
