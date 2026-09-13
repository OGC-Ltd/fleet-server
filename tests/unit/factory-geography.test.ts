/**
 * Where the factories are.
 *
 * A coordinate is the one kind of constant that cannot be reviewed by reading
 * it — 0.3358 and -0.8234 look equally like numbers, and NDHIWA carried the
 * first of those for as long as this table has existed (it was the Kakamega
 * "Sukari HQ" point, 129 km and one hemisphere away). Nothing read the field,
 * so nothing complained.
 *
 * These pin the site against the fleet that works there, which is the only
 * check that would have caught it: a factory's own units are at the factory.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/lib/prisma.js')

import { FACTORIES } from '../../src/modules/webhooks/factory-map.js'

describe('factory coordinates', () => {
  it('puts Ndhiwa in Homa Bay, south of the equator', () => {
    // The gate as the operator states it: -0.82340 / 34.38449. Corroborated
    // by the median of 268,032 SUKARI fixes (-0.82001 / 34.38443) and by the
    // mill's own two weighbridges (-0.8227 / 34.3832).
    const f = FACTORIES.NDHIWA
    expect(f.lat).toBeGreaterThan(-0.9)
    expect(f.lat).toBeLessThan(-0.75)
    expect(f.lng).toBeGreaterThan(34.3)
    expect(f.lng).toBeLessThan(34.5)
  })

  it('puts Naitiri in Bungoma, north of it', () => {
    // The sign differs between the two sites, which is what makes a copied
    // coordinate here look plausible rather than absurd.
    const f = FACTORIES.NAITIRI
    expect(f.lat).toBeGreaterThan(0.7)
    expect(f.lat).toBeLessThan(0.9)
    expect(f.lng).toBeGreaterThan(34.8)
    expect(f.lng).toBeLessThan(35.0)
  })

  it('keeps every factory inside Kenya', () => {
    // A cheap floor for the next site added by hand: a transposed pair or a
    // dropped minus lands outside this box long before it lands in the wrong
    // county.
    for (const [code, f] of Object.entries(FACTORIES)) {
      expect(f.lat, code).toBeGreaterThan(-4.8)
      expect(f.lat, code).toBeLessThan(5.1)
      expect(f.lng, code).toBeGreaterThan(33.9)
      expect(f.lng, code).toBeLessThan(41.9)
    }
  })
})
