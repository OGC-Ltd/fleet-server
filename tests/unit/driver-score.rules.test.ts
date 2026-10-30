import { describe, it, expect } from 'vitest'
import { scoreDay, monthStanding, harshForceMs2, SCORE_RULES } from '../../src/modules/driver-score/driver-score.rules.js'
import { driverScoresQuerySchema } from '../../src/modules/analytics/analytics.schema.js'

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

  it('stops at the daily floor of −13', () => {
    const d = scoreDay({ overspeeds: [over('07:00', 30)], violations: [viol('08:00', 'phone'), viol('09:00', 'phone')] })
    expect(d.safetyRaw).toBe(-20)
    expect(d.safetyPoints).toBe(SCORE_RULES.safety.dailyFloor)
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
