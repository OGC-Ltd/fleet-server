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
 * It never says where the fuel went, and since 2026-08-17 it announces only
 * one thing: `SIPHON`, where the engine was provably off and the fall was
 * sustained, neither settling nor a probe step.
 *
 * `UNEXPLAINED_BURN` is still computed and stored — it is a real measurement
 * against a stated expectation — but it reaches nobody. It described OUR
 * inability to account for a drop rather than the fuel's behaviour, and on a
 * fleet where most machines have no band that is a statement about our
 * reference data wearing the costume of a finding. See ANNOUNCED.
 */

import { lerp, probeSwings, probeOverreads, type ProbeProfile } from './fuel-adjudication.js'
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
  /**
   * Far above anything the machine's own consumption explains. STORED, and
   * not announced — see ANNOUNCED for why the operator withdrew it.
   */
  | 'UNEXPLAINED_BURN'
  /** Engine provably off, sustained, not settling, not a probe step. Announced. */
  | 'SIPHON'
  /** A rate no engine could burn and no pump could draw — the reading, not the tank. */
  | 'SLOSH'
  /** Parked, and the fall decays like liquid finding its level. */
  | 'SETTLING'
  /** Not enough evidence to say. The default, and by far the most common. */
  | 'INDETERMINATE'

/**
 * Causes where the fuel did NOT leave the tank, whatever the verdict says.
 *
 * `NO_FUEL_LEFT` in fuel-adjudication does the same job one level up, on the
 * VERDICT — a drop that turned out to be a refill, an oscillating probe, a dead
 * sensor. This is the level below it: a row can be judged DRAIN, because the
 * level really did fall and stay down, and still be a reading rather than a
 * loss once the shape of the fall is examined.
 *
 * Both members are cases where the tank is the same afterwards:
 *
 *  · `SLOSH` — "a rate no engine could burn and no pump could draw". Fuel
 *    moving inside the tank, or a probe inventing the movement.
 *  · `SETTLING` — the fall decays like liquid finding its level after a stop.
 *
 * Measured over 30 days: 54 slosh rows carrying 3,571 L sat inside a
 * "litres lost" figure of 217,608 L. Not the largest error in that number, but
 * the one that is provably not fuel at all.
 *
 * `ENGINE_BURN` is NOT here, by the operator's decision on 2026-08-28: engine
 * burn is part of the fuel drain. That fuel did leave the tank — the engine
 * burned it doing its job — and this figure counts fuel that left, not fuel
 * that was taken. It is 17,104 L over the same window, five times the slosh
 * this list removes, so the question was put and answered rather than settled
 * by widening a filter.
 *
 * And `INDETERMINATE` is not here either, nor an unjudged null, for the reason
 * `NO_FUEL_LEFT` gives: we remove what we can DISPROVE, not what we merely
 * doubt. A fall nobody could explain is not thereby explained away.
 */
export const CAUSE_NO_FUEL_LEFT: readonly DrainCause[] = ['SLOSH', 'SETTLING']

export interface CauseJudgement {
  cause:      DrainCause
  /** Short slug naming the rule that decided, for auditing. */
  reason:     string
  /** How sure we are of the CAUSE, 0-1. Never read by this module's own gates. */
  confidence: number
  /** Litres per engine-hour the fall implies, where engine time allowed it. */
  impliedLph: number | null
}

/**
 * Only these reach an operator. Everything else lands silently on the ledger.
 *
 * ## Why UNEXPLAINED_BURN is not in this set
 *
 * It was, for a few hours on 2026-08-17, and the operator withdrew it — not
 * over the wording but over the idea. The name described OUR failure to
 * account for a drop rather than anything that happened to the fuel, which is
 * the exact defect that got `UNVERIFIED` deleted from the verdict enum: *"not
 * a description of the fuel at all — a description of OUR evidence, promoted
 * to a verdict."*
 *
 * `MUFINDI - DG 13` is what made it concrete. It is a generator: moving in
 * 0.95% of readings over 14.6 days, engine on 85.9% of the time, a 1,696 L
 * tank refuelled 710-1,488 L every day or two, burning a steady 40-50 L/h.
 * Nothing about its consumption is unexplained. It reads that way only because
 * it has no band — `vehicleType` is UNSPECIFIED and its derived rate is
 * 13.23 L/h from two runs, against an actual 40-50. Announcing that would tell
 * an operator a machine is behaving abnormally when the abnormality is a hole
 * in OUR reference data.
 *
 * And while MACHINE_CLASS covers four KASULU prefixes, that is the common case
 * rather than the rare one: SUKARI's 482 tractors and 19 dozers have no class
 * at all.
 *
 * So the tier stays COMPUTED and STORED — it is real, it is visible in the
 * fuel tables, and it is what the bands will eventually be judged against —
 * but it says nothing to anyone until a machine's expected rate is something
 * we can stand behind. Put it back in this set when the class table is
 * populated, and the replay will say what it costs.
 */
const ANNOUNCED: ReadonlySet<DrainCause> = new Set<DrainCause>(['SIPHON'])

/**
 * The one burn finding that IS announced, identified by its rule rather than
 * its cause.
 *
 * `UNEXPLAINED_BURN` was withdrawn because on a machine with no trustworthy
 * band it names our missing reference data. That objection does not apply
 * where the OPERATOR set the line: `burn-above-class-ceiling` can only be
 * reached through `CLASS_CEILING_LPH`, and a ceiling exists only for a class
 * someone has actually specified. So the reason slug is already a reliable
 * marker for "a human said what this machine should burn, and it exceeded it"
 * — no new field needed, and nothing to keep in step.
 *
 * This is what gives generators a route to a theft finding at all. They can
 * never reach SIPHON: that branch requires the engine provably off, and a
 * generator's engine is on 87-96% of the time. Without this they are the
 * largest tanks on the fleet with no detection of any kind.
 */
const ANNOUNCED_REASONS: ReadonlySet<string> = new Set([
  // Heavy machinery, against a band a human specified.
  'burn-above-class-ceiling',
  // Heavy machinery on its own or its type's DERIVED rate. This is the tier
  // the operator withdrew on 2026-08-17 and restored the same day once every
  // category needed covering. The objection was real and is answered two ways
  // rather than by ignoring it: the machines that produced nonsense derived
  // bands are now CLASSED (EX, CTR, MTR, HYD, DG), and the wording no longer
  // claims the drop is "unexplained" — it states the measured rate against
  // the expected one and lets a reader judge. 26 events over 30 days.
  'burn-far-above-band',
  // Regular vehicles, against their OWN measured kilometres per litre — not a
  // type median, and only above ROAD_MIN_KM_PER_L. That is a per-vehicle
  // baseline, so it never had the "this names our missing reference data"
  // problem the L/h bands had.
  'drop-exceeds-distance',
  'drop-while-stationary',
])

/**
 * Does this judgement reach an operator?
 *
 * Takes the whole judgement rather than the cause alone, because since
 * 2026-08-17 announceability is not a property of the cause: the same
 * UNEXPLAINED_BURN is silent on a derived band and announced on an
 * operator-set ceiling.
 */
export const announces = (j: Pick<CauseJudgement, 'cause' | 'reason'>): boolean =>
  ANNOUNCED.has(j.cause) || ANNOUNCED_REASONS.has(j.reason)

/**
 * The causes that reach an operator, for callers that need them in a query.
 *
 * Exported so the fleet snapshot's red-vehicle lookup selects on the SAME set
 * this module announces on, rather than a second hardcoded list that can drift
 * from it — which is precisely what happened here: the snapshot query named
 * `('SIPHON', 'UNEXPLAINED_BURN')` inline, so withdrawing one from the feed
 * would have left vehicles going red for it anyway.
 */
export const ANNOUNCED_CAUSES: readonly DrainCause[] = [...ANNOUNCED]

/**
 * Reason slugs the snapshot's red-vehicle lookup must also match, for the same
 * no-second-list reason as ANNOUNCED_CAUSES.
 */
export const ANNOUNCED_REASON_SLUGS: readonly string[] = [...ANNOUNCED_REASONS]

/** Does this cause put something in front of a human? */
export const isAnnounced = (c: DrainCause): boolean => ANNOUNCED.has(c)

/**
 * Only a `SIPHON` may be described to an operator with the word "theft", and
 * only qualified — *"when we have determined that truly it was a theft then we
 * need to use the word possible theft"* (operator, 2026-08-16).
 *
 * Nothing else qualifies. `UNEXPLAINED_BURN` does not reach an operator at all
 * now, but the rule is kept rather than collapsed into "always theft": the
 * moment a second cause is announced, the wording question returns, and a
 * guard that only holds while the set has one member is not a guard.
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
  /**
   * Absolute L/h at which this class is announced, where the operator has
   * given one — see CLASS_CEILING_LPH. Undefined means "no ceiling supplied",
   * and the band's multiple decides instead.
   */
  ceilingLph?: number
  /**
   * Kilometres per litre this vehicle actually achieves, for units that are
   * NOT heavy machinery.
   *
   * The operator's instruction, 2026-08-16: heavy machinery is judged on L/h,
   * and *"if a unit is not heavy machinery"* it is judged on distance against
   * its own measured baseline. Derived from `vehicle_fuel_rates.lPerKm`, which
   * is already measured per vehicle over engine-on runs — NOT from the flat
   * `KM_PER_LITRE = 2` the daily panel uses, which the operator explicitly
   * said not to trust ("Do not use the app's calculated Expected column").
   */
  kmPerL?: number
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
   * A dozer smaller than anything in the operator's model table. `MUFINDI - DZ
   * 02` and `DZ 03` run 450-455 L tanks at 5.6-12.9 L/h median, below even a
   * Cat D6's 14-22. Measured, not assumed — see CLASS_BY_TANK.
   */
  | 'DOZER_SMALL'
  /**
   * A generator, or anything else that runs its engine hard while standing
   * still — pumps, crushers. Its own category because distance means nothing
   * to it and, unlike every other class here, it is almost never engine-off.
   */
  | 'GENERATOR'

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
  /**
   * Generators, one band for all of them at the operator's instruction
   * (2026-08-17), around their stated 45 L/h.
   *
   * The upper edge is 95 rather than anything near 45 because a shared band
   * has to cover the spread of the machines sharing it. Measured over 14 days
   * on the three units that actually behave like generators — moving in 0.0%
   * of readings, engine on 87-96% — the hourly burn is:
   *
   *   MUFINDI - DG 12   p10 51.3   p50 71.3   p90 94.6   (1,696 L tank)
   *   MUFINDI - DG 13   p10 36.6   p50 49.5   p90 61.1   (1,696 L tank)
   *   KHMA 449U         p10 22.4   p50 45.2   p90 90.0   (  520 L tank)
   *
   * So 45 L/h is a fair centre for DG 13 and KHMA 449U and badly low for DG
   * 12, which runs half again as much on an identical tank. A band ending at
   * 45 would have flagged DG 12's ordinary operation continuously — the same
   * mistake the CTR crawlers taught, one class over.
   *
   * The spread is also wider than a generator's steady reputation suggests:
   * 1.7x from p10 to p90 on DG 13 over 154 measured hours, 4x on KHMA 449U.
   * That is load, and it is why the ALERTING line is a ceiling well above p90
   * rather than a multiple of this band — see CLASS_CEILING_LPH.
   */
  ['GENERATOR',            { lowLph: 35, highLph: 95 }],
  /**
   * The small dozers, from their own 21 days rather than a manufacturer sheet,
   * because no band in the operator's table goes low enough:
   *
   *   MUFINDI - DZ 02   450 L   p50 12.9   p90 19.4
   *   MUFINDI: DZ 03    455 L   p50  5.6   p90 15.0
   *
   * 5-20 spans both machines' ordinary hours and stops just above the worse
   * p90. Only two contributors, so it is the weakest band here and should be
   * revisited when either has more history.
   */
  ['DOZER_SMALL',          { lowLph:  5, highLph: 20 }],
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
export const MACHINE_CLASS: ReadonlyMap<string, MachineClass> = new Map([
  ['KASULU:EX',  'EXCAVATOR_LARGE'],
  // CTR was briefly given the same band as EX, on the operator's "EX AND CTR
  // can use the same band". Measured per machine, they are not alike: the
  // implied rate of an EX drain runs 17-30 L/h, and a CTR drain 46-111.
  //
  //   MUFINDI: CTR 23   n=78   p10 46  p50  70  p90 111   tank 1,631 L
  //   MUFINDI - CTR 10  n=36   p10 41  p50  74  p90 235   tank 1,082 L
  //   MUFINDI - CTR 03  n=41   p10 58  p50  99  p90 635   tank   760 L
  //   MUFINDI: EX 17    n=27   p10 17  p50  23  p90  30   tank   320-665 L
  //
  // On the excavator band those three produced 143 of 188 alerts — 76% of
  // everything the classifier raised. On D10 they produce NONE, and the
  // remaining 47 spread across 25 vehicles with no machine above 6. The band
  // is the operator's own, from their dozer table, and the 1,631 L tank is
  // consistent with a D10-class crawler.
  //
  // Note what this is NOT: the ceiling was raised 20 -> 30 first, on the
  // reasoning that CTR 23's DERIVED rate of 28.26 L/h sat just above 20. That
  // was the wrong diagnosis — a derived rate describes a machine's quiet runs,
  // and its drain events are a different population entirely. No ceiling near
  // 30 could have fixed a machine whose events imply 70.
  ['KASULU:CTR', 'DOZER_CAT_D10'],
  // Small tractors, on tanks of 83-90 L and 43 L, measuring 2-5 and 1.6 L/h.
  ['KASULU:MTR', 'TRACTOR_SMALL'],
  ['KASULU:HYD', 'TRACTOR_SMALL'],
  // The generators. Found by BEHAVIOUR rather than trusted from the prefix —
  // moving in 0.0% of readings over 14 days with the engine on 87-89% — and
  // the prefix then used as the durable key.
  ['KASULU:DG',  'GENERATOR'],
])

/**
 * Prefix groups that are NOT one class, split on tank capacity.
 *
 * `KASULU:DZ` covers two plainly different machines. Measured over 21 days of
 * clean engine-hours, with the three overreading probes (DZ 16, DZ 04, DZ 09)
 * set aside because their volumes are not measurements of their tanks:
 *
 *   DZ 13   645 L   p50 40.4   p90 60.3      DZ 02   450 L   p50 12.9   p90 19.4
 *   DZ 14   640 L   p50 34.5   p90 58.1      DZ 03   455 L   p50  5.6   p90 15.0
 *   DZ 05   640 L   p50 32.5   p90 68.6
 *   DZ 20   642 L   p50 30.3   p90 50.5
 *
 * The 640 L group lands at 30-40 L/h, which is `DOZER_CAT_D8T` (25-40) almost
 * exactly — the operator's own figure, arrived at independently. The 450 L
 * pair runs a third of that. One band across both would hold the small
 * machines to three times what they burn, which is the CTR mistake again.
 *
 * ## Tank size is a PROXY and is being used as one
 *
 * The operator's table is per MODEL, and no model is recorded anywhere — not
 * in the database, not in Wialon's custom fields, both checked. Capacity is
 * the only size signal available. It is unreliable as a denominator (it
 * disagrees with the probes on 180 of 299 units) but the split here is 450 vs
 * 640 L, a gap far wider than that error, and it is only being asked which
 * SIDE a machine falls on.
 *
 * Ordered ascending; the first entry whose `maxTankL` the vehicle does not
 * exceed wins.
 */
export const CLASS_BY_TANK: ReadonlyMap<string, ReadonlyArray<{ maxTankL: number; cls: MachineClass }>> = new Map([
  ['KASULU:DZ', [
    { maxTankL: 500,      cls: 'DOZER_SMALL' },
    { maxTankL: Infinity, cls: 'DOZER_CAT_D8T' },
  ]],
])

/**
 * Classes keyed on `ORG:VEHICLE_TYPE`, for fleets whose plates carry no
 * machine family.
 *
 * SUKARI is the case: 482 tractors on ordinary registrations, with nothing in
 * the plate to group them by. Only 32 have earned a derived rate, and those
 * read p10 0.8, p50 5.2, p75 6.9, p90 8.0, max 13.4 L/h on 75-165 L tanks —
 * squarely `TRACTOR_MEDIUM` (5-12).
 *
 * Read that with its sample size attached: 32 machines standing in for 482.
 * It is a reasonable central estimate for the group and a weak claim about any
 * individual tractor, which is why it is a BAND and why the announcing
 * multiple sits well above it.
 */
export const TYPE_CLASS: ReadonlyMap<string, MachineClass> = new Map([
  ['SUKARI:TRACTOR', 'TRACTOR_MEDIUM'],
])

/**
 * Which denominator a machine's fuel should be judged against.
 *
 * `DISTANCE` — litres per kilometre — is the DEFAULT (operator, 2026-08-26).
 * For anything whose work IS travelling, L/km is the figure an operator
 * reconciles against. `HOURS` is the exception, for machines that do their work
 * without travelling — an excavator slewing in place, a generator that never
 * moves, a tractor standing in a field — where a distance denominator is not
 * merely imprecise but zero.
 *
 * `docs/fuel-consumption-rates.md` concluded the opposite ("engine hours is the
 * primary basis for every type"), and it over-generalised: all of its evidence
 * is plant, where it is right, and it was applied to the 95 road units where it
 * is not.
 *
 * ## Why declared TYPE and not measured travel
 *
 * The plan proposed splitting on measured km/L against `ROAD_MIN_KM_PER_L`.
 * Measured 2026-08-26 over 221 vehicles, that no longer works: the docstring's
 * "p25 is 0.07 and p75 is 2.05, with nothing in between" has become p25 1.05,
 * p50 1.70, p75 2.70, and **141 of 221 vehicles now sit inside the gap the
 * threshold was placed in**. Worse, the band mixes categories — `MUFINDI - FTT
 * 01` (LORRY) at 0.84 km/L and `KCX 796S` (TRUCK) at 0.88 would both be sent to
 * an hours basis.
 *
 * km per ENGINE-HOUR is the better measure, because it describes travel without
 * being contaminated by thirst, and it orders the fleet exactly as physics
 * would (7-day medians, 2026-08-26):
 *
 *     PLANT 0.82 · TRACTOR 6.08 · LORRY 7.81 · TRUCK 12.19 · SALOON 22.16
 *
 * But its histogram is continuous — 45, 21, 15, 20, 17, 28, 51, 29, 17, 14, 5
 * across the bands — so there is no empty region to put a threshold in either.
 * What separates cleanly is the TYPE, not any number derived from it, which is
 * why this reads the type and uses measurement only as the evidence behind the
 * mapping rather than as the rule.
 */
export type ConsumptionBasis = 'HOURS' | 'DISTANCE'

/**
 * The types that work without travelling: judged, and reported, in litres per
 * engine-hour. Everything else is judged and reported in **litres per
 * kilometre** — `L/km`, the unit `vehicle_fuel_rates.l_per_km` already stores,
 * not litres per 100 km.
 *
 * The basis governs BOTH reporting and adjudication (operator, 2026-08-26).
 * They are not separable here: a figure an operator reconciles against and the
 * figure a drain is judged against have to be the same one, or the alert and
 * the report disagree about the same machine.
 *
 * ## TRACTOR is here, and it was briefly not
 *
 * Tractors were moved to DISTANCE on 2026-08-26 and moved back the same day.
 * Measured over 30 days, drains over 15 L, share that covered less than 0.5 km
 * during the fall:
 *
 *     TRACTOR          273 of 339   80.5%
 *     TRUCK             76 of  85   89.4%
 *     COMPANY_VEHICLE   66 of  73   90.4%
 *
 * Read those three lines together, because the obvious reading of the first one
 * alone is wrong. Drains happen at rest almost everywhere — a truck is MORE
 * likely to be standing still during one than a tractor is. "Tractors drain
 * while stationary" is therefore not the discriminator, and any rule built on
 * that number as though it were distinctive would be built on a coincidence.
 *
 * What separates them is what standing still MEANS. A tractor at 0 km/h is
 * working, and the fuel is going into the job; a truck at 0 km/h is not, and
 * fuel leaving then is the very signature worth announcing. So the same
 * observation is ordinary on one machine and suspicious on the other, and only
 * the type says which.
 *
 * On a distance basis the tractor cases score ~100% unexplained by
 * construction, land on `drop-while-stationary`, and announce — about nine a
 * day against the ~5/day the whole fleet produces now. The names settle it:
 * `KTCB 295U` is four of the top eight, and is the very vehicle
 * `ROAD_MIN_KM_PER_L` was written to protect, while `MUFINDI: OPTIM - CTR 23`
 * tops the list at 1,160 L across 0.00 km.
 *
 * So the rule is not "things that travel take distance" but "things whose WORK
 * is travelling take distance". A tractor travels between jobs and works
 * standing still; a truck's work IS the kilometres.
 */
const HOURS_TYPES: ReadonlySet<string> = new Set(['PLANT', 'GENERATOR', 'TRACTOR'])

/**
 * Types that state, positively, what the machine IS. Anything in here settles
 * the basis on its own and the class table is not consulted.
 */
const KNOWN_TYPES: ReadonlySet<string> = new Set([
  'PLANT', 'GENERATOR', 'TRACTOR', 'TRUCK', 'LORRY', 'SALOON', 'BUS', 'COMPANY_VEHICLE',
])

/**
 * Classes that mean plant, used ONLY where the type says nothing.
 *
 * This exists for the machines whose class is the only description of them: a
 * generator reaches `GENERATOR` through `MACHINE_CLASS` while carrying
 * `vehicleType = 'UNSPECIFIED'`, and without this it would take the distance
 * default and be judged on kilometres it never covers.
 *
 * It must NOT outrank a stated type, and a test is what proves why.
 * `MUFINDI: CTR 02` is a cane TRACTOR, and `MACHINE_CLASS` maps `KASULU:CTR` to
 * `EXCAVATOR_LARGE` — deliberately, because the operator said "EX AND CTR can
 * use the same band". That mapping is a statement about what the machine BURNS,
 * not about what it is. Consulted first it sent a tractor to an hours basis, in
 * direct contradiction of the instruction that every tractor takes distance.
 *
 * So: type answers "what is it", class answers "what does it burn", and only
 * the first decides the denominator.
 */
const HOURS_CLASSES: ReadonlySet<MachineClass> = new Set<MachineClass>([
  'GENERATOR',
  'EXCAVATOR_MINI', 'EXCAVATOR_MEDIUM', 'EXCAVATOR_LARGE',
  'DOZER_CAT_D6', 'DOZER_CAT_D7', 'DOZER_CAT_D8T', 'DOZER_CAT_D9',
  'DOZER_CAT_D10', 'DOZER_CAT_D11',
  'DOZER_KOMATSU_D85', 'DOZER_KOMATSU_D155A',
])

/**
 * Resolve the basis for one machine. A stated type wins; the class is the
 * fallback for machines the type does not describe; distance is the default.
 */
export function resolveBasis(orgCode: string, m: MachineIdentity): ConsumptionBasis {
  const type = m.vehicleType?.toUpperCase()
  if (type && KNOWN_TYPES.has(type)) return HOURS_TYPES.has(type) ? 'HOURS' : 'DISTANCE'

  const cls = resolveClass(orgCode, m)
  if (cls != null && HOURS_CLASSES.has(cls)) return 'HOURS'
  return 'DISTANCE'
}

/**
 * Which basis applies to ONE event, as opposed to the machine in general.
 *
 * `resolveBasis` answers "what is this machine"; this answers "what was it doing
 * while the fuel left". A truck on the open road is judged per kilometre; the
 * same truck idling in a yard is judged per hour, because that is the denominator
 * that describes what it was actually doing (operator, 2026-08-26).
 *
 * An HOURS machine never switches — an excavator that tracks 2 km across a site
 * has not become a haulier, and its kilometres explain none of its burn.
 */
export function applicableBasis(
  machine: ConsumptionBasis,
  distanceKm: number | null,
): ConsumptionBasis {
  if (machine === 'HOURS') return 'HOURS'
  // Null is not zero: no reading carried a speed, so we cannot say it stood
  // still. Absent evidence falls to hours rather than asserting a distance of 0
  // and calling the whole drop unexplained.
  if (distanceKm == null) return 'HOURS'
  return distanceKm >= OPEN_ROAD_MIN_KM ? 'DISTANCE' : 'HOURS'
}

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

/** What the classifier needs to know about a machine to place it in a class. */
export interface MachineIdentity {
  plate:              string
  vehicleType?:       string | null
  tankCapacityLitres?: number | null
}

/**
 * Which class a machine belongs to, by prefix, then by tank inside a prefix,
 * then by vehicle type. Null when nothing places it.
 */
export function resolveClass(orgCode: string, m: MachineIdentity): MachineClass | null {
  const key = classKey(orgCode, m.plate)

  // A prefix that splits by tank is asked first — it is the more specific
  // statement about the same group.
  const bands = CLASS_BY_TANK.get(key)
  if (bands && m.tankCapacityLitres != null) {
    for (const b of bands) if (m.tankCapacityLitres <= b.maxTankL) return b.cls
  }
  const direct = MACHINE_CLASS.get(key)
  if (direct) return direct

  // ...and the type table last, for fleets whose plates carry no family.
  if (m.vehicleType) return TYPE_CLASS.get(`${orgCode.toUpperCase()}:${m.vehicleType.toUpperCase()}`) ?? null
  return null
}

/**
 * The highest litres-per-hour a DERIVATION may believe for this machine.
 *
 * Distinct from `CLASS_CEILING_LPH`, and the distinction matters. That is an
 * ANNOUNCE ceiling — "a human said this machine should never burn more than
 * this, so tell someone". Using it here would invert it: a generator's ceiling
 * of 120 would admit `MUFINDI - DG 12`'s 110.3 L/h as the machine's own
 * expected rate, and a burn the operator set that number to CATCH would become
 * the baseline it is measured against.
 *
 * So the cap is the class band's upper edge — what the operator says the
 * machine actually burns — with `floor` as a lower bound it can never go below.
 * That makes this strictly LOOSENING: no machine loses a rate it has today, and
 * only the heavy classes gain headroom. Tightening the small classes to their
 * band tops would be a much larger change, stripping rates from machines that
 * currently have them and moving them onto type medians, and nothing has
 * measured what that would do.
 *
 * Measured over 14 days on 2026-08-27, four vehicles exceeded the flat 40 and
 * this resolves each one the way the evidence points:
 *
 * | machine | class | L/h | runs | outcome |
 * | --- | --- | --- | --- | --- |
 * | `MUFINDI: CTR 23` | `DOZER_CAT_D10` (43-71) | 40.6 | 60 | admitted — the fix |
 * | `MUFINDI - DG 12` | `GENERATOR` (35-95) | 110.3 | 9 | still excluded |
 * | `MUFINDI: DZ 09` | `DOZER_CAT_D8T` (25-40) | 45.6 | 2 | still excluded |
 * | `KHMA 449U` | unclassed | 60.8 | 1 | still excluded |
 *
 * DG 12 is the machine the flat cap was introduced for — it derived 109.89 L/h
 * off probe noise on a 1,696 L tank — and it stays excluded, because 110 is
 * above what the operator says a generator burns even though it is under the
 * announce ceiling. That is the case that shows why the two numbers must not be
 * the same number.
 */
export function derivationCapLph(orgCode: string, m: MachineIdentity, floor: number): number {
  const cls = resolveClass(orgCode, m)
  const band = cls != null ? CLASS_BANDS.get(cls) : undefined
  return Math.max(band?.highLph ?? 0, floor)
}

export function resolveBand(
  orgCode: string,
  machine: string | MachineIdentity,
  derived: { lPerHour: number; basis: 'vehicle' | 'type'; lPerKm?: number | null } | null,
): BurnBand | null {
  const m: MachineIdentity = typeof machine === 'string' ? { plate: machine } : machine
  const plate = m.plate
  const cls = resolveClass(orgCode, m)
  const band = cls != null ? CLASS_BANDS.get(cls) : undefined
  if (band && cls != null) {
    const ceiling = CLASS_CEILING_LPH.get(cls)
    return { ...band, source: 'operator', ...(ceiling != null ? { ceilingLph: ceiling } : {}) }
  }
  if (derived == null || !(derived.lPerHour > 0)) return null
  // No machine class SUGGESTS this is not heavy plant — but the class table is
  // incomplete, so the baseline itself has to corroborate it. A machine that
  // travels less than ROAD_MIN_KM_PER_L gets no distance basis and is judged
  // on L/h alone.
  const rawKmPerL = derived.lPerKm != null && derived.lPerKm > 0 ? 1 / derived.lPerKm : null
  const kmPerL = rawKmPerL != null && rawKmPerL >= ROAD_MIN_KM_PER_L ? rawKmPerL : undefined
  return {
    lowLph:  derived.lPerHour,
    highLph: derived.lPerHour * DERIVED_BAND_SPREAD,
    source:  derived.basis,
    ...(kmPerL != null ? { kmPerL } : {}),
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
 * Absolute litres-per-engine-hour above which a class is flagged, regardless
 * of the multiple.
 *
 * The operator's own alerting rule, 2026-08-16: *"If Normalized L/hr > 20 for
 * an excavator, flag for investigation."* It is a better instrument than
 * ANNOUNCE_MULTIPLE for two reasons, and both are about who can reason with it:
 *
 *   · It is a number an operator can state, argue with and change, in the
 *     units they already think in. "Four times the band" requires knowing the
 *     band, which is itself derived, so a multiple compounds one uncertainty
 *     with another.
 *   · It does not move when the band moves. Under the multiple, widening a
 *     class's band to stop nuisance alerts silently raises its alerting
 *     threshold too — the two are the same knob, which is how a band widened
 *     for a good reason quietly blinds the alert.
 *
 * Only the excavator figure was supplied. The rest are LEFT UNSET on purpose:
 * a ceiling invented here becomes the thing that decides whether a machine is
 * investigated, and the whole point of moving to absolute figures is that they
 * come from someone who knows the machines. A class without a ceiling falls
 * back to ANNOUNCE_MULTIPLE against its band, which is the behaviour that
 * shipped.
 *
 * Note this sits BELOW where the multiple would fire for excavators — 4x a
 * 5-12 band is 48 L/h against this 20 — so adopting it makes the alert
 * markedly more sensitive for that class. That is the operator's call and the
 * replay in `prisma/fuel-cause-replay.ts` is how its cost in volume is checked
 * before it ships.
 */
/**
 * Least a road vehicle's drop must be before the distance rule looks at it.
 *
 * The operator's own figure: *"IF (Negative Change > 15 Liters)"*. Below this a
 * drop is inside the noise these probes produce — the 99th-percentile
 * ping-to-ping jump on this fleet is ~5 L.
 */
export const ROAD_MIN_DROP_L = 15

/**
 * Least the UNEXPLAINED remainder must be, after ordinary driving is
 * subtracted, before it is announced. The operator's figure again:
 * *"IF Calculated_Theft > 5 Liters, THEN Flag"*.
 *
 * Their safety check is structural here rather than a separate test — a
 * negative remainder means driving explains more than the tank lost, which is
 * a sensor disagreeing with itself, and it cannot pass a `> 5` comparison.
 */
export const ROAD_MIN_UNEXPLAINED_L = 5

/**
 * Kilometres per litre below which a machine does not travel enough for
 * distance to be a basis for anything.
 *
 * Without this the road rule reaches PLANT. A vehicle with no `MachineClass`
 * falls through to the distance branch, and on this fleet that includes every
 * SUKARI tractor — their plates carry no family prefix, so nothing classifies
 * them — and any excavator whose group is unmapped. Measured over the 33
 * vehicles that have earned their own km/L (2026-08-17), the population is
 * plainly two:
 *
 *   MUFINDI: EX 20   0.02      KDL 208X   1.91
 *   MUFINDI - EX 24  0.03      KDL 705E   2.05
 *   MUFINDI - EX 26  0.05      KTCB 293U  2.40
 *   KTCB 295U        0.31      KCX 802S   3.38
 *
 * p25 is 0.07 km/L and p75 is 2.05, with nothing in between. 1.5 sits in that
 * gap: it keeps every road vehicle and drops every machine.
 *
 * The failure it prevents is not subtle. At 0.31 km/L a 40 L drop with 0.7 km
 * driven scores 36 L "unexplained" by construction, because the baseline says
 * the machine should have burned 2.3 L. `KTCB 295U` — a 160 L tractor — was
 * being judged that way. `fuel-rate` already records the same thing from the
 * other direction: PLANT measures 7.361 L/km, which its docstring calls "not
 * a rate anyone can use".
 *
 * A vehicle below the floor is not left unjudged; it simply keeps the L/h
 * comparison, which is the correct basis for a machine that works without
 * travelling. That makes this the safe default for SUKARI's 482 unclassified
 * tractors until someone supplies their classes.
 */
export const ROAD_MIN_KM_PER_L = 1.5

/**
 * Kilometres a road vehicle must have covered DURING THE FALL before it is
 * judged on distance rather than on hours.
 *
 * Operator, 2026-08-26: *"Commercial trucks measure fuel consumption by distance
 * when traveling on the open road, but switch to time (per hour) when idling or
 * operating specialized equipment."*
 *
 * So the basis is not purely a property of the MACHINE, it is a property of what
 * the machine was DOING. `resolveBasis` says which denominator a truck uses when
 * it is working as a truck; this says whether it was.
 *
 * That distinction is what the data was asking for. Of 232 drains over 15 L on
 * distance-basis vehicles in 30 days, the kilometres covered during the fall
 * are:
 *
 *     p10-p80  0.000      p90  0.014      p95  1.275
 *
 * Four fifths moved no measurable distance at all, and there is nothing between
 * 0.014 and 1.275 — a genuinely empty band, unlike the km/L gap that closed.
 * A threshold of 1 km sits inside it, so the figure is not finely balanced:
 * anything from 0.05 to 1.2 selects the same 15-16 events.
 *
 * Judging those 216 stationary drains on distance would score each ~100%
 * unexplained by construction and announce it — 7.7/day against the ~5/day the
 * whole fleet produces now. Judging them on L/h instead asks the question that
 * fits: a parked truck burning fuel is either idling, which its own hourly rate
 * explains, or losing it, which the rate does not. Neither reading is available
 * from a distance denominator when the distance is zero.
 *
 * The 16 that DO travel are kept, and they are the cases worth having:
 * `KDL 207X` 78.2 L over 11.5 km, `KBV 714U` five times over 1.3-7.0 km.
 */
export const OPEN_ROAD_MIN_KM = 1.0

export const CLASS_CEILING_LPH: ReadonlyMap<MachineClass, number> = new Map([
  ['EXCAVATOR_MINI',   20],
  ['EXCAVATOR_MEDIUM', 20],
  // 30, not the operator's 20, and the difference is measured rather than
  // preferred. `EXCAVATOR_LARGE` carries the CTR crawlers as well as the
  // excavators — "EX AND CTR can use the same band" — and `MUFINDI: CTR 23`
  // has its OWN derived rate of 28.26 L/h from 15 qualifying runs. A 20 L/h
  // ceiling on a machine measured at 28 flags its ordinary working day: it
  // fired 76 times in 30 days under that setting, which is the same failure as
  // the 4.32 L/h tractor median that this whole class mapping exists to fix.
  //
  // 30 sits above every rate this fleet has actually earned on the class and
  // below the 35-47 L/h outliers that prompted the ceiling in the first place.
  // It stays a number set by a measurement, which is the property that makes a
  // ceiling better than a multiple.
  ['EXCAVATOR_LARGE',  30],
  /**
   * 120 L/h for a generator — above every hour any of them has actually
   * worked, and far below the 300 L/h at which a reading stops describing
   * fuel leaving a tank at all.
   *
   * The worst observed hour across the three units is 94.6 (DG 12 p90), so
   * this clears real operation by ~27%. The window it leaves open is 120-300
   * L/h, which is exactly where drawing fuel off a running generator lands: a
   * theft adding 60 L/h on top of a 45-70 L/h burn crosses it, while the
   * machine's own hardest hour does not.
   *
   * A MULTIPLE could not do this job here. Four times the band's upper edge
   * is 380 L/h, above MAX_PLAUSIBLE_REMOVAL_LPH, so every excursion would be
   * dismissed as a sensor artifact before it was ever compared — the burn rule
   * would be silently dead for the class with the largest tanks on the fleet.
   */
  ['GENERATOR',        120],
])

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
 * How long a fall must last before its implied rate may ANNOUNCE.
 *
 * A rate is a quotient, and over a short enough window the denominator stops
 * describing anything. `MIN_ENGINE_SECONDS` already refuses to compute a rate
 * from almost no engine time, but two minutes is still enough to turn a small
 * drop into a wild figure: 12 L over 120 s implies 363 L/h, which clears any
 * band by twenty times while being, physically, one bad pair of readings.
 *
 * `KTCB 295U` is the case. A SUKARI tractor whose probe reads 18-404 L on a
 * 160 L tank — two and a half times its declared capacity — produced two
 * announcements from drains with ZERO-LENGTH windows: 12.1 L and 15.1 L with
 * `beganAt` equal to `detectedAt`. It was half of all alerts on the fleet.
 *
 * Ten minutes, because that is the floor the parked branch already uses
 * (`SIPHON_MIN_SECONDS`) for the same reason: below it, a fall is an event we
 * watched too briefly to describe. A shorter fall still gets a CAUSE — it is
 * still classified and still on the ledger — it simply cannot be announced on
 * the strength of a rate measured across a couple of readings.
 */
export const MIN_RATE_WINDOW_SECONDS = 10 * 60

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

/**
 * ## RETIRED 2026-09-24 — no longer consulted by `classifyDrain`
 *
 * Kept as an exported constant because `fall_seconds`, `measured_drop_ml` and
 * `step_fraction` are still persisted on every drain and the number remains
 * useful for auditing a verdict after the fact. It no longer decides one.
 *
 * ### What it was calibrated on, and why that no longer describes it
 *
 * The defence above cites "confirmed drains p50 0.25, distrusted probes p50
 * 0.42". That was measured across the WHOLE ledger — but `probeSwings` runs at
 * gate 1 and returns INDETERMINATE before any question about the fall is asked,
 * so the distrusted population never reaches this test. It was calibrated on a
 * population it is never applied to.
 *
 * Re-measured over 30 days, split by what the trust gate actually lets through
 * (`prisma/measure-step-fraction.ts`, re-runnable):
 *
 *   probe        population          n      p25    p50    p75    > 0.6
 *   TRUSTED      confirmed drain    258    0.310  0.522  0.716   109 (42%)
 *   TRUSTED      everything else     26    0.558  0.747  0.946    18 (69%)
 *   distrusted   confirmed drain    299    0.397  0.525  0.672   116 (39%)
 *   distrusted   everything else  1,903    0.468  0.597  0.735   943 (50%)
 *
 * Confirmed drains now sit at p50 **0.522**, not 0.25 — the threshold was
 * placed below the middle of the population it exists to admit, and refuses
 * **109 of 258** events where our own telemetry watched the level fall and stay
 * down. Some separation does survive (1.43x), but on n=26 and at that cost it
 * is not a trade an alerting gate can make.
 *
 * ### Why the quantity cannot answer the question anyway
 *
 * `fuel-drop-shape`'s own docstring says it: the metric "measures the shape and
 * says nothing about the cause", and telling a sharp siphon from a probe glitch
 * "is the recovery test's job, which has already run by the time a drop reaches
 * here". The two modules disagreed, and drop-shape is right.
 *
 * The share of a fall landing in one interval says nothing without the LENGTH
 * of that interval. These probes report on CHANGE at a 30 s median gap, so a
 * 20 L draw over five minutes puts 60-98% of itself in one reported interval by
 * construction. MUFINDI: MTR 09's level moved 14.18 L across a **6-second** gap
 * — 8,500 L/h, which is not fuel flow — while MUFINDI: CTR 19's moved 14.95 L
 * across **two minutes**, 450 L/h, an ordinary transfer pump. Identical step
 * fractions, opposite causes.
 *
 * ### What must replace it, and when
 *
 * A RATE test over the steepest interval: litres per hour implied by the
 * largest single step, judged against `MAX_PLAUSIBLE_REMOVAL_LPH` the way
 * gate 3 already judges the whole-fall average. That distinguishes the two
 * cases above; this constant cannot.
 *
 * Retiring this is safe **only while gate 3's ceiling stays low**. At 300 L/h
 * that gate is aggressive enough to catch the genuine single-reading dropouts
 * this test used to absorb. Raising the ceiling — which
 * docs/fuel-theft-alerting-gaps.md argues for, since 300 L/h is slower than any
 * pump — without adding the per-interval rate test would let a dead probe
 * report a SIPHON. **The two changes are coupled and must ship together.**
 */

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
  /**
   * The machine's own basis — see `resolveBasis`.
   *
   * Optional for callers that have no vehicle to hand, but NOT a no-op when
   * omitted: the distance branch requires OPEN_ROAD_MIN_KM either way, so a
   * stationary drop stops being `drop-while-stationary` regardless. What the
   * argument adds is the ability to stand the burn branch aside for a vehicle
   * that genuinely travelled.
   */
  machineBasis?: ConsumptionBasis,
): CauseJudgement {
  const none = { impliedLph: null }

  // 1. The probe trust gate, reused rather than re-derived. A probe that moves
  //    25 L on a standing machine cannot support any statement about why the
  //    level fell — including a reassuring one, which is why this returns
  //    INDETERMINATE and not ENGINE_BURN.
  if (probeSwings(profile)) {
    return { cause: 'INDETERMINATE', reason: 'probe-swings', confidence: 0.5, ...none }
  }

  // ...and the other way an instrument can be untrustworthy: reporting volumes
  // the tank could not hold. A separate fault from swing and caught separately
  // — KTCB 295U is steady parked and reads 404 L on a 160 L tank.
  if (probeOverreads(profile)) {
    return { cause: 'INDETERMINATE', reason: 'probe-overreads', confidence: 0.5, ...none }
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

  // 4. THE PRIMARY RULE — unless this event belongs to the other denominator.
  //
  // A truck on the open road is judged per kilometre; the same truck idling in a
  // yard is judged per hour (operator, 2026-08-26). `applicableBasis` decides
  // which of those this fall was, so the burn branch stands aside only for a
  // road vehicle that demonstrably travelled — see OPEN_ROAD_MIN_KM.
  const travelling = machineBasis != null
    && applicableBasis(machineBasis, ev.distanceKm) === 'DISTANCE'
  if (impliedLph != null && !travelling) {
    // The operator's absolute ceiling takes precedence where one exists. It is
    // checked BEFORE the multiple because it is the stricter statement: a class
    // with a ceiling has had someone say "above this, go and look", and a ratio
    // against a derived band should not be able to overrule that.
    if (band.ceilingLph != null && impliedLph >= band.ceilingLph
        && ev.fallSeconds >= MIN_RATE_WINDOW_SECONDS) {
      return {
        cause: 'UNEXPLAINED_BURN', reason: 'burn-above-class-ceiling', impliedLph,
        confidence: lerp(impliedLph, band.ceilingLph, band.ceilingLph * 3, 0.6, 0.9),
      }
    }
    // A rate measured across a fall too short to be a fall cannot carry an
    // announcement — see MIN_RATE_WINDOW_SECONDS. It is still classified, so
    // the ledger and the tables keep it; it just does not speak.
    const rateIsMeasurable = ev.fallSeconds >= MIN_RATE_WINDOW_SECONDS
    const ratio = impliedLph / band.highLph
    if (ratio >= ANNOUNCE_MULTIPLE && !rateIsMeasurable) {
      return {
        cause: 'HIGH_BURN', reason: 'burn-window-too-short', impliedLph,
        confidence: 0.4,
      }
    }
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

  // 5. ROAD VEHICLES — distance explains part of the drop.
  //
  // The operator's rule for anything that is not heavy machinery: work out
  // what the kilometres actually driven should have cost at this vehicle's own
  // measured baseline, subtract it, and judge what is left.
  //
  //   unexplained = drop − (distance ÷ baseline km/L)
  //
  // Placed AFTER the burn branch so a road vehicle with real engine time is
  // still checked against its L/h first — a truck idling away 60 L without
  // moving is caught there, and this branch would score it as 100%
  // unexplained on the strength of having travelled no distance.
  //
  // The zero-distance case is the operator's "idling theft": nothing was
  // driven, so nothing is explained, and the whole drop is unexplained. That
  // is only safe because of what has already run — a level that came back is
  // REDISTRIBUTION and never reaches here, and an oscillating probe is
  // INDETERMINATE at gate 1. Without those two this rule alone would call
  // every parked probe swing a theft, which is the failure this project
  // exists to remove.
  //
  // Gated on having MOVED, which is what makes a distance denominator mean
  // anything. Without it, four fifths of these events carry 0.000 km, score
  // ~100% unexplained by construction, and announce — 7.7/day against the ~5/day
  // the whole fleet produces. Those events are not silenced: they fall to the
  // burn branch above, where an idling truck is measured against its own hourly
  // rate, which is the question that actually fits them.
  if (band.kmPerL != null && ev.distanceKm != null && dropL >= ROAD_MIN_DROP_L
      && ev.distanceKm >= OPEN_ROAD_MIN_KM) {
    const explainedL   = ev.distanceKm / band.kmPerL
    const unexplainedL = dropL - explainedL
    if (unexplainedL > ROAD_MIN_UNEXPLAINED_L) {
      return {
        cause: 'UNEXPLAINED_BURN',
        // Always `drop-exceeds-distance` now. This used to pick
        // `drop-while-stationary` below 0.5 km, but the gate above requires
        // OPEN_ROAD_MIN_KM (1.0), so that arm became unreachable the moment
        // the basis change landed — measured 2026-08-27: twelve stored events
        // moved OFF the reason and nothing moved onto it.
        //
        // The slug stays in ANNOUNCED. `announces` keys on the reason string
        // and rows judged under the old rule still carry it, so dropping it
        // there would retroactively silence events that did announce.
        reason: 'drop-exceeds-distance',
        impliedLph,
        // Graded on the SHARE of the drop that driving fails to explain, not
        // on its size: 40 unexplained litres out of 45 is a different claim
        // from 40 out of 200, and only the ratio says which this is.
        confidence: lerp(unexplainedL / dropL, 0.2, 1, 0.55, 0.9),
      }
    }
    // Driving accounts for it. Explicit rather than falling through, so a road
    // vehicle whose distance explains its drop is recorded as ordinary
    // consumption instead of landing in INDETERMINATE.
    return {
      cause: 'ENGINE_BURN', reason: 'explained-by-distance', impliedLph,
      confidence: lerp(explainedL / dropL, 0.8, 1.5, 0.6, 0.9),
    }
  }

  // 6. The parked branch — the only route to SIPHON.
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
    // (The `step-shaped` refusal stood here until 2026-09-24. It refused 42% of
    // the confirmed drains on trusted probes — see SIPHON_MAX_STEP_FRACTION for
    // the measurement and for what must replace it before the rate ceiling is
    // raised.)
    return {
      cause: 'SIPHON', reason: 'parked-sustained-fall', impliedLph: null,
      confidence: lerp(wallLph, SIPHON_MIN_LPH, SIPHON_MIN_LPH * 8, 0.55, 0.9),
    }
  }

  // 7. Engine state unknown and no engine time to reason from. Half the ledger
  //    lands here, and it is accepted as a blind spot rather than papered over.
  return { cause: 'INDETERMINATE', reason: 'engine-state-unknown', confidence: 0.5, ...none }
}
