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

/**
 * The tracker's own word on the fuel probe (operator, 2026-11-25: "the tracker's message is more
 * important"): a BLE probe sends a fault code where a level should be (4095 short circuit / water /
 * dirt, 6500 lost contact with tubes, 7000 contamination), and the Wialon adapter carries it as
 * flags.fuelProbeFault with the account's own label. Opened while the unit's latest frame carries it;
 * closed only once the unit reads a real level again with no fault, never merely because the flag is
 * absent: after a restart the adapter does not know of a fault until the probe's next message, and an
 * absent flag then is "not yet known", not "repaired".
 */
export const TRACKER_PROBE_KIND = 'fuel_probe_fault'

interface SnapshotProbe { vehicleId: string; fuelProbeFault?: boolean; fuelProbeFaultReason?: string | null; fuelLevelMl?: number | null }

/** Which units the tracker says have a faulty probe now, and which read a real level with no fault. Pure. */
export function trackerProbeStates(snapshot: SnapshotProbe[]) {
  const faulty = new Map<string, string | null>()
  const reading = new Set<string>()
  for (const v of snapshot) {
    if (!v?.vehicleId) continue
    if (v.fuelProbeFault) faulty.set(v.vehicleId, v.fuelProbeFaultReason ?? null)
    else if (v.fuelLevelMl != null) reading.add(v.vehicleId)
  }
  return { faulty, reading }
}

/**
 * The tracker's own status codes (operator, 2026-11-27): fuel probe status, probe battery and GPS,
 * judged by the account's labels in the Wialon adapter (wialon.status-codes) and carried once they
 * have lasted 10 minutes. Opened from when the fault began; closed only when the tracker shows that
 * sensor healthy again, never because a restart left the adapter not knowing yet.
 */
export const TRACKER_STATUS_KINDS = ['fuel_probe_status', 'fuel_probe_battery', 'gnss_fault'] as const

interface SnapshotStatus {
  vehicleId: string
  trackerFaults?: Array<{ kind?: string; reason?: string; raw?: number; since?: string }>
  trackerOk?: string[]
}

/** Which units carry which tracker status faults now, and which kinds they last showed healthy. Pure. */
export function trackerStatusStates(snapshot: SnapshotStatus[]) {
  const kinds = new Set<string>(TRACKER_STATUS_KINDS)
  const faulty = new Map<string, Array<{ kind: string; reason: string; raw: number | null; since: Date | null }>>()
  const healthy = new Map<string, Set<string>>()
  for (const v of snapshot) {
    if (!v?.vehicleId) continue
    for (const f of v.trackerFaults ?? []) {
      if (!f?.kind || !kinds.has(f.kind)) continue
      const since = f.since ? new Date(f.since) : null
      const list = faulty.get(v.vehicleId) ?? []
      list.push({ kind: f.kind, reason: f.reason ?? 'Tracker reports a fault', raw: typeof f.raw === 'number' ? f.raw : null, since: since && !Number.isNaN(since.getTime()) ? since : null })
      faulty.set(v.vehicleId, list)
    }
    const ok = (v.trackerOk ?? []).filter(k => kinds.has(k))
    if (ok.length) healthy.set(v.vehicleId, new Set(ok))
  }
  return { faulty, healthy }
}

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
  // `getProbeReport` resolves to the ROWS — `ProbeReportRow[]` — not to a
  // report object wrapping them. This read them as `report.rows`, which on an
  // array is `undefined`, so every sweep since the feature landed reconciled
  // against an empty desired state: nothing to open, and nothing kept alive
  // either. It logged `opened:0 closed:0 skipped:0` and looked like a quiet
  // fleet. The `as` cast is what hid it — it asserted a shape the function
  // never returns, so the compiler had nothing to object to.
  const rows = await getProbeReport(orgId)

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
      // A GPS that has never fixed while its tracker talks has no "last seen";
      // the unit's last report is the honest start we have.
      const since = asDate(c.lastSeenAt) ?? lastReported
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

  // The tracker's probe faults (TRACKER_PROBE_KIND). The cached snapshot, as the probe report above:
  // a failed read leaves the tracker's episodes as they are rather than closing them.
  let tracker: ReturnType<typeof trackerProbeStates> | null = null
  let status: ReturnType<typeof trackerStatusStates> | null = null
  try {
    // Loaded here, not at the top: the telemetry service pulls in most of the server, and every
    // importer of this sweep would load it all (a test that imports the sweep without the alert
    // settings failed on it, 2026-11-25).
    const { getFleetSnapshot } = await import('./telemetry.service.js')
    const snapshot = (await getFleetSnapshot(orgId)) ?? []
    tracker = trackerProbeStates(snapshot as SnapshotProbe[])
    status = trackerStatusStates(snapshot as SnapshotStatus[])
  } catch (err) {
    logger.warn({ err, orgId }, 'Sensor fault sweep: snapshot unavailable, tracker probe faults left as they are')
  }
  if (tracker) {
    for (const [vehicleId, reason] of tracker.faulty) {
      want(
        vehicleId, TRACKER_PROBE_KIND, now, 'warning',
        `Fuel probe: ${reason ?? 'reporting a fault'}`,
        { reason, source: 'tracker' },
      )
    }
  }
  if (status) {
    for (const [vehicleId, faults] of status.faulty) {
      for (const f of faults) {
        want(vehicleId, f.kind, f.since ?? now, 'warning', f.reason, { reason: f.reason, raw: f.raw, source: 'tracker' })
      }
    }
  }

  // Anything open that the report no longer shows has recovered. Only episodes
  // this sweep OWNS are closed here: a frame-driven kind is closed by the
  // poller, which sees the recovery a whole cycle sooner.
  let closed = 0
  const sweepKinds = new Set<string>([...Object.values(CHANNEL_KINDS), 'signal_lost', 'fuel_probe_dead'])
  for (const [k, e] of openByKey) {
    if (wanted.has(k)) continue
    // A tracker probe fault closes only on a real level read with no fault (see TRACKER_PROBE_KIND)
    if (e.kind === TRACKER_PROBE_KIND) {
      if (!tracker?.reading.has(e.vehicleId)) continue
    } else if ((TRACKER_STATUS_KINDS as readonly string[]).includes(e.kind)) {
      // Only on the tracker's word that the sensor is healthy again.
      if (!status?.healthy.get(e.vehicleId)?.has(e.kind)) continue
    } else if (!sweepKinds.has(e.kind)) continue
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
  // One organisation's failure must not cost the others their sweep. On
  // 2026-11-24 the probe report timed out for one organisation and the loop
  // threw on it, so every organisation after it in the list went unswept on
  // every run. Each is tried on its own; the job still fails (and is retried)
  // if any did, so the failure stays visible.
  const failed: string[] = []
  for (const o of orgs) {
    try {
      const r = await sweepSensorFaults(o.id, now)
      total.opened  += r.opened
      total.closed  += r.closed
      total.skipped += r.skipped
    } catch (err) {
      failed.push(o.id)
      logger.warn({ err, orgId: o.id }, 'Sensor fault sweep failed for organisation')
    }
  }
  if (failed.length) {
    throw new Error(`Sensor fault sweep failed for ${failed.length} of ${orgs.length} organisations: ${failed.join(', ')}`)
  }
  return total
}
