/**
 * The sweep that finds fuel probes nobody is looking at.
 *
 * The rule is in `fuel-probe-health.ts` and is pure; this is the plumbing round
 * it — one aggregate over the telemetry table, then a feed item per faulty
 * probe. It is not on the poll path: probe death is a thing that happens over
 * days, so this runs daily and reads a 30-day window.
 *
 * ## Why a notification and not a VehicleAlert row
 *
 * A `VehicleAlert` looks like the right home — it has open/resolved semantics,
 * which is exactly the lifecycle of a broken probe. It is not usable here.
 * `syncFrameAlerts` resolves every open alert whose type is not in the frame's
 * active flags, on every poll cycle, for that vehicle. An alert raised out of
 * band by this sweep would be closed within seconds by the next ping, because
 * nothing in a telemetry frame carries a "probe is dead" flag. Rather than
 * carve an exception into that loop — which is the one place alert state is
 * reconciled, and worth keeping simple — this uses the durable notification
 * path the fuel adjudicator already publishes on.
 *
 * Re-raised daily, with the date in the feed id, so a probe that stays broken
 * keeps asking rather than scrolling away once. `publishNotificationDurable`
 * dedupes on content, so a second run on the same day is silent.
 */

import { Prisma } from '../../../generated/prisma/client.js'
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { publishNotificationDurable } from '../../lib/notifications/notification.store.js'
import {
  classifyProbe, isFaulty, DEAD_HOURS, LOOKBACK_DAYS, MIN_PINGS,
  type ProbeState, type ProbeWindow,
} from './fuel-probe-health.js'

export interface ProbeSweepOptions {
  /** Restrict to one organisation. Omitted = every org. */
  orgId?:  string
  /** Publish feed items. False makes the call a dry run that only reports. */
  notify:  boolean
  /** Overridable for tests. */
  now?:    Date
}

export interface ProbeSweepOutcome {
  examined:   number
  died:       number
  silent:     number
  notFitted:  number
  ok:         number
  unknown:    number
  published:  number
}

/** One row of the aggregate, before it is classified. */
interface ProbeRow extends ProbeWindow {
  vehicleId: string
  orgId:     string
  plate:     string
}

const EMPTY: ProbeSweepOutcome = {
  examined: 0, died: 0, silent: 0, notFitted: 0, ok: 0, unknown: 0, published: 0,
}

const L = (ml: number): string => {
  const l = ml / 1000
  return `${Number.isInteger(l) ? l : l.toFixed(1)} L`
}

/** "3 days" / "17 hours" — how long the probe has been dark, in words. */
function darkFor(since: Date, now: Date): string {
  const h = Math.floor((now.getTime() - since.getTime()) / 3_600_000)
  if (h < 48) return `${h} hours`
  return `${Math.floor(h / 24)} days`
}

/**
 * One pass over the fleet's probes.
 *
 * The aggregate is raw SQL rather than Prisma: it is one grouped scan of the
 * telemetry table with several conditional aggregates over the same rows, and
 * expressing it through the query builder would be several passes.
 */
export async function sweepProbeHealth(opts: ProbeSweepOptions): Promise<ProbeSweepOutcome> {
  const now  = opts.now ?? new Date()
  const from = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 3_600_000)
  const deadFrom = new Date(now.getTime() - DEAD_HOURS * 3_600_000)

  const rows = await prisma.$queryRaw<Array<{
    vehicle_id: string; org_id: string; plate: string
    pings: bigint; level_pings: bigint; peak_ml: number | null
    last_alive_at: Date | null; recent_pings: bigint
    recent_peak_ml: number | null; recent_moving: bigint
  }>>`
    SELECT t.vehicle_id,
           v.organisation_id                                        AS org_id,
           v.registration_plate                                     AS plate,
           count(*)                                                 AS pings,
           count(t.fuel_level_ml)                                   AS level_pings,
           max(t.fuel_level_ml)                                     AS peak_ml,
           max(t.captured_at) FILTER (WHERE t.fuel_level_ml > 0)    AS last_alive_at,
           count(*)           FILTER (WHERE t.captured_at >= ${deadFrom}) AS recent_pings,
           max(t.fuel_level_ml) FILTER (WHERE t.captured_at >= ${deadFrom}) AS recent_peak_ml,
           count(*) FILTER (WHERE coalesce(t.speed_kmh, 0) > 1
                              AND t.captured_at >= ${deadFrom})     AS recent_moving
      FROM vehicle_telemetries t
      JOIN vehicles v ON v.id = t.vehicle_id
     WHERE t.captured_at >= ${from}
       AND v.is_active
       ${opts.orgId ? Prisma.sql`AND v.organisation_id = ${opts.orgId}` : Prisma.empty}
     GROUP BY 1, 2, 3
    HAVING count(*) >= ${MIN_PINGS}`

  const out: ProbeSweepOutcome = { ...EMPTY }

  for (const r of rows) {
    const probe: ProbeRow = {
      vehicleId: r.vehicle_id, orgId: r.org_id, plate: r.plate,
      pings:        Number(r.pings),
      levelPings:   Number(r.level_pings),
      peakMl:       r.peak_ml,
      lastAliveAt:  r.last_alive_at,
      recentPings:  Number(r.recent_pings),
      recentPeakMl: r.recent_peak_ml,
      recentMoving: Number(r.recent_moving),
    }
    out.examined++

    const verdict = classifyProbe(probe)
    tally(out, verdict.state)
    if (!isFaulty(verdict) || !opts.notify) continue

    // The message names the repair, not the vehicle's behaviour: whoever reads
    // this needs to know which unit to visit and what they will find. A dead
    // probe is a workshop job, so it says the last good reading and when —
    // that dates the failure to a shift.
    const text = verdict.state === 'DIED'
      ? `FUEL PROBE: ${probe.plate} has had no reading for ${darkFor(probe.lastAliveAt!, now)}`
        + `, the last being ${L(probe.peakMl ?? 0)} on ${probe.lastAliveAt!.toISOString().slice(0, 10)}`
        + `${probe.recentMoving > 0 ? ', and the machine has moved since' : ''}. It needs a workshop visit.`
      : `FUEL PROBE: ${probe.plate} has never reported a fuel level`
        + ` in ${LOOKBACK_DAYS} days of telemetry. It needs a workshop visit.`

    const { published } = await publishNotificationDurable({
      orgId:     probe.orgId,
      // Dated, so a probe that stays broken asks again tomorrow instead of
      // scrolling away once and being forgotten — which is how 32 of them got
      // to a month.
      id:        `fsl-dead-${probe.vehicleId}-${now.toISOString().slice(0, 10)}`,
      source:    'fleet',
      alertType: 'fuelSensorFault',
      // Warning, not critical: nothing is being stolen and nobody is being
      // accused. It is a machine that needs a fitter, and pricing it level with
      // a suspected theft is how a maintenance list gets ignored.
      severity:  'warning',
      text,
      at:        now,
      plate:     probe.plate,
      vehicleId: probe.vehicleId,
    })
    if (published) out.published++
  }

  logger.info({ ...out, orgId: opts.orgId ?? 'all' }, 'Fuel probe health sweep complete')
  return out
}

function tally(out: ProbeSweepOutcome, s: ProbeState): void {
  if (s === 'DIED')            out.died++
  else if (s === 'SILENT')     out.silent++
  else if (s === 'NOT_FITTED') out.notFitted++
  else if (s === 'OK')         out.ok++
  else                         out.unknown++
}
