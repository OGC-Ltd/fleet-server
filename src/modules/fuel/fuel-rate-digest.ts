/**
 * The daily summary that stands in for FUEL RATE and FUEL DOWN alerts.
 *
 * Both come from the adjudicator: a drop the machine's measured burn, or the
 * distance it drove, does not account for. Posted one by one they were the
 * bulk of the fuel feed — 800 items over the 30 days to 2026-09-27, 499 of
 * them critical because a machine had three on its record — and not one was
 * ever marked a theft. On 26 Sep at Mufindi all 43 of that day's were slosh,
 * fuel moving in the tank, a refill or a broken probe. So on 2026-09-27 the
 * operator chose to have them once a day, never critical, while a SIPHON's
 * POSSIBLE THEFT still goes out as it happens.
 *
 * Same vocabulary rule as the live wording in fuel-adjudication.service: say
 * what the tank did and who to look at, and leave the conclusion to the
 * reader. The text never uses the word theft.
 */

/** One FUEL RATE or FUEL DOWN finding on the ledger. */
export interface DigestRow {
  plate:    string
  kind:     DigestKind
  stolenMl: number
}

export type DigestKind = 'FUEL RATE' | 'FUEL DOWN'

/** The headline each announced reason slug used to go out under. */
export function digestKind(reason: string | null | undefined): DigestKind | null {
  if (reason === 'burn-above-class-ceiling' || reason === 'burn-far-above-band') return 'FUEL RATE'
  if (reason === 'drop-while-stationary' || reason === 'drop-exceeds-distance') return 'FUEL DOWN'
  return null
}

const DAYS   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** Hours the fleet's wall clock runs ahead of UTC. EAT, and it has no DST. */
const EAT_H = 3

/** "Sat 26 Sep" for the fleet day beginning at `dayStart` (EAT midnight, as an instant). */
export function fleetDayLabel(dayStart: Date): string {
  const eat = new Date(dayStart.getTime() + EAT_H * 3_600_000)
  return `${DAYS[eat.getUTCDay()]} ${eat.getUTCDate()} ${MONTHS[eat.getUTCMonth()]}`
}

/** How many machines are named before "and N more". */
export const DIGEST_TOP = 5

const litres = (ml: number): string => `${Math.round(ml / 1000)} L`
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/**
 * The day's summary for one organisation, or null when there is nothing to say
 * — an empty day posts nothing rather than a line reading "none".
 *
 * Machines are ordered by how often they appeared, then by litres, so the one
 * that keeps coming back leads.
 */
export function fuelRateDigestText(rows: readonly DigestRow[], dayLabel: string): string | null {
  if (rows.length === 0) return null

  const byPlate = new Map<string, { n: number; ml: number }>()
  let totalMl = 0, rate = 0
  for (const r of rows) {
    const m = byPlate.get(r.plate) ?? { n: 0, ml: 0 }
    m.n += 1
    m.ml += r.stolenMl
    byPlate.set(r.plate, m)
    totalMl += r.stolenMl
    if (r.kind === 'FUEL RATE') rate += 1
  }
  const down = rows.length - rate
  const machines = [...byPlate.entries()]
    .sort((a, b) => b[1].n - a[1].n || b[1].ml - a[1].ml || a[0].localeCompare(b[0]))

  const split = [rate > 0 ? `${rate} FUEL RATE` : null, down > 0 ? `${down} FUEL DOWN` : null]
    .filter((s): s is string => s != null).join(', ')
  const named = machines.slice(0, DIGEST_TOP).map(([plate, m]) => `${plate} ×${m.n} (${litres(m.ml)})`).join(', ')
  const more = machines.length > DIGEST_TOP ? `, and ${machines.length - DIGEST_TOP} more` : ''

  return `FUEL RATE / FUEL DOWN, daily summary for ${dayLabel}: `
    + `${plural(rows.length, 'drop', 'drops')} beyond what the machine's measured burn or distance accounts for (${split}), `
    + `on ${plural(machines.length, 'machine', 'machines')}, ${litres(totalMl)} in all. `
    + `By machine: ${named}${more}. `
    + `A machine that appears day after day is worth checking against its fuel records.`
}
