/**
 * Litres per engine-hour for a day, corrected for probe turbulence.
 *
 * The operator's formula, supplied 2026-08-16 with the DZ 14 worked example:
 *
 *     normalised = ((A - B) * (1 - (C / (A - B))^2)) / D
 *     min        = ((A - B) - C) / D
 *     max        = ((A - B) + C) / D
 *
 *   A = opening level, B = closing level, C = turbulence (±L), D = engine hours
 *
 * ## Why this belongs beside the existing figures rather than replacing them
 *
 * The operator's challenge was specific: *"Stop using km for excavators, bull
 * dozers or heavy machinery... at least manually divide fuel used by engine
 * hours — that single number will save you from false theft alarms."*
 *
 * `fuel-rate` already does exactly that for the ALERT path, which is why DZ 14
 * raises nothing today. What still shows a distance figure is the DAILY panel:
 * `fuel-tank-state` carries `expectedBurnMl` at a flat `KM_PER_LITRE = 2`, and
 * on a machine that works without travelling that produces the 0.06 km/L the
 * operator objected to. This is the per-day answer to that, in the units the
 * work is actually done in.
 *
 * What it adds over a bare `consumed / hours` is the TURBULENCE correction:
 * the same probe swing that `fuel-tank-state` already measures per run is used
 * to discount a day's consumption by how much of it the instrument could have
 * invented, and to put a band around the answer instead of a single number.
 *
 * ## Where the published formula is guarded, and why it has to be
 *
 * The shrinkage term `1 - (C/(A-B))^2` is well behaved while turbulence is
 * small against consumption, and inverts when it is not. Checked against the
 * operator's own example machine, `MUFINDI: DZ 14` on 2026-08-10 — consumption
 * -7.8 L, turbulence 32.0 L:
 *
 *     (32.0 / -7.8)^2 = 16.83   →   1 - 16.83 = -15.83
 *     -7.8 * -15.83   = +123 L
 *
 * A day the tank ENDED HIGHER than it started becomes 123 litres burned. The
 * sign flips twice and the result is confidently wrong rather than obviously
 * broken, which is the dangerous kind.
 *
 * So the factor is clamped to [0, 1] and the degenerate inputs return null
 * rather than a number:
 *
 *   · **no engine time** — a rate needs a denominator
 *   · **consumption at or below zero** — the tank did not fall, so there is no
 *     burn to normalise. On this fleet that is not an edge case: three of DZ
 *     14's last eight days are negative.
 *   · **turbulence at or above consumption** — the factor floors at 0 and the
 *     day is reported as unmeasurable, because a reading whose noise exceeds
 *     its signal is exactly that. `noiseDominates` says which case it was.
 *
 * The clamp preserves the formula's intent — discount the burn by the relative
 * noise — and removes only the region where the algebra contradicts it.
 */

/** A day's consumption expressed as a rate, with the band turbulence implies. */
export interface NormalisedRate {
  /** Litres per engine-hour, turbulence-corrected. */
  lPerHour:    number
  /** The same day with the turbulence subtracted from consumption. */
  minLPerHour: number
  /** ...and added to it. */
  maxLPerHour: number
  /**
   * Turbulence met or exceeded the consumption it was correcting, so the
   * corrected figure floored at zero. The day HAS a min/max band but its
   * central estimate carries no information — the probe moved at least as much
   * as the tank did.
   */
  noiseDominates: boolean
}

/**
 * Normalise one day.
 *
 * Millilitres and seconds in, litres-per-hour out, matching how the trend rows
 * are stored (`consumedMl`, `turbulenceMl`, `engineSeconds`) — the conversion
 * is done here so no caller has to remember which unit each column is in.
 *
 * `turbulenceMl` is null on rows written before it existed and on machines with
 * too few runs to average; that is treated as ZERO correction rather than as a
 * missing day, so the figure degrades to plain consumption-over-hours.
 */
export function normalisedRate(
  consumedMl:    number | null,
  turbulenceMl:  number | null,
  engineSeconds: number | null,
): NormalisedRate | null {
  if (engineSeconds == null || engineSeconds <= 0) return null
  if (consumedMl   == null || consumedMl   <= 0) return null

  const consumedL = consumedMl / 1000
  const turbL     = Math.abs((turbulenceMl ?? 0) / 1000)
  const hours     = engineSeconds / 3600

  // The published shrinkage term, clamped. Unclamped this inverts once
  // turbulence exceeds consumption — see the module note on DZ 14.
  const ratio  = turbL / consumedL
  const factor = Math.min(1, Math.max(0, 1 - ratio * ratio))

  return {
    lPerHour:       (consumedL * factor) / hours,
    // The band is the operator's own, and is deliberately NOT clamped at zero
    // on the low side: a min below zero is a true statement about a day whose
    // turbulence exceeded its consumption, and hiding it would make the band
    // look tighter than the evidence supports.
    minLPerHour:    (consumedL - turbL) / hours,
    maxLPerHour:    (consumedL + turbL) / hours,
    noiseDominates: ratio >= 1,
  }
}
