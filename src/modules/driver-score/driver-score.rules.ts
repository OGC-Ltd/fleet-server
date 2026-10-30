/**
 * Driver scorecard: the points rules from the driver pay proposal (sheets
 * "3. Incentive Matrix (revised)" §3.2 / §3.4 and "C) Life-saving safety
 * violations"), as one config and one pure function per driver-day.
 *
 * Only what telemetry can measure is scored here. Fuel (§3.1) waits on a probe
 * km/L that can be trusted (MENENGAI's median truck-day reads 3.7 km/L), and
 * vehicle care (§3.3), attendance and trip-wise pay are not in our data — the
 * scorecard lists them as manual.
 *
 * Where the sheets disagree the first-listed source wins and the conflict is
 * named next to the number, so the data analyst can settle it in one place:
 *
 *   · speeding over the limit is in BOTH §3.2 (> 10 km/h: −15 × KES 30) and the
 *     violations list (> 15 km/h: −10 × KES 50). Both are applied, as written.
 *   · the daily safety cap is −13 points (sheet C, and §3.4's own explanation);
 *     §3.4's table says −15.
 *   · an "offence" in the 4–10 km/h band is counted per DAY.
 *   · nothing on the sheets earns positive SAFETY points, so none are given.
 */

export const SCORE_RULES = {
  speed: {
    /** No penalty up to this far over the limit (GPS / speedometer variance). */
    bufferKmh: 3,
    /** Upper edge of the escalating band; above it every incident is severe. */
    bandTopKmh: 10,
    compliantPoints: 5,
    /** 1st, 2nd, 3rd-and-later offence in the 4–10 km/h band on one day. */
    bandPoints: [-3, -5, -10],
    severePoints: -15,
    kesPerPoint: 30,
  },
  safety: {
    kesPerPoint: 50,
    /** Worst day, in points. Sheet C and §3.4's explanation; §3.4's table says −15. */
    dailyFloor: -13,
    violations: {
      speeding:   { points: -10, label: 'Speeding over 15 km/h above limit', overKmh: 15 },
      seatbelt:   { points: -3,  label: 'Seatbelt not fastened' },
      phone:      { points: -5,  label: 'Mobile phone use while driving' },
      freewheel:  { points: -5,  label: 'Free-wheeling (coasting in neutral)' },
      harshBrake: { points: -3,  label: 'Harsh braking over 4.5 m/s²', overMs2: 4.5 },
    },
  },
  zeroTolerance: {
    /** Violations in one day that cost that day's trip-wise pay. */
    tripPayDay: 3,
    /** Violations in a month: one-day suspension, then termination. */
    suspendMonth: 5,
    terminateMonth: 10,
  },
} as const

export type ViolationKind = keyof typeof SCORE_RULES.safety.violations

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

export interface DayInput {
  /** km/h over the limit of each speeding incident that day, in time order. */
  overspeeds: Array<{ at: string; vehicleId: string; plate: string | null; overKmh: number }>
  violations: Array<{ at: string; vehicleId: string; plate: string | null; kind: Exclude<ViolationKind, 'speeding'>; value: number | null }>
}

export interface DayScore {
  speedPoints:  number
  speedKes:     number
  /** Before the daily floor. */
  safetyRaw:    number
  safetyPoints: number
  safetyKes:    number
  violations:   number
  losesTripPay: boolean
  events:       ScoreEvent[]
}

/** Score one driver's day. Pure. */
export function scoreDay(input: DayInput, rules = SCORE_RULES): DayScore {
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

  for (const v of input.violations) {
    events.push({ at: v.at, kind: v.kind, vehicleId: v.vehicleId, plate: v.plate, value: v.value,
                  points: rules.safety.violations[v.kind].points, rule: 'safety' })
  }
  events.sort((a, b) => a.at.localeCompare(b.at))

  const safety = events.filter(e => e.rule === 'safety')
  const safetyRaw = safety.reduce((n, e) => n + e.points, 0)
  const safetyPoints = Math.max(safetyRaw, rules.safety.dailyFloor)
  return {
    speedPoints,
    speedKes: speedPoints * s.kesPerPoint,
    safetyRaw,
    safetyPoints,
    safetyKes: safetyPoints * rules.safety.kesPerPoint,
    violations: safety.length,
    losesTripPay: safety.length >= rules.zeroTolerance.tripPayDay,
    events,
  }
}

/** The month's zero-tolerance standing from its violation count. */
export function monthStanding(violations: number, rules = SCORE_RULES): 'ok' | 'suspension' | 'termination' {
  if (violations >= rules.zeroTolerance.terminateMonth) return 'termination'
  if (violations >= rules.zeroTolerance.suspendMonth) return 'suspension'
  return 'ok'
}

/**
 * Harsh-braking force as stored. The tracker's io_254 is g × 100 (the
 * account's 2.7 m/s² threshold shows up as a 0.27 floor in the data), so the
 * `ms2` the harsh-driving worker records is really g. Converted here, once.
 */
export const G = 9.80665
export const harshForceMs2 = (storedG: number): number => storedG * G
