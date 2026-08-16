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
 * Only a DRAIN is announced. A REDISTRIBUTION means the fuel came back and a
 * REFILL means it went in, so neither is news. An UNCONFIRMED drain still is —
 * the provider saw something and we could not check it — but the wording and
 * the severity say so rather than implying we corroborated it.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { publishNotificationDurable } from '../../lib/notifications/notification.store.js'
import {
  adjudicateDrain, applyProbeTrustGate, SETTLE_MINUTES, SWING_ML,
  type Adjudication, type DrainClaim, type LevelSample, type ProbeProfile, type Verdict,
} from './fuel-adjudication.js'

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
  /** The level went down and did not come back. */
  drain:          number
  /** ...and of those, the ones our own telemetry watched happen. */
  drainConfirmed: number
  /** A filling explains it: fuel went in. */
  refill:         number
  redistribution: number
  /** Drains blamed on a dead fuel probe rather than on the tank. */
  sensorFault:    number
  stillPending:   number
  published:      number
  /** Millilitres reclassified as never having left the tank. */
  recoveredMl:    number
}

const EMPTY: AdjudicateOutcome = {
  examined: 0, drain: 0, drainConfirmed: 0, refill: 0, redistribution: 0,
  sensorFault: 0, stillPending: 0, published: 0, recoveredMl: 0,
}

/** litres, without the false precision of "40.0" for a whole number. */
const L = (ml: number): string => {
  const l = ml / 1000
  return `${Number.isInteger(l) ? l : l.toFixed(1)} L`
}

/**
 * How far back the probe's parked-swing profile is measured.
 *
 * Three weeks: long enough that a machine which spends its days working has
 * accumulated the MIN_PARKED_WINDOWS the profile needs, short enough that a
 * probe repaired last month is not still being judged on how it behaved before.
 */
const PROFILE_DAYS = 21

/** Readings a half-hour needs before its swing is worth measuring. */
const PROFILE_MIN_SAMPLES = 30

/**
 * Profiles are a property of the machine and move over weeks, so they are
 * cached rather than re-read per drain. The backfill re-judges thousands of
 * rows across ~173 vehicles; without this it would ask the same question of the
 * same machine hundreds of times.
 */
const PROFILE_TTL_MS = 6 * 60 * 60_000
const profileCache = new Map<string, { profile: ProbeProfile; at: number }>()

/** Test seam — the cache is module-global and would leak between cases. */
export function __resetProbeProfileCache(): void {
  profileCache.clear()
}

/**
 * How much this vehicle's fuel probe moves while the machine is standing still.
 *
 * A half-hour counts as parked when it holds PROFILE_MIN_SAMPLES readings and
 * never records any speed at all — a machine that moved was burning fuel, and
 * a level falling because it is being consumed is not the probe's fault.
 */
export async function getProbeProfile(vehicleId: string, now: Date): Promise<ProbeProfile> {
  const hit = profileCache.get(vehicleId)
  if (hit && now.getTime() - hit.at < PROFILE_TTL_MS) return hit.profile

  const from = new Date(now.getTime() - PROFILE_DAYS * 24 * 3_600_000)
  const rows = await prisma.$queryRaw<Array<{ parked: bigint; swinging: bigint }>>`
    WITH win AS (
      SELECT date_trunc('hour', captured_at)
               + interval '30 min' * floor(extract(minute FROM captured_at) / 30) AS bucket,
             count(*)                                          AS n,
             max(fuel_level_ml) - min(fuel_level_ml)           AS swing,
             max(coalesce(speed_kmh, 0))                       AS top_speed
        FROM vehicle_telemetries
       WHERE vehicle_id = ${vehicleId}
         AND captured_at >= ${from}
         AND fuel_level_ml IS NOT NULL
       GROUP BY 1
    )
    SELECT count(*)                                       AS parked,
           count(*) FILTER (WHERE swing >= ${SWING_ML})    AS swinging
      FROM win
     WHERE n >= ${PROFILE_MIN_SAMPLES} AND top_speed = 0`

  const profile: ProbeProfile = {
    parkedWindows: Number(rows[0]?.parked   ?? 0),
    swingWindows:  Number(rows[0]?.swinging ?? 0),
  }
  profileCache.set(vehicleId, { profile, at: now.getTime() })
  return profile
}

/**
 * Gather the evidence for one drain and judge it.
 *
 * Separated from the sweep below because it has a SECOND caller: the backfill
 * in `prisma/readjudicate-fuel.ts`, which revisits rows that already carry a
 * verdict. A re-judgement is only worth anything if it sees exactly what the
 * live pass would have seen — same windows, same columns, same filling rule —
 * and keeping two copies of that query did not survive contact with a change.
 *
 * The backfill's copy selected `capturedAt` and `fuelLevelMl` and NOT
 * `engineOn`. Both dead-probe rules decide on engine evidence, so from the day
 * `SENSOR_FAULT` shipped the backfill could not reach that verdict for any row
 * — silently, since a missing `engineOn` reads as "no engine evidence", which
 * is a state the rules are designed to tolerate. That is the whole class of row
 * most worth revisiting, so it is now impossible to fix one caller alone.
 */
export async function judgeDrain(
  drain: DrainClaim & { vehicleId: string },
  now: Date,
): Promise<Adjudication> {
  const from = new Date(drain.beganAt.getTime() - LOOKBEHIND_MS)
  const to   = new Date(drain.detectedAt.getTime() + LOOKAHEAD_MS)

  const [rows, filling] = await Promise.all([
    prisma.vehicleTelemetry.findMany({
      where:   { vehicleId: drain.vehicleId, capturedAt: { gte: from, lte: to }, fuelLevelMl: { not: null } },
      // engineOn is what separates a dead probe from a tank drained empty —
      // an engine cannot run on an empty tank. Without it the dropout rule
      // stays silent and the ordinary recovery test decides.
      select:  { capturedAt: true, fuelLevelMl: true, engineOn: true },
      orderBy: { capturedAt: 'asc' },
    }),
    prisma.fuelFilling.findFirst({
      where:   {
        vehicleId: drain.vehicleId,
        filledAt:  { gte: drain.beganAt, lte: to },
        // A filling only closes the recovery window if fuel actually arrived.
        // Since 2026-08-11 fillings are adjudicated too, and 307 of 5,794 are
        // REDISTRIBUTION — the up-swings of oscillating probes, claiming
        // 13,075 L while those tanks collectively FELL 3,689 L. Letting one of
        // those truncate a drain's evidence is how `filling-too-soon` reached
        // 438 rows, and how a -27.7 L undulation on MUFINDI - EX 22 came to be
        // classified a refill: the "fillings" that closed its window were the
        // same probe swing as the drop.
        //
        // PENDING fillings still count. Unjudged is not disproved, and assuming
        // a filling is real until shown otherwise is the conservative
        // direction — it withholds confirmation rather than inventing it.
        verdict:   { not: 'REDISTRIBUTION' },
      },
      select:  { filledAt: true },
      // The EARLIEST filling is the one that closes the window — a later one
      // cannot explain a rise the first already accounts for.
      orderBy: { filledAt: 'asc' },
    }),
  ])
  const samples: LevelSample[] = rows.map(r => ({
    capturedAt: r.capturedAt, fuelLevelMl: r.fuelLevelMl!, engineOn: r.engineOn,
  }))

  const verdict = adjudicateDrain(drain, samples, filling?.filledAt ?? null, now)

  // The trust gate, asked LAST and only of the rows it can act on. It costs a
  // second query, and the great majority never need it: on the ledger as it
  // stands 417 of 2,571 are a CONFIRMED drain.
  if (verdict.verdict !== 'DRAIN' || !verdict.confirmed) return verdict
  return applyProbeTrustGate(verdict, await getProbeProfile(drain.vehicleId, now))
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

    const verdict = await judgeDrain(
      { vehicleId: t.vehicleId, beganAt: t.beganAt, detectedAt: t.detectedAt, stolenMl: t.stolenMl },
      now,
    )

    if (verdict.verdict === 'PENDING') { out.stillPending++; continue }
    tally(out, verdict)
    if (verdict.verdict === 'REDISTRIBUTION') out.recoveredMl += t.stolenMl

    if (!opts.apply) continue

    await prisma.fuelTheft.update({
      where: { id: t.id },
      data:  {
        verdict:           verdict.verdict,
        verdictAt:         now,
        recoveredMl:       verdict.recoveredMl,
        verdictReason:     verdict.reason,
        verdictConfidence: verdict.confidence,
      },
    })

    // Only a drain is news, and only one recent enough to be news — see
    // notifyCutoff.
    //
    // A REDISTRIBUTION never reaches the feed: the fuel came back, so there is
    // nothing to send anyone to look at. Nor does a REFILL, which is a
    // refuelling reported as a theft by the provider and is the opposite of an
    // exception. Nor does a SENSOR_FAULT — a dead probe reads a full tank
    // draining to nothing, and announcing that names whoever happened to be
    // driving for an event that never occurred, the one outcome here worse than
    // missing a real one. Dead probes get their own daily list instead, which
    // sends a fitter rather than an investigator: see fuel-probe-health.
    if (!opts.notify || verdict.verdict !== 'DRAIN') continue
    if (opts.notifyCutoff && t.beganAt < opts.notifyCutoff) continue

    const plate = t.vehicle.registrationPlate
    const where = t.initialLocation ? ` at ${t.initialLocation}` : ''
    const tank  = t.finalFuelLevelMl != null ? `. Tank now ${L(t.finalFuelLevelMl)}.` : '.'
    // Neither line says "loss", "theft", "stolen" or "suspicious". A DRAIN is
    // the level going down and not coming back; where the fuel went is not
    // something a probe can see, and the wording used to decide that question
    // for whoever read it. The message's job is to send someone to look.
    //
    // What the two lines DO distinguish is whether we watched it ourselves, and
    // that is carried by the wording and the severity rather than by a trailing
    // caveat — the place string alone runs to a full line on this fleet, and a
    // caveat nobody reaches the end of is not a caveat.
    const text = verdict.confirmed
      ? `FUEL DRAIN: ${plate} — ${L(t.stolenMl)} down and not recovered${where}${tank}`
      : `FUEL DRAIN: ${plate} — ${L(t.stolenMl)} reported, not confirmed${where}${tank}`

    const { published } = await publishNotificationDurable({
      orgId:     t.vehicle.organisationId,
      id:        `fuel-drain-${t.vehicleId}-${t.id}`,
      source:    'wialon',
      alertType: 'fuelInconsistency',
      severity:  verdict.confirmed ? 'critical' : 'warning',
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

function tally(out: AdjudicateOutcome, a: Adjudication): void {
  if (a.verdict === 'DRAIN') {
    out.drain++
    if (a.confirmed) out.drainConfirmed++
  }
  else if (a.verdict === 'REFILL')         out.refill++
  else if (a.verdict === 'REDISTRIBUTION') out.redistribution++
  else if (a.verdict === 'SENSOR_FAULT')   out.sensorFault++
}