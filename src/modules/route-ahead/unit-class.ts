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
 * From `vehicleType` where the register has one; most of Kabras, Menengai,
 * West Kenya and Nzoia say UNSPECIFIED, and there the plate decides: a Kenyan
 * tractor is registered KT…, so `KTCC 870B` is a tractor whatever the register
 * says, and any other registered unit is taken as a lorry.
 *
 * The plate rule (operator, 2026-10-15): "WKS - Kabras KTCB 358X is a
 * tractor — KTCB followed by 3 numbers and a letter — unlike those with 3
 * letters like KDJ followed by 3 numbers and a letter". KT plus two letters,
 * three digits, one letter; the space is optional.
 */
export const TRACTOR_PLATE = /\bKT[A-Z]{2}\s?\d{3}[A-Z]\b/i

export type UnitClass = 'TRACTOR' | 'TRUCK' | 'CAR' | 'PLANT'

export function unitClass(vehicleType: string | null | undefined, name: string | null | undefined): UnitClass {
  const t = (vehicleType ?? '').toUpperCase()
  if (t === 'TRACTOR' || TRACTOR_PLATE.test(name ?? '')) return 'TRACTOR'
  if (t === 'PLANT') return 'PLANT'
  if (['SALOON', 'COMPANY_VEHICLE', 'PICKUP', 'CAR', 'SUV'].includes(t)) return 'CAR'
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
}

export const etaFactor = (c: UnitClass): EtaFactor => ETA_FACTORS[c]
