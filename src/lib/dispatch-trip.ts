/**
 * A dispatch as a ROUND TRIP: yard → destination → yard.
 *
 * The provider models a dispatch as one row with a destination name, a clock,
 * and eventually a return clock. Operationally it is a there-and-back run — a
 * unit is not done when it reaches the cane zone, it is done when it is back at
 * the plant — and this turns the row plus a position into that shape.
 *
 * Everything here is derived from MEASURED points: the yard from the fleet's
 * own densest cluster of fixes, the destination from the median turn-around of
 * completed trips to that name (see prisma/sync-destinations.ts). Where either
 * is missing, this returns a trip with no geometry rather than inventing one —
 * the name still renders, the distances do not.
 *
 * ## On the progress figure
 *
 * A distance bar on a dispatch was built and deliberately removed once before,
 * because it was filled by ELAPSED TIME: a tractor 90% through its typical
 * hours read as 90% done while it sat in the yard having never left. The figure
 * here cannot do that, because it is computed from where the vehicle actually
 * is. In the yard is 0%, whatever the clock says. Half way out is 25%. At the
 * destination is 50%. Back at the plant is 100%.
 *
 * It is still a straight-line ratio, not road distance, so it is a position
 * along the run rather than a fraction of the driving. Callers should render it
 * beside `leg`, which is the categorical truth, and must handle `null` — a
 * vehicle that has not reported since it was dispatched has no position, and
 * "we have not heard from it" is not "it has not moved".
 */

export interface Point { lat: number; lng: number }

export type TripLeg =
  /** Dispatched, but no fix since — nothing can be said about where it is. */
  | 'no-fix'
  /** Reported, still at the yard. The paperwork is raised before the wheels turn. */
  | 'at-yard'
  /** On its way out, not yet seen at the destination. */
  | 'outbound'
  /** Seen within the destination's arrival radius, still out there. */
  | 'at-destination'
  /** Has been to the destination and is heading back. */
  | 'returning'
  /** Back at the yard. The trip is complete in fact; the provider closes it. */
  | 'back'

export interface TripGeometry {
  /** Straight-line yard → destination, metres. Null without a derived point. */
  legM: number | null
  /** There and back. Null without a derived point. */
  roundTripM: number | null
  /** Metres from the yard right now. Null without a current fix. */
  fromYardM: number | null
  /** Metres from the destination right now. */
  toDestinationM: number | null
  /** 0–100 along the round trip, or null when it cannot be measured. */
  percent: number | null
  leg: TripLeg
}

const R_EARTH_M = 6_371_000

export function haversineM(a: Point, b: Point): number {
  const r = Math.PI / 180
  const dLat = (b.lat - a.lat) * r
  const dLng = (b.lng - a.lng) * r
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2
  return 2 * R_EARTH_M * Math.asin(Math.sqrt(h))
}

/**
 * How close counts as "at the yard".
 *
 * The plant is a compound, not a point — its own fixes spread over a couple of
 * hundred metres of weighbridge, workshop and parking — so a tight radius would
 * flicker a stationary unit between at-yard and outbound on GPS noise alone.
 */
export const YARD_RADIUS_M = 800

/**
 * How close counts as "arrived".
 *
 * Scaled by the destination's own measured spread rather than fixed: a name
 * whose trips agree to 60 m is a gate, one that agrees to 900 m is a stretch of
 * field track, and the same radius cannot serve both. The floor covers GPS
 * noise and the fact that a truck parks where it can, not on the pin.
 */
export function arrivalRadiusM(spreadM: number): number {
  return Math.min(Math.max(spreadM * 2, 800), 3_000)
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

export interface TripInput {
  /** The organisation's measured yard. Null before sync:destinations has run. */
  yard: Point | null
  /** The destination's measured point. Null for a name we cannot place. */
  destination: Point | null
  /** Median spread of the destination's measurement, metres. */
  destinationSpreadM: number
  /** Where the vehicle is now. Null when it has never reported. */
  current: Point | null
  /**
   * Whether the vehicle has been seen at the destination during THIS dispatch.
   *
   * Determined from telemetry rather than from proximity right now: a unit
   * heading home passes back through the outbound corridor, so "it is 12 km
   * out" says nothing about which way it is pointing. Without this the return
   * leg would render as an outbound one that keeps losing ground.
   */
  arrived: boolean
  /** Whether any fix at all has landed since the dispatch clock. */
  hasFixSinceDispatch: boolean
}

export function tripGeometry(input: TripInput): TripGeometry {
  const { yard, destination, destinationSpreadM, current, arrived, hasFixSinceDispatch } = input

  const legM = yard && destination ? Math.round(haversineM(yard, destination)) : null
  const roundTripM = legM != null ? legM * 2 : null

  if (!current || !hasFixSinceDispatch) {
    return { legM, roundTripM, fromYardM: null, toDestinationM: null, percent: null, leg: 'no-fix' }
  }

  const fromYardM = yard ? Math.round(haversineM(yard, current)) : null
  const toDestinationM = destination ? Math.round(haversineM(destination, current)) : null

  // Categorical first — the leg is knowable from the yard alone, so a
  // destination we could not place still gets "it has left" / "it is back",
  // which is most of what an operator wants.
  let leg: TripLeg
  const atYard = fromYardM != null && fromYardM <= YARD_RADIUS_M
  const atDest = toDestinationM != null && toDestinationM <= arrivalRadiusM(destinationSpreadM)

  if (atDest)             leg = 'at-destination'
  else if (arrived)       leg = atYard ? 'back' : 'returning'
  else if (atYard)        leg = 'at-yard'
  else                    leg = 'outbound'

  // No destination point ⇒ no denominator ⇒ no percentage. The leg above still
  // stands; this is the number we refuse to invent.
  if (legM == null || legM === 0 || fromYardM == null) {
    return { legM, roundTripM, fromYardM, toDestinationM, percent: null, leg }
  }

  // Outbound fills the first half by how far from the yard it has got; the
  // return fills the second half by how much of that it has given back. Both
  // are measured from position, so time passing alone never moves the bar.
  const percent = (leg === 'at-yard' || leg === 'outbound')
    ? Math.round(clamp01(fromYardM / legM) * 50)
    : leg === 'at-destination'
      ? 50
      : 50 + Math.round(clamp01(1 - fromYardM / legM) * 50)

  return { legM, roundTripM, fromYardM, toDestinationM, percent, leg }
}
