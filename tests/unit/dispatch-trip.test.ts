/**
 * The round-trip geometry behind the Active Trip bar.
 *
 * A distance bar on a dispatch was built and removed once already, because it
 * was filled by ELAPSED TIME and so read 90% on a tractor that had never left
 * the yard. These pin the property that makes the replacement safe: the figure
 * is a function of POSITION alone, so time passing can never move it — plus
 * the cases where it must refuse to produce a number at all.
 */

import { describe, it, expect } from 'vitest'
import { tripGeometry, arrivalRadiusM, YARD_RADIUS_M } from '../../src/lib/dispatch-trip.js'

// Measured points, from the live Sukari fleet (prisma/sync-destinations).
const YARD    = { lat: -0.821769, lng: 34.381997 }
const NYAONDO = { lat: -0.91128,  lng: 34.61348  }   // 27.6 km out, ±83 m
const SPREAD  = 83

/** Fraction f of the way along the straight line yard → destination. */
const along = (f: number) => ({
  lat: YARD.lat + (NYAONDO.lat - YARD.lat) * f,
  lng: YARD.lng + (NYAONDO.lng - YARD.lng) * f,
})

const base = { yard: YARD, destination: NYAONDO, destinationSpreadM: SPREAD, hasFixSinceDispatch: true }

describe('tripGeometry', () => {
  it('measures the leg and the round trip from the two anchors', () => {
    const t = tripGeometry({ ...base, current: YARD, arrived: false })
    // Sanity against the derivation's own figure: 27.6 km out, so ~55 km back
    // and forth.
    expect(t.legM).toBeGreaterThan(27_000)
    expect(t.legM).toBeLessThan(28_500)
    expect(t.roundTripM).toBe(t.legM! * 2)
  })

  it('reads 0% in the yard, however long ago the dispatch was raised', () => {
    // The failure that got the old bar deleted. Dispatch time is when the
    // paperwork was raised; a unit can sit in the yard for hours after it.
    const t = tripGeometry({ ...base, current: YARD, arrived: false })
    expect(t.leg).toBe('at-yard')
    expect(t.percent).toBe(0)
  })

  it('fills the FIRST half on the way out', () => {
    const t = tripGeometry({ ...base, current: along(0.5), arrived: false })
    expect(t.leg).toBe('outbound')
    expect(t.percent).toBe(25)   // half of the outbound leg = a quarter of the run
  })

  it('reads 50% at the destination', () => {
    const t = tripGeometry({ ...base, current: NYAONDO, arrived: true })
    expect(t.leg).toBe('at-destination')
    expect(t.percent).toBe(50)
  })

  it('fills the SECOND half on the way home', () => {
    // Same point as the outbound case — only `arrived` differs. Distance from
    // the yard cannot tell the two legs apart, which is exactly why arrival is
    // established from history rather than from proximity.
    const out  = tripGeometry({ ...base, current: along(0.5), arrived: false })
    const home = tripGeometry({ ...base, current: along(0.5), arrived: true })
    expect(out.percent).toBe(25)
    expect(home.leg).toBe('returning')
    expect(home.percent).toBe(75)
  })

  it('completes at 100% back in the yard', () => {
    const t = tripGeometry({ ...base, current: YARD, arrived: true })
    expect(t.leg).toBe('back')
    expect(t.percent).toBe(100)
  })

  it('gives no percentage, and no leg, when nothing was heard since dispatch', () => {
    // 20 of the 52 open runs on 2026-08-03. "We have not heard from it" is not
    // "it has not moved", and must not render as 0%.
    const t = tripGeometry({ ...base, current: YARD, arrived: false, hasFixSinceDispatch: false })
    expect(t.leg).toBe('no-fix')
    expect(t.percent).toBeNull()
  })

  it('still reports the leg for a destination it cannot place, but no percentage', () => {
    // 58 of Sukari's destination names have too few completed trips to measure,
    // and one is too spread out to be a point. Those runs still need "it has
    // left" / "it is back" — that only needs the yard.
    const t = tripGeometry({
      ...base, destination: null, destinationSpreadM: 0,
      current: along(0.5), arrived: false,
    })
    expect(t.leg).toBe('outbound')
    expect(t.legM).toBeNull()
    expect(t.percent).toBeNull()
  })

  it('does not flicker on GPS noise inside the yard', () => {
    // The plant is a compound — weighbridge, workshop, parking — and its own
    // fixes spread over a couple of hundred metres.
    const nudged = { lat: YARD.lat + 0.003, lng: YARD.lng }   // ~330 m
    const t = tripGeometry({ ...base, current: nudged, arrived: false })
    expect(t.fromYardM).toBeLessThan(YARD_RADIUS_M)
    expect(t.leg).toBe('at-yard')
  })

  it('scales the arrival radius to how tightly the destination was measured', () => {
    // A name whose trips agree to 60 m is a gate; one that agrees to 900 m is a
    // stretch of field track, and one radius cannot serve both.
    expect(arrivalRadiusM(60)).toBe(800)      // floor covers GPS noise
    expect(arrivalRadiusM(900)).toBe(1800)
    expect(arrivalRadiusM(9000)).toBe(3000)   // capped
  })
})
