/**
 * Reading RaiFactorySuite's machine register (`GET /machines`) into the
 * columns `vehicles` keeps for it. Pure — the sync script does the I/O.
 */

import type { RaiFactorySuiteMachineRow } from './raifactorysuite.client.js'

/**
 * The register's category with its noise removed, so one kind of machine reads
 * as one type. Measured 2026-10-01 the 366 rows use 49 spellings, of which the
 * noise is three kinds:
 *
 *   • a contractor prefix — "FES - LMV", "FES-Mahindra", "Hired Truck". The
 *     contractor has its own field, so the prefix is dropped here.
 *   • spelling and case — "Concret Mixer" / "CONCRETE MIXER", "SMALLCOMPACTOR".
 *   • plurals — "DIESEL GENERATORS" beside "DIESEL GENERATOR".
 *
 * Nothing is merged beyond that: "Case Puma" stays a Case Puma rather than
 * becoming "Tractor", because which tractor it is is the whole point.
 */
const SPELLING: Record<string, string> = {
  'CONCRET MIXER':  'Concrete Mixer',
  'SMALLCOMPACTOR': 'Small Compactor',
  'BULL DOZER':     'Bulldozer',
  'HYDRA':          'Hydra Crane',
  'LMV':            'LMV',
  'CASE SPRAYINGTRACTOR': 'Case Spraying Tractor',
  'DRUMS':          'Drum',
  // FES's two Mahindras beside the register's own "Mahindra Tractor" rows.
  'MAHINDRA':       'Mahindra Tractor',
  // "Hired Machines", once the prefix is gone.
  'MACHINES':       'Machine',
}

const ACRONYMS = new Set(['LMV', 'FES', 'KSP', 'JCB'])

const titleCase = (s: string): string =>
  s.toLowerCase().split(/\s+/).map(w => {
    const up = w.toUpperCase()
    return ACRONYMS.has(up) ? up : w.charAt(0).toUpperCase() + w.slice(1)
  }).join(' ')

export function equipmentTypeOf(category: string | null | undefined): string | null {
  if (!category) return null
  let s = category.trim().replace(/\s+/g, ' ')
  // Contractor prefix, in every spelling seen.
  s = s.replace(/^(FES\s*-\s*|Hired\s+)/i, '').trim()
  if (!s) return null
  const key = s.toUpperCase()
  if (SPELLING[key]) return SPELLING[key]
  // "DIESEL GENERATORS" → "Diesel Generator". Only the trailing word, and only
  // a plain plural, so "Bus" and "Machines"-style oddities are left as sent.
  s = s.replace(/(GENERATOR)S$/i, '$1')
  return titleCase(s)
}

export interface RatedConsumption {
  value: number
  basis: 'HOURS' | 'DISTANCE'
}

/**
 * The operator's stated consumption, with the basis our enum names.
 *
 * HOUR → litres per engine-hour; KM_PER_LITRE → kilometres per litre, kept as
 * stated (not inverted to L/km — a "2.6" an operator can recognise beats a
 * 0.385 they cannot). Null when the register gives no figure or a basis this
 * code has not seen, rather than a guess.
 */
export function ratedConsumptionOf(m: RaiFactorySuiteMachineRow): RatedConsumption | null {
  const v = m.expectedConsumption
  if (v == null || !Number.isFinite(v) || v <= 0) return null
  if (m.consumptionBasis === 'HOUR')         return { value: v, basis: 'HOURS' }
  if (m.consumptionBasis === 'KM_PER_LITRE') return { value: v, basis: 'DISTANCE' }
  return null
}

/** Our externalId for the Wialon unit the register names, or null. */
export function wialonExternalIdOf(m: RaiFactorySuiteMachineRow): string | null {
  const id = m.gpsUnitId?.trim()
  return id && /^\d+$/.test(id) ? `wialon:${id}` : null
}

/**
 * "BH-01", "MUFINDI: BH 01", "MUFINDI - EX 24" → "BH01" / "EX24". Used only as
 * the opt-in fallback join (`--by-reference`) for register rows that carry no
 * GPS id. Leading zeros are kept on both sides because both sides write them.
 */
export function fleetCodeOf(s: string | null | undefined): string | null {
  if (!s) return null
  const body = s.replace(/^\s*MUFINDI\s*[:\-]\s*/i, '')
  const m = /^([A-Z]+)\s*-?\s*(\d+)$/i.exec(body.trim())
  return m ? `${m[1]!.toUpperCase()}${m[2]}` : null
}

/** The vehicle columns a register row sets. */
export function machineColumns(m: RaiFactorySuiteMachineRow, now: Date) {
  const rated = ratedConsumptionOf(m)
  const clean = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null)
  return {
    machineId:             m.id,
    equipmentType:         equipmentTypeOf(m.category),
    equipmentCategory:     clean(m.category),
    equipmentReference:    clean(m.reference),
    makeModel:             clean(m.makeModel),
    contractor:            clean(m.contractor),
    fuelType:              clean(m.fuelType),
    ratedConsumption:      rated?.value ?? null,
    ratedConsumptionBasis: rated?.basis ?? null,
    fuelSensorFitted:      m.fuelSensorFitted ?? null,
    machineSyncedAt:       now,
  }
}
