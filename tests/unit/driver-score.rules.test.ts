import { describe, it, expect } from 'vitest'
import { scoreDay, monthStanding, harshForceMs2, SCORE_RULES, PAY_RULES, payPerTrip, routeOf, fuelBandPoints, retainerForDay, suspensionDayKes, netOf } from '../../src/modules/driver-score/driver-score.rules.js'
import { driverScoresQuerySchema, driverScoresPdfQuerySchema } from '../../src/modules/analytics/analytics.schema.js'

const over = (at: string, overKmh: number) => ({ at: `2026-10-29T${at}:00Z`, vehicleId: 'v1', plate: 'KCP 131P', overKmh })
const viol = (at: string, kind: 'seatbelt' | 'phone' | 'freewheel' | 'harshBrake') =>
  ({ at: `2026-10-29T${at}:00Z`, vehicleId: 'v1', plate: 'KCP 131P', kind, value: null })

describe('scoreDay — speed (§3.2)', () => {
  it('a clean day earns the compliance points (5 × KES 30)', () => {
    const d = scoreDay({ overspeeds: [], violations: [] })
    expect(d.speedPoints).toBe(5)
    expect(d.speedKes).toBe(150)
    expect(d.safetyPoints).toBe(0)
  })

  it('up to 3 km/h over is the buffer, not an offence', () => {
    expect(scoreDay({ overspeeds: [over('08:00', 3)], violations: [] }).speedPoints).toBe(5)
  })

  it('escalates in the 4–10 band by offence of the day: −3, −5, −10, −10', () => {
    const d = scoreDay({ overspeeds: [over('08:00', 5), over('09:00', 8), over('10:00', 10), over('11:00', 4)], violations: [] })
    expect(d.speedPoints).toBe(-3 - 5 - 10 - 10)
    expect(d.events.map(e => e.points)).toEqual([-3, -5, -10, -10])
  })

  it('over 10 km/h is −15 whatever the count, and over 15 is also a safety violation', () => {
    const d = scoreDay({ overspeeds: [over('08:00', 12), over('09:00', 20)], violations: [] })
    expect(d.speedPoints).toBe(-30)
    expect(d.safetyPoints).toBe(-10)
    expect(d.violations).toBe(1)
  })
})

describe('scoreDay — safety (violations list)', () => {
  it('sums violation points at KES 50', () => {
    const d = scoreDay({ overspeeds: [], violations: [viol('08:00', 'seatbelt'), viol('09:00', 'phone')] })
    expect(d.safetyPoints).toBe(-8)
    expect(d.safetyKes).toBe(-400)
  })

  it("stops at the workbook's daily floor of −15 ('3 - Incentives' C39)", () => {
    const d = scoreDay({ overspeeds: [over('07:00', 30)], violations: [viol('08:00', 'phone'), viol('09:00', 'phone')] })
    expect(d.safetyRaw).toBe(-20)
    expect(SCORE_RULES.safety.dailyFloor).toBe(-15)
    expect(d.safetyPoints).toBe(-15)
  })

  it('3 violations in a day cost that day\'s trip pay', () => {
    expect(scoreDay({ overspeeds: [], violations: [viol('08:00', 'seatbelt'), viol('09:00', 'seatbelt')] }).losesTripPay).toBe(false)
    expect(scoreDay({ overspeeds: [], violations: [viol('08:00', 'seatbelt'), viol('09:00', 'seatbelt'), viol('10:00', 'harshBrake')] }).losesTripPay).toBe(true)
  })
})

describe('monthStanding', () => {
  it('5 violations a month is a suspension, 10 a termination', () => {
    expect(monthStanding(4)).toBe('ok')
    expect(monthStanding(5)).toBe('suspension')
    expect(monthStanding(10)).toBe('termination')
  })
})

describe('harshForceMs2', () => {
  it('reads the stored force as g (0.27 is the account\'s 2.7 m/s² threshold)', () => {
    expect(harshForceMs2(0.27)).toBeCloseTo(2.65, 1)
    expect(harshForceMs2(0.46)).toBeGreaterThan(4.5)
  })
})

describe('driverScoresQuerySchema', () => {
  it('takes fleet days, in order, at most 31', () => {
    expect(driverScoresQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-31' }).success).toBe(true)
    expect(driverScoresQuerySchema.safeParse({ from: '2026-10-01', to: '2026-11-01' }).success).toBe(false)
    expect(driverScoresQuerySchema.safeParse({ from: '2026-10-29', to: '2026-10-28' }).success).toBe(false)
    expect(driverScoresQuerySchema.safeParse({ from: '29/10/2026', to: '2026-10-30' }).success).toBe(false)
  })
})

// ── the pay structure ('Molasses Truck Drivers Pay Structure', Kabras Bioenergy) ──

const route = (name: string) => PAY_RULES.trip.routes.find(r => r.name.startsWith(name))!
const trip = (at: string, r: string | null) => ({ at: `2026-10-29T${at}:00Z`, vehicleId: 'v1', plate: 'KCP 131P', route: r ? route(r) : null, ref: null })

describe('trip-wise pay (sheet 2)', () => {
  it("prices each route exactly as the workbook's G15:G19 do", () => {
    expect(PAY_RULES.trip.routes.map(r => payPerTrip(r))).toEqual([208, 450, 367, 508, 950])
  })

  it('finds the route from the factory or the destination', () => {
    expect(routeOf(['Ndhiwa', null])?.name).toBe('Sukari to Distillery')
    expect(routeOf([null, 'NAITIRI YARD'])?.name).toBe('Naitiri to Distillery')
    expect(routeOf(['Nzoia Sugar'])?.name).toBe('Nzoia SC to Distillery')
    expect(routeOf(['RAIPLY'])).toBeNull()
    // The factory decides before the organisation's own name.
    expect(routeOf(['Ndhiwa', null, 'KABRAS'])?.name).toBe('Sukari to Distillery')
    expect(routeOf([null, 'RAIPLY', 'KABRAS'])?.name).toBe('Kabras to Distillery')
  })

  it('pays each completed trip, and lunch on a day with at least one', () => {
    const d = scoreDay({ overspeeds: [], violations: [], trips: [trip('08:00', 'Kabras'), trip('11:00', 'Kabras'), trip('14:00', 'Kabras')] })
    expect(d.trips).toBe(3)
    expect(d.tripPay).toBe(3 * 208)
    expect(d.lunch).toBe(200)
    expect(scoreDay({ overspeeds: [], violations: [] }).lunch).toBe(0)
  })

  it('counts a trip with no known route but pays nothing for it', () => {
    const d = scoreDay({ overspeeds: [], violations: [], trips: [trip('08:00', null)] })
    expect(d).toMatchObject({ trips: 1, unpricedTrips: 1, tripPay: 0, lunch: 200 })
  })

  it("loses the day's trip pay on 3 violations, or on the 3rd 4–10 km/h offence (G18)", () => {
    const trips = [trip('06:00', 'Sukari')]
    const v = scoreDay({ overspeeds: [], violations: [viol('08:00', 'seatbelt'), viol('09:00', 'seatbelt'), viol('10:00', 'phone')], trips })
    expect(v).toMatchObject({ tripPayEarned: 950, tripPay: 0, losesTripPay: true, tripPayLostFor: 'violations' })
    const s = scoreDay({ overspeeds: [over('08:00', 5), over('09:00', 6), over('10:00', 7)], violations: [], trips })
    expect(s).toMatchObject({ tripPay: 0, tripPayLostFor: 'speeding' })
    expect(scoreDay({ overspeeds: [over('08:00', 5), over('09:00', 6)], violations: [], trips }).tripPay).toBe(950)
  })
})

describe('fuel incentive (§3.1)', () => {
  const fuel = (km: number, l: number, avgKmh: number | null = 55) => ({ distanceKm: km, burnL: l, avgKmh })

  it('bands at 2.0 and 1.80 km/L: +5, +3, −3 points at KES 50', () => {
    expect([fuelBandPoints(2.1), fuelBandPoints(2.0), fuelBandPoints(1.85), fuelBandPoints(1.8), fuelBandPoints(1.79)]).toEqual([5, 5, 3, 3, -3])
    const d = scoreDay({ overspeeds: [], violations: [], fuel: fuel(210, 100) })
    expect(d.fuel).toMatchObject({ kmpl: 2.1, points: 5, why: null })
    expect(d.fuelKes).toBe(250)
  })

  it('withholds the bonus below the average speed qualifier: 50 km/h, 40 on the Kabras route', () => {
    expect(scoreDay({ overspeeds: [], violations: [], fuel: fuel(210, 100, 45) }).fuel).toMatchObject({ points: 0, why: 'too-slow' })
    expect(scoreDay({ overspeeds: [], violations: [], fuel: fuel(210, 100, 45) }, PAY_RULES, { kabras: true }).fuel.points).toBe(5)
  })

  it('a poor economy costs its points whatever the speed', () => {
    expect(scoreDay({ overspeeds: [], violations: [], fuel: fuel(150, 100, 20) }).fuel.points).toBe(-3)
  })

  it('scores nothing without a usable probe day', () => {
    expect(scoreDay({ overspeeds: [], violations: [] }).fuel.why).toBe('no-data')
    expect(scoreDay({ overspeeds: [], violations: [], fuel: fuel(10, 4) }).fuel.why).toBe('short-day')
    expect(scoreDay({ overspeeds: [], violations: [], fuel: fuel(300, 10) }).fuel).toMatchObject({ why: 'implausible', points: 0 })
  })
})

describe('daily caps (C38:C39)', () => {
  it('positive points never pass +20 a day', () => {
    const rules = { ...PAY_RULES, dailyPositiveCap: 8 } as unknown as typeof PAY_RULES
    const d = scoreDay({ overspeeds: [], violations: [], fuel: { distanceKm: 210, burnL: 100, avgKmh: 60 } }, rules)
    expect(d.speedPoints + d.fuel.points).toBe(8)
    expect(d.cappedPoints).toBe(2)
    expect(PAY_RULES.dailyPositiveCap).toBe(20)
  })
})

describe('retainer, suspension and net (sheets 1, 3.4, 6)', () => {
  it('pro-rates the KES 25,000 retainer by calendar day', () => {
    expect(retainerForDay('2026-10-15') * 31).toBeCloseTo(25_000)
    expect(retainerForDay('2026-02-10') * 28).toBeCloseTo(25_000)
  })
  it('a 1-day suspension costs one working day: 25,000 ÷ 20', () => {
    expect(suspensionDayKes()).toBe(1_250)
  })
  it("estimates net at 85% of gross, as the Pay Summary does (55,050 → 46,793)", () => {
    expect(netOf(55_050)).toBe(46_793)
  })
})

describe('driverScoresPdfQuerySchema', () => {
  it('takes the same range, and drivers as a comma-separated list (all when absent)', () => {
    expect(driverScoresPdfQuerySchema.parse({ from: '2026-10-01', to: '2026-10-07' }).drivers).toBeNull()
    expect(driverScoresPdfQuerySchema.parse({ from: '2026-10-01', to: '2026-10-07', drivers: 'u1, u2,u1,' }).drivers).toEqual(['u1', 'u2'])
    expect(driverScoresPdfQuerySchema.safeParse({ from: '2026-10-01', to: '2026-11-05' }).success).toBe(false)
  })
})
