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
  adjudicateDrain, applyProbeTrustGate, smoothLevels, SETTLE_MINUTES, SWING_ML,
  type Adjudication, type DrainClaim, type LevelSample, type ProbeProfile, type Verdict,
} from './fuel-adjudication.js'
import { measureFall, type FallSample, type DropEvidence } from './fuel-drop-shape.js'
import {
  classifyDrain, resolveBand, resolveBasis, announces, mayUseTheftWording, type CauseJudgement,
  ANNOUNCED_CAUSES, ANNOUNCED_REASON_SLUGS,
} from './fuel-theft-classifier.js'
import { resolveRates, MIN_RUNS, type ResolvedRate } from './fuel-rate.js'

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
  /**
   * Causes assigned this cycle, by name. Reported so a SHADOW run — causes
   * written, notifications unchanged — is visible in the ordinary cycle log
   * rather than needing a query against the ledger.
   */
  causes:         Record<string, number>
}

const EMPTY: AdjudicateOutcome = {
  examined: 0, drain: 0, drainConfirmed: 0, refill: 0, redistribution: 0,
  sensorFault: 0, stillPending: 0, published: 0, recoveredMl: 0, causes: {},
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
 * A half-hour counts as parked when it holds PROFILE_MIN_SAMPLES readings, never
 * records any speed, AND never records the engine running.
 *
 * ## Why speed alone was not enough
 *
 * The original test was `top_speed = 0`, on the reasoning that "a machine that
 * moved was burning fuel, and a level falling because it is being consumed is
 * not the probe's fault". That reasoning is right and the test does not
 * implement it: a machine can burn fuel hard without moving a metre, and this
 * fleet is full of them.
 *
 * `MUFINDI - DG 13` is the clearest case — a generator, moving in 0.95% of
 * readings over 14.6 days, engine on 85.9% of the time, burning a steady
 * 40-50 L/h with a 1,696 L tank refuelled every day or two. Under the speed
 * test, 143 of its 326 half-hours "swung" 25 L or more, so 44% of its windows
 * were counted as the instrument misbehaving. They were the machine working.
 * Requiring the engine to be off as well leaves it 2 parked windows and 0
 * swings, which is the truth: it is essentially never idle.
 *
 * That mattered because this gate is the FIRST thing `classifyDrain` checks
 * and it returns INDETERMINATE — which blocks every verdict, including the
 * reassuring ones. Any stationary plant that runs its engine hard was being
 * quietly disqualified from fuel judgement altogether: gensets, pumps,
 * crushers, an excavator that works all day without travelling. That is the
 * exact population the engine-hours redesign was built for.
 *
 * ## What this does on a unit with no ignition
 *
 * Nothing, deliberately. `engine_on` is NOT NULL with a default of false and
 * the adapter fills it as `ignition ?? (speed > 0)`, so where ignition is
 * absent the column restates movement — and a window with no speed also has no
 * engine-on reading. Those units keep exactly the behaviour they have today.
 *
 * The stricter alternative — count a window only where ignition was MEASURED
 * and off — was rejected. It would leave a unit without ignition zero parked
 * windows, `probeSwings` would return false for want of evidence, and its
 * genuinely noisy probe would stop being distrusted at all. That is the
 * dangerous direction: it turns missing evidence into a clean bill of health.
 */
export async function getProbeProfile(vehicleId: string, now: Date): Promise<ProbeProfile> {
  const hit = profileCache.get(vehicleId)
  if (hit && now.getTime() - hit.at < PROFILE_TTL_MS) return hit.profile

  const from = new Date(now.getTime() - PROFILE_DAYS * 24 * 3_600_000)
  const rows = await prisma.$queryRaw<Array<{ parked: bigint; swinging: bigint; fill_ratio: number | null }>>`
    WITH win AS (
      SELECT date_trunc('hour', captured_at)
               + interval '30 min' * floor(extract(minute FROM captured_at) / 30) AS bucket,
             count(*)                                          AS n,
             max(fuel_level_ml) - min(fuel_level_ml)           AS swing,
             max(coalesce(speed_kmh, 0))                       AS top_speed,
             count(*) FILTER (WHERE engine_on)                 AS running
        FROM vehicle_telemetries
       WHERE vehicle_id = ${vehicleId}
         AND captured_at >= ${from}
         AND fuel_level_ml IS NOT NULL
       GROUP BY 1
    )
    , cap AS (
      -- The probe's sustained ceiling against the tank it is fitted to. p99
      -- rather than max, so one spurious reading cannot condemn an
      -- instrument — this is about a scale that is wrong, not a glitch.
      SELECT percentile_cont(0.99) WITHIN GROUP (ORDER BY t.fuel_level_ml) / 1000.0
               / NULLIF(v.tank_capacity_litres, 0) AS fill_ratio
        FROM vehicle_telemetries t
        JOIN vehicles v ON v.id = t.vehicle_id
       WHERE t.vehicle_id = ${vehicleId}
         AND t.captured_at >= ${from}
         AND t.fuel_level_ml IS NOT NULL
       GROUP BY v.tank_capacity_litres
    )
    SELECT count(*)                                       AS parked,
           count(*) FILTER (WHERE swing >= ${SWING_ML})    AS swinging,
           (SELECT fill_ratio FROM cap)                    AS fill_ratio
      FROM win
     WHERE n >= ${PROFILE_MIN_SAMPLES} AND top_speed = 0 AND running = 0`

  const profile: ProbeProfile = {
    parkedWindows: Number(rows[0]?.parked   ?? 0),
    swingWindows:  Number(rows[0]?.swinging ?? 0),
    fillRatio:     rows[0]?.fill_ratio != null ? Number(rows[0].fill_ratio) : null,
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
): Promise<Adjudication & { cause: CauseJudgement | null; evidence: DropEvidence | null }> {
  const from = new Date(drain.beganAt.getTime() - LOOKBEHIND_MS)
  const to   = new Date(drain.detectedAt.getTime() + LOOKAHEAD_MS)

  const [rows, filling] = await Promise.all([
    // Raw SQL rather than `findMany` because of `ignition_known`, which lives
    // in the raw payload and is the only way to tell a MEASURED engine state
    // from the adapter's fallback.
    //
    // `vehicle_telemetries.engine_on` is NOT NULL with a default of false and
    // is filled as `ignition ?? (speed > 0)`, so on a unit that reports no
    // ignition it silently becomes "was the vehicle moving". The cause
    // classifier's parked branch cannot be built on that — "engine off and
    // stationary" would be true of every parked machine by construction.
    //
    // Both readings are carried, and they feed DIFFERENT consumers on purpose:
    // `adjudicateDrain` keeps the raw column it has always had, so its
    // dead-probe rules behave exactly as before, and only the classifier sees
    // the stricter ignition-aware version. Narrowing what adjudication sees
    // would change verdicts, which this step must not do.
    prisma.$queryRaw<Array<{
      captured_at: Date; fuel_level_ml: number; engine_on: boolean
      speed_kmh: number | null; ignition_known: boolean | null
    }>>`
      SELECT t.captured_at, t.fuel_level_ml, t.engine_on, t.speed_kmh,
             (r.payload->>'ignition_known')::boolean AS ignition_known
        FROM vehicle_telemetries t
        JOIN vehicle_telemetry_raws r ON r.telemetry_id = t.id
       WHERE t.vehicle_id = ${drain.vehicleId}
         AND t.captured_at >= ${from} AND t.captured_at <= ${to}
         AND t.fuel_level_ml IS NOT NULL
       ORDER BY t.captured_at ASC`,
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
    capturedAt: r.captured_at, fuelLevelMl: r.fuel_level_ml, engineOn: r.engine_on,
  }))

  const verdict = adjudicateDrain(drain, samples, filling?.filledAt ?? null, now)

  // ── the cause ────────────────────────────────────────────────────────────
  //
  // Only a DRAIN has a cause to determine. A REDISTRIBUTION means the fuel came
  // back and a SENSOR_FAULT means the probe lied, so neither poses the question
  // "where did it go" that this answers.
  if (verdict.verdict !== 'DRAIN') return { ...verdict, cause: null, evidence: null }

  // The trust gate, asked only of the rows it can act on. It costs a second
  // query, and the great majority never need it: on the ledger as it stands 417
  // of 2,571 are a CONFIRMED drain.
  const gated = verdict.confirmed
    ? applyProbeTrustGate(verdict, await getProbeProfile(drain.vehicleId, now))
    : verdict

  // The classifier gets the STRICTER engine reading — see the query note.
  const fallSamples: FallSample[] = rows.map(r => ({
    capturedAt:  r.captured_at,
    fuelLevelMl: r.fuel_level_ml,
    engineOn:    r.ignition_known === true ? r.engine_on : undefined,
    speedKmh:    r.speed_kmh,
  }))
  const measured = measureFall(fallSamples, drain, smoothLevels)
  if (measured == null) {
    // No measurable fall in our own series. The verdict stands — the provider
    // saw something we could not — but there is nothing to attribute it to.
    return { ...gated, cause: { cause: 'INDETERMINATE', reason: 'no-measurable-fall', confidence: 0.5, impliedLph: null }, evidence: null }
  }

  const { orgCode, plate, rate, lPerKm, vehicleType, tankCapacityLitres } =
    await getBandInputs(drain.vehicleId, now)
  const band = resolveBand(orgCode, { plate, vehicleType, tankCapacityLitres },
    rate == null ? null : { lPerHour: rate.lPerHour, basis: rate.basis, lPerKm })
  const profile = await getProbeProfile(drain.vehicleId, now)
  // Which denominator this machine is judged in, and — inside classifyDrain —
  // whether THIS fall belongs to it. A truck on the open road is judged per
  // kilometre; the same truck idling is judged per hour.
  const basis = resolveBasis(orgCode, { plate, vehicleType, tankCapacityLitres })
  // The evidence rides out alongside the cause so the caller can PERSIST what
  // the verdict was reached on. Computed here for every drain since the
  // classifier was written and discarded every time until 2026-08-28.
  return {
    ...gated,
    cause: classifyDrain(measured.evidence, band, profile, basis),
    evidence: measured.evidence,
  }
}

/**
 * What `resolveBand` needs about a vehicle: which org and machine it is, and
 * what it has been measured to burn.
 *
 * Fetched HERE rather than passed in by the caller, for the reason the module
 * docstring already gives about the evidence query: `judgeDrain` has two
 * callers — the live sweep and `prisma/readjudicate-fuel.ts` — and anything one
 * of them assembles for itself is something the two can come to disagree about.
 * A backfill that resolved a different band than the live pass would produce
 * causes that could never be reproduced.
 *
 * The resolved rates are a FLEET-WIDE computation (a type median needs every
 * vehicle's rate), so they are built once and cached rather than per drain.
 */
const BAND_TTL_MS = 6 * 60 * 60_000
let bandCache: { at: number; byVehicle: Map<string, BandInputs> } | null = null

/**
 * `lPerKm` rides alongside the resolved rate rather than inside it: a type
 * MEDIAN has no meaningful distance figure — it is pooled across machines that
 * travel differently — so only a vehicle's OWN measured lPerKm is carried, and
 * a vehicle without one gets no distance baseline and is judged on L/h alone.
 */
interface BandInputs {
  orgCode: string; plate: string; rate: ResolvedRate | null; lPerKm: number | null
  /** Both carried because a class can be decided by either — see resolveClass. */
  vehicleType: string | null; tankCapacityLitres: number | null
}

/** Test seam — the cache is module-global and would leak between cases. */
export function __resetBandCache(): void {
  bandCache = null
}

async function getBandInputs(vehicleId: string, now: Date): Promise<BandInputs> {
  if (bandCache == null || now.getTime() - bandCache.at >= BAND_TTL_MS) {
    const [vehicles, rates] = await Promise.all([
      prisma.vehicle.findMany({
        select: {
          id: true, registrationPlate: true, vehicleType: true, organisationId: true,
          tankCapacityLitres: true,
          organisation: { select: { code: true } },
        },
      }),
      prisma.vehicleFuelRate.findMany({ select: { vehicleId: true, lPerHour: true, lPerKm: true, runs: true } }),
    ])
    // The SAME resolution the trend rows and the measurement harness use —
    // per-vehicle where earned, type median otherwise.
    const resolved = resolveRates(
      rates.map(r => ({ vehicleId: r.vehicleId, lPerHour: r.lPerHour, lPerKm: r.lPerKm, runs: r.runs })),
      vehicles.map(v => ({ vehicleId: v.id, organisationId: v.organisationId, vehicleType: v.vehicleType })),
    )
    const ownKm = new Map(rates.filter(r => r.runs >= MIN_RUNS && r.lPerKm != null)
      .map(r => [r.vehicleId, r.lPerKm!]))
    bandCache = {
      at: now.getTime(),
      byVehicle: new Map(vehicles.map(v => [v.id, {
        orgCode: v.organisation?.code ?? '',
        plate:   v.registrationPlate,
        rate:    resolved.get(v.id) ?? null,
        lPerKm:  ownKm.get(v.id) ?? null,
        vehicleType:        v.vehicleType,
        tankCapacityLitres: v.tankCapacityLitres,
      }])),
    }
  }
  return bandCache.byVehicle.get(vehicleId)
      ?? { orgCode: '', plate: '', rate: null, lPerKm: null, vehicleType: null, tankCapacityLitres: null }
}

/**
 * How far back a repeat is still a repeat.
 *
 * Thirty days, matching the window every other fuel measurement here uses, and
 * comfortably wider than the pattern it has to catch: measured 2026-08-19 over
 * the live ledger, the repeat vehicles clustered tightly — KCX 802S took six
 * flagged events inside 1.3 days, MUFINDI - DZ 20 four inside 2.0. A week would
 * have caught both. Thirty days also catches the slower case, a unit losing
 * fuel once a fortnight, which is the one an operator would otherwise never
 * connect.
 */
export const REPEAT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** How many earlier volumes the headline quotes before it stops listing. */
const RECENT_VOLUMES_SHOWN = 3

export interface IncidentHistory {
  /** Announced events on this unit BEFORE this one, inside the window. */
  priorCount: number
  /** This one included — the ordinal the operator reads. */
  totalCount: number
  /** Every announced event in the window including this one, millilitres. */
  totalMl: number
  /** The most recent earlier volumes, newest first, capped. */
  recentMl: number[]
  /**
   * How many of them were siphons, which are the only ones that may be called
   * theft. Zero in the live ledger today; carried so the wording can change the
   * moment that is not true.
   */
  siphonCount: number
}

/**
 * What else has been announced about this unit lately.
 *
 * ## Why this counts ANNOUNCED events and not siphons
 *
 * The operator asked for repeat THEFT. Taken literally that means repeat
 * `SIPHON`, and measured against the live ledger on 2026-08-19 it would never
 * fire once: there are no siphons in it at all, and there were only six in the
 * best thirty days this detector has ever had. A feature that cannot fire is
 * not a cautious feature, it is an absent one.
 *
 * What DOES repeat is the announcement — the thing the operator was actually
 * told about. Five of the eleven flagged vehicles in the last thirty days were
 * flagged more than once, and the worst, KCX 802S, six times for 417.7 L inside
 * thirty-two hours. That is the pattern worth putting in front of somebody.
 *
 * The vocabulary does not move with it. `siphonCount` is carried separately so
 * the sentence says "possible theft" only when the events genuinely were
 * siphons and "flagged event" otherwise — the rule that has held since the LOSS
 * verdict was removed, and the reason this counts events without claiming to
 * know where the fuel went.
 *
 * One indexed range scan on (vehicle_id, began_at), run only for a drain that
 * is about to be announced — a few a day against roughly fifty judged.
 */
export async function getIncidentHistory(
  vehicleId: string, beganAt: Date, thisMl: number, thisIsSiphon: boolean,
): Promise<IncidentHistory> {
  const from = new Date(beganAt.getTime() - REPEAT_WINDOW_MS)
  // Strictly BEFORE this drain, so the ordinal counts what came first rather
  // than whatever the settle pass happens to have written already.
  const prior = await prisma.$queryRaw<Array<{ stolen_ml: number; is_siphon: boolean }>>`
    SELECT t.stolen_ml, (t.drain_cause::text = 'SIPHON') AS is_siphon
      FROM fuel_thefts t
     WHERE t.vehicle_id = ${vehicleId}
       AND t.began_at  >= ${from}
       AND t.began_at   < ${beganAt}
       AND (t.drain_cause::text = ANY(${[...ANNOUNCED_CAUSES]}::text[])
         OR t.cause_reason      = ANY(${[...ANNOUNCED_REASON_SLUGS]}::text[]))
     ORDER BY t.began_at DESC`

  return {
    priorCount:  prior.length,
    totalCount:  prior.length + 1,
    totalMl:     prior.reduce((a, r) => a + r.stolen_ml, 0) + thisMl,
    recentMl:    prior.slice(0, RECENT_VOLUMES_SHOWN).map(r => r.stolen_ml),
    siphonCount: prior.filter(r => r.is_siphon).length + (thisIsSiphon ? 1 : 0),
  }
}

/** 1st, 2nd, 3rd — the count never gets large enough to need more. */
function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th'
    : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
  return `${n}${suffix}`
}

/**
 * The repeat clause, or empty when there is nothing to repeat.
 *
 * Silent on a first event, which is six of the eleven flagged vehicles — an
 * operator told "1st flagged event" has learned nothing, and a tail that is
 * usually noise is a tail nobody reads when it matters.
 */
export function repeatClause(h: IncidentHistory, allSiphons: boolean): string {
  if (h.totalCount < 2) return ''
  const what   = allSiphons ? 'possible theft' : 'flagged event'
  const recent = h.recentMl.length
    ? ` (before this: ${h.recentMl.map(ml => L(ml)).join(', ')})`
    : ''
  return ` ${ordinal(h.totalCount)} ${what} on this unit in 30 days — ${L(h.totalMl)} in total${recent}.`
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
  if (pending.length === 0) return { ...EMPTY, causes: {} }

  const out: AdjudicateOutcome = { ...EMPTY, causes: {} }

  for (const t of pending) {
    out.examined++

    const verdict = await judgeDrain(
      { vehicleId: t.vehicleId, beganAt: t.beganAt, detectedAt: t.detectedAt, stolenMl: t.stolenMl },
      now,
    )

    if (verdict.verdict === 'PENDING') { out.stillPending++; continue }
    tally(out, verdict)
    if (verdict.cause) out.causes[verdict.cause.cause] = (out.causes[verdict.cause.cause] ?? 0) + 1
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
        // Written but NOT yet acted on. The notification gate below is
        // deliberately unchanged in this step: causes accumulate on the ledger
        // for a day so the thresholds can be checked against what the live
        // pass actually decides, before any of them start suppressing an
        // alert. Flipping the gate is a one-line change once that is done —
        // see docs/fuel-theft-discrimination-plan.md step 6.
        drainCause:        verdict.cause?.cause      ?? null,
        causeConfidence:   verdict.cause?.confidence ?? null,
        causeReason:       verdict.cause?.reason     ?? null,
        // The measured shape this verdict was reached on. Persisted as it was
        // at judgement time and never recomputed: the sweep re-reads telemetry,
        // so a figure derived later would describe a different fall while
        // looking like a contemporaneous measurement.
        //
        // `impliedLph` comes off the CAUSE rather than the evidence — the
        // classifier is what decides which denominator applies, and the same
        // fall implies a different rate under HOURS than under DISTANCE.
        fallSeconds:       verdict.evidence?.fallSeconds    ?? null,
        measuredDropMl:    verdict.evidence?.dropMl         ?? null,
        engineSeconds:     verdict.evidence?.engineSeconds  ?? null,
        engineEvidence:    verdict.evidence?.engineEvidence ?? null,
        stepFraction:      verdict.evidence?.stepFraction   ?? null,
        fallDistanceKm:    verdict.evidence?.distanceKm     ?? null,
        impliedLph:        verdict.cause?.impliedLph        ?? null,
      },
    })

    // ── the gate ─────────────────────────────────────────────────────────
    //
    // A DRAIN is no longer news by itself. Until 2026-08-17 it was, and that
    // is the complaint this whole branch exists to answer: the ledger could
    // not tell fuel a machine burned from fuel that left, so it announced all
    // of it — 46.9 items a day, of which the great majority were a machine
    // working normally.
    //
    // Now only a CAUSE is news, and only two of the seven are:
    //
    //   UNEXPLAINED_BURN  the tank fell by more than this machine's own
    //                     consumption accounts for
    //   SIPHON            the engine was provably off, the fall was sustained,
    //                     and it was neither settling nor a probe step
    //
    // Everything else lands on the ledger and the dashboard tables silently.
    // ENGINE_BURN and HIGH_BURN are a machine doing its job; SLOSH and
    // SETTLING are the instrument or the liquid; INDETERMINATE is us admitting
    // we cannot say, which is 60% of the ledger and is not something to
    // announce. A REDISTRIBUTION or SENSOR_FAULT never even reaches a cause.
    //
    // Measured over 30 days of real drains: 90 announcements against 1,407,
    // spread across 31 vehicles. Reversible in one line if it proves wrong.
    if (!opts.notify || verdict.cause == null || !announces(verdict.cause)) continue
    if (opts.notifyCutoff && t.beganAt < opts.notifyCutoff) continue

    const cause = verdict.cause
    const plate = t.vehicle.registrationPlate
    const where = t.initialLocation ? ` at ${t.initialLocation}` : ''
    const tank  = t.finalFuelLevelMl != null ? `. Tank now ${L(t.finalFuelLevelMl)}.` : '.'

    // ONLY a SIPHON may say theft, and only qualified — "when we have
    // determined that truly it was a theft then we need to use the word
    // possible theft" (operator, 2026-08-16). Everything else keeps the
    // vocabulary rule that has held since the LOSS verdict was removed: the
    // message says what the tank did and sends someone to look, and does not
    // decide where the fuel went on the reader's behalf.
    //
    // UNEXPLAINED_BURN deliberately does not qualify. A leak, a mis-calibrated
    // probe and a wrong expected rate all produce it, and so does theft —
    // naming it would answer a question this data cannot.
    // Per RULE, because a single non-theft headline cannot be honest across
    // four different findings. "FUEL UNEXPLAINED" was one line for all of
    // them, and it described OUR failure to account for a drop rather than
    // what was measured — the operator's objection, and the same defect that
    // removed the LOSS verdict. Each line below states the observation and
    // leaves the conclusion to the reader.
    // What else this unit has been flagged for lately. Asked only here, past
    // the gate, so it costs one indexed read per ANNOUNCEMENT rather than per
    // drain — a few a day against roughly fifty.
    const history = await getIncidentHistory(
      t.vehicleId, t.beganAt, t.stolenMl, cause.cause === 'SIPHON',
    )
    // "Possible theft" only when EVERY event being counted was a siphon. A
    // count that mixed one siphon with five rate findings and called the total
    // theft would be the strongest claim in the sentence resting on the
    // weakest evidence in it.
    const repeat = repeatClause(history, history.siphonCount === history.totalCount)

    const rate = cause.impliedLph != null ? `${Math.round(cause.impliedLph)} L/h` : null
    const headline = mayUseTheftWording(cause.cause)
      ? `POSSIBLE THEFT: ${plate} — ${L(t.stolenMl)} drawn off while parked${where}${tank}`
      : cause.reason === 'drop-while-stationary'
      ? `FUEL DOWN: ${plate} — ${L(t.stolenMl)} while stationary, nothing driven${where}${tank}`
      : cause.reason === 'drop-exceeds-distance'
      ? `FUEL DOWN: ${plate} — ${L(t.stolenMl)}, more than the distance driven accounts for${where}${tank}`
      : rate
      ? `FUEL RATE: ${plate} — ${L(t.stolenMl)} at ${rate}, above what this machine is measured to burn${where}${tank}`
      : `FUEL RATE: ${plate} — ${L(t.stolenMl)} above this machine's measured rate${where}${tank}`

    const { published } = await publishNotificationDurable({
      orgId:     t.vehicle.organisationId,
      id:        `fuel-drain-${t.vehicleId}-${t.id}`,
      source:    'wialon',
      alertType: 'fuelInconsistency',
      // A siphon is the only one we are prepared to call theft, so it is the
      // only one that arrives as critical on its own merits.
      //
      // A REPEAT is the other route to critical, and it is the point of
      // counting: one unexplained drop on a machine is a reading, the fourth in
      // a fortnight is a pattern, and the operator should not have to notice
      // that themselves by scrolling the feed. Third and beyond, because a
      // second event is a coincidence often enough to be worth staying quiet
      // about — of the five repeat vehicles measured, two stopped at two.
      severity:  cause.cause === 'SIPHON' || history.totalCount >= 3 ? 'critical' : 'warning',
      text:      `${headline}${repeat}`,
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