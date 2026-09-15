/**
 * The Naitiri → Raiply sales run, end to end as geometry.
 *
 * This route is the reason `known-destinations` and the OpenTrip origin exist,
 * and it is the one route where every figure can be checked against something
 * outside this repository: the gate and the destination are both the operator's
 * stated coordinates, and the dash holds an independent surveyed KML of each
 * site. So these tests pin the numbers rather than the plumbing — the plumbing
 * is exercised by the integration suite, and a wrong coordinate here would pass
 * every one of those while putting a truck 50 km from where it is.
 *
 * What would break if this file were absent: a stated point silently dropping
 * out of the table (no Raiply row means no far end, which renders as "distance
 * not measured" rather than as an error), and a gate coordinate drifting into
 * the wrong hemisphere or the wrong district without anything saying so.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/lib/prisma.js')

import { FACTORIES } from '../../src/modules/webhooks/factory-map.js'
import { knownDestination, KNOWN_DESTINATIONS } from '../../src/modules/dispatches/known-destinations.js'
import { haversineM, tripGeometry, YARD_RADIUS_M, arrivalRadiusM } from '../../src/lib/dispatch-trip.js'

const NAITIRI = { lat: FACTORIES.NAITIRI.lat, lng: FACTORIES.NAITIRI.lng }
const RAIPLY  = { lat: KNOWN_DESTINATIONS.RAIPLY.lat, lng: KNOWN_DESTINATIONS.RAIPLY.lng }

describe('the stated destinations table', () => {
  it('places Raiply, which the measured table never will', () => {
    // Every live Naitiri sales row closed between 15 seconds and 32 minutes
    // after sign-out (measured 2026-09-15), so `dispatch_destinations` — which
    // is built from completed round trips — holds nothing for this name and
    // cannot accumulate one. The stated point is the only far end this route
    // will ever have.
    expect(knownDestination('Raiply')).not.toBeNull()
  })

  it('matches the provider through its own inconsistent spelling', () => {
    // Both of these are on live rows for the same route in the same week.
    expect(knownDestination('RaiPly')).toEqual(knownDestination('Raiply'))
    expect(knownDestination('  raiply ')).toEqual(knownDestination('Raiply'))
  })

  it('places Raiply in Uasin Gishu, east of the factory and north of the equator', () => {
    expect(RAIPLY.lat).toBeGreaterThan(0.4)
    expect(RAIPLY.lat).toBeLessThan(0.7)
    expect(RAIPLY.lng).toBeGreaterThan(35.1)
    expect(RAIPLY.lng).toBeLessThan(35.4)
    // East and south of Naitiri — the run goes down-country, and a sign slip
    // on either axis is the single most likely way this table goes wrong.
    expect(RAIPLY.lng).toBeGreaterThan(NAITIRI.lng)
    expect(RAIPLY.lat).toBeLessThan(NAITIRI.lat)
  })

  it('places nothing it was not given', () => {
    // It is not a geocoder and must not become one. An unknown name falls
    // through to the measured table and then to "no distance".
    expect(knownDestination('OPAPO')).toBeNull()
    expect(knownDestination('')).toBeNull()
    expect(knownDestination(null)).toBeNull()
    expect(knownDestination(undefined)).toBeNull()
  })

  it('gives Raiply an arrival radius a truck can park inside', () => {
    // 400 m of stated spread puts the radius on the 800 m floor: the point is
    // a gate, and a lorry stands in the yard behind it, not on the pin.
    expect(arrivalRadiusM(KNOWN_DESTINATIONS.RAIPLY.spreadM)).toBe(800)
  })
})

describe('the run as a distance', () => {
  it('is the ~50 km the operator describes', () => {
    expect(haversineM(NAITIRI, RAIPLY) / 1000).toBeGreaterThan(48)
    expect(haversineM(NAITIRI, RAIPLY) / 1000).toBeLessThan(52)
  })

  it('leaves the gate far enough out that the run is not born already arrived', () => {
    // A leg shorter than the yard radius would have the truck at-yard and
    // at-destination simultaneously, and the percentage would be meaningless.
    expect(haversineM(NAITIRI, RAIPLY)).toBeGreaterThan(YARD_RADIUS_M * 10)
  })
})

describe('tripGeometry over the real route', () => {
  const geo = (current: { lat: number; lng: number } | null, arrived = false) =>
    tripGeometry({
      yard: NAITIRI,
      destination: RAIPLY,
      destinationSpreadM: KNOWN_DESTINATIONS.RAIPLY.spreadM,
      current,
      arrived,
      hasFixSinceDispatch: current != null,
    })

  it('reads at-yard at the gate — which is what stops a stale run looking live', () => {
    // The origin fix is load-bearing here. With no yard point, `fromYardM` is
    // null, `atYard` is false, and the leg falls through to 'outbound' — which
    // the snapshot's day filter keeps indefinitely. A sales row the provider
    // never closed then declared its tonnage on a parked truck for days.
    expect(geo(NAITIRI).leg).toBe('at-yard')
    expect(geo(NAITIRI).percent).toBe(0)
  })

  it('fills the first half outbound and never overshoots it', () => {
    const half = geo({ lat: 0.6557, lng: 35.0639 })
    expect(half.leg).toBe('outbound')
    expect(half.percent).toBeGreaterThan(20)
    expect(half.percent).toBeLessThan(30)
  })

  it('pins the bar at half on arrival at Raiply', () => {
    expect(geo(RAIPLY).leg).toBe('at-destination')
    expect(geo(RAIPLY).percent).toBe(50)
  })

  it('completes at the gate it started from, not at the owner’s hub', () => {
    const home = geo(NAITIRI, true)
    expect(home.leg).toBe('back')
    expect(home.percent).toBe(100)
  })

  it('says nothing at all when the unit has not reported since sign-out', () => {
    const silent = tripGeometry({
      yard: NAITIRI,
      destination: RAIPLY,
      destinationSpreadM: KNOWN_DESTINATIONS.RAIPLY.spreadM,
      current: NAITIRI,
      arrived: false,
      hasFixSinceDispatch: false,
    })
    expect(silent.leg).toBe('no-fix')
    expect(silent.percent).toBeNull()
    // The leg length is a property of the route and survives the silence —
    // "we do not know where it is" is not "we do not know how far it is".
    expect(silent.legM).toBeGreaterThan(48_000)
  })
})

describe('the gate the sugar leaves from', () => {
  it('ships processed sugar in bags, which is what makes the load nameable', () => {
    // The /sales payload carries a tonnage and never says what of. The site is
    // the only place the commodity is known.
    expect(FACTORIES.NAITIRI.commodity).toBe('Processed Sugar')
    expect(FACTORIES.NAITIRI.cargoType).toBe('PACKAGED')
  })

  it('stays within a yard radius of the survey the dash draws', () => {
    // The operator has restated this gate twice on the same day; both figures
    // and the older derived one sit inside ~90 m of each other. That slack is
    // fine and this test says how much of it is fine: anything beyond the yard
    // radius would start changing at-yard verdicts.
    const surveyedGate = { lat: 0.7811577, lng: 34.8770457 }  // public/naitiri-site.geojson
    expect(haversineM(NAITIRI, surveyedGate)).toBeLessThan(YARD_RADIUS_M)
  })
})

describe('the legs that mean the load has come off', () => {
  // telemetry.service empties the bed on 'at-destination' | 'returning' |
  // 'back', on the claim that those three are exactly the legs reachable once
  // the unit has been seen at the far end. If that stopped being true, a truck
  // would be emptied on its way OUT — 29 t written off the fleet's in-transit
  // stock while the sugar is still on the bed — and nothing else would fail.
  const geo = (current: { lat: number; lng: number }, arrived: boolean) =>
    tripGeometry({
      yard: NAITIRI,
      destination: RAIPLY,
      destinationSpreadM: KNOWN_DESTINATIONS.RAIPLY.spreadM,
      current,
      arrived,
      hasFixSinceDispatch: true,
    }).leg

  const DELIVERED = ['at-destination', 'returning', 'back']
  const midway = { lat: 0.6557, lng: 35.0639 }

  it('are unreachable before the unit has been to the destination', () => {
    expect(DELIVERED).not.toContain(geo(NAITIRI, false))   // at-yard
    expect(DELIVERED).not.toContain(geo(midway,  false))   // outbound
  })

  it('are all reachable after it has', () => {
    expect(DELIVERED).toContain(geo(RAIPLY,  false))       // at-destination
    expect(DELIVERED).toContain(geo(midway,  true))        // returning
    expect(DELIVERED).toContain(geo(NAITIRI, true))        // back
  })

  it('treat standing in the destination as arrival without needing history', () => {
    // The `arrived` flag comes from telemetry since dispatch, but a unit sitting
    // inside the radius right now is delivered whatever the history says —
    // otherwise the bed would stay full through the whole offload.
    expect(geo(RAIPLY, false)).toBe('at-destination')
  })
})
