/**
 * Menengai's target fuel rates, from the operator's FUEL_RATES_FOR_FLEET_2.xlsx
 * (v47): a rate per registration where the sheet gives one (Sheet 1), else the
 * rate for the unit's model (Sheet 2), loaded and empty.
 *
 * A model is matched on the unit's recorded model, or its name, longest name
 * first ("TATA 2518" before "TATA"). The page used to look for the model in
 * the number plate, which never matched. Where only the model is known, the
 * loaded rate is the target: the lower of the two, so a unit is only called
 * below target when it is below even that.
 */

/** Sheet 1: km/L by registration. */
export const VEHICLE_RATES: Record<string, number> = {
  'KCA 917P': 1.789, 'KCN 909F': 2.167, 'KBG 389E': 3.78, 'KDM 138L': 5.861, 'KDE 142E': 6.183,
  'KCA 223M': 1.991, 'KBT 112R': 1.716, 'KCT 358W': 4.533, 'KAX 536U': 5.4, 'KDA 258J': 4.7, 'KBZ 911V': 3.933,
}

/** Sheet 2: km/L by model, loaded and empty. */
export const MODEL_RATES: Record<string, { loaded: number; empty: number }> = {
  'PICKUP HILUX': { loaded: 8, empty: 10 },
  'TATA': { loaded: 7.2, empty: 8 },
  'HYUNDAI': { loaded: 7, empty: 7.5 },
  'HINO 500': { loaded: 5.5, empty: 6.5 },
  'MITSUBISHI FH': { loaded: 5.8, empty: 6.2 },
  'MITSUBISHI FN': { loaded: 3.2, empty: 3.8 },
  'MAN CLA': { loaded: 3, empty: 3.2 },
  'TATA 2518': { loaded: 3.5, empty: 4 },
  'FUSO': { loaded: 6, empty: 6.5 },
  'MERC ACTROS 3340': { loaded: 1.8, empty: 2.1 },
  'MERC ACTROS 3350': { loaded: 1.6, empty: 1.9 },
  'MAN': { loaded: 1.9, empty: 2.5 },
}

export interface FuelTarget {
  /** The figure a rate is held against. */
  kmPerL: number
  /** As the sheet gives it: "4.70" or "5.5-6.5". */
  words: string
  source: 'vehicle' | 'model'
}

const norm = (s: string | null | undefined) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
const BY_PLATE = new Map(Object.entries(VEHICLE_RATES).map(([p, r]) => [norm(p).replace(/ /g, ''), r]))
const MODELS = Object.entries(MODEL_RATES).sort((a, b) => b[0].length - a[0].length)

/**
 * A unit's own standard (vehicles.standard_km_per_l, from the operator's fuel
 * log, 2026-11-25), as a target. It comes before the sheet's rates: a figure
 * for this very unit is the one it is held against. Null where none is set.
 */
export function unitTarget(standardKmPerL: number | null | undefined): FuelTarget | null {
  if (standardKmPerL == null || !Number.isFinite(standardKmPerL) || standardKmPerL <= 0) return null
  return { kmPerL: standardKmPerL, words: standardKmPerL.toFixed(2), source: 'vehicle' }
}

export function targetFor(plate: string, modelOrName: string | null | undefined): FuelTarget | null {
  const rate = BY_PLATE.get(norm(plate).replace(/ /g, ''))
  if (rate != null) return { kmPerL: rate, words: rate.toFixed(2), source: 'vehicle' }
  const m = ` ${norm(modelOrName)} `
  const hit = MODELS.find(([model]) => m.includes(` ${norm(model)} `))
  if (!hit) return null
  const [, r] = hit
  return { kmPerL: r.loaded, words: `${r.loaded}-${r.empty}`, source: 'model' }
}
