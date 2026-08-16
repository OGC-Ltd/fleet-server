/**
 * WHY did the fuel leave — burn, slosh, settling, or removal?
 *
 * `fuel-adjudication` answers a different question and answers it first: did
 * the fuel actually leave the tank, or did the level come back? By the time a
 * drain reaches here it is already a `DRAIN` — the level fell and stayed down,
 * on a probe the recovery test did not disprove. This module asks what happened
 * to it.
 *
 * Pure: no clock, no database. The evidence is gathered by
 * `fuel-adjudication.service` and the shape arithmetic lives in
 * `fuel-drop-shape`, which the measurement harness shares so that thresholds
 * are chosen against exactly the code that will apply them.
 *
 * ## Burn rate is the primary rule, and that was a measured decision
 *
 * The original design put the weight on SHAPE — a siphon draws fuel at a
 * steady rate, a tank settling on a slope decays — and on ENGINE STATE, with
 * theft only ever claimed on a machine that was switched off. Measured over
 * 2,267 drains across 30 days (2026-08-16), neither survived:
 *
 *   · **The parked population is 0.9% of the ledger.** Of 1,407 measurable
 *     drains, 708 (50.3%) have no ignition reading at all, 534 moved during
 *     the fall, 113 were running — and just 21 were provably stopped. A rule
 *     that only fires on a parked machine fires on almost nothing: three
 *     alerts in thirty days, against 1,407 today. That is not a filter, it is
 *     near-blindness.
 *
 *   · **Shape barely separates anything.** Across every existing verdict
 *     reason, `kT` sits at 0.58-0.69 and the half-slope ratio at 0.77-1.03.
 *     The linear-versus-decay split the design predicted is not visible.
 *
 *   · **Step fraction runs the WRONG WAY.** The hypothesis was that a sharp
 *     one-interval drop meant siphoning. The only external check available
 *     says the opposite: CONFIRMED drains (`level-stayed-down`) are the
 *     LEAST steppy at 0.25, while the distrusted `probe-swings` population
 *     reads 0.42 and `filling-too-soon` 0.55 — and those carry drops 2.4x
 *     larger. On this fleet a step is the signature of a bad probe, not a
 *     thief. Gating theft on it would have selected precisely the events the
 *     trust gate already withdraws confidence from.
 *
 * What does separate is the burn rate. Implied litres-per-engine-hour over the
 * machine's own expected rate spans 1.23 at p10 to 147 at p99, and it is the
 * one measure with real spread. So the operator's instruction (2026-08-16) is
 * that a drop far above what the machine could plausibly have burned is the
 * primary signal, whatever the engine was doing, with the provably-parked case
 * kept as a higher-severity subset.
 *
 * ## What this module refuses to do
 *
 * It never says where the fuel went. `UNEXPLAINED_BURN` means the tank fell by
 * more than this machine's consumption accounts for — it does not mean theft,
 * and the wording downstream must not imply it. Only `SIPHON`, which requires
 * the engine to have been provably off and the fall to be neither settling nor
 * a probe step, is announced with the operator's agreed phrase. That split is
 * the whole reason there are two causes rather than one.
 */

import { lerp, probeSwings, type ProbeProfile } from './fuel-adjudication.js'
import type { DropEvidence } from './fuel-drop-shape.js'

export type { DropEvidence }

/**
 * What happened to the fuel, once we know it left.
 *
 * Deliberately NOT merged into `Verdict`. That enum answers "did the fuel
 * leave", is written on 3,300 historical rows, and is read by the analytics,
 * the reports, the AI insight and the dashboard chips. A second question needs
 * a second field, or every consumer silently changes meaning.
 */
export type DrainCause =
  /** Consistent with what this machine burns. Not an incident. */
  | 'ENGINE_BURN'
  /** Above the expected band, below the alerting multiple. Silent by decision. */
  | 'HIGH_BURN'
  /** Far above anything the machine's own consumption explains. Announced. */
  | 'UNEXPLAINED_BURN'
  /** Engine provably off, sustained, not settling, not a probe step. Announced. */
  | 'SIPHON'
  /** A rate no engine could burn and no pump could draw — the reading, not the tank. */
  | 'SLOSH'
  /** Parked, and the fall decays like liquid finding its level. */
  | 'SETTLING'
  /** Not enough evidence to say. The default, and by far the most common. */
  | 'INDETERMINATE'

export interface CauseJudgement {
  cause:      DrainCause
  /** Short slug naming the rule that decided, for auditing. */
  reason:     string
  /** How sure we are of the CAUSE, 0-1. Never read by this module's own gates. */
  confidence: number
  /** Litres per engine-hour the fall implies, where engine time allowed it. */
  impliedLph: number | null
}

/** Only these reach an operator. Everything else lands silently on the ledger. */
const ANNOUNCED: ReadonlySet<DrainCause> = new Set<DrainCause>(['UNEXPLAINED_BURN', 'SIPHON'])

/** Does this cause put something in front of a human? */
export const isAnnounced = (c: DrainCause): boolean => ANNOUNCED.has(c)

/**
 * Only a `SIPHON` may be described to an operator with the word "theft", and
 * only qualified — *"when we have determined that truly it was a theft then we
 * need to use the word possible theft"* (operator, 2026-08-16).
 *
 * `UNEXPLAINED_BURN` deliberately does NOT qualify. It says the tank fell by
 * more than consumption explains, which is a real finding and a different one:
 * a leak, a mis-calibrated probe and a wrong expected rate all produce it, and
 * so does theft. Naming it theft would decide that question for the reader —
 * the exact failure the `LOSS` verdict was removed for.
 */
export const mayUseTheftWording = (c: DrainCause): boolean => c === 'SIPHON'

// ─── the expected band ─────────────────────────────────────────────────────

/** Where a machine's expected consumption came from. */
export type BandSource = 'operator' | 'vehicle' | 'type'

/**
 * What this machine is expected to burn, per engine-hour.
 *
 * A BAND, not a figure, because the thing being tested is whether a drop is
 * explicable — and a single number makes every drop above it inexplicable by a
 * millilitre. The upper edge is what the ratio is measured against.
 */
export interface BurnBand {
  lowLph:  number
  highLph: number
  source:  BandSource
}

/**
 * A machine class, in the terms the operator actually reasons about.
 *
 * NOT `vehicles.vehicleType`, and the difference is the whole reason this
 * exists. That column holds TRACTOR, PLANT, TRUCK — labels that say what a
 * machine is FOR and nothing about how big it is. Measured 2026-08-16, KASULU's
 * `TRACTOR` label spans tanks from 84 L to 1,631 L and derived rates from 1.6
 * to 28.3 L/h, and its median of 4.32 L/h was being applied to every one of
 * them. Two machines in that group — `MUFINDI - CTR 10` and `CTR 03`, both
 * working normally at 50-110 L/h — produced 64% of every alert the classifier
 * raised over thirty days. The label was the bug.
 */
export type MachineClass =
  | 'TRACTOR_SMALL'   | 'TRACTOR_MEDIUM'   | 'TRACTOR_LARGE'
  | 'EXCAVATOR_MINI'  | 'EXCAVATOR_MEDIUM' | 'EXCAVATOR_LARGE'
  // Dozers are per MODEL, not per size class — the operator's point, and the
  // figures bear it out: a D6 and a D11 differ more than fourfold.
  | 'DOZER_CAT_D6'    | 'DOZER_CAT_D7'     | 'DOZER_CAT_D8T'
  | 'DOZER_CAT_D9'    | 'DOZER_CAT_D10'    | 'DOZER_CAT_D11'
  | 'DOZER_KOMATSU_D85' | 'DOZER_KOMATSU_D155A'

/**
 * Litres per engine-hour by class, as supplied by the operator 2026-08-16.
 *
 * Their figures verbatim, with the sizing they gave:
 *
 *   Tractors    20-50 HP        2 - 4 L/h   light work or idle
 *               60-100 HP       5 - 12      ploughing or tilling
 *               150-300+ HP    18 - 45+     heavy field operations
 *   Excavators  1-6 ton         2 - 4
 *               10-20 ton       5 - 12
 *               20-30+ ton     15 - 25
 *
 * These are DATA, not estimates of ours, and they are not to be adjusted to fit
 * the fleet's measured rates. Where the two disagree, that disagreement is the
 * finding — see `docs/fuel-theft-discrimination-plan.md`.
 *
 * The open half of this is not the numbers but WHICH MACHINE IS WHICH CLASS:
 * the database holds no horsepower and no operating weight, so nothing here can
 * derive a size. See `MACHINE_CLASS`.
 *
 * Dozers are given per MODEL, at the operator's insistence and with the data to
 * back it: *"Fuel use varies significantly by model, not just by broad size
 * class"*. A Cat D6 at 14-22 L/h and a D11 at 59-97 are both "a dozer", and a
 * band covering both would be useless for either.
 *
 * The manufacturer figures are quoted low/medium/HIGH LOAD, so each band spans
 * the low-load floor to the high-load ceiling — a machine legitimately works
 * across that whole range during a shift, and a band narrower than the
 * manufacturer's own load envelope would flag ordinary heavy work.
 */
export const CLASS_BANDS: ReadonlyMap<MachineClass, { lowLph: number; highLph: number }> = new Map([
  ['TRACTOR_SMALL',        { lowLph:  2, highLph:  4 }],
  ['TRACTOR_MEDIUM',       { lowLph:  5, highLph: 12 }],
  ['TRACTOR_LARGE',        { lowLph: 18, highLph: 45 }],
  ['EXCAVATOR_MINI',       { lowLph:  2, highLph:  4 }],
  ['EXCAVATOR_MEDIUM',     { lowLph:  5, highLph: 12 }],
  ['EXCAVATOR_LARGE',      { lowLph: 15, highLph: 25 }],
  // Caterpillar, low load → high load.
  ['DOZER_CAT_D6',         { lowLph: 14, highLph: 22 }],
  ['DOZER_CAT_D7',         { lowLph: 17, highLph: 27 }],
  ['DOZER_CAT_D8T',        { lowLph: 25, highLph: 40 }],
  ['DOZER_CAT_D9',         { lowLph: 30, highLph: 49 }],
  ['DOZER_CAT_D10',        { lowLph: 43, highLph: 71 }],
  ['DOZER_CAT_D11',        { lowLph: 59, highLph: 97 }],
  // Komatsu.
  ['DOZER_KOMATSU_D85',    { lowLph: 10, highLph: 29 }],
  ['DOZER_KOMATSU_D155A',  { lowLph: 13, highLph: 38 }],
])

/**
 * Which machines belong to which class, keyed `ORG:PREFIX`.
 *
 * The prefix is the operator's own naming — `MUFINDI - CTR 10` is `CTR`,
 * `MUFINDI: EX 26` is `EX` — and it groups the fleet far better than
 * `vehicleType` does. Measured by group (n, tank range, derived L/h):
 *
 *   KASULU EX     32   320-665 L    7-14 L/h    excavators
 *   KASULU MTR    20    83- 90 L    2- 5        small tractors
 *   KASULU CTR    18    84-1631 L   8-28        spans two sizes at least
 *   KASULU DZ     12   640    L    28           dozers
 *   KASULU WL      8   304    L     7-13        wheel loaders
 *   KASULU GR      5   395    L    10           graders
 *
 * EMPTY, deliberately, and it must stay empty until the operator confirms it.
 * The mapping is a 10x decision on the denominator of a live alert — placing a
 * CTR in TRACTOR_SMALL rather than TRACTOR_LARGE moves its band from 4 L/h to
 * 45 — and nothing in the data settles it. Tank capacity is the obvious proxy
 * and is not a safe one: it disagrees with the probe on 180 of 299 units, and
 * within `CTR` it ranges 84 L to 1,631 L, so the group is not even internally
 * consistent.
 *
 * DZ, WL, GR, BH and the trucks have no band at all in the operator's figures,
 * which cover tractors and excavators only. They fall back to their derived
 * rate until someone supplies one.
 */
export const MACHINE_CLASS: ReadonlyMap<string, MachineClass> = new Map()

/** `ORG:PREFIX`, the key `MACHINE_CLASS` is written in. */
export const classKey = (orgCode: string, plate: string): string =>
  `${orgCode.toUpperCase()}:${machinePrefix(plate)}`

/**
 * The operator's machine-family prefix, from a plate.
 *
 * `MUFINDI - CTR 10` and `MUFINDI: EX 26` both carry an estate name, a
 * separator that is sometimes a dash and sometimes a colon, then the family.
 * SUKARI plates are ordinary registrations (`KTCB 295U`) with no family in
 * them, so they yield the leading letters and simply will not match an entry
 * in `MACHINE_CLASS` — which is correct, since SUKARI's fleet is not organised
 * this way.
 */
export function machinePrefix(plate: string): string {
  const afterEstate = plate.replace(/^[A-Z]+\s*[-:]\s*/i, '')
  return (afterEstate.match(/^([A-Z]+)/i)?.[1] ?? '').toUpperCase()
}

/**
 * Resolve the band for one machine: the operator's class band first, then its
 * own derived rate, then nothing.
 *
 * The class band is primary because the derived rates are measurably biased
 * low. `fuel-rate.service` excludes any run containing a `fuel_thefts` row from
 * its derivation — correctly, so a drain cannot calibrate the expectation it
 * will later be compared against — but the consequence is that the rates
 * describe only the quiet periods. Over 475 running drains the implied rate
 * exceeds the derived expectation at EVERY percentile, p10 included at 1.23x.
 * A gate built on the derived rate alone calls the fleet's ordinary behaviour
 * "above expected".
 *
 * A derived rate is a point estimate, so it is widened into a band rather than
 * used as an edge. Returns null when nothing is known, and the caller must then
 * reach `INDETERMINATE`: a machine whose consumption we cannot state is one
 * whose drop we cannot attribute to consumption.
 */
export const DERIVED_BAND_SPREAD = 1.5

export function resolveBand(
  orgCode: string,
  plate: string,
  derived: { lPerHour: number; basis: 'vehicle' | 'type' } | null,
): BurnBand | null {
  const cls = MACHINE_CLASS.get(classKey(orgCode, plate))
  const band = cls != null ? CLASS_BANDS.get(cls) : undefined
  if (band) return { ...band, source: 'operator' }
  if (derived == null || !(derived.lPerHour > 0)) return null
  return {
    lowLph:  derived.lPerHour,
    highLph: derived.lPerHour * DERIVED_BAND_SPREAD,
    source:  derived.basis,
  }
}

// ─── thresholds ────────────────────────────────────────────────────────────

/**
 * How far above the band's upper edge a drop must sit before it is announced.
 *
 * PROVISIONAL — to be set from §8 of the measurement harness
 * (`prisma/fuel-cause-measure.ts`), which reports alert volume at each
 * multiple. It is written here as a named constant so the grid has something
 * to replace rather than a number buried in a branch.
 *
 * The shape of the decision is already known from the 30-day distribution of
 * implied-over-expected: p50 2.13, p75 3.84, p90 18.15, p99 147. So the choice
 * is between roughly "a quarter of running drains" and "a tenth", and it is an
 * ALERT VOLUME decision rather than an accuracy one — there is no ground truth
 * for theft on this ledger, so nothing here can be tuned for precision, and
 * pretending otherwise would be the fabrication this project has been careful
 * to avoid elsewhere.
 */
export const ANNOUNCE_MULTIPLE = 4

/**
 * Above this the reading is not describing fuel leaving a tank at all.
 *
 * Grounded in physics rather than in the ledger: a siphon or a transfer pump
 * moves fuel at some tens of litres per hour, and a hose big enough to beat
 * this figure is not something anyone empties a parked machine with. A drop
 * implying more is a probe artifact — the same population `SLOSH` names.
 *
 * This is the one gate that must sit ABOVE the announcing multiple: without it
 * the most extreme sensor faults on the fleet would be the loudest alerts.
 * p99 of implied burn is 858 L/h, which is what it is guarding against.
 */
export const MAX_PLAUSIBLE_REMOVAL_LPH = 300

/**
 * Engine seconds a fall needs before an implied rate means anything.
 *
 * A rate is a quotient, and a small denominator makes it arbitrary: twelve
 * seconds of engine time under a 40 L drop implies 12,000 L/h and says nothing
 * except that the fall was not mostly engine-on. Below this the burn branch is
 * skipped and the parked branch decides.
 */
export const MIN_ENGINE_SECONDS = 120

/**
 * Share of a fall's readings that must carry a MEASURED ignition before the
 * engine state is treated as known.
 *
 * `vehicle_telemetries.engine_on` is NOT NULL with a default of false, and the
 * Wialon adapter fills it as `ignition ?? (speed > 0)` — so on a unit that
 * reports no ignition the column is a restatement of whether the vehicle
 * MOVED, and "engine off and stationary" becomes true of every parked machine
 * by construction. The caller must pass the share derived from
 * `ignition_known`, never from `engine_on`.
 *
 * Half the ledger fails this and is accepted as a blind spot (operator,
 * 2026-08-16): those drains can reach `UNEXPLAINED_BURN` on rate alone, but
 * never `SIPHON`.
 */
export const MIN_ENGINE_EVIDENCE = 0.5

/**
 * Least a parked fall must drop before it is worth a verdict.
 *
 * Guards thermal contraction — diesel cooling overnight genuinely lowers the
 * level — and ordinary probe drift. Deliberately a flat volume rather than a
 * share of tank capacity, which is the form the original outline proposed:
 * `vehicles.tankCapacityLitres` disagrees with the probe on 180 of 299 units,
 * so a percentage-of-tank floor would be computed against a denominator known
 * to be wrong. See the probe trust gate's note in `fuel-adjudication`.
 */
export const SIPHON_MIN_DROP_ML = 15_000

/** Least a parked fall must sustain, in litres per wall-clock hour. */
export const SIPHON_MIN_LPH = 5

/** Shortest parked fall that can be called sustained. */
export const SIPHON_MIN_SECONDS = 10 * 60

/**
 * Above this share of the drop landing in one interval, the fall is a STEP and
 * cannot support a siphon verdict.
 *
 * The inverse of the original hypothesis, and the measurement is why. Confirmed
 * drains are the least steppy population on the ledger (p50 0.25) while the
 * distrusted-probe population is the steppiest (0.42) — so on this fleet a step
 * indicates the instrument, not a thief. A siphon is a person with a hose, and
 * that takes minutes; it does not empty a tank between two consecutive pings.
 */
export const SIPHON_MAX_STEP_FRACTION = 0.6

/** `kT` at or above which a parked fall is settling rather than being drawn off. */
export const SETTLING_MIN_KT = 1.0
/** ...and how well the decay must fit, as a share of the drop, to be believed. */
export const SETTLING_MAX_RESIDUAL = 0.05

/**
 * Judge one drain's cause.
 *
 * Gate order is deliberate and each gate is a reason to STOP asking:
 *
 *   1. an instrument we do not trust ends the enquiry
 *   2. a machine whose consumption we cannot state ends it too
 *   3. a rate no pump could produce is the reading, not the tank
 *   4. with engine time, the burn comparison decides — the primary rule
 *   5. with the engine provably off, the parked rules decide
 *   6. otherwise we do not know, and say so
 */
export function classifyDrain(
  ev: DropEvidence,
  band: BurnBand | null,
  profile: ProbeProfile | null,
): CauseJudgement {
  const none = { impliedLph: null }

  // 1. The probe trust gate, reused rather than re-derived. A probe that moves
  //    25 L on a standing machine cannot support any statement about why the
  //    level fell — including a reassuring one, which is why this returns
  //    INDETERMINATE and not ENGINE_BURN.
  if (probeSwings(profile)) {
    return { cause: 'INDETERMINATE', reason: 'probe-swings', confidence: 0.5, ...none }
  }

  // 2. No expectation to compare against.
  if (band == null) {
    return { cause: 'INDETERMINATE', reason: 'no-expected-rate', confidence: 0.5, ...none }
  }

  const dropL      = ev.dropMl / 1000
  const hasEngine  = ev.engineSeconds >= MIN_ENGINE_SECONDS
  const impliedLph = hasEngine ? dropL / (ev.engineSeconds / 3600) : null
  const wallLph    = ev.fallSeconds > 0 ? dropL / (ev.fallSeconds / 3600) : 0

  // 3. Not physically removable, however it happened. Tested against the
  //    WALL-CLOCK rate as well, so a fall with little engine time cannot slip
  //    past by having no implied rate to test.
  if (wallLph > MAX_PLAUSIBLE_REMOVAL_LPH || (impliedLph != null && impliedLph > MAX_PLAUSIBLE_REMOVAL_LPH)) {
    return { cause: 'SLOSH', reason: 'rate-not-physical', confidence: 0.8, impliedLph }
  }

  // 4. THE PRIMARY RULE.
  if (impliedLph != null) {
    const ratio = impliedLph / band.highLph
    if (ratio >= ANNOUNCE_MULTIPLE) {
      // Graded from the announcing edge upward. A drop at exactly the multiple
      // is the weakest case this branch produces, which is the same reasoning
      // `adjudicateDrain` applies around RECOVERY_THRESHOLD.
      return {
        cause: 'UNEXPLAINED_BURN', reason: 'burn-far-above-band', impliedLph,
        confidence: lerp(ratio, ANNOUNCE_MULTIPLE, ANNOUNCE_MULTIPLE * 4, 0.55, 0.9),
      }
    }
    if (ratio >= 1) {
      return {
        cause: 'HIGH_BURN', reason: 'burn-above-band', impliedLph,
        confidence: lerp(ratio, 1, ANNOUNCE_MULTIPLE, 0.5, 0.8),
      }
    }
    return {
      cause: 'ENGINE_BURN', reason: 'burn-within-band', impliedLph,
      confidence: lerp(ratio, 1, 0, 0.55, 0.9),
    }
  }

  // 5. The parked branch — the only route to SIPHON.
  const parked = ev.engineEvidence >= MIN_ENGINE_EVIDENCE && !ev.moved
  if (parked) {
    if (ev.dropMl < SIPHON_MIN_DROP_ML || wallLph < SIPHON_MIN_LPH || ev.fallSeconds < SIPHON_MIN_SECONDS) {
      // Below the noise floor: thermal contraction and drift live here.
      return { cause: 'INDETERMINATE', reason: 'below-parked-floor', confidence: 0.5, ...none }
    }
    if (ev.kT != null && ev.kT >= SETTLING_MIN_KT &&
        ev.decayResidual != null && ev.decayResidual <= SETTLING_MAX_RESIDUAL) {
      return { cause: 'SETTLING', reason: 'decay-shaped', confidence: 0.7, ...none }
    }
    if (ev.stepFraction > SIPHON_MAX_STEP_FRACTION) {
      // A step is the instrument, not a hose — see SIPHON_MAX_STEP_FRACTION.
      return { cause: 'INDETERMINATE', reason: 'step-shaped', confidence: 0.5, ...none }
    }
    return {
      cause: 'SIPHON', reason: 'parked-sustained-fall', impliedLph: null,
      confidence: lerp(wallLph, SIPHON_MIN_LPH, SIPHON_MIN_LPH * 8, 0.55, 0.9),
    }
  }

  // 6. Engine state unknown and no engine time to reason from. Half the ledger
  //    lands here, and it is accepted as a blind spot rather than papered over.
  return { cause: 'INDETERMINATE', reason: 'engine-state-unknown', confidence: 0.5, ...none }
}
