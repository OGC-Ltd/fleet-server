/**
 * Driver scorecard and pay: the "Molasses Truck Drivers' Pay Structure"
 * (Revised Proposal v2.0, Kabras Bioenergy, July 2026) as one config and pure
 * functions per driver-day and per driver.
 *
 * Every number below is an INPUT cell of that workbook, named by sheet and
 * cell. Where the workbook's prose disagrees with its own inputs, the inputs
 * win, because they are what its formulas compute from:
 *
 *   · §3.1 / §3.2 explanations quote "× 15" and "× 5" per point; the inputs
 *     are KES 50 (fuel, D7:D9) and KES 30 (speed, D15:D19).
 *   · the daily caps are +20 / −15 points ('3 - Incentives' C38:C39); sheet
 *     4's note says +15 / −13.
 *   · a 1st offence in the 4–10 km/h band is −3 points (C16); G21 calls it a
 *     warning.
 *
 * How the workbook's rules meet the data:
 *
 *   · speeding over 10 km/h is in BOTH §3.2 (−15 × KES 30) and the violations
 *     list (> 15 km/h: −10 × KES 50). Both apply, as written.
 *   · an "offence" in the 4–10 km/h band is counted per day; the 3rd and later
 *     also cost the day's trip-wise pay (G18).
 *   · the +20 cap is on the day's POSITIVE incentive points (speed, fuel,
 *     vehicle care — what C38's formula E38 adds up); the −15 floor is on the
 *     day's safety violation points (C39, "worst cumulative daily deductions").
 *   · the retainer is a monthly salary, so a period gets it pro-rated by
 *     calendar day, whether or not the driver drove each day.
 *   · a 1-day suspension without pay is one working day's retainer
 *     (KES 25,000 ÷ 20).
 *
 * Not computable from fleet data, and listed as manual on the page: vehicle
 * care (§3.3, sheet 4A/4B: the inspection app's score), its perfect-score and
 * driver-of-the-quarter bonuses, the retainer growth path (sheet 1, rows
 * 11–13: tenure and vehicle care), unexcused absenteeism (sheet 5), and red
 * lights / headlights at night, which neither the trackers nor the cameras
 * detect.
 */

const ROUTE = (name: string, keys: string[], roundTripKm: number, tatHours: number) => ({ name, keys, roundTripKm, tatHours })

export const PAY_RULES = {
  /** Sheet '2 - Trip-wise Pay' C7 / '3 - Incentives' C3. */
  workingDaysPerMonth: 20,
  /** Sheet '1 - Retainer' C6. */
  retainerMonthly: 25_000,
  trip: {
    /** C5: hours available for trip cycles per shift. */
    shiftHours: 12,
    /** C6: pay per trip is set so the calculated trips earn about this a day. */
    dailyTarget: 1_000,
    /**
     * B15:D19. Matched by name against where the trip started (the factory)
     * or was going. Order matters only for a trip naming two of them.
     */
    routes: [
      ROUTE('Kabras to Distillery', ['KABRAS'], 6, 2.5),
      ROUTE('Naitiri to Distillery', ['NAITIRI'], 154, 5.4),
      ROUTE('Nzoia SC to Distillery', ['NZOIA'], 104, 4.4),
      ROUTE('Olepitio to Distillery', ['OLEPITIO'], 188, 6.1),
      ROUTE('Sukari to Distillery', ['SUKARI', 'NDHIWA'], 450, 11.4),
    ],
  },
  /** Sheet '5 - Lunch Allowance' C5: on a day with at least one full trip. */
  lunchPerDay: 200,
  fuel: {
    kesPerPoint: 50,
    /** B7:C9 — over 2.0 km/L, 1.80–1.99, below 1.80. */
    bands: [
      { minKmpl: 2.0, points: 5 },
      { minKmpl: 1.8, points: 3 },
      { minKmpl: 0, points: -3 },
    ],
    /** B10: the minimum average speed that qualifies a day for the bonus. */
    minAvgKmh: { kabras: 40, other: 50 },
    /** Not in the workbook: a day this short says nothing about economy. */
    minDistanceKm: 20,
    /** Not in the workbook: outside this a probe reading is not a truck's burn. */
    plausibleKmpl: [0.5, 8] as const,
  },
  speed: {
    /** B20: no penalty up to this far over the limit (GPS / speedometer variance). */
    bufferKmh: 3,
    /** Upper edge of the escalating band; above it every incident is severe. */
    bandTopKmh: 10,
    compliantPoints: 5,
    /** C16:C18 — 1st, 2nd, 3rd-and-later offence in the 4–10 km/h band on one day. */
    bandPoints: [-3, -5, -10],
    /** G18: the 3rd band offence of a day also costs that day's trip-wise pay. */
    bandTripPayOffence: 3,
    severePoints: -15,
    kesPerPoint: 30,
  },
  safety: {
    /** '3 - Incentives' C36. */
    kesPerPoint: 50,
    /** C39: the worst a day's safety violations can cost, in points. */
    dailyFloor: -15,
    /** Sheet '4 - Scoring & Safety' B23:C29. */
    violations: {
      speeding:   { points: -10, label: 'Speeding over 15 km/h above limit', overKmh: 15, detectable: true },
      seatbelt:   { points: -3,  label: 'Seatbelt not fastened', detectable: true },
      phone:      { points: -5,  label: 'Mobile phone use while driving', detectable: true },
      freewheel:  { points: -5,  label: 'Free-wheeling (coasting in neutral)', detectable: true },
      harshBrake: { points: -3,  label: 'Harsh braking over 4.5 m/s²', overMs2: 4.5, detectable: true },
      redLight:   { points: -10, label: 'Running a red light / stop sign', detectable: false },
      headlights: { points: -5,  label: 'Driving without headlights at night', detectable: false },
    },
  },
  /** C38: the most positive incentive points a day can earn. */
  dailyPositiveCap: 20,
  zeroTolerance: {
    /** B40: violations in one day that cost that day's trip-wise pay. */
    tripPayDay: 3,
    /** Violations in a month: one-day suspension without pay, then termination. */
    suspendMonth: 5,
    terminateMonth: 10,
  },
  /** Sheet '6 - Pay Summary' C12: estimated statutory deductions. */
  netDeduction: 0.15,
} as const

/** Back-compat name for the scoring half. */
export const SCORE_RULES = PAY_RULES

export type ViolationKind = keyof typeof PAY_RULES.safety.violations
export type Route = (typeof PAY_RULES.trip.routes)[number]

/**
 * Pay per trip on a route ('2 - Trip-wise Pay' E15:G19): trips a shift allows
 * (hours ÷ TAT), and the daily target spread over them, to the shilling.
 */
export function payPerTrip(route: Route, rules = PAY_RULES): number {
  const trips = rules.trip.shiftHours / route.tatHours
  return Math.round(rules.trip.dailyTarget / trips)
}

/**
 * The route a trip ran, from the names it carries in priority order (the
 * factory it left, then where it was going, then the organisation); the first
 * name that names a route decides. Null when none does.
 */
export function routeOf(names: Array<string | null | undefined>, rules = PAY_RULES): Route | null {
  for (const name of names) {
    const text = name?.toUpperCase()
    if (!text) continue
    const hit = rules.trip.routes.find(r => r.keys.some(k => text.includes(k)))
    if (hit) return hit
  }
  return null
}

/** Fuel points for a day's km/L, before the speed qualifier. */
export function fuelBandPoints(kmpl: number, rules = PAY_RULES): number {
  return rules.fuel.bands.find(b => kmpl >= b.minKmpl)!.points
}

/** One scored event on a driver's day. */
export interface ScoreEvent {
  at:     string
  kind:   'overspeed' | ViolationKind
  vehicleId: string
  plate:  string | null
  /** km/h over the limit (speeding), m/s² (harsh braking), else null. */
  value:  number | null
  points: number
  /** Which rule the points came from: "speed" (§3.2) or "safety" (violations). */
  rule:   'speed' | 'safety'
}

export interface TripInput { at: string; vehicleId: string; plate: string | null; route: Route | null; ref: string | null }

export interface FuelInput {
  distanceKm: number
  burnL: number
  /** Average moving speed, km/h; null when it cannot be measured. */
  avgKmh: number | null
}

export interface DayInput {
  /** km/h over the limit of each speeding incident that day, in time order. */
  overspeeds: Array<{ at: string; vehicleId: string; plate: string | null; overKmh: number }>
  violations: Array<{ at: string; vehicleId: string; plate: string | null; kind: Exclude<ViolationKind, 'speeding'>; value: number | null }>
  /** Completed trips that day. */
  trips?: TripInput[]
  /** The day's distance and fuel on the vehicles held, summed; null without a usable probe. */
  fuel?: FuelInput | null
}

export interface DayScore {
  speedPoints:  number
  speedKes:     number
  fuel: {
    kmpl: number | null
    avgKmh: number | null
    /** Why the day earns no fuel points, when it does not. */
    why: 'no-data' | 'short-day' | 'implausible' | 'too-slow' | null
    points: number
  }
  fuelKes:      number
  /** Positive points given up to the +20 daily cap. */
  cappedPoints: number
  /** Before the daily floor. */
  safetyRaw:    number
  safetyPoints: number
  safetyKes:    number
  violations:   number
  trips:        number
  /** Trips whose route is unknown, so carry no pay. */
  unpricedTrips: number
  /** Trip-wise pay earned, before any zero-tolerance loss. */
  tripPayEarned: number
  /** Trip-wise pay credited: zero on a day it was lost. */
  tripPay:      number
  losesTripPay: boolean
  /** Why the day's trip-wise pay was lost. */
  tripPayLostFor: 'violations' | 'speeding' | null
  lunch:        number
  events:       ScoreEvent[]
}

/** Score one driver's day. Pure. */
export function scoreDay(input: DayInput, rules = PAY_RULES, opts: { kabras?: boolean } = {}): DayScore {
  const events: ScoreEvent[] = []
  const s = rules.speed
  let bandOffences = 0, speedPoints = 0, penalised = false

  for (const o of [...input.overspeeds].sort((a, b) => a.at.localeCompare(b.at))) {
    if (o.overKmh <= s.bufferKmh) continue
    penalised = true
    const points = o.overKmh > s.bandTopKmh
      ? s.severePoints
      : s.bandPoints[Math.min(bandOffences++, s.bandPoints.length - 1)]!
    speedPoints += points
    events.push({ at: o.at, kind: 'overspeed', vehicleId: o.vehicleId, plate: o.plate, value: o.overKmh, points, rule: 'speed' })
    const sv = rules.safety.violations.speeding
    if (o.overKmh > sv.overKmh) {
      events.push({ at: o.at, kind: 'speeding', vehicleId: o.vehicleId, plate: o.plate, value: o.overKmh, points: sv.points, rule: 'safety' })
    }
  }
  if (!penalised) speedPoints = s.compliantPoints

  // ── fuel (§3.1) ──
  const f = rules.fuel
  const fuel: DayScore['fuel'] = { kmpl: null, avgKmh: input.fuel?.avgKmh ?? null, why: null, points: 0 }
  if (!input.fuel || input.fuel.burnL <= 0) fuel.why = 'no-data'
  else if (input.fuel.distanceKm < f.minDistanceKm) fuel.why = 'short-day'
  else {
    const kmpl = input.fuel.distanceKm / input.fuel.burnL
    fuel.kmpl = Math.round(kmpl * 100) / 100
    if (kmpl < f.plausibleKmpl[0] || kmpl > f.plausibleKmpl[1]) fuel.why = 'implausible'
    else {
      const band = fuelBandPoints(kmpl, rules)
      const minKmh = opts.kabras ? f.minAvgKmh.kabras : f.minAvgKmh.other
      // The qualifier guards the BONUS (driving slowly for economy); a poor
      // economy band costs its points either way.
      if (band > 0 && (input.fuel.avgKmh == null || input.fuel.avgKmh < minKmh)) fuel.why = 'too-slow'
      else fuel.points = band
    }
  }

  // The day's positive incentive points stop at the cap (C38).
  const positive = Math.max(speedPoints, 0) + Math.max(fuel.points, 0)
  const cappedPoints = Math.max(0, positive - rules.dailyPositiveCap)
  if (cappedPoints > 0) {
    // Taken off fuel first: speed compliance is the steadier figure.
    const fromFuel = Math.min(cappedPoints, Math.max(fuel.points, 0))
    fuel.points -= fromFuel
    speedPoints -= cappedPoints - fromFuel
  }

  for (const v of input.violations) {
    events.push({ at: v.at, kind: v.kind, vehicleId: v.vehicleId, plate: v.plate, value: v.value,
                  points: rules.safety.violations[v.kind].points, rule: 'safety' })
  }
  events.sort((a, b) => a.at.localeCompare(b.at))

  const safety = events.filter(e => e.rule === 'safety')
  const safetyRaw = safety.reduce((n, e) => n + e.points, 0)
  const safetyPoints = Math.max(safetyRaw, rules.safety.dailyFloor)

  // ── trip-wise pay and lunch ──
  const trips = input.trips ?? []
  const tripPayEarned = trips.reduce((n, t) => n + (t.route ? payPerTrip(t.route, rules) : 0), 0)
  const tripPayLostFor = safety.length >= rules.zeroTolerance.tripPayDay ? 'violations' as const
    : bandOffences >= s.bandTripPayOffence ? 'speeding' as const
    : null

  return {
    speedPoints,
    speedKes: speedPoints * s.kesPerPoint,
    fuel,
    fuelKes: fuel.points * f.kesPerPoint,
    cappedPoints,
    safetyRaw,
    safetyPoints,
    safetyKes: safetyPoints * rules.safety.kesPerPoint,
    violations: safety.length,
    trips: trips.length,
    unpricedTrips: trips.filter(t => !t.route).length,
    tripPayEarned,
    tripPay: tripPayLostFor ? 0 : tripPayEarned,
    losesTripPay: tripPayLostFor != null,
    tripPayLostFor,
    lunch: trips.length > 0 ? rules.lunchPerDay : 0,
    events,
  }
}

/** The month's zero-tolerance standing from its violation count. */
export function monthStanding(violations: number, rules = PAY_RULES): 'ok' | 'suspension' | 'termination' {
  if (violations >= rules.zeroTolerance.terminateMonth) return 'termination'
  if (violations >= rules.zeroTolerance.suspendMonth) return 'suspension'
  return 'ok'
}

/** A month's retainer for one calendar day of it (the retainer is a monthly salary). */
export function retainerForDay(day: string, rules = PAY_RULES): number {
  const [y, m] = day.split('-').map(Number) as [number, number]
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return rules.retainerMonthly / daysInMonth
}

/** One working day's retainer: what a 1-day suspension without pay costs. */
export const suspensionDayKes = (rules = PAY_RULES) => rules.retainerMonthly / rules.workingDaysPerMonth

/** Estimated take-home from gross ('6 - Pay Summary' row 13). */
export const netOf = (gross: number, rules = PAY_RULES) => Math.round(gross * (1 - rules.netDeduction))

/**
 * Harsh-braking force as stored. The tracker's io_254 is g × 100 (the
 * account's 2.7 m/s² threshold shows up as a 0.27 floor in the data), so the
 * `ms2` the harsh-driving worker records is really g. Converted here, once.
 */
export const G = 9.80665
export const harshForceMs2 = (storedG: number): number => storedG * G
