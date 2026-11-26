/**
 * Generators have no speed and no speed limit (operator, 2026-11-26: "on the
 * generators they do not have speed, should be blank and never have speed
 * limit configurations at all").
 *
 * A standing genset's tracker still reports a speed — GPS drift; MUFINDI: DG 09
 * read 38 km/h that afternoon — and every unit was judged against a limit, 80
 * by default, so a generator could raise an overspeed. `overspeedLimitFor`
 * answers `null` for one of these, which every caller reads as "never judged
 * on speed": no flag, no feed line, no incident, no playback event, no limit
 * on the snapshot and no Speed Report row.
 *
 * Identified by NAME, because the type does not: all ten generators on the
 * platform that day were `UNSPECIFIED` — Mufindi's six "MUFINDI: DG 06" …
 * "MUFINDI - DG 13" and Menengai's four "MORL FARM … - GENSET …". Their
 * registration plate is that name. The browser's rule (new-ui
 * lib/vehicleMap `hasNoSpeed`) is the same, so a unit it blanks is one this
 * never judges.
 */

const GENERATOR_NAME = /\b(GENERATOR|GENSET)\b|(?:^|[\s:-])DG\s*\d+\b/i

export function isGeneratorUnit(nameOrPlate: string | null | undefined, vehicleType?: string | null): boolean {
  if ((vehicleType ?? '').toUpperCase() === 'GENERATOR') return true
  return nameOrPlate != null && GENERATOR_NAME.test(nameOrPlate)
}
