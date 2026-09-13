/**
 * The ground an excavator actually worked over, in square metres, and the hours
 * it spent doing it.
 *
 * ## Why the obvious geometries fail
 *
 * Swath × distance is the earthmoving standard and is meaningless here: an
 * excavator covers 0.55 km per engine hour against a road vehicle's 29. It does
 * not travel over the ground it works, it sits on it.
 *
 * A convex hull of the day's fixes fails differently and more convincingly.
 * Tried against KASULU on 2026-08-19 it gave `MUFINDI: EX 17` 18.5 million m²
 * across a 9.8 km span — the machine had been floated between two sites and the
 * hull spanned both, counting the road between them as worked ground. A hull
 * cannot tell "worked all of this" from "worked at either end of it".
 *
 * ## What this measures instead
 *
 * The machine's own working footprint: a circle of REACH_METRES at every fix
 * where it was digging, unioned. That is the ground the bucket could have
 * touched, and it is the shape of the work rather than the shape of the day's
 * travel. Two spots 10 km apart contribute two small discs, not the corridor
 * between them.
 *
 * Digging means engine on and speed at or below DIG_SPEED_KMH — tramming
 * between faces is excluded, which is the same distinction that keeps the hull
 * honest.
 *
 * ## What it is not
 *
 * An upper bound on ground touched, not a survey. It assumes the machine could
 * reach anywhere within REACH_METRES of where it stood, which is true of its
 * arm and not necessarily true of its work — a machine trenching in a line
 * sweeps far less than the discs suggest. It is the right figure for "how much
 * ground did this unit range over", and the wrong one for billing.
 */

import { prisma } from '../../lib/prisma.js'
import { createWarmCache } from '../../lib/warm-cache.js'
import { vehicleSql, windowCacheKey, parseWindowCacheKey, categoriesKey, vehiclesKey, vehicleIdsFor } from './vehicle-filter.js'
import { fleetDayStart, fleetDayKey } from '../../lib/provider-time.js'

/**
 * The excavator's working reach, metres — supplied by the operator, 2026-08-20.
 *
 * One number for the class rather than per machine, which is what makes this
 * computable at all: `vehicles.model` is empty on all 218 units, so there is no
 * per-model figure to look up. Changing it rescales every area here, so it is a
 * named constant and not a literal inside the query.
 */
export const REACH_METRES = 8

/** At or below this the machine is digging, not tramming between faces. */
export const DIG_SPEED_KMH = 2

/** Longest gap between fixes that still counts as continuous work — matches
 *  the rollup's cap so these hours are the same measure as every other. */
export const MAX_GAP_SECONDS = 900

/**
 * Grid the digging positions are snapped to before they are deduplicated, in
 * degrees. 5e-6 deg is about 0.55 m at this latitude.
 *
 * Sized against REACH_METRES rather than against GPS accuracy: the question is
 * how far the snapped disc sits from the true one, and half a metre of centre
 * shift on an eight-metre radius is under a tenth of the reach.
 */
export const SNAP_DEGREES = 0.000005

/** Fixes below which a day's geometry is too thin to report. */
export const MIN_DIG_FIXES = 20

export interface ExcavatorDay {
  vehicleId: string
  plate:     string
  /** Ground the bucket could have touched, square metres. */
  areaM2:    number
  /** Hours the machine spent digging over that ground. */
  digHours:  number
  /** Fixes behind the geometry — the measurement's own sample size. */
  digFixes:  number
  /** Square metres per digging hour. The rate, which is what makes two days
   *  comparable when they are different lengths. */
  m2PerHour: number
}

/**
 * One fleet day of excavator work.
 *
 * Defaults to the last COMPLETE day rather than today: the figure is a day's
 * output, and a day four hours old reports a quarter of one while looking like
 * a full result.
 */
export async function excavatorAreaByDay(
  orgId: string, day?: Date, vehicleIds: string[] | null = null,
): Promise<{ day: string; reachMetres: number; units: ExcavatorDay[]; totalM2: number }> {
  const start = day ?? new Date(fleetDayStart().getTime() - 24 * 3_600_000)

  // Read, do not compute.
  //
  // This used to build the geometry on demand behind an hourly cache, and it
  // stopped fitting: measured 2026-08-20 the endpoint returned 500 after 60 s,
  // the client query_timeout. Reading and unioning one machine's digging day
  // takes about 19 s and there are nineteen machines. The union was never the
  // expensive part — a count over the same rows with no geometry at all also
  // timed out — so no amount of reshaping the query was going to fit it into a
  // request.
  //
  // The day is complete and immutable, so the nightly job draws it once per
  // machine and this reads the answer. See vehicle-daily-stats.service.
  const rows = await prisma.vehicleDailyStat.findMany({
    where: {
      day:       fleetDayKey(new Date(start.getTime() + 1)),
      digAreaM2: { not: null },
      vehicle:   { organisationId: orgId, isActive: true },
      ...(vehicleIds == null ? {} : { vehicleId: { in: vehicleIds } }),
    },
    select: {
      vehicleId: true, digAreaM2: true, digSeconds: true,
      vehicle: { select: { registrationPlate: true } },
    },
    orderBy: { digAreaM2: 'desc' },
  })

  const units: ExcavatorDay[] = rows.map((r) => {
    const digHours = Math.round(((r.digSeconds ?? 0) / 3600) * 10) / 10
    const areaM2   = r.digAreaM2 ?? 0
    return {
      vehicleId: r.vehicleId,
      plate:     r.vehicle.registrationPlate,
      areaM2,
      digHours,
      // The frame count behind the geometry is not carried on the stored row —
      // it described the sample size of a computation that no longer happens
      // here. Reported as the hours it produced instead.
      digFixes:  0,
      m2PerHour: digHours > 0 ? Math.round(areaM2 / digHours) : 0,
    }
  })

  return {
  // The fleet day's own DATE, not the instant it began.
  //
  // A fleet day starts at 21:00 UTC the previous evening, so returning that
  // instant labelled the day one earlier than the day it describes, and every
  // reader had to know the convention to undo it. Neither did. The dash's
  // fmtDay appends "T00:00:00Z" to whatever it is given, so a full ISO string
  // became "...ZT00:00:00Z" and rendered "Invalid Date"; FleetStateSection
  // formatted the instant in the VIEWER's timezone, so a reader in Nairobi and
  // a reader in London saw different dates for the same figures.
  //
  // A bare YYYY-MM-DD has no timezone to get wrong, and it matches what every
  // other endpoint already returns — fuel trends, vehicle daily stats and the
  // telemetry repository all send fleetDayKey sliced to ten characters.
    day: fleetDayKey(new Date(start.getTime() + 1)).toISOString().slice(0, 10),
    reachMetres: REACH_METRES,
    units,
    totalM2: units.reduce((a, u) => a + u.areaM2, 0),
  }
}

/**
 * Served from the warmer.
 *
 * An hour between rebuilds, and generous at that: the default day is already
 * complete, so its answer cannot change. The interval exists because the union
 * of several thousand reach buffers costs seven to eleven seconds, not because
 * the data moves.
 *
 * Only the default day is warmed. A named past day is asked for occasionally,
 * is equally immutable once built, and enters the cache on first use — warming
 * every date anyone had ever picked would have the sweep rebuilding history
 * nobody is looking at.
 */
const AREA_REFRESH_MS = 60 * 60_000

const areaCache = createWarmCache<Awaited<ReturnType<typeof excavatorAreaByDay>>>({
  name: 'excavator-area',
  refreshMs: AREA_REFRESH_MS,
  maxEntries: 200,
  // Key: `${orgId}|${day}|${cats}|${units}` — only the default day, whole
  // fleet, is warmed.
  warmKeysFor: (orgId) => [`${orgId}|last|all|all`],
  compute: async (key) => {
    const [orgId = '', day = 'last', cats = 'all', units = 'all'] = key.split('|')
    return excavatorAreaByDay(orgId, day === 'last' ? undefined : new Date(day),
      await vehicleIdsFor(orgId,
        cats === 'all' ? null : cats.split(','),
        units === 'all' ? null : units.split(',')))
  },
})

/** Filtered reads are cached too — see the note on summaryCache in
 *  machine-operations for why computing them live was the wrong call. */
export async function getExcavatorArea(
  orgId: string, day?: Date,
  categories: string[] | null = null, vehicles: string[] | null = null,
) {
  return areaCache.get(
    `${orgId}|${day ? day.toISOString().slice(0, 10) : 'last'}`
    + `|${categoriesKey(categories)}|${vehiclesKey(vehicles)}`)
}


/**
 * Ground worked per fleet day, for a heatmap.
 *
 * The daily card on a haulage fleet plots TRIPS, which is the right measure
 * there and meaningless on plant — KASULU's excavators complete no trips at
 * all. This is the same question asked of a machine that never leaves its pit:
 * how much ground did the fleet turn over each day.
 *
 * Read from `vehicle_daily_stats`, never recomputed. Building one day's
 * geometry takes about fifteen seconds per machine; a month of them is a
 * nightly job's work, not a request's — see vehicle-daily-stats.service.
 *
 * Days with no stored figure are ABSENT rather than zero. A zero says the
 * excavators worked no ground that day; a gap says nobody measured it, and on a
 * window that reaches back past the rollup's own history those are very
 * different claims for a heatmap to make.
 */
/**
 * @param vehicleIds the Analytics page's vehicle-type filter, resolved to ids.
 *   Null is unfiltered; an empty array is a category this fleet has none of and
 *   correctly yields an empty series. `= ANY` rather than `IN` because Prisma
 *   parameterises a JS array into a single Postgres array argument.
 */
export async function areaByDay(
  orgId: string, days = 30, to?: Date, vehicleIds: string[] | null = null,
): Promise<{ days: Array<{ day: string; m2: number; km2: number; machines: number }>
             totalM2: number; measuredDays: number; windowDays: number }> {
  // Anchored, not rolling. The page is driven by a month picker, so the window
  // has to be the month the operator chose — 1st to today for the current one,
  // 1st to last for a past one. `to` is the same anchor the delivery analytics
  // take, and `days` the same length, so a heatmap and the figures beside it
  // cannot end up describing different stretches of time.
  const anchor  = to ?? new Date()
  const lastDay = fleetDayKey(anchor)
  const from    = fleetDayKey(new Date(fleetDayStart(anchor).getTime() - (days - 1) * 86_400_000))

  const rows = await prisma.$queryRaw<Array<{ day: Date; m2: number; machines: bigint }>>`
    SELECT s.day,
           sum(s.dig_area_m2)::float8 AS m2,
           count(*)::bigint           AS machines
      FROM vehicle_daily_stats s
      JOIN vehicles v ON v.id = s.vehicle_id
     WHERE v.organisation_id = ${orgId}
       AND v.is_active
       AND s.dig_area_m2 IS NOT NULL
       AND s.day >= ${from}
       AND s.day <= ${lastDay}
       ${vehicleSql(vehicleIds)}
     GROUP BY 1
     ORDER BY 1`

  const out = rows.map(r => ({
    day:      r.day.toISOString().slice(0, 10),
    m2:       Math.round(r.m2),
    km2:      Math.round((r.m2 / 1_000_000) * 1000) / 1000,
    machines: Number(r.machines),
  }))

  return {
    days: out,
    totalM2: out.reduce((a, d) => a + d.m2, 0),
    // Stated so the card can say what it is drawing. A heatmap over thirty days
    // with four measured ones must not look like a fleet that stopped working.
    measuredDays: out.length,
    windowDays: days,
  }
}

/** Cached like the day view: the answer is a stack of completed days and cannot
 *  change until the nightly job adds one. */
const dayCache = createWarmCache<Awaited<ReturnType<typeof areaByDay>>>({
  name: 'excavator-area-by-day',
  refreshMs: AREA_REFRESH_MS,
  maxEntries: 200,
  // Only the current month, whole fleet, is warmed. A past month is immutable
  // and asked for occasionally; warming every month anyone had ever paged to
  // would keep the sweep rebuilding history nobody is looking at, and the same
  // goes for every category selection anyone had ever ticked.
  warmKeysFor: (orgId) => [windowCacheKey(orgId, 31, undefined, null)],
  compute: async (key) => {
    const { orgId, days, to, categories, vehicles } = parseWindowCacheKey(key)
    return areaByDay(orgId, days, to, await vehicleIdsFor(orgId, categories, vehicles))
  },
})

export async function getAreaByDay(
  orgId: string, days = 30, to?: Date,
  categories: string[] | null = null, vehicles: string[] | null = null,
) {
  return dayCache.get(windowCacheKey(orgId, days, to, categories, vehicles))
}
