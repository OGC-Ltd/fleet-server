// Costing for the fuel ledger aggregate (analytics.repository's
// fuelConsumption). Split out from the query for two reasons:
//
//  - The database records litres, never money. There is no price column on
//    FuelFilling, no supplier invoice table, nothing. Cost is therefore always
//    a DERIVED figure — litres × a rate someone supplies — and keeping that
//    derivation in one pure function makes it obvious which numbers are
//    measured and which are modelled.
//  - The quantities are cached and warmed per org+window (fuel-cost.cache.ts).
//    Pricing here, on the way out, keeps `pricePerLitre` out of the cache key,
//    so an operator re-pricing a period never evicts anyone else's entry.
//
// This replaces what the dashboard used to do client-side: estimate litres from
// distance at an assumed 35 L/100km and price them at a hardcoded constant. The
// litres below are real ledger rows.

import type { fuelConsumption } from './analytics.repository.js'

type FuelConsumption = Awaited<ReturnType<typeof fuelConsumption>>

/** Millilitres → litres, 1 dp — the precision a fuel probe actually resolves. */
const litres = (ml: number) => Math.round(ml / 100) / 10

/**
 * Money, rounded to whole currency units.
 *
 * Costed from millilitres, NOT from the rounded litres above: rounding each
 * vehicle to 0.1 L and then multiplying would let the per-vehicle costs drift
 * away from the total by a few units across a large fleet, and a total that
 * doesn't equal the sum of its rows is the one thing an operator will notice.
 */
const cost = (ml: number, pricePerLitre: number) => Math.round((ml / 1000) * pricePerLitre)

export interface FuelPricing {
  pricePerLitre: number
  currency:      string
  /** Where the rate came from: the server's configured default, or this request. */
  source:        'configured' | 'request'
}

/**
 * Turn the raw ledger aggregate into the payload clients render: litres and
 * money on every level, the price echoed back so the UI never has to guess
 * which rate produced the figures it is showing.
 */
export function priceFuelConsumption(data: FuelConsumption, { pricePerLitre, currency, source }: FuelPricing) {
  const { totals } = data
  // Per-day means divide by ACTIVE days, not window days: a fleet that fuelled
  // on 4 days out of 30 burns its fuel on those 4: dividing by 30 would report
  // a daily rate no day ever saw. Matches deliveriesAnalytics' perDayKm.
  const perDay = totals.activeDays || 1

  return {
    // The rate every money figure below was computed at, and where it came
    // from — `configured` when the server default applied, `request` when the
    // caller overrode it. The dashboard prints this next to the totals.
    price: { pricePerLitre, currency, source },

    totals: {
      litresFilled: litres(totals.filledMl),
      litresLost:   litres(totals.stolenMl),
      cost:         cost(totals.filledMl, pricePerLitre),
      // What the drains cost — the number that justifies chasing them.
      lossCost:     cost(totals.stolenMl, pricePerLitre),
      fillings:     totals.fillings,
      thefts:       totals.thefts,
      windowDays:   totals.windowDays,
      activeDays:   totals.activeDays,
    },

    averages: {
      perDayLitres: Math.round((totals.filledMl / perDay) / 100) / 10,
      perDayCost:   Math.round(cost(totals.filledMl, pricePerLitre) / perDay),
    },

    byDay: data.byDay.map(d => ({
      day:          d.day,
      litresFilled: litres(d.filledMl),
      litresLost:   litres(d.stolenMl),
      cost:         cost(d.filledMl, pricePerLitre),
      lossCost:     cost(d.stolenMl, pricePerLitre),
      fillings:     d.fillings,
      thefts:       d.thefts,
      // Mean per-vehicle probe slosh that day, and the vehicles behind it.
      // NOT priced: turbulence is fuel moving INSIDE a tank, not fuel bought or
      // lost, and costing it would invent a number. Null, never 0, where the
      // day has no reading — see the repository's note on why that is the
      // normal case for the current day.
      turbulenceL:  d.turbulenceMl == null ? null : litres(d.turbulenceMl),
      turbulenceVehicles: d.turbulenceVehicles,
    })),

    byVehicle: data.byVehicle.map(v => ({
      vehicleId:         v.vehicleId,
      registrationPlate: v.registrationPlate,
      name:              v.name,
      litresFilled:      litres(v.filledMl),
      litresLost:        litres(v.stolenMl),
      cost:              cost(v.filledMl, pricePerLitre),
      lossCost:          cost(v.stolenMl, pricePerLitre),
      fillings:          v.fillings,
      thefts:            v.thefts,
    })),

    /**
     * The individual drains behind `totals.litresLost`, newest first.
     *
     * Priced here like every other level, so the report's table and the
     * "Litres lost" figure above it are the same litres at the same rate.
     *
     * This function REBUILDS the payload field by field rather than spreading
     * the aggregate, which is deliberate — a client only ever sees what is
     * named here — but it means a new field on the repository reaches nobody
     * until it is named here too. `drains` was added upstream and silently
     * dropped at this line, and nothing failed: the endpoint kept returning a
     * valid payload with the key simply absent, and the report rendered no
     * table rather than an error.
     */
    drains: data.drains.map(d => ({
      id:                d.id,
      vehicleId:         d.vehicleId,
      registrationPlate: d.registrationPlate,
      name:              d.name,
      beganAt:           d.beganAt,
      litres:            litres(d.stolenMl),
      cost:              cost(d.stolenMl, pricePerLitre),
      // The FSL either side of the fall, in litres. Carried so the row shows
      // the tank level the probe read at that hour rather than only the
      // difference — and so `levelBefore - levelAfter` visibly equals `litres`,
      // which it does on every drain measured over 30 days. Null-safe: a level
      // is absent, never zero, when the probe said nothing.
      levelBefore:       d.levelBeforeMl == null ? null : litres(d.levelBeforeMl),
      levelAfter:        d.levelAfterMl  == null ? null : litres(d.levelAfterMl),
      location:          d.location,
      cause:             d.cause,
      causeReason:       d.causeReason,
      verdict:           d.verdict,
      // Whether an operator was told. 90 of 3,275 over 30 days — the gap
      // between what the ledger RECORDS and what the detector CLAIMS.
      announced:         d.announced,
      // Null on rows judged before 2026-08-28 — never back-computed.
      fallSeconds:       d.fallSeconds,
    })),
  }
}
