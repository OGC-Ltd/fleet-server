/**
 * Per-vehicle tank state for the Fuel FSL table, for one fleet day.
 *
 * The rule is in `fuel-tank-state.ts` and is pure; this is the plumbing.
 *
 * Two queries for the whole org, never one per vehicle. A fleet of 200 units
 * would otherwise cost 400 round trips to the same pooler the 2-second
 * telemetry poll is using, for a table that redraws whenever an operator opens
 * a tab.
 */

import { prisma } from '../../lib/prisma.js'
import { fleetDayStart, fleetDayKey } from '../../lib/provider-time.js'
import {
  closingLevel, deriveTankState, resolveEngineSeconds, dayEngineSeconds,
  CLOSE_WINDOW_MINUTES,
  MAX_ENGINE_GAP_SECONDS, MOTION_MIN_KMH, UNKNOWN_TANK_STATE,
  type LevelReading, type TankState,
} from './fuel-tank-state.js'
import { getOrgFuelRates } from './fuel-rate.service.js'
import { normalisedRate } from './fuel-normalised-rate.js'
import { engineBurnMl } from './fuel-rate.js'

/*
 * `PREV_CLOSE_SAMPLES` used to live here — the per-vehicle row cap on the
 * previous-day close query, sized at 600 to clear the densest 15 minutes any
 * vehicle produced (measured p50 2, p99 77, densest 376).
 *
 * It is gone because the query no longer ships rows to be medianised in Node;
 * it medianises in SQL and returns one row per vehicle, so there is nothing to
 * cap. The note is kept because the reasoning behind 600 was measured, and
 * anyone reintroducing a row-shipping form of this query needs it: the cap has
 * to exceed the densest CLOSE_WINDOW_MINUTES on the fleet or the median is
 * taken over a shorter span than `closingLevel` uses, and the day-to-day
 * reconciliation breaks for exactly the busiest units.
 */

/**
 * How far back to gather run slosh so the turbulence average can span days.
 *
 * Vehicles average 1.3-2.0 runs a day (measured 2026-08-13), so a fortnight
 * comfortably contains the TURBULENCE_STOPS most recent runs for all but the
 * most idle unit — and one that idle has no recent journeys to describe.
 */
const TREND_LOOKBACK_DAYS = 14

/**
 * Longest single hop counted as travel.
 *
 * At a 30-second ping, 10 km between consecutive fixes is over 600 km/h — a GPS
 * jump, not a journey. One such fix left in would add hundreds of kilometres to
 * a vehicle's day, and the dropped hop costs at most the real distance the unit
 * covered while its fix was wrong.
 */
const MAX_HOP_KM = 10

export interface VehicleTankState extends TankState {
  vehicleId: string
}

/**
 * Tank state for every vehicle in the org, for the fleet day containing `asOf`.
 *
 * `asOf` bounds the day: for today it is now, so `currentMl` is the latest
 * reading; for a past day the caller passes that day's end and `currentMl` is
 * that day's closing level.
 */
export async function getFleetTankState(orgId: string, asOf = new Date()): Promise<VehicleTankState[]> {
  // A finished day has already been measured — read it rather than measure it
  // again. Null when the day is today, or when nothing usable is stored.
  const stored = await readStoredTankState(orgId, asOf)
  if (stored) return stored
  return computeFleetTankState(orgId, asOf)
}

/**
 * A past fleet day, served from `fuel_daily_trends`.
 *
 * ## Why this exists
 *
 * `computeFleetTankState` rebuilds a whole fleet day from raw telemetry on
 * every request — **241,281 rows for one KASULU day** — against an instance
 * whose `work_mem` is 4 MB, so its window functions spill to disk. Measured
 * 2026-08-14: 5.6 s for today, **13.4 s for a past day**, and the FSL table
 * redraws whenever an operator opens a tab or moves the date picker.
 *
 * The nightly trend job has already computed exactly these figures for every
 * finished day. Recomputing them is work done twice, and the second time is on
 * a person waiting.
 *
 * ## Only for a day that is OVER
 *
 * Today has no stored row yet and would be wrong if it had one: the day is
 * still accumulating, and `currentMl` for today means "the latest reading",
 * which changes every few seconds. Today always recomputes.
 *
 * ## Only for a day the CURRENT code computed
 *
 * Rows written before `engineHoursMeter` existed carry nulls for it and for
 * `engineSeconds`, and serving those would blank columns that the recompute
 * path fills — a regression dressed as a speed-up. A day qualifies only if at
 * least one of its rows carries a meter reading, which no pre-2026-08-14 row
 * does. Older days keep recomputing, correctly and slowly, and convert to the
 * fast path as `prisma/fuel-trends.ts` backfills them.
 *
 * ## Rates are resolved live, not read from the row
 *
 * `engineBurnMl` is stored, but it is a rate multiplied by a duration and the
 * RATE moves — weekly, and whenever a bad one is pruned. Only the DURATION is a
 * fact about that day. So the duration comes from the row and the rate from the
 * current table, which means a corrected rate reaches history without a
 * backfill, and a stored burn can never disagree with the rate shown beside it.
 */
async function readStoredTankState(orgId: string, asOf: Date): Promise<VehicleTankState[] | null> {
  const day = fleetDayKey(asOf)
  if (day.getTime() >= fleetDayKey(new Date()).getTime()) return null

  const rows = await prisma.fuelDailyTrend.findMany({
    where:  { day, vehicle: { organisationId: orgId } },
    select: {
      vehicleId: true, openingMl: true, closingMl: true, consumedMl: true,
      turbulenceMl: true, stopsAveraged: true, runSloshMl: true,
      temporaryStops: true, heavyStops: true, distanceM: true,
      expectedBurnMl: true, engineSeconds: true, engineHoursMeter: true,
    },
  })
  if (rows.length === 0) return null
  // Written before the engine fields existed — recompute instead of serving
  // blanks. See the note above.
  if (!rows.some(r => r.engineHoursMeter != null)) return null

  const rates = await getOrgFuelRates(orgId)

  return rows.map(r => {
    const rate = rates.get(r.vehicleId) ?? null
    // Recomputed from the stored columns rather than stored itself. The
    // arithmetic is cheap and derived-and-stored is how a figure comes to
    // disagree with the numbers printed next to it — the same reasoning that
    // keeps `engineBurnMl` out of the table.
    const norm = normalisedRate(r.consumedMl, r.turbulenceMl, r.engineSeconds)
    return {
      vehicleId:      r.vehicleId,
      initialMl:      r.openingMl,
      currentMl:      r.closingMl,
      consumedMl:     r.consumedMl,
      turbulenceMl:   r.turbulenceMl,
      stopsAveraged:  r.stopsAveraged,
      runSloshMl:     r.runSloshMl,
      temporaryStops: r.temporaryStops,
      heavyStops:     r.heavyStops,
      distanceM:      r.distanceM,
      expectedBurnMl: r.expectedBurnMl,
      engineHoursMeter: r.engineHoursMeter,
      engineSeconds:  r.engineSeconds,
      engineBurnMl:   engineBurnMl(r.engineSeconds, rate),
      normalisedLPerHour:       norm?.lPerHour    ?? null,
      normalisedMinLPerHour:    norm?.minLPerHour ?? null,
      normalisedMaxLPerHour:    norm?.maxLPerHour ?? null,
      normalisedNoiseDominates: norm?.noiseDominates ?? false,
      engineRateLPerHour: rate?.lPerHour ?? null,
      engineRateBasis:    rate?.basis    ?? null,
      engineRateSpread:   rate?.spread   ?? null,
      engineRateRuns:     rate?.runs     ?? null,
    }
  })
}

/**
 * The previous day's closing level per vehicle, reconstructed from telemetry.
 *
 * The FALLBACK for when yesterday has no stored trend row — a gap in the
 * backfill, or the first day of the record. Everything else should be reading
 * that row instead; see the note at the call site for what this costs.
 *
 * The median is taken IN SQL and returns one row per vehicle. It used to ship
 * every candidate row to Node — up to 600 per vehicle, ~66,000 for KASULU, to
 * produce 133 numbers.
 *
 * ⚠️ This median MUST match `closingLevel` exactly, because one day's Current
 * is the next day's Initial and a disagreement breaks the reconciliation the
 * column exists for. `closingLevel` sorts ascending and takes index
 * `floor(n/2)`, which for an even count is the UPPER of the two middle values.
 * Postgres `percentile_cont` interpolates and `percentile_disc` takes the
 * LOWER — neither matches — so the array is indexed directly, +1 for SQL's
 * 1-based arrays. Verified against the JS implementation on live data:
 * **129 of 129 identical, 0 different.**
 *
 * The window is anchored to each vehicle's OWN last reading rather than to the
 * day boundary: a unit that went quiet at noon closes at noon, and cutting the
 * window at midnight would leave it with no readings at all.
 */
async function closeFromTelemetry(orgId: string, dayStart: Date): Promise<Map<string, number>> {
  const prevStart = new Date(dayStart.getTime() - 24 * 3_600_000)
  const rows = await prisma.$queryRaw<Array<{ vehicle_id: string; close_ml: number | null }>>`
    WITH last_read AS (
      SELECT v.id AS vehicle_id, t.captured_at AS last_at
        FROM vehicles v
        CROSS JOIN LATERAL (
          SELECT tt.captured_at
            FROM vehicle_telemetries tt
           WHERE tt.vehicle_id = v.id
             AND tt.captured_at >= ${prevStart}
             AND tt.captured_at <  ${dayStart}
             AND tt.fuel_level_ml IS NOT NULL
           ORDER BY tt.captured_at DESC
           LIMIT 1
        ) t
       WHERE v.organisation_id = ${orgId}
    ), tail AS (
      SELECT l.vehicle_id, tt.fuel_level_ml
        FROM last_read l
        JOIN vehicle_telemetries tt
          ON tt.vehicle_id = l.vehicle_id
         AND tt.captured_at <= l.last_at
         AND tt.captured_at >= l.last_at - make_interval(mins => ${CLOSE_WINDOW_MINUTES})
       WHERE tt.fuel_level_ml IS NOT NULL
    )
    SELECT vehicle_id,
           (array_agg(fuel_level_ml ORDER BY fuel_level_ml))[floor(count(*) / 2) + 1] AS close_ml
      FROM tail
     GROUP BY vehicle_id`

  const out = new Map<string, number>()
  for (const r of rows) if (r.close_ml != null) out.set(r.vehicle_id, Number(r.close_ml))
  return out
}

/**
 * Measure the day from raw telemetry. The expensive path.
 *
 * Exported because `recordFuelTrends` MUST call it directly and never
 * `getFleetTankState`. The job writes the very rows the cached path reads, so
 * going through the cache would have it read its own previous output and write
 * it straight back — the trend table would freeze at whatever it last held and
 * a backfill would be a no-op that reported success.
 */
export async function computeFleetTankState(orgId: string, asOf: Date): Promise<VehicleTankState[]> {
  const dayStart = fleetDayStart(asOf)

  // The day's readings, for the closing level and the working turbulence.
  const dayRows = await prisma.vehicleTelemetry.findMany({
    where: {
      vehicle:     { organisationId: orgId },
      capturedAt:  { gte: dayStart, lte: asOf },
      fuelLevelMl: { not: null },
    },
    select:  { vehicleId: true, capturedAt: true, fuelLevelMl: true, engineOn: true, speedKmh: true },
    orderBy: { capturedAt: 'asc' },
  })

  // The PREVIOUS day's closing level — the LAST FEW readings per vehicle, not
  // one, and not another 24 hours of rows either.
  //
  // It has to be the last few, because `closingLevel` medianises the final
  // CLOSE_WINDOW_MINUTES and this value must come out identical to the
  // `currentMl` that vehicle's own row showed yesterday. Otherwise one day's
  // Current and the next day's Initial disagree and the column stops
  // reconciling — which is the whole reason the pair is a day boundary. A
  // single reading, which is what this did first, cannot match a median.
  //
  // `PREV_CLOSE_SAMPLES` is a comfortable over-fetch of the ~30 readings
  // CLOSE_WINDOW_MINUTES spans at this fleet's ping rate; `closingLevel` then
  // applies the real time window to whatever it is handed, so over-fetching is
  // free and under-fetching would silently change the answer.
  //
  // LATERAL rather than a 24-hour scan: it walks the (vehicle_id, captured_at)
  // index backwards per vehicle and stops after LIMIT rows.
  // ## The median is taken IN SQL, and that is a performance fix, not a style one
  //
  // This shipped every candidate row to Node and medianised them here: up to
  // `PREV_CLOSE_SAMPLES` per vehicle, ~66,000 rows for KASULU, to produce 214
  // numbers. Measured 2026-08-14 it was the single query that broke the table —
  // **60 s and a client timeout**, where every other query in this function ran
  // in 1.4–8.4 s. The FSL table then rendered with Initial, Current, Mileage,
  // Expected, Engine hrs and Turbulence all blank, because the dashboard
  // catches a failed tank-state call and falls back to an empty map. A silent
  // blank, from the one query nobody was watching.
  //
  // It now returns one row per vehicle. The window is still anchored to that
  // vehicle's OWN last reading rather than to the day boundary — a unit that
  // went quiet at noon closes at noon, and cutting the window at midnight would
  // give it no readings at all.
  //
  // ⚠️ The median here MUST match `closingLevel` exactly, because one day's
  // Current is the next day's Initial and a disagreement breaks the
  // reconciliation the whole column exists for. `closingLevel` sorts ascending
  // and takes index `floor(n/2)`, which for an even count is the UPPER of the
  // two middle values. Postgres `percentile_cont` interpolates and
  // `percentile_disc` takes the LOWER — neither matches — so the array is
  // indexed directly, +1 for SQL's 1-based arrays.
  // ## First ask yesterday's stored row, because Initial IS yesterday's Current
  //
  // That is not an approximation, it is the invariant the column is built on and
  // it was verified on live data when the pair shipped: 129 agree, 0 differ. So
  // the opening balance for a day is a 133-row indexed read, not a reconstruction
  // from a full day of telemetry.
  //
  // This matters most for TODAY, which can never be served from the cached path
  // and so pays the reconstruction on every request. Measured 2026-08-14 the
  // telemetry form of this query was the one that broke the table: **60 s and a
  // client timeout**, while every other query in this function ran in 1.4–8.4 s.
  // The dashboard catches a failed tank-state call and renders an empty map, so
  // the operator saw Initial, Current, Mileage, Expected, Engine hrs and
  // Turbulence all blank at once, with no error anywhere.
  //
  // The instance is why it is marginal rather than merely slow: ~1 GB of RAM,
  // `work_mem` 4 MB, and it goes IO-bound under any concurrent aggregation, at
  // which point a query that normally takes 1.7 s takes more than a minute.
  // Removing the scan removes the exposure.
  const prevDayKey = fleetDayKey(new Date(dayStart.getTime() - 1))
  const storedPrev = await prisma.fuelDailyTrend.findMany({
    where:  { day: prevDayKey, vehicle: { organisationId: orgId } },
    select: { vehicleId: true, closingMl: true },
  })

  const prevClose = new Map<string, number>()
  for (const r of storedPrev) {
    if (r.closingMl != null) prevClose.set(r.vehicleId, r.closingMl)
  }

  // Fall back to the telemetry only when yesterday was never recorded — a gap in
  // the backfill, or the first day of the record. Correct but expensive, so it
  // is the exception rather than the path every request takes.
  if (prevClose.size === 0) {
    for (const [id, close] of await closeFromTelemetry(orgId, dayStart)) {
      prevClose.set(id, close)
    }
  }
  const byVehicle = new Map<string, LevelReading[]>()
  for (const r of dayRows) {
    const s = {
      capturedAt: r.capturedAt, fuelLevelMl: r.fuelLevelMl!,
      engineOn: r.engineOn, speedKmh: r.speedKmh,
    }
    const list = byVehicle.get(r.vehicleId)
    if (list) list.push(s)
    else byVehicle.set(r.vehicleId, [s])
  }

  // Run slosh from BEFORE this day, so the turbulence average spans midnight
  // rather than restarting on it. Only the last TURBULENCE_STOPS runs can
  // matter, and vehicles average 1.3-2.0 runs a day, so a fortnight is a
  // generous reach — bounded so a long-silent vehicle cannot drag the query.
  const priorFrom = new Date(dayStart.getTime() - TREND_LOOKBACK_DAYS * 86_400_000)
  const priorRows = await prisma.fuelDailyTrend.findMany({
    where:   { day: { gte: priorFrom, lt: dayStart }, vehicle: { organisationId: orgId } },
    select:  { vehicleId: true, runSloshMl: true },
    orderBy: { day: 'asc' },
  })
  const priorRuns = new Map<string, number[]>()
  for (const r of priorRows) {
    const list = priorRuns.get(r.vehicleId)
    if (list) list.push(...r.runSloshMl)
    else priorRuns.set(r.vehicleId, [...r.runSloshMl])
  }

  // Ground covered today, and time the engine spent running — the two
  // measurements the day's fuel expectations are built on.
  //
  // ONE pass over the day's telemetry for both. They need the same rows: every
  // fix, including the ones with no fuel reading that the day query above
  // filters out. Pulling those into memory would roughly double the payload for
  // two numbers, and running two queries would scan the same partition twice.
  //
  // Distance: there is no odometer on vehicle_telemetries — Wialon's counter
  // reaches the snapshot but is not persisted per ping — so it is the sum of
  // great-circle hops between consecutive fixes. Haversine written out rather
  // than PostGIS: ST_DistanceSphere would do, but this needs no extension to be
  // present and the arithmetic is not the hard part. Hops longer than
  // MAX_HOP_KM are dropped — at a 30-second ping that is over 600 km/h, so it
  // is a GPS jump rather than travel, and one such fix would otherwise add
  // hundreds of kilometres to a vehicle's day.
  //
  // Engine seconds: the gap between consecutive fixes, charged to the EARLIER
  // fix's engine state and capped at MAX_ENGINE_GAP_SECONDS. The day's first
  // fix per vehicle has no predecessor, so `prev_on` and `secs` are both NULL
  // there and the CASE contributes nothing — a day opens from its first ping,
  // not from midnight, which is the only honest reading when the hours before
  // it are simply unobserved.
  //
  // The two are computed over DIFFERENT row sets on purpose: the hop chain
  // takes only position-bearing fixes, so a fix with no lat/lng breaks no hop,
  // while engine time takes every fix, because a unit reporting ignition
  // without a position is still running its engine.
  const dayRowsSql = await prisma.$queryRaw<Array<{
    vehicle_id: string; metres: number | null; seconds: number | null
    on_pings: number | null; moving_pings: number | null
  }>>`
    WITH base AS (
      SELECT t.vehicle_id, t.captured_at, t.lat, t.lng, t.engine_on, t.speed_kmh
        FROM vehicle_telemetries t
        JOIN vehicles v ON v.id = t.vehicle_id
       WHERE v.organisation_id = ${orgId}
         AND t.captured_at >= ${dayStart} AND t.captured_at <= ${asOf}
    ), pos AS (
      SELECT vehicle_id, lat, lng,
             lag(lat) OVER w AS plat,
             lag(lng) OVER w AS plng
        FROM base
       WHERE lat IS NOT NULL AND lng IS NOT NULL
      WINDOW w AS (PARTITION BY vehicle_id ORDER BY captured_at)
    ), hop AS (
      SELECT vehicle_id,
             6371000 * 2 * asin(sqrt(
               power(sin(radians(lat - plat) / 2), 2)
               + cos(radians(plat)) * cos(radians(lat))
                 * power(sin(radians(lng - plng) / 2), 2)
             )) AS metres
        FROM pos WHERE plat IS NOT NULL
    ), dist AS (
      SELECT vehicle_id, sum(metres) AS metres
        FROM hop
       WHERE metres < ${MAX_HOP_KM * 1000}
       GROUP BY vehicle_id
    ), gap AS (
      -- engine_on and speed_kmh are carried through so the aggregate below can
      -- compute the ignition-signal counts in the SAME pass. They were a
      -- separate CTE over the base rows and that pass cost 2.1 s of a 4.5 s
      -- query — a full extra scan and GROUP BY to produce two counters that
      -- the existing GROUP BY was already positioned to produce.
      SELECT vehicle_id, engine_on, speed_kmh,
             lag(engine_on) OVER w AS prev_on,
             extract(epoch FROM (captured_at - lag(captured_at) OVER w)) AS secs
        FROM base
      WINDOW w AS (PARTITION BY vehicle_id ORDER BY captured_at)
    ), eng AS (
      SELECT vehicle_id,
             sum(CASE WHEN prev_on AND secs > 0
                      THEN least(secs, ${MAX_ENGINE_GAP_SECONDS}) ELSE 0 END) AS seconds,
             -- Is the ignition flag corroborated by motion? Speed does not come
             -- from the ignition wire, so a unit that moved while never
             -- reporting engine-on has a dead flag rather than a quiet day. 27
             -- units on this fleet send 500+ pings and never once report it.
             -- See resolveEngineSeconds for what is done with these counts.
             count(*) FILTER (WHERE engine_on)::int AS on_pings,
             count(*) FILTER (WHERE speed_kmh >= ${MOTION_MIN_KMH})::int AS moving_pings
        FROM gap
       GROUP BY vehicle_id
    )
    SELECT COALESCE(d.vehicle_id, e.vehicle_id) AS vehicle_id,
           d.metres, e.seconds, e.on_pings, e.moving_pings
      FROM dist d
      FULL OUTER JOIN eng e ON e.vehicle_id = d.vehicle_id`

  const distance = new Map<string, number>()
  // The gap-integrated engine time. Only a FALLBACK now — it is structurally
  // over-counted, by 664 s against the operator's figure for KTCC 959G — and is
  // used where a unit's tracker reports no counter. Combined with the counter
  // below, once that query has run.
  const integratedSeconds = new Map<string, number | null>()
  for (const r of dayRowsSql) {
    if (r.metres != null) distance.set(r.vehicle_id, Math.round(Number(r.metres)))
    if (r.seconds != null) {
      // Null, not zero, when the day's motion contradicts a silent ignition
      // flag — otherwise a dead wire renders as "burned nothing".
      integratedSeconds.set(r.vehicle_id, resolveEngineSeconds(
        Math.round(Number(r.seconds)), Number(r.on_pings ?? 0), Number(r.moving_pings ?? 0),
      ))
    }
  }

  // The unit's cumulative ENGINE-HOUR METER as it stood at the day's end.
  //
  // Wialon's `cneh` reaches us in the RAW payload, not as a column on
  // vehicle_telemetries — the same way the odometer does. Coverage measured
  // 2026-08-14: 159 of 214 active KASULU units and 270 of 284 SUKARI ones.
  //
  // ## This must stay a per-vehicle LATERAL, never a scan
  //
  // `vehicle_telemetry_raws` is ~156 MB. Joining it across a whole org-day
  // TIMED OUT at 60 s against this instance while measuring — that attempt is
  // why this is written as an indexed backward walk taking ONE row per
  // vehicle. In that form the whole org costs about 250 ms, because it rides
  // the (vehicle_id, captured_at) index and stops at the first row.
  //
  // The value is carried forward by the adapter into every frame, so the
  // newest row almost always has it and the walk stops immediately. LIMIT 1
  // rather than "the newest non-null" for exactly that reason: a NOT NULL
  // predicate on a JSON field cannot use an index, so on a unit that never
  // reports `cneh` it would walk the entire day before giving up.
  // BOTH boundary readings of the counter, so the day's engine hours can be its
  // DELTA — see dayEngineSeconds, which is exact against the operator's own
  // figure where integrating pings is out by minutes.
  //
  // Both readings are bounded INSIDE the day. The closing one alone could be
  // carried forward from an earlier day (the adapter repeats the last known
  // value), and a delta taken against that would attribute another day's hours
  // to this one.
  const meterRows = await prisma.$queryRaw<Array<{
    vehicle_id: string; first_eh: number | null; last_eh: number | null
  }>>`
    SELECT v.id AS vehicle_id, f.eh AS first_eh, l.eh AS last_eh
      FROM vehicles v
      LEFT JOIN LATERAL (
        SELECT (r.payload->>'engine_hours')::float AS eh
          FROM vehicle_telemetries t
          JOIN vehicle_telemetry_raws r ON r.telemetry_id = t.id
         WHERE t.vehicle_id = v.id
           AND t.captured_at >= ${dayStart} AND t.captured_at <= ${asOf}
         ORDER BY t.captured_at ASC
         LIMIT 1
      ) f ON true
      LEFT JOIN LATERAL (
        SELECT (r.payload->>'engine_hours')::float AS eh
          FROM vehicle_telemetries t
          JOIN vehicle_telemetry_raws r ON r.telemetry_id = t.id
         WHERE t.vehicle_id = v.id
           AND t.captured_at >= ${dayStart} AND t.captured_at <= ${asOf}
         ORDER BY t.captured_at DESC
         LIMIT 1
      ) l ON true
     WHERE v.organisation_id = ${orgId} AND v.is_active`

  const engineHoursMeter = new Map<string, number>()
  const meterFirst = new Map<string, number>()
  for (const r of meterRows) {
    // A zero counter is a tracker that reports the field without a real value,
    // not a machine that has never run.
    if (r.last_eh  != null && r.last_eh  > 0) engineHoursMeter.set(r.vehicle_id, Number(r.last_eh))
    if (r.first_eh != null && r.first_eh > 0) meterFirst.set(r.vehicle_id, Number(r.first_eh))
  }

  // The day's engine hours: the machine's own counter where it has one, the
  // integrated figure only where it does not. See dayEngineSeconds.
  const engineSeconds = new Map<string, number | null>()
  for (const id of new Set([...integratedSeconds.keys(), ...meterFirst.keys()])) {
    engineSeconds.set(id, dayEngineSeconds(
      meterFirst.get(id) ?? null,
      engineHoursMeter.get(id) ?? null,
      integratedSeconds.get(id) ?? null,
    ))
  }

  // Consumption rates, resolved per vehicle with an org+type fallback. Read
  // from the table the weekly derivation writes — never computed here, which is
  // the point of §7.1 of docs/fuel-consumption-rates.md: this runs whenever an
  // operator opens a tab.
  const rates = await getOrgFuelRates(orgId)

  // Every vehicle that reported on EITHER day gets a row. One that reported
  // yesterday and not today still has an opening balance worth showing, and
  // dropping it would make a silent unit vanish from the table rather than
  // appear with a blank current — which is the thing worth noticing.
  const ids = new Set([...byVehicle.keys(), ...prevClose.keys()])

  return [...ids].map(vehicleId => {
    const readings = byVehicle.get(vehicleId) ?? []
    const prev = prevClose.get(vehicleId) ?? null
    if (readings.length === 0 && prev == null) return { vehicleId, ...UNKNOWN_TANK_STATE }
    return {
      vehicleId,
      ...deriveTankState(readings, prev, {
        priorRunSloshMl: priorRuns.get(vehicleId) ?? [],
        distanceM:       distance.get(vehicleId) ?? null,
        engineSeconds:   engineSeconds.get(vehicleId) ?? null,
        rate:            rates.get(vehicleId) ?? null,
        engineHoursMeter: engineHoursMeter.get(vehicleId) ?? null,
      }),
    }
  })
}
