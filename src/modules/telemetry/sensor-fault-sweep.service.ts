/**
 * Sensor faults as EPISODES — the absence-driven half.
 *
 * ## Why a sweep and not the poller
 *
 * The Wialon adapter emits a frame only when a unit's fix time advances, so a
 * unit that has gone silent produces NOTHING. There is no arrival to hang a
 * detector off. The same is true of a dead channel: a tracker still reporting
 * position while its odometer stopped years ago emits perfectly ordinary
 * frames. Absence can only be found by looking at the whole fleet and asking
 * what is missing — which is what this does, every fifteen minutes.
 *
 * That is not an optimisation over doing it per frame. It is the only place the
 * question can be asked at all.
 *
 * ## It is a full reconcile
 *
 * Desired state (what the probe report says is broken now) against actual state
 * (what episodes are open). Opens what is missing, closes what recovered, and
 * leaves the rest alone — so a missed run costs latency, never correctness, and
 * running it twice changes nothing the second time.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { env } from '../../config/env.js'
import { eventBus } from '../../lib/event-bus.js'
import { markSilent, clearSilent } from '../../lib/sensor-faults.js'
import { getProbeReport } from '../fuel/probe-report.service.js'

/** Silent for longer than this and the tracker is not merely between fixes. */
const SILENT_AFTER_MS = 60 * 60_000

/**
 * Channels the report judges, and the episode kind each maps to.
 *
 * `fuelProbe` is included so the daily prose notification that
 * fuel-probe-health already publishes finally gains a durable start/recovery
 * pair beside it. That notification is left alone — it feeds the workshop's
 * morning list and that is wanted.
 */
const CHANNEL_KINDS = {
  gps:         'gps_not_reporting',
  ignition:    'ignition_not_reporting',
  odometer:    'odometer_not_reporting',
  engineHours: 'engine_hours_not_reporting',
} as const

export interface SweepResult {
  opened:  number
  closed:  number
  skipped: number
}

interface ChannelLike {
  state?: string | null
  lastSeenAt?: Date | string | null
  lastValue?: unknown
}

const asDate = (v: Date | string | null | undefined): Date | null => {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

export async function sweepSensorFaults(orgId: string, now = new Date()): Promise<SweepResult> {
  if (!env.INCIDENT_CAPTURE_ENABLED) return { opened: 0, closed: 0, skipped: 0 }

  // The CACHED getter, never buildProbeReport directly: the build is a
  // multi-second aggregate behind a 10-minute warm cache, and a 15-minute sweep
  // calling the builder would pay for it in full every single time while the
  // cache sat unused beside it. Ten minutes of staleness is nothing against
  // faults measured in hours.
  const report = await getProbeReport(orgId)
  const rows = (report as { rows?: unknown[] })?.rows ?? []

  const openEpisodes = await prisma.sensorFaultEpisode.findMany({
    where:  { organisationId: orgId, recoveredAt: null },
    select: { id: true, vehicleId: true, kind: true },
  })
  const openByKey = new Map(openEpisodes.map(e => [`${e.vehicleId}:${e.kind}`, e]))
  const wanted = new Set<string>()

  let opened = 0, skipped = 0

  const want = (
    vehicleId: string, kind: string, startedAt: Date,
    severity: 'critical' | 'warning', detail: string, evidence: Record<string, unknown>,
  ) => {
    const k = `${vehicleId}:${kind}`
    wanted.add(k)
    if (openByKey.has(k)) return
    opened++
    eventBus.publish('sensorFault:open', {
      orgId, vehicleId, kind, severity, source: 'sweep',
      startedAt, lastSeenAt: now, detail, evidence,
    })
  }

  for (const raw of rows) {
    const r = raw as {
      vehicleId?: string; plate?: string; deviceId?: string
      trackerSilent?: boolean; lastReportedAt?: Date | string | null
      fuelProbe?: { state?: string; lastAliveAt?: Date | string | null; reason?: string }
      channels?: Record<string, ChannelLike>
    }
    const vehicleId = r.vehicleId
    if (!vehicleId) continue

    // A unit with no tracker bound is a COVERAGE gap, not a fault — 313 of
    // Sukari's 597 are in this state, and reporting them as broken sensors
    // would bury the units that really are broken. The frontend already draws
    // this distinction with the same test.
    const hasTracker = typeof r.deviceId === 'string' && /^wialon:/.test(r.deviceId)
    if (!hasTracker) { skipped++; continue }

    const lastReported = asDate(r.lastReportedAt)

    if (r.trackerSilent) {
      // The whole unit is silent. Its per-channel verdicts underneath are
      // meaningless — without this guard one dead tracker generates five
      // episodes describing the same fact.
      if (lastReported && now.getTime() - lastReported.getTime() > SILENT_AFTER_MS) {
        want(
          vehicleId, 'signal_lost', lastReported, 'warning',
          'Tracker has stopped reporting',
          { lastReportedAt: lastReported.toISOString() },
        )
        // Tell the poller a close is worth publishing when this unit pings.
        markSilent(vehicleId)
      }
      continue
    }
    clearSilent(vehicleId)

    for (const [channel, kind] of Object.entries(CHANNEL_KINDS)) {
      const c = r.channels?.[channel]
      // NOT_FITTED and UNKNOWN are neither. A channel we cannot judge must not
      // open an episode, and — more importantly — must not silently resolve one
      // that is already open.
      if (c?.state !== 'NOT_REPORTING') continue
      const since = asDate(c.lastSeenAt)
      if (!since) continue
      want(
        vehicleId, kind, since, 'warning',
        `${channel} has stopped reporting`,
        { channel, lastSeenAt: since.toISOString(), lastValue: c.lastValue ?? null },
      )
    }

    const probe = r.fuelProbe
    if (probe?.state === 'DIED' || probe?.state === 'SILENT') {
      const since = asDate(probe.lastAliveAt)
      if (since) {
        want(
          vehicleId, 'fuel_probe_dead', since, 'warning',
          probe.reason ? `Fuel probe: ${probe.reason}` : 'Fuel probe has stopped reporting',
          { probeState: probe.state, lastAliveAt: since.toISOString() },
        )
      }
    }
  }

  // Anything open that the report no longer shows has recovered. Only episodes
  // this sweep OWNS are closed here: a frame-driven kind is closed by the
  // poller, which sees the recovery a whole cycle sooner.
  let closed = 0
  const sweepKinds = new Set<string>([...Object.values(CHANNEL_KINDS), 'signal_lost', 'fuel_probe_dead'])
  for (const [k, e] of openByKey) {
    if (wanted.has(k) || !sweepKinds.has(e.kind)) continue
    closed++
    eventBus.publish('sensorFault:close', {
      orgId, vehicleId: e.vehicleId, kind: e.kind, recoveredAt: now,
    })
  }

  const out = { opened, closed, skipped }
  logger.info({ orgId, ...out }, 'Sensor fault sweep complete')
  return out
}

/** Every org with vehicles — the scheduler has no org in hand. */
export async function sweepAllOrgs(now = new Date()): Promise<SweepResult> {
  const orgs = await prisma.organisation.findMany({ select: { id: true } })
  const total: SweepResult = { opened: 0, closed: 0, skipped: 0 }
  for (const o of orgs) {
    const r = await sweepSensorFaults(o.id, now)
    total.opened  += r.opened
    total.closed  += r.closed
    total.skipped += r.skipped
  }
  return total
}
