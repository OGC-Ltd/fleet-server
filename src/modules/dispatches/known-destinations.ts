/**
 * Destinations the operator has TOLD us the coordinates of.
 *
 * ## Why a stated point is allowed to beat a measured one
 *
 * `dispatch_destinations` places a name by averaging where completed trips to
 * it actually turned around (see prisma/sync-destinations.ts). That is the
 * right mechanism and it stays the default — it needs no maintenance, it
 * improves as the fleet drives, and it cannot be wrong about a place it has
 * been to often.
 *
 * It has one failure mode, and the Naitiri sugar run is sitting in it: a
 * destination cannot be measured until enough runs to it have COMPLETED, and a
 * run only completes once the provider records a return. Measured on the live
 * database (2026-09-15), every one of the twelve Naitiri → Raiply sales rows
 * closed between 15 seconds and 32 minutes after sign-out — the guard signs the
 * unit out and signs it back in without the round trip ever being recorded — so
 * `dispatch_destinations` holds NO row for Raiply and never will. The trip
 * therefore had no far end: no `legM`, no percentage, no bar, no distance to
 * go, and no arrival test, on the one route we know the most about.
 *
 * So: where the operator states a point, we use the operator's point. This is
 * not a fallback for a thin measurement — it is a different and better source,
 * because it is the gate itself rather than the average of where trucks parked
 * near it.
 *
 * ## What this table is NOT
 *
 * It is not a geocoder and it must not grow into one. A name absent from it
 * falls through to the measured table and then to "no distance", exactly as
 * before; nothing here guesses. It holds only places an operator has given us
 * coordinates for in so many words.
 *
 * It is also not a geofence. Rows in `geofences` are ENFORCED and would raise
 * violations for trucks standing exactly where they belong — the same reason
 * the dash keeps its site plans as static assets.
 *
 * ## Matching
 *
 * By the same key the measured lookup uses: trimmed and upper-cased. The
 * provider is not consistent about case on this field — the live rows carry
 * both "Raiply" and "RaiPly" on the same route in the same week — so anything
 * comparing raw text would place half the runs and not the other half.
 */

export interface KnownDestination {
  /** How to name it in a sentence, in the operator's own spelling. */
  label: string
  lat: number
  lng: number
  /**
   * Arrival tolerance, metres, in the units `arrivalRadiusM` scales: it is
   * doubled and then floored at 800 m. A stated gate has no measured spread —
   * there is no sample to take a median of — so this states how much slack the
   * place deserves instead of implying a precision we did not compute.
   *
   * 400 m puts Raiply's radius on the 800 m floor, which is the right answer
   * for a single gate: a truck parks in the yard behind it, not on the pin.
   */
  spreadM: number
}

/**
 * Keyed by the destination name as the provider writes it, upper-cased.
 *
 * RAIPLY is the far end of the Naitiri sugar run: processed sugar in 50 kg
 * bags leaves the factory gate and is offloaded here, ~50 km east-south-east.
 * The coordinate is the operator's, given 2026-09-15. The dash draws the same
 * place from its own surveyed KML (`public/raiply-site.geojson`), and this
 * point sits inside that perimeter — the two are independent statements of the
 * same site and they agree, which is the only check available for a figure
 * nothing measured.
 */
export const KNOWN_DESTINATIONS: Record<string, KnownDestination> = {
  RAIPLY: { label: 'Raiply', lat: 0.53120, lng: 35.25001, spreadM: 400 },
}

/** The stated point for a destination name, or null. Case- and space-tolerant. */
export function knownDestination(name: string | null | undefined): KnownDestination | null {
  if (!name) return null
  return KNOWN_DESTINATIONS[name.trim().toUpperCase()] ?? null
}
