/**
 * Puts a live fuel drop on the operations feed.
 *
 * `lib/fuel-drop-watch` decides; this publishes. Same split as
 * `speeding.worker` and for the same reason: the detector runs inside the poll
 * loop, where a write must never hold up the next vehicle's turn.
 *
 * ## The theft call, within minutes
 *
 * This item IS the verdict of the parked-fall rule (`modules/fuel/parked-fall`):
 * a `critical` possible theft, posted about five minutes after the fuel fell.
 * The operator's requirement is a verdict within ten minutes (2026-09-26), and it
 * replaced an earlier design that waited for the machine's next start — a median
 * of 2.7 hours. The price is stated in `parked-fall`: nothing visible within
 * minutes separates the falls that later come back, so about a third of these
 * are retracted by the follow-up.
 *
 * Before it says anything it runs the gates the poll loop cannot: the probe's
 * 30-day profile (the adjudicator's own trust gate), a probe reading empty, and
 * — for a fall judged on the engine-hours counter — whether that counter tracks
 * the engine at all. A fall they refuse is still recorded, as WITHHELD, so the
 * gates can be audited against what they hid.
 *
 * ## Two items per event, deliberately
 *
 * The follow-up carries `fuel-parked-<fallId>`, from `lib/queues/parked-falls`:
 * poured back (escalated), still gone after the next start (confirmed), or the
 * gauge coming back (retracted). Rather than overwrite this item with it, the
 * operator sees the sequence — the call, then what became of it.
 *
 * The id is keyed on the SETTLED time rather than on now, so the same fall
 * re-offered by a replay updates one row instead of duplicating the feed.
 */

import { eventBus } from '../event-bus.js'
import { logger } from '../logger.js'
import { prisma } from '../prisma.js'
import { publishNotification } from '../notifications/notification.store.js'
import { getProbeProfile } from '../../modules/fuel/fuel-adjudication.service.js'
import { probeOverreads, probeSwings } from '../../modules/fuel/fuel-adjudication.js'
import { counterTracksEngine, probeFrozeWhileRunning, probeReadsEmpty } from '../../modules/fuel/parked-fall.js'
import type { LiveFuelDrop } from '../fuel-drop-watch.js'

const L = (ml: number): string => `${(ml / 1000).toFixed(1)} L`

/** Minutes, for a sentence rather than a field. */
const mins = (ms: number): string => {
  const m = Math.round(ms / 60_000)
  if (m >= 90) return `${(m / 60).toFixed(1)} hours`
  return m < 1 ? 'under a minute' : m === 1 ? '1 minute' : `${m} minutes`
}

/** How much of a unit's history decides whether its engine-hours counter tracks the engine. */
const COUNTER_HISTORY_MS = 72 * 3_600_000
/** How far back a frozen probe is looked for before a fall. MTR 18's froze for six hours. */
const FROZEN_LOOKBACK_MS = 12 * 3_600_000

/**
 * The gates stage one cannot run in the poll loop, because each is a database
 * question. Null means publish; otherwise, why not.
 *
 *  - a probe reading empty at the trough is the probe dropping out;
 *  - the probe's own 30-day parked profile — the adjudicator's trust gate,
 *    reused so the two paths distrust the same instruments;
 *  - a fall judged on the engine-hours counter needs a counter that tracks the
 *    ENGINE, which only the unit's recent history can say.
 */
export async function stageOneRefusal(d: LiveFuelDrop, now: Date): Promise<string | null> {
  const tankL = d.tankCapacityMl ? d.tankCapacityMl / 1000 : null
  if (probeReadsEmpty(d.troughMl, tankL)) return 'the probe reads empty at the trough'
  const profile = await getProbeProfile(d.vehicleId, now)
  if (probeSwings(profile)) return 'the probe swings on this machine while it is parked (30-day profile)'
  if (probeOverreads(profile)) return 'the probe reads more than the tank holds (30-day profile)'
  // A probe that held one value while the engine ran was not reading, and a
  // fall after it is the catch-up — see probeFrozeWhileRunning.
  const history = await prisma.vehicleTelemetry.findMany({
    where:   { vehicleId: d.vehicleId, capturedAt: { gte: new Date(d.fallStartedAt.getTime() - FROZEN_LOOKBACK_MS), lte: d.fallStartedAt } },
    orderBy: { capturedAt: 'asc' },
    select:  { capturedAt: true, fuelLevelMl: true, speedKmh: true, engineOn: true, ignitionKnown: true, engineHoursMeter: true },
  })
  const frozen = probeFrozeWhileRunning(history.map(r => ({
    t: r.capturedAt.getTime(), fuelMl: r.fuelLevelMl, speedKmh: r.speedKmh, engineOn: r.engineOn,
    ignitionKnown: r.ignitionKnown === true, meterH: r.engineHoursMeter,
  })))
  if (frozen.frozen && frozen.heldMl != null) {
    return `the probe held ${L(frozen.heldMl)} to the millilitre through ${frozen.ranH.toFixed(1)} h of the engine ` +
      `running before this, so it was not reading and this fall is it catching up`
  }
  if (d.engineEvidence === 'counter') {
    const rows = await prisma.vehicleTelemetry.findMany({
      where:   { vehicleId: d.vehicleId, capturedAt: { gte: new Date(now.getTime() - COUNTER_HISTORY_MS), lte: now } },
      orderBy: { capturedAt: 'asc' },
      select:  { capturedAt: true, speedKmh: true, engineHoursMeter: true },
    })
    const c = counterTracksEngine(rows.map(r => ({ t: r.capturedAt.getTime(), speedKmh: r.speedKmh, meterH: r.engineHoursMeter })))
    if (!c.trusted) {
      return `the engine-hours counter does not track the engine (moved ${c.advancedH.toFixed(1)} h, ` +
        `${c.standingH.toFixed(1)} h of it standing, in the last 72 h)`
    }
  }
  return null
}

/**
 * Stage one's record and feed item for one confirmed fall.
 *
 * The row is written whatever the gates say — a WITHHELD fall is how the gates
 * get audited later — and first write wins, so a fall re-offered by a replay
 * can neither reopen a decided row nor announce twice.
 */
export async function recordParkedFall(d: LiveFuelDrop, now = new Date()): Promise<void> {
  const existing = await prisma.parkedFuelFall.findUnique({
    where:  { vehicleId_settledAt: { vehicleId: d.vehicleId, settledAt: d.settledAt } },
    select: { id: true },
  })
  if (existing) return
  const refusal = await stageOneRefusal(d, now)
  await prisma.parkedFuelFall.create({
    data: {
      organisationId: d.orgId,
      vehicleId:      d.vehicleId,
      settledAt:      d.settledAt,
      flaggedAt:      d.confirmedAt,
      baselineMl:     d.baselineMl,
      troughMl:       d.troughMl,
      droppedMl:      d.droppedMl,
      stillForMs:     d.stillForMs,
      engineOnMs:     d.engineOnMs,
      engineEvidence: d.engineEvidence,
      meterAdvanceH:  d.meterAdvanceH,
      verdict:        refusal ? 'WITHHELD' : 'PENDING',
      verdictAt:      refusal ? now : null,
      verdictReason:  refusal,
    },
  })
  if (refusal) {
    logger.info({ vehicleId: d.vehicleId, droppedMl: d.droppedMl, refusal }, 'Parked fuel fall withheld')
    return
  }
  const plate = d.plate ?? 'a vehicle'
  publishNotification({
    orgId:     d.orgId,
    id:        `fuel-watch-${d.vehicleId}-${d.settledAt.getTime()}`,
    source:    'live',
    alertType: 'fuelInconsistency',
    // The verdict itself — see the note above. The follow-up may retract it.
    severity:  'critical',
    text:
      `POSSIBLE THEFT — FUEL DRAINED FROM A PARKED MACHINE: ${plate} lost ${L(d.droppedMl)} ` +
      `(${L(d.baselineMl)} to ${L(d.troughMl)}) after standing still for ${mins(d.stillBeforeFallMs)} ` +
      `with the engine off` +
      (d.engineOnMs > 0 ? ` (it ran for ${mins(d.engineOnMs)} in that time, without moving)` : '') +
      (d.attitudeShiftG != null ? ' and without tilting, by its accelerometer' : '') +
      (d.engineEvidence === 'counter' ? ', going by its engine-hours counter' : '') +
      `, and was still down ${mins(d.confirmedAt.getTime() - d.settledAt.getTime())} later. ` +
      `This is updated if the fuel comes back.`,
    at:        d.settledAt,
    plate:     d.plate,
    vehicleId: d.vehicleId,
  })
}

export function startFuelWatchWorker(): () => void {
  const onDrop = (d: LiveFuelDrop) => {
    // A feed item is not worth taking the poll loop down for.
    void recordParkedFall(d).catch((err) => logger.warn({ err, vehicleId: d.vehicleId }, 'Live fuel drop: record failed'))
  }

  const unsub = eventBus.subscribe('fuel:dropped', onDrop)
  logger.info('Live fuel-drop worker started')
  return unsub
}
