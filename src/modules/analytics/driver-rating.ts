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
  daysSinceLastTrip?: number
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
  const daysSinceLastTrip = Math.max(0, input.daysSinceLastTrip ?? 0)

  // Workbook rule: no recent work is not a poor score; it is inactive.
  if (trips === 0 && mileageKm === 0 && daysSinceLastTrip >= DRIVER_RATING_CONFIG.inactivityWindowDays) {
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
  // overspeeding are treated as conduct risks and reduce the score directly.
  const safetyPenalty =
    fuelTheftCases * DRIVER_RATING_CONFIG.theftPenaltyPerCase +
    overspeedingCases * DRIVER_RATING_CONFIG.overspeedPenaltyPerCase
  const safetyScore = clamp(
    DRIVER_RATING_CONFIG.safetyWeight - safetyPenalty,
    0,
    DRIVER_RATING_CONFIG.safetyWeight,
  )

  const score = clamp(
    retainerComponent + productivityScore + incentiveScore + safetyScore,
    0,
    100,
  )

  let rating = 0
  let band: DriverRatingResult['band'] = 'Poor'

  if (score >= DRIVER_RATING_CONFIG.excellentMin) {
    rating = 5
    band = 'Excellent'
  } else if (score >= DRIVER_RATING_CONFIG.veryGoodMin) {
    rating = 4.5
    band = 'Very Good'
  } else if (score >= DRIVER_RATING_CONFIG.goodMin) {
    rating = 4
    band = 'Good'
  } else if (score >= DRIVER_RATING_CONFIG.fairMin) {
    rating = 3.5
    band = 'Fair'
  } else if (score >= DRIVER_RATING_CONFIG.weakMin) {
    rating = 3
    band = 'Needs Improvement'
  } else if (score >= DRIVER_RATING_CONFIG.poorMin) {
    rating = 2.5
    band = 'Poor'
  } else {
    rating = 2
    band = 'Poor'
  }

  return { score: Math.round(score), rating, band }
}
