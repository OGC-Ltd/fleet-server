/**
 * What kind of vehicle a unit is, for drive times, and how much slower than
 * Google's car it really goes.
 *
 * Google has no tractor or lorry mode: every DRIVE answer is a car's. A cane
 * tractor at 25 km/h is not a car, so a car's ETA and a car's 60-minute zone
 * promise it far too much. The factors below are MEASURED — real departure to
 * arrival between known sites from our own telemetry, over Google's
 * no-traffic time for the same pair — and every answer that uses one says how
 * many runs it came from.
 *
 * ## Classes
 *
 * From RaiFactorySuite's machine register first, where it lists the unit
 * (KASULU, synced hourly into `equipmentType` and the rated basis). The
 * register says what the machine IS; Wialon's `vehicleType` for the same
 * units disagrees on 1 in 20 (measured 2026-10-20, 183 linked units: six
 * diesel generators and a wheel loader UNSPECIFIED, so timed as lorries; two
 * Hydra Cranes TRACTOR; the Case spraying tractor TRUCK; a dump truck PLANT).
 * A register type no rule names falls to its rated basis: km/L is a road
 * vehicle, L/h is plant.
 *
 * Then `vehicleType`; most of Kabras, Menengai, West Kenya and Nzoia say
 * UNSPECIFIED, and there the plate decides: a Kenyan tractor is registered
 * KT…, so `KTCC 870B` is a tractor whatever the register says, and any other
 * registered unit is taken as a lorry.
 *
 * The plate rule (operator, 2026-10-15): "WKS - Kabras KTCB 358X is a
 * tractor — KTCB followed by 3 numbers and a letter — unlike those with 3
 * letters like KDJ followed by 3 numbers and a letter". KT plus two letters,
 * three digits, one letter; the space is optional.
 *
 * FIXED is what never drives to a hub: generators, hand compactors, drums.
 */
export const TRACTOR_PLATE = /\bKT[A-Z]{2}\s?\d{3}[A-Z]\b/i

export type UnitClass = 'TRACTOR' | 'TRUCK' | 'CAR' | 'PLANT' | 'FIXED'

/** What the register lists for a unit: its type (`equipmentTypeOf`) and rated basis. */
export interface RegisterKind {
  equipmentType?: string | null
  ratedConsumptionBasis?: string | null
}

/**
 * Every register type seen, 2026-10-20 (52 categories, 367 rows), by what it
 * is on the road. Order matters: "Case Spraying Tractor" is a tractor before
 * anything else, "Concrete Mixer" is plant (self-loading, rated L/h), not a
 * truck.
 */
const REGISTER_RULES: [RegExp, UnitClass][] = [
  [/generator|hand compactor|^drums?$/i, 'FIXED'],
  [/tractor|^case (puma|steiger|magnum|maxxum|\d+)\b|challenger|fendt|massey|john deere|new holland|mahindra/i, 'TRACTOR'],
  [/excavator|dozer|loader|grader|backhoe|compactor|crane|hydra|mixer|pump|drill|forklift|harvester|roller|caterpillar|^machines?$/i, 'PLANT'],
  [/truck|lorry|tipper|bus|bowser|tanker|trailer/i, 'TRUCK'],
  [/^(lmv|police|saloon|car|suv|pick-?up|station wagon)$/i, 'CAR'],
]

/** The register's say, or null where it does not list the unit. */
export function registerClass(reg: RegisterKind | null | undefined): UnitClass | null {
  const t = reg?.equipmentType?.trim()
  if (t) for (const [re, c] of REGISTER_RULES) if (re.test(t)) return c
  if (reg?.ratedConsumptionBasis === 'DISTANCE') return 'TRUCK'
  if (reg?.ratedConsumptionBasis === 'HOURS') return 'PLANT'
  return null
}

/**
 * FactorySuite's /vehicles has three types (SUKARI): TRACTOR, TRUCK and
 * COMPANY_VEHICLE, and COMPANY_VEHICLE is everything else the company owns.
 * Of Sukari's 46 tracked on 2026-10-20: 28 pickups, Land Cruisers and a Hiace,
 * 8 FAW staff buses, and 10 machines (Caterpillar D8 dozers, Komatsu grader and
 * excavator, Hydra cranes, a JCB backhoe, a Bomag compactor). The unit's name
 * is FactorySuite's make and model plus the plate, so the same rules read it;
 * anything they do not name is a car.
 */
export function companyVehicleClass(name: string | null | undefined): UnitClass {
  const n = name ?? ''
  for (const [re, c] of REGISTER_RULES) if (re.test(n)) return c
  return 'CAR'
}

export function unitClass(
  vehicleType: string | null | undefined, name: string | null | undefined, reg?: RegisterKind | null,
): UnitClass {
  const r = registerClass(reg)
  if (r) return r
  const t = (vehicleType ?? '').toUpperCase()
  if (t === 'TRACTOR' || TRACTOR_PLATE.test(name ?? '')) return 'TRACTOR'
  if (t === 'PLANT') return 'PLANT'
  if (t === 'COMPANY_VEHICLE') return companyVehicleClass(name)
  if (['SALOON', 'PICKUP', 'CAR', 'SUV'].includes(t)) return 'CAR'
  return 'TRUCK'
}

export interface EtaFactor {
  /** Real drive time over Google's no-traffic car time, median. */
  factor: number
  /** Runs it was measured from; 0 = not measured, the factor is 1. */
  runs: number
}

/**
 * Measured 2026-10-15 on the live fleet, 21 days of telemetry: legs between
 * Sukari's yard and its Opapo / Oyani / Nyaondo weighbridges, and Menengai's
 * Naitiri ↔ Raiply ↔ Nakuru runs. Medians; see the commit for the spread.
 */
export const ETA_FACTORS: Record<UnitClass, EtaFactor> = {
  // 400 runs: Sukari's yard ↔ 21 measured farms (Ayiengo, Saramba A,
  // Ligodho, Kamwana A…), 120 tractors. Middle half 1.06–1.69: farm roads
  // already crawl in Google's model, so a tractor is slower, not 3× slower.
  TRACTOR: { factor: 1.32, runs: 400 },
  // 913 runs: Sukari yard ↔ Opapo / Oyani / Nyaondo and Menengai's
  // Naitiri ↔ Raiply ↔ Nakuru HQ. Middle half 1.13–1.50.
  TRUCK:   { factor: 1.29, runs: 913 },
  CAR:     { factor: 1, runs: 0 },
  PLANT:   { factor: 1, runs: 0 },
  FIXED:   { factor: 1, runs: 0 },
}

export const etaFactor = (c: UnitClass): EtaFactor => ETA_FACTORS[c]
