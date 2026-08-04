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
const LOOKBEHIND_MS = 30 * 60_000

/** How far past detection to look for the level returning. */
const LOOKAHEAD_MS = 3 * 60 * 60_000

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
}

export interface AdjudicateOutcome {
  examined:       number
  loss:           number
  redistribution: number
  unverified:     number
  stillPending:   number
  published:      number
  /** Millilitres reclassified as never having left the tank. */
  recoveredMl:    number
}

const EMPTY: AdjudicateOutcome = {
  examined: 0, loss: 0, redistribution: 0, unverified: 0,
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
        select:  { capturedAt: true, fuelLevelMl: true },
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
    const samples: LevelSample[] = rows.map(r => ({ capturedAt: r.capturedAt, fuelLevelMl: r.fuelLevelMl! }))

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

    // Only a surviving drain is news. A redistribution never reaches the feed.
    if (!opts.notify || verdict.verdict === 'REDISTRIBUTION') continue

    const plate = t.vehicle.registrationPlate
    const where = t.initialLocation ? ` at ${t.initialLocation}` : ''
    const tank  = t.finalFuelLevelMl != null ? `. Tank now ${L(t.finalFuelLevelMl)}.` : '.'
    const text = verdict.verdict === 'LOSS'
      ? `FUEL DROP: ${plate} — ${L(t.stolenMl)} lost${where}${tank}`
      // Say plainly that we could not check it. The alternative is a feed that
      // sounds equally certain about a measurement and a claim.
      : `FUEL DROP: ${plate} — ${L(t.stolenMl)} reported lost${where}, unconfirmed (no tank readings to check).`

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
}
