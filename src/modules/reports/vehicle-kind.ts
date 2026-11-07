/**
 * What kind of vehicle a unit is, as the reports head it (Trucks, Lorries, …),
 * and whether it is a truck. Pure, with no imports, so the probe-health build
 * (modules/fuel) can use it without loading the report services.
 *
 * Moved here from movement-report, tat-fuel-report and probe-disconnection
 * (7 Nov 2026), which re-export it unchanged.
 */

const TYPE_HEADING: Record<string, string> = {
  TRUCK: 'Trucks', LORRY: 'Lorries', TRACTOR: 'Tractors', TRAILER: 'Trailers', PLANT: 'Plant',
  SALOON: 'Saloons', BUS: 'Buses', COMPANY_VEHICLE: 'Company vehicles', UNSPECIFIED: 'Other',
}
export function typeHeading(type: string | null | undefined): string {
  const t = String(type ?? 'UNSPECIFIED').toUpperCase()
  return TYPE_HEADING[t] ?? t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, ' ')
}

/** A road registration; KTC.. is a tractor, KHMA a machine, KM.. a motorcycle. */
export const ROAD_PLATE = /^K(?!TC|HM|M)[A-Z]{2}\s*\d{3}[A-Z]$/i
/** Named for what it is, on a road plate like any truck's. */
const NOT_A_TRUCK = /land\s*cruiser|hilux|prado|pick\s*-?\s*up|double\s*cab/i
/** The kind of vehicle: its type, and an untyped unit on a road plate is a truck. Pure. */
export function vehicleHeading(v: { type: string; plate: string; name: string }): string {
  return v.type === 'UNSPECIFIED' && ROAD_PLATE.test(v.plate) && !NOT_A_TRUCK.test(v.name) ? 'Trucks' : typeHeading(v.type)
}

/** A prime mover, by its name on the register: every one is on the report (operator, 4 Nov 2026). */
const PRIME_MOVER = /prime[\s-]*mover/i
export const isPrimeMover = (name: string) => PRIME_MOVER.test(name)
export const PRIME_MOVERS = 'Prime Movers'

/** Named a light vehicle, whatever its plate or type says. */
const LIGHT_VEHICLE = /(?:^|[\s-])LV(?:[\s-]|$)/i
/** A truck: the reports' own heading for one, or a prime mover by its name. Pure. */
export function isTruck(v: { type: string; plate: string; name: string }): boolean {
  return !LIGHT_VEHICLE.test(v.name) && (['Trucks', 'Lorries'].includes(vehicleHeading(v)) || isPrimeMover(v.name))
}
