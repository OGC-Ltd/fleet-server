/**
 * The sweep that checks Wialon's refuelling claims against our own tank.
 *
 * The mirror of `fuel-adjudication.service.ts`, deliberately the same shape:
 * one function gathers the evidence and judges a single row, and both the
 * sweep and the backfill go through it so the two can never drift into
 * disagreeing about the same event. That drift is not hypothetical — the
 * drains had exactly that bug, and it silently disabled a whole verdict.
 *
 * Nothing here notifies. A filling is not an exception, and a filling
 * reclassified as undulation is a data-quality finding rather than something
 * to send anybody out about.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import {
  adjudicateFilling, FILL_HOLD_MINUTES, FILL_LOOKBEHIND_MINUTES, FILL_SETTLE_MINUTES,
  type FillingClaim,
} from './fuel-filling-adjudication.js'
import type { Adjudication, LevelSample } from './fuel-adjudication.js'

export interface FillingAdjudicateOptions {
  orgId?: string
  /** Write verdicts. False makes the whole call a dry run. */
  apply:  boolean
  limit?: number
  now?:   Date
  /** Re-judge rows that already carry a verdict, not just PENDING ones. */
  rejudge?: boolean
}

export interface FillingOutcome {
  examined:       number
  /** Corroborated by our own level series. */
  refillConfirmed: number
  /** Relayed from the provider because we had nothing to check it with. */
  refillUnchecked: number
  /** Fuel supposedly went in and the tank is no fuller — the probe swinging. */
  redistribution:  number
  stillPending:    number
  /** Millilitres claimed by rows we could not corroborate. */
  uncorroboratedMl: number
}

const EMPTY: FillingOutcome = {
  examined: 0, refillConfirmed: 0, refillUnchecked: 0, redistribution: 0,
  stillPending: 0, uncorroboratedMl: 0,
}

/**
 * Gather the evidence for one filling and judge it.
 *
 * The window is asymmetric on purpose: a short look behind for the pre-fill
 * baseline, and a look ahead that starts only once the pump has stopped. A
 * reading taken while a tank is filling is neither the old level nor the new
 * one.
 */
export async function judgeFilling(
  filling: FillingClaim & { vehicleId: string },
  now: Date,
): Promise<Adjudication> {
  const from = new Date(filling.filledAt.getTime() - FILL_LOOKBEHIND_MINUTES * 60_000)
  const to   = new Date(filling.filledAt.getTime() + (FILL_SETTLE_MINUTES + FILL_HOLD_MINUTES) * 60_000)

  const rows = await prisma.vehicleTelemetry.findMany({
    where:   { vehicleId: filling.vehicleId, capturedAt: { gte: from, lte: to }, fuelLevelMl: { not: null } },
    select:  { capturedAt: true, fuelLevelMl: true, engineOn: true },
    orderBy: { capturedAt: 'asc' },
  })
  const samples: LevelSample[] = rows.map(r => ({
    capturedAt: r.capturedAt, fuelLevelMl: r.fuelLevelMl!, engineOn: r.engineOn,
  }))

  return adjudicateFilling(filling, samples, now)
}

export async function adjudicateFillings(opts: FillingAdjudicateOptions): Promise<FillingOutcome> {
  const now  = opts.now ?? new Date()
  const ripe = new Date(now.getTime() - (FILL_SETTLE_MINUTES + FILL_HOLD_MINUTES) * 60_000)

  const pending = await prisma.fuelFilling.findMany({
    where: {
      ...(opts.rejudge ? {} : { verdict: 'PENDING' }),
      filledAt: { lte: ripe },
      ...(opts.orgId ? { vehicle: { organisationId: opts.orgId } } : {}),
    },
    select: {
      id: true, vehicleId: true, filledAt: true, filledMl: true,
      vehicle: { select: { registrationPlate: true } },
    },
    orderBy: { filledAt: 'asc' },
    take: opts.limit ?? 5000,
  })
  if (pending.length === 0) return { ...EMPTY }

  const out: FillingOutcome = { ...EMPTY }

  for (const f of pending) {
    out.examined++
    const verdict = await judgeFilling(
      { vehicleId: f.vehicleId, filledAt: f.filledAt, filledMl: f.filledMl }, now,
    )

    if (verdict.verdict === 'PENDING') { out.stillPending++; continue }
    if (verdict.verdict === 'REDISTRIBUTION') {
      out.redistribution++
      out.uncorroboratedMl += f.filledMl
    } else if (verdict.confirmed) out.refillConfirmed++
    else {
      out.refillUnchecked++
      out.uncorroboratedMl += f.filledMl
    }

    if (!opts.apply) continue
    await prisma.fuelFilling.update({
      where: { id: f.id },
      data:  {
        verdict:        verdict.verdict,
        verdictAt:      now,
        verdictReason:  verdict.reason,
        // What OUR telemetry saw arrive. `filledMl` is never touched — the
        // provider's claim stays on the row so the two can be compared.
        observedRiseMl: verdict.recoveredMl,
      },
    })
  }

  logger.info({ ...out, orgId: opts.orgId ?? 'all', apply: opts.apply }, 'Fuel filling adjudication complete')
  return out
}
