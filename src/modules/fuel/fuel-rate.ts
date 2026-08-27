/**
 * How much fuel a machine is expected to burn per hour its engine runs.
 *
 * The rule half of the consumption rates derived in
 * `docs/fuel-consumption-rates.md`; the derivation and the database live in
 * `fuel-rate.service.ts`. Pure: no clock, no database.
 *
 * ## Why engine hours, and not the distance we already have
 *
 * `fuel-tank-state` already carries a distance-based expectation
 * (`expectedBurnMl`, at a flat `KM_PER_LITRE`), and for a truck that is a fair
 * model. For most of this fleet it is not one at all:
 *
 * - **215 of 310 probed units are plant or tractors** — machines that burn fuel
 *   while stationary or crawling. KASULU PLANT has its engine on for 58.3% of
 *   samples and is moving in 19.3%, averaging 1.5 km/h.
 * - Position FREEZES at speed 0 on this telemetry, so a working excavator
 *   reports ≈0 km while burning ~11 L/h. A distance model predicts no
 *   consumption for it, and the entire real burn then presents as an
 *   unexplained drop.
 * - The measured L/km for PLANT is **7.361** — not a rate anyone can use, but
 *   the arithmetic saying the denominator is wrong.
 *
 * So the two expectations are not redundant and neither replaces the other.
 *
 * ## Corrected 2026-08-27: hours is not primary for every type
 *
 * This module used to conclude "engine hours is the primary basis for every
 * type, distance is the secondary check on road vehicles". The evidence above
 * is sound and the conclusion over-reached it: every figure cited — 215 of 310
 * units, 58.3% engine-on, 1.5 km/h, 7.361 L/km — is about PLANT, and it was
 * generalised onto the 95 road units, where distance is the natural
 * denominator and a stationary truck's whole burn presents as unexplained.
 *
 * `resolveBasis` in fuel-theft-classifier now decides per machine, and the
 * choice is recorded on `vehicle_fuel_rates.primary_basis`. Plant, generators
 * and tractors keep hours for exactly the reasons set out above; trucks,
 * lorries, buses, saloons and company vehicles take kilometres. Both figures
 * are still stored for every machine, and both sit beside `consumedMl`, which
 * is what the tank actually did.
 *
 * See docs/fuel-consumption-rates.md §1, which states the superseded rule and
 * now carries the correction beside it.
 *
 * ## Nothing here judges anything
 *
 * These are expectations shown next to a measurement, exactly like
 * `expectedBurnMl`. No verdict reads them. `docs/fuel-consumption-rates.md` §5
 * lists why they could not carry one yet — three days of history, load not
 * modelled, idle not separated from work, and rates derived from the very probe
 * a detector would be watching, so a mis-calibrated probe yields a
 * self-consistent wrong rate that cross-checks against nothing.
 */

/**
 * Runs a vehicle needs before its OWN rate is used rather than its type's.
 *
 * Three, matching the `having count(*) >= 3` the rates were measured under —
 * the per-vehicle table in `fuel-consumption-rates.md` §4 reports coverage at
 * that threshold and nothing below it was ever validated. A rate off one run is
 * one haul's load and one probe's afternoon.
 */
export const MIN_RUNS = 3

/**
 * Vehicles a type median needs before it describes a type rather than a unit.
 *
 * Measured on prod 2026-08-14, and the fallback turned out to be the DOMINANT
 * path rather than an edge case: **689 of 815 active vehicles borrow a rate**,
 * only 77 have their own. So the quality of a group matters more than the
 * quality of a vehicle's own rate.
 *
 * Two groups were serving a median built from two machines:
 *
 * | group | units | contributing | rates |
 * | --- | --- | --- | --- |
 * | `KASULU UNSPECIFIED` | 22 | 2 | 4.42 and 109.89 L/h |
 * | `SUKARI TRUCK` | 67 | 2 | 6.11 and 14.06 L/h |
 *
 * The median of two numbers that disagree 25-fold is not an estimate of
 * anything, and it was reaching 22 vehicles as ≈57 L/h. Three is the same bar
 * MIN_RUNS sets for a single vehicle, for the same reason.
 */
export const MIN_GROUP_CONTRIBUTORS = 3

/**
 * Vehicle types that are not types.
 *
 * `UNSPECIFIED` is the ABSENCE of a label, so grouping by it groups by
 * ignorance: 22 KASULU units carry it and have nothing in common but that
 * nobody classified them. It was the worst group on the fleet — a 24.9x spread
 * between its two contributors — and that is not a coincidence to be guarded
 * against with a threshold, it is a category error to be excluded.
 *
 * A unit here gets no fallback and therefore no expectation, which is correct:
 * we do not know what kind of machine it is, so we cannot say what it should
 * burn. It still gets its OWN rate if it has earned one.
 */
const UNGROUPABLE_TYPES = new Set(['UNSPECIFIED', 'UNKNOWN', 'OTHER', ''])

/** A per-vehicle rate as derived and stored. */
export interface VehicleRate {
  vehicleId: string
  /** Litres per engine-hour. Primary where the machine's basis is HOURS. */
  lPerHour:  number
  /**
   * Litres per kilometre. Primary where the machine's basis is DISTANCE — see
   * the module note's 2026-08-27 correction — and meaningless on plant.
   *
   * Not used by `resolveRates`, which pools an HOURS median only: a type median
   * over kilometres would pool machines that travel differently, so a road
   * vehicle without its own figure gets no distance baseline rather than a
   * borrowed one. `getBandInputs` carries the vehicle's own value alongside.
   */
  lPerKm:    number | null
  /** Qualifying runs the rate was averaged over. Below MIN_RUNS it is a hint. */
  runs:      number
}

/** What a vehicle's rate is keyed against when it has none of its own. */
export interface RateGroup {
  vehicleId:   string
  organisationId: string
  vehicleType: string
}

/** Where a resolved rate came from — reported so a borrowed one is visible. */
export type RateBasis = 'vehicle' | 'type'

export interface ResolvedRate {
  lPerHour: number
  basis:    RateBasis
  /**
   * Runs behind the figure: the vehicle's own for a `vehicle` basis, the number
   * of VEHICLES the median spans for a `type` one.
   */
  runs:     number
  /**
   * For a `type` basis, how far apart the group's own members are (max ÷ min).
   *
   * Carried because a group can clear MIN_GROUP_CONTRIBUTORS and still be
   * incoherent: SUKARI TRACTOR pools **481 units onto 8 contributors spanning
   * 6.8x**, and a median drawn from machines that disagree that much is a weak
   * claim about a machine that contributed nothing. Rejecting it outright would
   * strip the column from more than half the fleet, so it is reported instead —
   * the UI can mark a wide group as provisional, which is a decision about
   * presentation rather than one this module should make.
   *
   * Null on a `vehicle` basis, where the question does not arise.
   */
  spread:   number | null
}

/**
 * Build a per-vehicle rate lookup, falling back to the vehicle's org+type.
 *
 * ## The fallback is a MEDIAN of per-vehicle rates, not a fleet aggregate
 *
 * This is the one modelling choice here worth defending, and
 * `fuel-consumption-rates.md` calls it out explicitly: the fleet aggregate
 * (Σ litres / Σ hours) is VOLUME-WEIGHTED, so a few heavy machines dominate it.
 * Kasulu TRACTOR reads **12.47 L/h** aggregated against a per-vehicle median of
 * **3.51** — and against Sukari's 4.71 the apparent 4x gap between the two orgs
 * reverses once you stop weighting by volume. An aggregate is the right number
 * for a fleet total and the wrong one for "what should THIS machine have
 * burned", which is the only question asked here.
 *
 * Falling back per org AND type, never fleet-wide: a saloon at 3.04 L/h and an
 * excavator at 11.28 have nothing to say to each other.
 *
 * Vehicles under MIN_RUNS contribute to nothing — not their own rate and not
 * their type's median. A rate too thin to trust for one machine is too thin to
 * be evidence about twenty.
 */
export function resolveRates(
  rates:  readonly VehicleRate[],
  groups: readonly RateGroup[],
): Map<string, ResolvedRate> {
  const byVehicle = new Map(rates.map(r => [r.vehicleId, r]))
  const groupOf   = new Map(groups.map(g => [g.vehicleId, groupKey(g)]))

  // Per-vehicle rates that cleared MIN_RUNS, gathered by org+type, so the
  // fallback is a median over MACHINES rather than over litres.
  const pool = new Map<string, number[]>()
  for (const r of rates) {
    if (r.runs < MIN_RUNS) continue
    const key = groupOf.get(r.vehicleId)
    if (key == null) continue
    const list = pool.get(key)
    if (list) list.push(r.lPerHour)
    else pool.set(key, [r.lPerHour])
  }

  const typeRate = new Map<string, { lPerHour: number; vehicles: number; spread: number }>()
  for (const [key, values] of pool) {
    // A group thinner than MIN_GROUP_CONTRIBUTORS is one or two machines
    // wearing a type's name. Dropped entirely rather than served weakly.
    if (values.length < MIN_GROUP_CONTRIBUTORS) continue
    const lo = Math.min(...values), hi = Math.max(...values)
    typeRate.set(key, {
      lPerHour: median(values),
      vehicles: values.length,
      spread:   lo > 0 ? hi / lo : Infinity,
    })
  }

  const out = new Map<string, ResolvedRate>()
  for (const g of groups) {
    const own = byVehicle.get(g.vehicleId)
    if (own && own.runs >= MIN_RUNS) {
      out.set(g.vehicleId, { lPerHour: own.lPerHour, basis: 'vehicle', runs: own.runs, spread: null })
      continue
    }
    const key = groupKey(g)
    const fallback = key == null ? undefined : typeRate.get(key)
    // No rate at all is null, never a fleet number and never a zero. A machine
    // whose type has never been measured has no expectation, and saying so is
    // the honest column — a zero would read as "burned nothing".
    if (fallback) {
      out.set(g.vehicleId, {
        lPerHour: fallback.lPerHour, basis: 'type',
        runs: fallback.vehicles, spread: Math.round(fallback.spread * 10) / 10,
      })
    }
  }
  return out
}

/**
 * The org+type a vehicle falls back on, or null when it has no usable type.
 *
 * Null for an UNGROUPABLE_TYPES member on BOTH sides of the lookup — such a
 * vehicle neither contributes to a median nor draws one. A machine nobody
 * classified cannot inform an expectation about other unclassified machines.
 */
function groupKey(g: RateGroup): string | null {
  const type = (g.vehicleType ?? '').trim().toUpperCase()
  if (UNGROUPABLE_TYPES.has(type)) return null
  return `${g.organisationId} ${type}`
}

/** Median of a non-empty list. Even counts take the mean of the middle pair. */
function median(values: readonly number[]): number {
  const v = [...values].sort((a, b) => a - b)
  const mid = Math.floor(v.length / 2)
  return v.length % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2
}

/**
 * Fuel the engine is expected to have burned over `engineSeconds`, in
 * millilitres. Null without a rate or without engine time.
 *
 * Rounded to a whole millilitre. The rate carries two decimals of litres per
 * hour and stands on a handful of runs, so anything finer would be inventing
 * precision the derivation never had.
 */
export function engineBurnMl(engineSeconds: number | null, rate: ResolvedRate | null): number | null {
  if (engineSeconds == null || rate == null) return null
  return Math.round((engineSeconds / 3600) * rate.lPerHour * 1000)
}
