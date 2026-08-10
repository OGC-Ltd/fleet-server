/**
 * The sweep that turns Wialon's drain claims into verdicts.
 *
 * Reads PENDING rows that have had their settle window, asks our own telemetry
 * whether the fuel came back, writes the verdict, and — for the ones that
 * survive — puts the drain on the Live Feed. The judgement itself lives in
 * `fuel-adjudication.ts` and is pure; this file is the plumbing round it.
 *
 * ## Why the notification moved here
 *
 * It used to fire in `fuel-sync.service` the moment a drain was written, which
 * is what makes the false flags reach the operator at all. Measured, that is
 * roughly half of them. Announcing on the VERDICT costs the settle window —
 * 20 minutes, agreed with the operator — and stops the feed asserting a theft
 * that the next twenty minutes will contradict.
 *
 * A drain judged REDISTRIBUTION is never announced. One judged UNVERIFIED is,
 * because the provider saw something and we could not check it; the wording
 * says so rather than implying we confirmed it.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { publishNotificationDurable } from '../../lib/notifications/notification.store.js'
import { adjudicateDrain, SETTLE_MINUTES, type LevelSample, type Verdict } from './fuel-adjudication.js'

/**
 * How far before the drain to read levels. Needs to comfortably precede the
 * event so the pre-drop baseline is a real reading and not the drop already in
 * progress — Wialon re-clamps `beganAt` while a drain is running.
 */
export const LOOKBEHIND_MS = 30 * 60_000

/** How far past detection to look for the level returning. */
export const LOOKAHEAD_MS = 3 * 60 * 60_000

export interface AdjudicateOptions {
  /** Restrict to one organisation. Omitted = every org. */
  orgId?: string
  /** Write verdicts. False makes the whole call a dry run. */
  apply:  boolean
  /** Publish feed items for the drains that survive. */
  notify: boolean
  /** Cap the batch. */
  limit?: number
  /** Judge rows this old or older; defaults to the settle window. */
  now?: Date
  /**
   * Only announce drains that began at or after this. Without it, the first
   * run over a backlog would replay every drain in it — the ledger holds 30
   * days — onto a feed that is meant to show what is happening now. The sync
   * this replaced had the same guard for the same reason.
   */
  notifyCutoff?: Date
}

export interface AdjudicateOutcome {
  examined:       number
  loss:           number
  redistribution: number
  unverified:     number
  /** Drains blamed on a dead fuel probe rather than on the tank. */
  sensorFault:    number
  stillPending:   number
  published:      number
  /** Millilitres reclassified as never having left the tank. */
  recoveredMl:    number
}

const EMPTY: AdjudicateOutcome = {
  examined: 0, loss: 0, redistribution: 0, unverified: 0, sensorFault: 0,
  stillPending: 0, published: 0, recoveredMl: 0,
}

/** litres, without the false precision of "40.0" for a whole number. */
const L = (ml: number): string => {
  const l = ml / 1000
  return `${Number.isInteger(l) ? l : l.toFixed(1)} L`
}

export async function adjudicatePendingDrains(opts: AdjudicateOptions): Promise<AdjudicateOutcome> {
  const now = opts.now ?? new Date()
  const ripeBefore = new Date(now.getTime() - SETTLE_MINUTES * 60_000)

  const pending = await prisma.fuelTheft.findMany({
    where: {
      verdict:    'PENDING',
      detectedAt: { lte: ripeBefore },
      ...(opts.orgId ? { vehicle: { organisationId: opts.orgId } } : {}),
    },
    select: {
      id: true, vehicleId: true, beganAt: true, detectedAt: true, stolenMl: true,
      initialLocation: true, finalFuelLevelMl: true,
      vehicle: { select: { organisationId: true, registrationPlate: true } },
    },
    orderBy: { detectedAt: 'asc' },
    take: opts.limit ?? 500,
  })
  if (pending.length === 0) return { ...EMPTY }

  const out: AdjudicateOutcome = { ...EMPTY }

  for (const t of pending) {
    out.examined++

    const from = new Date(t.beganAt.getTime() - LOOKBEHIND_MS)
    const to   = new Date(t.detectedAt.getTime() + LOOKAHEAD_MS)

    const [rows, filling] = await Promise.all([
      prisma.vehicleTelemetry.findMany({
        where:   { vehicleId: t.vehicleId, capturedAt: { gte: from, lte: to }, fuelLevelMl: { not: null } },
        // engineOn is what separates a dead probe from a tank drained empty —
        // an engine cannot run on an empty tank. Without it the dropout rule
        // stays silent and the ordinary recovery test decides.
        select:  { capturedAt: true, fuelLevelMl: true, engineOn: true },
        orderBy: { capturedAt: 'asc' },
      }),
      prisma.fuelFilling.findFirst({
        where:   { vehicleId: t.vehicleId, filledAt: { gte: t.beganAt, lte: to } },
        select:  { filledAt: true },
        // The EARLIEST filling is the one that closes the window — a later one
        // cannot explain a rise the first already accounts for.
        orderBy: { filledAt: 'asc' },
      }),
    ])
    const samples: LevelSample[] = rows.map(r => ({
      capturedAt: r.capturedAt, fuelLevelMl: r.fuelLevelMl!, engineOn: r.engineOn,
    }))

    const verdict = adjudicateDrain(
      { beganAt: t.beganAt, detectedAt: t.detectedAt, stolenMl: t.stolenMl },
      samples, filling?.filledAt ?? null, now,
    )

    if (verdict.verdict === 'PENDING') { out.stillPending++; continue }
    tally(out, verdict.verdict)
    if (verdict.verdict === 'REDISTRIBUTION') out.recoveredMl += t.stolenMl

    if (!opts.apply) continue

    await prisma.fuelTheft.update({
      where: { id: t.id },
      data:  {
        verdict:       verdict.verdict,
        verdictAt:     now,
        recoveredMl:   verdict.recoveredMl,
        verdictReason: verdict.reason,
      },
    })

    // Only a surviving drain is news. A redistribution never reaches the feed,
    // and neither does one too old to be news — see notifyCutoff.
    //
    // Nor does a SENSOR_FAULT. A dead probe reads a full tank draining to
    // nothing, and announcing that names whoever happened to be driving for a
    // theft that never occurred — the one outcome here worse than missing a
    // real one. 37 of 298 probes sit at exactly zero; five died inside a day.
    if (!opts.notify || verdict.verdict === 'REDISTRIBUTION'
                     || verdict.verdict === 'SENSOR_FAULT') continue
    if (opts.notifyCutoff && t.beganAt < opts.notifyCutoff) continue

    const plate = t.vehicle.registrationPlate
    const where = t.initialLocation ? ` at ${t.initialLocation}` : ''
    const tank  = t.finalFuelLevelMl != null ? `. Tank now ${L(t.finalFuelLevelMl)}.` : '.'
    // The distinction between a confirmed loss and an unchecked claim is
    // carried by "lost" vs "reported lost" and by the severity, not by a
    // trailing explanation. The place string alone runs to a full line on this
    // fleet, and a caveat nobody finishes reading is not a caveat.
    // "Suspicious", never "lost". A LOSS verdict means the level did not come
    // back inside the settle window — strong evidence, not proof. The
    // adjudicator removes what it can DISPROVE rather than confirming what is
    // left, and it cannot see a probe that failed without ever reporting. The
    // message's job is to send someone to look, not to name a thief.
    const text = verdict.verdict === 'LOSS'
      ? `FUEL DROP: ${plate} — ${L(t.stolenMl)} suspicious${where}${tank}`
      : `FUEL DROP: ${plate} — ${L(t.stolenMl)} reported, unverified${where}${tank}`

    const { published } = await publishNotificationDurable({
      orgId:     t.vehicle.organisationId,
      id:        `fuel-drain-${t.vehicleId}-${t.id}`,
      source:    'wialon',
      alertType: 'fuelInconsistency',
      severity:  verdict.verdict === 'LOSS' ? 'critical' : 'warning',
      text,
      at:        t.beganAt,
      plate,
      vehicleId: t.vehicleId,
    })
    if (published) out.published++
  }

  logger.info({ ...out, orgId: opts.orgId ?? 'all', apply: opts.apply }, 'Fuel drain adjudication complete')
  return out
}

function tally(out: AdjudicateOutcome, v: Verdict): void {
  if (v === 'LOSS')                out.loss++
  else if (v === 'REDISTRIBUTION') out.redistribution++
  else if (v === 'UNVERIFIED')     out.unverified++
  else if (v === 'SENSOR_FAULT')   out.sensorFault++
}
