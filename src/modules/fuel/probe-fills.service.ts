/**
 * POST fuel/probe-fills { plates, from, to }: each unit's refuels over whole
 * Nairobi days, for a reconciliation sheet's "Filling as per Fuel Probes".
 *
 * Read off our fuel ledger, not Wialon. The ledger's `filledMl` is Wialon's own
 * fill report (fuel-sync, every 15 minutes, settled again overnight), so the
 * figures are the same; reading them here is one indexed query for a whole
 * sheet. Reading Wialon per upload took ~20 s a unit over a year (84 units, ~28
 * min for Aquamist's 4,588-row sheet, 2026-11-27) and ran into error 1003 when
 * the fuel sync's own report was running on the account.
 *
 * `coveredFrom` is the first day the organisation's ledger holds: a sheet row
 * before it cannot be checked, which is not the same as "no refuel that day".
 * History before an org's ledger began is backfilled with
 * `sync-fuel-events --from --to --fillings-only` (Aquamist: from 27 Nov 2025,
 * the start of its units' Wialon history).
 */
import { prisma } from '../../lib/prisma.js'
import { BadRequestError } from '../../core/errors/errors.js'
import { fleetDayBounds } from '../../lib/provider-time.js'
import { WialonError } from '../../providers/wialon/wialon.client.js'
import { plateKey, probeFillsOf, type ProbeFill } from './probe-fills.js'

/** A year and a bit: one sheet's span. */
export const MAX_DAYS = 400
/** Units on one sheet, at most. */
export const MAX_PLATES = 500
const DAY_MS = 86_400_000
const OFFSET_MS = 3 * 3_600_000

export interface ProbeFillsUnit {
  plate: string
  /** The unit on the platform, or null when no unit of this org (in the user's scope) has the plate. */
  vehicle: { id: string; name: string; plate: string } | null
  note: string | null
  fills: ProbeFill[]
}
export interface ProbeFillsResult {
  from: string
  to: string
  /** The first day (Nairobi) the organisation's fuel ledger holds, or null when it holds none. */
  coveredFrom: string | null
  units: ProbeFillsUnit[]
}

const dayOf = (at: Date) => new Date(at.getTime() + OFFSET_MS).toISOString().slice(0, 10)

export async function getProbeFills(
  orgId: string, plates: readonly string[], from: string, to: string, scope: Set<string> | null,
): Promise<ProbeFillsResult> {
  const start = fleetDayBounds(from), end = fleetDayBounds(to)
  if (!start || !end || end.from < start.from) throw new BadRequestError('from and to must be days, from first')
  if ((end.from.getTime() - start.from.getTime()) / DAY_MS + 1 > MAX_DAYS) throw new BadRequestError(`at most ${MAX_DAYS} days at a time`)
  const wanted = [...new Set(plates.map(p => p.trim()).filter(Boolean))]
  if (wanted.length > MAX_PLATES) throw new BadRequestError(`at most ${MAX_PLATES} units at a time`)

  const vehicles = await prisma.vehicle.findMany({
    where: { organisationId: orgId },
    select: { id: true, name: true, registrationPlate: true, isActive: true },
  })
  // An active unit before a retired one holding the same plate.
  const byKey = new Map<string, (typeof vehicles)[number]>()
  for (const v of [...vehicles].sort((a, b) => Number(a.isActive) - Number(b.isActive))) {
    if (!scope || scope.has(v.id)) byKey.set(plateKey(v.registrationPlate), v)
  }

  const found = wanted.map(plate => ({ plate, v: byKey.get(plateKey(plate)) ?? null }))
  const ids = [...new Set(found.flatMap(f => (f.v ? [f.v.id] : [])))]

  const [rows, first] = await Promise.all([
    ids.length
      ? prisma.fuelFilling.findMany({
          where: { vehicleId: { in: ids }, filledAt: { gte: start.from, lt: end.to } },
          select: { vehicleId: true, filledAt: true, filledMl: true, initialFuelLevelMl: true, finalFuelLevelMl: true },
          orderBy: { filledAt: 'asc' },
        })
      : Promise.resolve([]),
    prisma.fuelFilling.findFirst({
      where: { vehicle: { organisationId: orgId } },
      select: { filledAt: true },
      orderBy: { filledAt: 'asc' },
    }),
  ])

  const byVehicle = new Map<string, typeof rows>()
  for (const r of rows) byVehicle.set(r.vehicleId, [...(byVehicle.get(r.vehicleId) ?? []), r])

  return {
    from, to,
    coveredFrom: first ? dayOf(first.filledAt) : null,
    units: found.map(({ plate, v }) => v
      ? {
          plate,
          vehicle: { id: v.id, name: v.name, plate: v.registrationPlate },
          note: null,
          fills: probeFillsOf((byVehicle.get(v.id) ?? []).map(r => ({ ...r, location: null, mileageAtFillKm: null }))),
        }
      : { plate, vehicle: null, note: 'Not on the platform', fills: [] }),
  }
}

/**
 * Run a Wialon call, waiting out error 1003: Wialon refuses a report while
 * another runs on the account, separate sessions or not (the fuel sync's own,
 * say). Used by the history backfill (sync-fuel-events).
 */
export const BUSY_RETRIES = [2_000, 5_000, 10_000, 20_000, 30_000]
export async function whenFree<T>(call: () => Promise<T>, waits: readonly number[] = BUSY_RETRIES): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await call() } catch (err) {
      if (!(err instanceof WialonError && err.code === 1003) || i >= waits.length) throw err
      await new Promise(r => setTimeout(r, waits[i]))
    }
  }
}
