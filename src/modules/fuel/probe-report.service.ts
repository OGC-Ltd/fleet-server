/**
 * One row per vehicle answering, for every channel it carries: is it working,
 * when did it last work, what did it last read, and what is it fitted to.
 *
 * ## Two questions, deliberately kept apart
 *
 * The dashboard's probe grid renders the LIVE snapshot: whatever the last frame
 * carried. That answers "what is this reading now" and cannot answer "when did
 * it stop", so a probe dead for a week looks exactly like one never installed —
 * both render a dash. Every question an operator actually asks about a faulty
 * probe is a question about history.
 *
 * So each channel here has two independent facts behind it:
 *
 *   FITTED   from `vehicle_sensors`, the provider's own configuration. A fuel
 *            sensor with no calibration table can never produce litres, and it
 *            reports no fault either, so nothing else on the fleet can see it.
 *   ALIVE    from telemetry over the lookback: last reading, last non-zero
 *            reading, and the value that came with it.
 *
 * Crossed, they separate faults that want different people. A probe that DIED
 * is a workshop job. A fuel sensor with `calibrationPoints = 0` is a Wialon
 * record somebody has to correct, and sending a fitter to that machine wastes
 * the trip. Measured 2026-08-20: 12 DIED, 31 SILENT, and 40 fuel sensors
 * carrying no calibration table.
 *
 * ## Why the non-fuel channels get a weaker verdict
 *
 * Fuel has vendor fault codes behind it — 4095 short circuit, 6500 lost tubes,
 * 7000 contamination — so `classifyProbe` can say a probe is broken rather than
 * merely quiet. GPS, ignition, odometer and engine hours have nothing of the
 * sort. All that can honestly be said of them is REPORTING or NOT REPORTING,
 * and this does not dress that up as a fault verdict.
 */

import { Prisma } from '../../../generated/prisma/client.js'
import { prisma } from '../../lib/prisma.js'
import { createWarmCache } from '../../lib/warm-cache.js'
import { logger } from '../../lib/logger.js'
import {
  classifyProbe, LOOKBACK_DAYS, DEAD_HOURS, MIN_PINGS,
  type ProbeState,
} from './fuel-probe-health.js'
import { FUEL_SENSOR_TYPE } from './sensor-inventory.service.js'

/** A channel that is not fuel: no fault codes, so only two honest live states. */
export type ChannelState = 'REPORTING' | 'NOT_REPORTING' | 'NOT_FITTED' | 'UNKNOWN'

export interface ChannelHealth {
  state:      ChannelState
  /** Last time this channel carried a value at all. */
  lastSeenAt: Date | null
  /** What it read then. Null when the channel is not numeric or never read. */
  lastValue:  number | null
}

export interface FuelSensorConfig {
  /** The provider has a fuel-level sensor on this unit. */
  fitted:            boolean
  name:              string | null
  parameter:         string | null
  calibrationPoints: number
  /** Top of the calibrated domain; above it a reading is a fault code. */
  calibratedMax:     number | null
  /**
   * Configured but uncalibrated: it can never produce a level and never reports
   * a fault. Invisible to every other rule, which is why it is named here.
   */
  uncalibrated:      boolean
}

export interface ProbeReportRow {
  vehicleId: string
  plate:     string
  name:      string
  /** The provider unit this is installed on — "which unit was it installed on". */
  deviceId:  string | null
  orgCode:   string

  /** The fuel probe, with the full DIED / SILENT / OK verdict. */
  fuelProbe: {
    state:       ProbeState
    reason:      string
    /** Last reading above zero and what it read — "when was it last operational". */
    lastAliveAt: Date | null
    lastValueMl: number | null
    /** Last reading of any kind, zeroes included. */
    lastSeenAt:  Date | null
    pings:       number
  }
  fuelSensor: FuelSensorConfig
  channels: {
    gps:         ChannelHealth
    ignition:    ChannelHealth
    odometer:    ChannelHealth
    engineHours: ChannelHealth
  }
  /**
   * When this unit last sent ANY telemetry, at any point in its life. Null when
   * it never has.
   */
  lastReportedAt: Date | null
  /**
   * The TRACKER has been silent for the whole lookback.
   *
   * A category the telemetry-only version could not represent at all, because
   * it was built by grouping telemetry: a unit with none simply had no row.
   * Measured on SUKARI 2026-08-20, 66 of 284 tracked units are in this state —
   * a device registered, provisioned and silent, several for over a year. They
   * are not a probe fault and no channel on them can be judged; the fault is
   * upstream of every question this report otherwise asks, which is exactly why
   * hiding them was wrong.
   */
  trackerSilent: boolean
  /** True when anything on this unit wants attention. Drives the default filter. */
  needsAttention: boolean
}

export interface ProbeReportOptions {
  orgId?: string
  now?:   Date
}

/**
 * A channel with no fault codes: REPORTING if seen inside the dead window,
 * NOT_REPORTING if seen only before it, NOT_FITTED if never seen at all, and
 * UNKNOWN when the unit has too little telemetry to judge anything.
 */
export function classifyChannel(
  lastSeenAt: Date | null, lastValue: number | null, deadFrom: Date, enough: boolean,
): ChannelHealth {
  if (!enough)            return { state: 'UNKNOWN',    lastSeenAt, lastValue }
  if (lastSeenAt == null) return { state: 'NOT_FITTED', lastSeenAt, lastValue }
  return {
    state: lastSeenAt >= deadFrom ? 'REPORTING' : 'NOT_REPORTING',
    lastSeenAt, lastValue,
  }
}


/**
 * Build the report.
 *
 * ## Five bounded queries, not one big one
 *
 * The natural shape — a single aggregate over the lookback computing every
 * channel — does not run here. Thirty days is 8.8 M telemetry rows, and each
 * extra `FILTER` expression is another predicate evaluated over all of them.
 * Measured against production on 2026-08-20:
 *
 *     the sweep's own shape                   12.8 s   375 rows
 *     the same plus GPS/ignition FILTERs      > 60 s   client timeout
 *     odometer via DISTINCT ON over the raws  > 60 s   client timeout
 *
 * So the month is scanned ONCE, in the shape already known to complete, and
 * every other fact comes from a query bounded either to the dead window or to a
 * few hundred keys. Vehicle metadata is joined in memory rather than widening
 * the GROUP BY.
 *
 * Around fifteen seconds all told, which is why callers get `getProbeReport`
 * and its cache rather than this.
 */
export async function buildProbeReport(opts: ProbeReportOptions = {}): Promise<ProbeReportRow[]> {
  const now       = opts.now ?? new Date()
  const from      = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 3_600_000)
  const deadFrom  = new Date(now.getTime() - DEAD_HOURS * 3_600_000)
  const orgFilter = opts.orgId ? Prisma.sql`AND v.organisation_id = ${opts.orgId}` : Prisma.empty

  // Per-stage timing. The build is six sequential round trips and we know only
  // the total; this says which one to attack next without an EXPLAIN, which
  // needs database access the deploy path does not have.
  const t0 = Date.now()
  let mark = t0
  const ms: Record<string, number> = {}
  const lap = (stage: string): void => { const n = Date.now(); ms[stage] = n - mark; mark = n }

  // ── 1. the month, in the shape that completes ────────────────────────────
  const rows = await prisma.$queryRaw<Array<{
    vehicle_id: string
    pings: bigint; level_pings: bigint; peak_ml: number | null
    last_alive_at: Date | null; last_level_at: Date | null
    recent_pings: bigint; recent_peak_ml: number | null; recent_moving: bigint
  }>>`
    SELECT t.vehicle_id,
           count(*)                                              AS pings,
           count(t.fuel_level_ml)                                AS level_pings,
           max(t.fuel_level_ml)                                  AS peak_ml,
           max(t.captured_at) FILTER (WHERE t.fuel_level_ml > 0) AS last_alive_at,
           max(t.captured_at) FILTER (WHERE t.fuel_level_ml IS NOT NULL) AS last_level_at,
           count(*)             FILTER (WHERE t.captured_at >= ${deadFrom}) AS recent_pings,
           max(t.fuel_level_ml) FILTER (WHERE t.captured_at >= ${deadFrom}) AS recent_peak_ml,
           count(*) FILTER (WHERE coalesce(t.speed_kmh, 0) > 1
                              AND t.captured_at >= ${deadFrom})  AS recent_moving
      FROM vehicle_telemetries t
      JOIN vehicles v ON v.id = t.vehicle_id
     WHERE t.captured_at >= ${from}
       AND v.is_active
       ${orgFilter}
     GROUP BY 1`

  lap('month')

  // The units that reported. NOT the population — see step 5, which starts from
  // the registry so a unit with no telemetry still gets a row.
  const vehicleIds = rows.map(r => r.vehicle_id)
  const aggByVehicle = new Map(rows.map(r => [r.vehicle_id, r]))

  // ── 2. the dead window: what each unit is reporting now ──────────────────
  // GPS and ignition presence live here rather than in the month's scan. The
  // question they answer is "is this channel alive today", and asking it of
  // 436 k rows instead of 8.8 M is the difference between running and timing
  // out. The newest row's id is carried out for step 3.
  const recent = vehicleIds.length === 0 ? [] : await prisma.$queryRaw<Array<{
    vehicle_id: string; latest_id: bigint; latest_at: Date
    gps_at: Date | null; ign_at: Date | null
  }>>`
    SELECT t.vehicle_id,
           (array_agg(t.id ORDER BY t.captured_at DESC))[1] AS latest_id,
           max(t.captured_at)                               AS latest_at,
           max(t.captured_at) FILTER (WHERE t.lat IS NOT NULL AND t.lng IS NOT NULL
                                        AND NOT (t.lat = 0 AND t.lng = 0)) AS gps_at,
           max(t.captured_at) FILTER (WHERE t.engine_on IS NOT NULL)       AS ign_at
      FROM vehicle_telemetries t
      JOIN vehicles v ON v.id = t.vehicle_id
     WHERE t.captured_at >= ${deadFrom}
       AND v.is_active
       ${orgFilter}
     GROUP BY 1`
  const recentByVehicle = new Map(recent.map(r => [r.vehicle_id, r]))

  lap('recent')

  // ── 3. the counters, by primary key ──────────────────────────────────────
  // Odometer and engine hours are not columns; they sit in the raw payload.
  // Joined on the few hundred ids from step 2 rather than across the window,
  // which is what made the DISTINCT ON version time out.
  const latestIds = recent.map(r => r.latest_id)
  const counters = latestIds.length === 0 ? [] : await prisma.$queryRaw<Array<{
    telemetry_id: bigint; odo_v: number | null; eh_v: number | null
  }>>`
    SELECT r.telemetry_id,
           (r.payload->>'odometer_km')::double precision  AS odo_v,
           (r.payload->>'engine_hours')::double precision AS eh_v
      FROM vehicle_telemetry_raws r
     WHERE r.telemetry_id IN (${Prisma.join(latestIds)})`
  const counterById = new Map(counters.map(c => [String(c.telemetry_id), c]))

  lap('counters')

  // ── 4. what the probe read when it was last alive ────────────────────────
  const alivePairs = rows
    .filter(r => r.last_alive_at != null)
    .map(r => Prisma.sql`(${r.vehicle_id}, ${r.last_alive_at}::timestamp)`)
  const lastValues = alivePairs.length === 0 ? [] : await prisma.$queryRaw<Array<{
    vehicle_id: string; fuel_level_ml: number | null
  }>>`
    SELECT DISTINCT ON (t.vehicle_id) t.vehicle_id, t.fuel_level_ml
      FROM vehicle_telemetries t
      JOIN (VALUES ${Prisma.join(alivePairs)}) AS w(vehicle_id, captured_at)
        ON w.vehicle_id = t.vehicle_id AND w.captured_at = t.captured_at
     ORDER BY t.vehicle_id, t.fuel_level_ml DESC NULLS LAST`
  const lastValueByVehicle = new Map(lastValues.map(v => [v.vehicle_id, v.fuel_level_ml]))

  lap('lastValues')

  // ── 5. the population, from the REGISTRY ─────────────────────────────────
  //
  // Every active unit with a tracker bound — not every unit that reported. The
  // difference is the point: a unit whose tracker has said nothing for a year
  // has no telemetry to group, so a telemetry-first query cannot produce a row
  // for it, and it was invisible. On SUKARI that is 66 of 284.
  const vehicles = await prisma.vehicle.findMany({
    where: {
      isActive: true,
      deviceId: { startsWith: 'wialon:' },
      ...(opts.orgId ? { organisationId: opts.orgId } : {}),
    },
    select: {
      id: true, registrationPlate: true, name: true, deviceId: true,
      organisation: { select: { code: true } },
    },
  })

  // How long the silent ones have been silent. Asked only of those units and
  // served by (vehicle_id, captured_at) as a backward index scan, so it is a
  // few dozen key lookups rather than a scan of the table.
  const darkIds = vehicles.filter(v => !aggByVehicle.has(v.id)).map(v => v.id)
  const lastSeen = darkIds.length === 0 ? [] : await prisma.$queryRaw<Array<{
    vehicle_id: string; last_at: Date | null
  }>>`
    SELECT vehicle_id, max(captured_at) AS last_at
      FROM vehicle_telemetries
     WHERE vehicle_id IN (${Prisma.join(darkIds)})
     GROUP BY 1`
  const lastSeenByVehicle = new Map(lastSeen.map(l => [l.vehicle_id, l.last_at]))

  const sensors = await prisma.vehicleSensor.findMany({
    where:  { type: FUEL_SENSOR_TYPE, vehicleId: { in: vehicles.map(v => v.id) } },
    select: {
      vehicleId: true, name: true, parameter: true,
      calibrationPoints: true, calibratedMax: true,
    },
    orderBy: { calibrationPoints: 'desc' },
  })
  // Highest-calibrated first, so a unit carrying both a real sensor and a
  // status sensor on the same parameter is described by the one that works.
  const sensorByVehicle = new Map<string, (typeof sensors)[number]>()
  for (const s of sensors) if (!sensorByVehicle.has(s.vehicleId)) sensorByVehicle.set(s.vehicleId, s)

  const out: ProbeReportRow[] = []
  // Over the REGISTRY, so a unit with no telemetry still produces a row. `r` is
  // undefined for those, and every channel below resolves to UNKNOWN — which is
  // the honest answer: with no readings there is nothing to judge.
  for (const v of vehicles) {
    const r = aggByVehicle.get(v.id)
    const trackerSilent = r == null

    const pings  = r ? Number(r.pings) : 0
    const enough = pings >= MIN_PINGS

    const verdict = classifyProbe({
      pings,
      levelPings:   r ? Number(r.level_pings) : 0,
      peakMl:       r?.peak_ml ?? null,
      lastAliveAt:  r?.last_alive_at ?? null,
      recentPings:  r ? Number(r.recent_pings) : 0,
      recentPeakMl: r?.recent_peak_ml ?? null,
      recentMoving: r ? Number(r.recent_moving) : 0,
    })

    const cfg = sensorByVehicle.get(v.id)
    const fuelSensor: FuelSensorConfig = {
      fitted:            cfg != null,
      name:              cfg?.name ?? null,
      parameter:         cfg?.parameter ?? null,
      calibrationPoints: cfg?.calibrationPoints ?? 0,
      calibratedMax:     cfg?.calibratedMax ?? null,
      uncalibrated:      cfg != null && cfg.calibrationPoints === 0,
    }

    const rec = recentByVehicle.get(v.id)
    const ctr = rec ? counterById.get(String(rec.latest_id)) : undefined
    // A counter reads UNKNOWN rather than NOT_FITTED when the unit has been
    // quiet: one day of silence says nothing about what is installed on it.
    const counter = (value: number | null | undefined): ChannelHealth =>
      rec == null || value == null
        ? { state: 'UNKNOWN',   lastSeenAt: rec?.latest_at ?? null, lastValue: null }
        : { state: 'REPORTING', lastSeenAt: rec.latest_at,          lastValue: value }

    const channels = {
      gps:         classifyChannel(rec?.gps_at ?? null, null, deadFrom, enough),
      ignition:    classifyChannel(rec?.ign_at ?? null, null, deadFrom, enough),
      odometer:    counter(ctr?.odo_v),
      engineHours: counter(ctr?.eh_v),
    }

    out.push({
      vehicleId: v.id,
      plate:     v.registrationPlate,
      name:      v.name,
      deviceId:  v.deviceId,
      orgCode:   v.organisation?.code ?? '',
      fuelProbe: {
        state:       verdict.state,
        reason:      trackerSilent ? 'tracker-silent' : verdict.reason,
        lastAliveAt: r?.last_alive_at ?? null,
        lastValueMl: lastValueByVehicle.get(v.id) ?? null,
        lastSeenAt:  r?.last_level_at ?? null,
        pings,
      },
      fuelSensor,
      channels,
      // For a reporting unit the newest frame in the dead window; for a silent
      // one the last time it EVER spoke, which is the number that says how long
      // this has been going on.
      lastReportedAt: r ? (rec?.latest_at ?? null) : (lastSeenByVehicle.get(v.id) ?? null),
      trackerSilent,
      // A dead probe, a sensor nobody calibrated, or a channel that has gone
      // quiet on a unit still reporting. NOT_FITTED is not attention — nothing
      // is broken about a machine that never had the hardware.
      needsAttention:
        trackerSilent ||
        verdict.state === 'DIED' || verdict.state === 'SILENT' ||
        fuelSensor.uncalibrated ||
        Object.values(channels).some(c => c.state === 'NOT_REPORTING'),
    })
  }
  lap('assemble')
  logger.info({ orgId: opts.orgId ?? 'all', totalMs: Date.now() - t0, ms, units: out.length },
    'probe report built')
  return out
}

/**
 * How old a built report may get before it is rebuilt.
 *
 * Unchanged from the TTL this replaced: probe faults move on the scale of days,
 * so ten minutes is generous. What changed is WHO waits for the rebuild.
 *
 * The previous cache expired hard — past ten minutes the next request found no
 * entry and blocked on the whole build. Measured against production KASULU on
 * 2026-08-20 that was **36.6 s** for the unlucky visitor and 1.1 s for everyone
 * after, which is precisely the "thirty seconds or more" the maintenance page
 * was reported to take. It was never a slow page; it was a fast page that
 * periodically made one person rebuild it.
 *
 * The database does exactly as much work as before — one build per org per ten
 * minutes. It now happens on the warmer's clock instead of a request's.
 */
const REFRESH_MS = 10 * 60_000

const reportCache = createWarmCache<ProbeReportRow[]>({
  name: 'probe-report',
  refreshMs: REFRESH_MS,
  // Primed at boot and kept hot per org, so even the first request of the
  // process is served from memory.
  warmKeysFor: (orgId) => [orgId],
  compute: (key) => buildProbeReport({ orgId: key === 'all' ? undefined : key }),
})

export async function getProbeReport(orgId?: string): Promise<ProbeReportRow[]> {
  return reportCache.get(orgId ?? 'all')
}
