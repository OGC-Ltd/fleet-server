/**
 * Withdraw a possible theft once the machine has RUN on its "empty" probe.
 *
 * The adjudicator confirms a fall to empty as a drain, on purpose: at the time
 * it is indistinguishable from a thief emptying the tank (see parked-fall
 * `ranOnEmpty`). This pass is the second look the adjudicator cannot take. For
 * every announced drain of the last day that ended reading empty, it reads the
 * machine's readings since; once the machine has started and run while the
 * probe still read empty, the fall was the probe dropping out — the drain is
 * re-judged SENSOR_FAULT, its cause cleared so it leaves the dashboard's theft
 * alerts and the unit's theft history, and a retraction goes on the feed.
 *
 * Measured on prod 2026-10-01: of 464 drains in 30 days that ended below 1 L,
 * 92 were already SENSOR_FAULT and one was announced as a siphon — `KTCC 872B`,
 * 30 Sep 22:14, 15.1 L, whose tractor drove at 05:44 next morning still
 * reading 0.1 L. The rest were never announced and are left alone.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { publishNotification } from '../../lib/notifications/notification.store.js'
import { ANNOUNCED_CAUSES } from './fuel-theft-classifier.js'
import { NEXT_START_HORIZON_MS, WORK_WINDOW_MS, probeReadsEmpty, ranOnEmpty } from './parked-fall.js'

/** How far back a drain is still re-checked: a day to start, plus a working window. */
export const RETRACT_LOOKBACK_MS = NEXT_START_HORIZON_MS + WORK_WINDOW_MS

const L = (ml: number) => `${(ml / 1000).toFixed(1)} L`

const clock = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Africa/Nairobi',
})

export interface DeadProbeRetractionOutcome {
  examined: number
  retracted: number
}

export async function retractDeadProbeDrains(
  { now = new Date(), apply = true, notify = true }: { now?: Date; apply?: boolean; notify?: boolean } = {},
): Promise<DeadProbeRetractionOutcome> {
  const candidates = await prisma.fuelTheft.findMany({
    where: {
      verdict:     'DRAIN',
      dismissedAt: null,
      drainCause:  { in: [...ANNOUNCED_CAUSES] },
      detectedAt:  { gte: new Date(now.getTime() - RETRACT_LOOKBACK_MS) },
    },
    select: {
      id: true, vehicleId: true, beganAt: true, detectedAt: true, stolenMl: true, finalFuelLevelMl: true,
      vehicle: { select: { organisationId: true, registrationPlate: true, tankCapacityLitres: true } },
    },
  })

  const out: DeadProbeRetractionOutcome = { examined: 0, retracted: 0 }
  for (const t of candidates) {
    const tankL = t.vehicle.tankCapacityLitres
    // Only a fall the provider itself says ended empty is worth reading for;
    // a null final level is read too, since our own readings decide.
    if (t.finalFuelLevelMl != null && !probeReadsEmpty(t.finalFuelLevelMl, tankL)) continue
    out.examined += 1

    const rows = await prisma.vehicleTelemetry.findMany({
      where: {
        vehicleId:  t.vehicleId,
        capturedAt: { gte: t.detectedAt, lte: new Date(Math.min(now.getTime(), t.detectedAt.getTime() + RETRACT_LOOKBACK_MS)) },
      },
      orderBy: { capturedAt: 'asc' },
      select:  { capturedAt: true, fuelLevelMl: true, speedKmh: true, engineOn: true, ignitionKnown: true },
    })
    const proved = ranOnEmpty(
      rows.map(r => ({
        t: r.capturedAt.getTime(), fuelMl: r.fuelLevelMl, speedKmh: r.speedKmh,
        engineOn: r.engineOn, ignitionKnown: r.ignitionKnown === true,
      })),
      t.detectedAt.getTime(),
      tankL,
    )
    if (!proved || !apply) { if (proved) out.retracted += 1; continue }

    // Guarded on the verdict still being DRAIN with an announced cause, so an
    // operator's decision or a second pass in between is never overwritten.
    const won = await prisma.fuelTheft.updateMany({
      where: { id: t.id, verdict: 'DRAIN', drainCause: { in: [...ANNOUNCED_CAUSES] } },
      data: {
        verdict:         'SENSOR_FAULT',
        verdictAt:       now,
        verdictReason:   'fsl-ran-empty',
        verdictConfidence: 0.9,
        drainCause:      null,
        causeReason:     'probe-dropout-ran-empty',
        causeConfidence: 0.9,
      },
    })
    if (won.count === 0) continue
    out.retracted += 1

    if (!notify) continue
    const plate = t.vehicle.registrationPlate ?? 'A vehicle'
    try {
      publishNotification({
        orgId:     t.vehicle.organisationId,
        id:        `fuel-dropout-${t.id}`,
        source:    'live',
        alertType: 'fuelInconsistency',
        severity:  'info',
        text:      `Retracted: ${plate}'s ${L(t.stolenMl)} "possible theft" at ${clock.format(t.beganAt)} was the fuel probe ` +
                   `dropping out — the machine ran afterwards with the probe still reading empty. Check the probe.`,
        at:        now,
        plate:     t.vehicle.registrationPlate,
        vehicleId: t.vehicleId,
      })
    } catch (err) {
      logger.warn({ err, theftId: t.id }, 'Dead-probe retraction: publish failed')
    }
  }

  if (out.retracted > 0) logger.info(out, 'Dead-probe drains retracted')
  return out
}
