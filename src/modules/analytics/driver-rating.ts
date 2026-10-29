const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const DRIVER_RATING_CONFIG = {
  retainerWeight: 50,
  productivityWeight: 30,
  incentivesWeight: 10,
  safetyWeight: 20,

  maxTripsForProductivity: 40,
  maxMileageKmForProductivity: 2500,
  maxTonnesForProductivity: 100,

  theftPenaltyPerCase: 6,
  overspeedPenaltyPerCase: 3,
  // Each harsh acceleration or hard braking report takes 0.2 off the rating
  // out of 5 itself, not off the score (operator, 2026-10-29), and the rating
  // stops at 0.
  harshRatingPenaltyPerCase: 0.2,

  inactivityWindowDays: 30,
  inactiveScore: 0,
  inactiveRating: 0,

  excellentMin: 85,
  veryGoodMin: 75,
  goodMin: 65,
  fairMin: 55,
  weakMin: 45,
  poorMin: 35,
} as const

export interface DriverRatingInput {
  baseScore?: number
  trips?: number
  mileageKm?: number
  tonnes?: number
  incentiveBonus?: number
  fuelTheftCases?: number
  overspeedingCases?: number
  harshAccelerationCases?: number
  harshBrakingCases?: number
  daysSinceLastTrip?: number
  /** Posted to a unit now. A posted driver is rated even with no trips. */
  postedToUnit?: boolean
}

export interface DriverRatingResult {
  score: number
  rating: number
  band: 'Inactive' | 'Poor' | 'Needs Improvement' | 'Fair' | 'Good' | 'Very Good' | 'Excellent'
}

export function calculateDriverRating(input: DriverRatingInput): DriverRatingResult {
  const baseScore = clamp(input.baseScore ?? 0, 0, 5)
  const trips = Math.max(0, input.trips ?? 0)
  const mileageKm = Math.max(0, input.mileageKm ?? 0)
  const tonnes = Math.max(0, input.tonnes ?? 0)
  const incentiveBonus = Math.max(0, input.incentiveBonus ?? 0)
  const fuelTheftCases = Math.max(0, input.fuelTheftCases ?? 0)
  const overspeedingCases = Math.max(0, input.overspeedingCases ?? 0)
  const harshAccelerationCases = Math.max(0, input.harshAccelerationCases ?? 0)
  const harshBrakingCases = Math.max(0, input.harshBrakingCases ?? 0)
  const daysSinceLastTrip = Math.max(0, input.daysSinceLastTrip ?? 0)

  // Workbook rule: no recent work is not a poor score; it is inactive -- unless
  // they hold a unit now (operator, 2026-10-29). Menengai logs no trips, so its
  // posted drivers were all unrated and their cases never touched the rating.
  const noTrips = trips === 0 && mileageKm === 0
  if (noTrips && !input.postedToUnit && daysSinceLastTrip >= DRIVER_RATING_CONFIG.inactivityWindowDays) {
    return {
      score: DRIVER_RATING_CONFIG.inactiveScore,
      rating: DRIVER_RATING_CONFIG.inactiveRating,
      band: 'Inactive',
    }
  }

  // Retainer / base score: fixed starting point from the workbook's baseline.
  const retainerComponent = (baseScore / 5) * DRIVER_RATING_CONFIG.retainerWeight

  // Productivity score: trip volume, distance, and tonnage in the workbook's
  // trip-wise pay model. All three contribute, but they are capped so one
  // metric cannot dominate the score.
  const productivityScore = clamp(
    (trips / DRIVER_RATING_CONFIG.maxTripsForProductivity) * 12 +
      (mileageKm / DRIVER_RATING_CONFIG.maxMileageKmForProductivity) * 10 +
      (tonnes / DRIVER_RATING_CONFIG.maxTonnesForProductivity) * 8,
    0,
    DRIVER_RATING_CONFIG.productivityWeight,
  )

  // Incentive score: a positive performance uplift from the workbook's
  // incentives sheet.
  const incentiveScore = clamp(incentiveBonus, 0, DRIVER_RATING_CONFIG.incentivesWeight)

  // Safety score: workbook safety scoring is a penalty model. Theft and
  // overspeeding are treated as conduct risks and reduce the score directly,
  // every recorded case. Harsh driving comes off the rating below.
  const safetyPenalty =
    fuelTheftCases * DRIVER_RATING_CONFIG.theftPenaltyPerCase +
    overspeedingCases * DRIVER_RATING_CONFIG.overspeedPenaltyPerCase
  const safetyScore = clamp(
    DRIVER_RATING_CONFIG.safetyWeight - safetyPenalty,
    0,
    DRIVER_RATING_CONFIG.safetyWeight,
  )

  // A posted driver with no trips has no productivity to measure, which is
  // not the same as none: they start at 5 and only their cases take it down,
  // so the rest of the score is scaled up to stand for the whole.
  const score = noTrips
    ? clamp(
        (retainerComponent + incentiveScore + safetyScore) * 100 / (100 - DRIVER_RATING_CONFIG.productivityWeight),
        0,
        100,
      )
    : clamp(
        retainerComponent + productivityScore + incentiveScore + safetyScore,
        0,
        100,
      )

  const banded =
    score >= DRIVER_RATING_CONFIG.excellentMin ? 5
    : score >= DRIVER_RATING_CONFIG.veryGoodMin ? 4.5
    : score >= DRIVER_RATING_CONFIG.goodMin ? 4
    : score >= DRIVER_RATING_CONFIG.fairMin ? 3.5
    : score >= DRIVER_RATING_CONFIG.weakMin ? 3
    : score >= DRIVER_RATING_CONFIG.poorMin ? 2.5
    : 2

  // Harsh driving, straight off the rating, never below 0. Tenths, so 0.2 a
  // case adds up without float noise.
  const harshCases = harshAccelerationCases + harshBrakingCases
  const rating = Math.max(0, Math.round((banded - harshCases * DRIVER_RATING_CONFIG.harshRatingPenaltyPerCase) * 10) / 10)

  // The band names where the rating landed, after harsh driving.
  const band: DriverRatingResult['band'] =
    rating >= 5 ? 'Excellent'
    : rating >= 4.5 ? 'Very Good'
    : rating >= 4 ? 'Good'
    : rating >= 3.5 ? 'Fair'
    : rating >= 3 ? 'Needs Improvement'
    : 'Poor'

  return { score: Math.round(score), rating, band }
}
