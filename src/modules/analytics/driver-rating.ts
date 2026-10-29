const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

// A driver's rating starts at 0 and is EARNED up to 5 (operator, 2026-10-29:
// "by default the rating starts from 0 working it all up to 5"): half from the
// work they have done, half from the days they have been on duty. Their cases
// then come off it, and it never goes below 0. Nothing is given for being on
// the books -- the old model handed every driver half the score as a retainer.
const DRIVER_RATING_CONFIG = {
  maxRating: 5,
  workShare: 0.5,
  dutyShare: 0.5,

  // Work: the workbook's trip-wise pay model -- trip volume, distance and
  // tonnage, each capped so one metric cannot carry it alone.
  maxTripsForProductivity: 40,
  maxMileageKmForProductivity: 2500,
  maxTonnesForProductivity: 100,
  tripsPoints: 12,
  mileagePoints: 10,
  tonnesPoints: 8,

  // Duty: days posted to a unit. A month on duty is the full half.
  fullDutyDays: 30,

  // Off the rating out of 5, per case. Theft and overspeeding keep their
  // original weights on the 100-point scale (6 and 3 points), here in fifths
  // of 100; harsh driving is 0.2 a report (operator, 2026-10-29).
  theftPenaltyPerCase: 6 / 20,
  overspeedPenaltyPerCase: 3 / 20,
  harshPenaltyPerCase: 0.2,
} as const

export interface DriverRatingInput {
  trips?: number
  mileageKm?: number
  tonnes?: number
  /** Days posted to a unit, counted once however many postings overlap. */
  dutyDays?: number
  fuelTheftCases?: number
  overspeedingCases?: number
  harshAccelerationCases?: number
  harshBrakingCases?: number
}

export interface DriverRatingResult {
  /** The rating on a 100-point scale (rating x 20), for anything that sorts by it. */
  score: number
  rating: number
  band: 'Inactive' | 'Poor' | 'Needs Improvement' | 'Fair' | 'Good' | 'Very Good' | 'Excellent'
}

export function calculateDriverRating(input: DriverRatingInput): DriverRatingResult {
  const C = DRIVER_RATING_CONFIG
  const trips = Math.max(0, input.trips ?? 0)
  const mileageKm = Math.max(0, input.mileageKm ?? 0)
  const tonnes = Math.max(0, input.tonnes ?? 0)
  const dutyDays = Math.max(0, input.dutyDays ?? 0)
  const fuelTheftCases = Math.max(0, input.fuelTheftCases ?? 0)
  const overspeedingCases = Math.max(0, input.overspeedingCases ?? 0)
  const harshCases = Math.max(0, input.harshAccelerationCases ?? 0) + Math.max(0, input.harshBrakingCases ?? 0)

  // 0..1 each.
  const work = clamp(
    (trips / C.maxTripsForProductivity) * C.tripsPoints +
      (mileageKm / C.maxMileageKmForProductivity) * C.mileagePoints +
      (tonnes / C.maxTonnesForProductivity) * C.tonnesPoints,
    0,
    C.tripsPoints + C.mileagePoints + C.tonnesPoints,
  ) / (C.tripsPoints + C.mileagePoints + C.tonnesPoints)
  const duty = clamp(dutyDays / C.fullDutyDays, 0, 1)

  // No work and never on duty: nothing to rate, which is not the same as a
  // poor driver.
  if (work === 0 && duty === 0) return { score: 0, rating: 0, band: 'Inactive' }

  const earned = C.maxRating * (C.workShare * work + C.dutyShare * duty)
  const penalty =
    fuelTheftCases * C.theftPenaltyPerCase +
    overspeedingCases * C.overspeedPenaltyPerCase +
    harshCases * C.harshPenaltyPerCase
  // Tenths, so 0.2 a case adds up without float noise.
  const rating = clamp(Math.round((earned - penalty) * 10) / 10, 0, C.maxRating)

  const band: DriverRatingResult['band'] =
    rating >= 4.5 ? 'Excellent'
    : rating >= 4 ? 'Very Good'
    : rating >= 3.5 ? 'Good'
    : rating >= 3 ? 'Fair'
    : rating >= 2.5 ? 'Needs Improvement'
    : 'Poor'

  return { score: Math.round(rating * 20), rating, band }
}

/** Whole days covered by a set of postings up to `now`, overlaps counted once. */
export function dutyDaysOf(postings: { assignedAt: Date; unassignedAt: Date | null }[], now = new Date()): number {
  const spans = postings
    .map(p => [p.assignedAt.getTime(), Math.min((p.unassignedAt ?? now).getTime(), now.getTime())] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])
  let ms = 0, end = -Infinity
  for (const [a, b] of spans) {
    if (b <= end) continue
    ms += b - Math.max(a, end)
    end = b
  }
  return Math.floor(ms / 86_400_000)
}
