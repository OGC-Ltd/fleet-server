import { describe, expect, it } from 'vitest'
import { incidentStaysOpen, FUEL_INCIDENT_WINDOW_MS } from '../../src/modules/telemetry/telemetry.repository.js'

const now = Date.UTC(2026, 9, 15, 6, 0)
const ago = (h: number) => now - h * 3_600_000
const base = { cause: 'SIPHON', reviewStatus: null, dismissedAt: null }

describe('incidentStaysOpen', () => {
  it('keeps an unreviewed theft case past 24 h until someone reviews it', () => {
    expect(incidentStaysOpen({ ...base, beganAtMs: ago(60) }, now)).toBe(true)
  })

  it('takes it down once dismissed', () => {
    expect(incidentStaysOpen({ ...base, dismissedAt: new Date(now), beganAtMs: ago(60) }, now)).toBe(false)
  })

  it('lets a reviewed theft case lapse after 24 h as before', () => {
    expect(incidentStaysOpen({ ...base, reviewStatus: 'CONFIRMED_THEFT', beganAtMs: ago(20) }, now)).toBe(true)
    expect(incidentStaysOpen({ ...base, reviewStatus: 'CONFIRMED_THEFT', beganAtMs: ago(30) }, now)).toBe(false)
  })

  it('lets anything that is not a theft case lapse after 24 h', () => {
    expect(incidentStaysOpen({ ...base, cause: 'HIGH_BURN', beganAtMs: now - FUEL_INCIDENT_WINDOW_MS - 1 }, now)).toBe(false)
  })

  it('never reaches behind the clean-slate epoch', () => {
    expect(incidentStaysOpen({ ...base, beganAtMs: Date.UTC(2026, 7, 1) }, now)).toBe(false)
  })
})
