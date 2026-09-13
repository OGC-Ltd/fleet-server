/**
 * Sugar out of the factory gate: what went, how much, and which units carried it.
 *
 * ## Why this is its own service rather than a filter on deliveries
 *
 * `deliveries` answers "what did this fleet move", over TRIPS, and a trip only
 * exists once a dispatch has closed AND the vehicle reported enough fixes to
 * measure. That is the right frame for distance and duration, and the wrong one
 * for tonnage: a sales run's weight is known the moment the sales office raises
 * it, long before the truck comes home, and a run whose telemetry was too
 * sparse to measure still carried its load.
 *
 * So the tonnage here is summed over the DISPATCHES — the yard's own record,
 * which exists for every unit whether or not it carries a tracker — and the
 * distance is joined in from the trip where one was built. The two populations
 * differ, deliberately, and `runsMeasured` says by how much rather than letting
 * a reader assume the kilometres cover every run in the tonnage.
 *
 * ## Bags are not a second measurement
 *
 * A bag count is the tonnage restated in the unit the yard counts in. It is
 * derived through the same `bagsFromTonnes` the feed line and the cargo card
 * use, so the three surfaces cannot round one load three different ways.
 *
 * ## Zero is a fact; null is the absence of one
 *
 * Every day in the window appears, zeroed where nothing ran — the chart plots a
 * continuous axis and a missing day would silently shorten it. But a unit's
 * `litresPerKm` is null rather than 0 when its fuel could not be measured: a
 * run containing a refuel cannot be balanced against the tank (see
 * trip-builder's tripFuelMl), and writing 0 there would report a truck that
 * hauled 29 tonnes for nothing.
 *
 * ## Both offices dispatch out of a sugar gate, and both count
 *
 * This read `kind: 'SALES'` and nothing else, which made it a report on the
 * SALES OFFICE'S paperwork rather than on the sugar that left. At Naitiri the
 * transport team raises runs of its own through the provider's `/dispatches`
 * lifecycle (they arrive here as `kind: 'CANE'`, the default that lifecycle
 * carries — the name is the endpoint's, not a claim about the load), and every
 * one of those was invisible on this card, on the daily tonnage chart beside
 * it, and in the run counts underneath.
 *
 * The discriminator that actually means "sugar going out" is the GATE, not the
 * office: `SUGAR_GATES` is the set of factories whose outbound load is
 * processed sugar. So a transport dispatch counts when it left one of those,
 * and Ndhiwa's cane dispatches — inbound deliveries to a mill — stay out, which
 * a bare `kind` widening would not have managed.
 *
 * ## A transport run has no weight, and that is not a zero
 *
 * The provider sends `tonnage` on a sales payload only (see factory-map's
 * `bagsFromTonnes` and the webhook's `handleSale`). A transport run out of
 * Naitiri therefore carries runs, distance and fuel but no tonnage at all, so
 * `tonnes` is null on those rows and `runsWeighed` says how many of a unit's
 * runs stand behind the weight that is shown. Summing them in as zero would
 * hold the tonnage still while the run count climbed, and quietly halve every
 * tonnes-per-run a reader computed off this table.
 */

import { prisma } from '../../lib/prisma.js'
import { fleetDayKey, fleetDayStart } from '../../lib/provider-time.js'
import { bagsFromTonnes, factoryOf, SUGAR_GATES } from '../webhooks/factory-map.js'

export interface SugarHaulDay {
  day:    string
  runs:   number
  tonnes: number
  bags:   number
}

/**
 * One run, as the gate recorded it.
 *
 * Carried per unit so the page can show WHEN each haul went and came back —
 * the aggregate row above answers "how much did this truck move", and it could
 * never answer "when did it move it". It is also what makes a date filter
 * honest: the client narrows this list and re-derives the unit's figures from
 * exactly the runs left standing, rather than filtering a total it cannot see
 * inside of.
 *
 * `km` and `litres` are the trip's, where a trip was built; both are null
 * otherwise, and independently — a run can be measured for distance and still
 * have no closable tank balance.
 */
export interface SugarHaulRun {
  id:           string
  /** 'SALES' from the sales office, 'CANE' from the transport team's lifecycle
   *  — the endpoint that raised it, not a claim about the load. */
  kind:         'CANE' | 'SALES'
  /** The crew the provider named on THIS run. Carried per run, not only per
   *  unit, so a date-filtered view names whoever drove inside the range. */
  driver:       string | null
  destination:  string | null
  /** When the unit was signed out of the gate. */
  dispatchedAt: string
  /** When it was signed back in. Null while the run is still open. */
  returnedAt:   string | null
  status:       string
  /** Null on a transport run: the provider sends a weight on a sales payload
   *  only, and an unweighed run is not a run that carried nothing. */
  tonnes:       number | null
  bags:         number | null
  km:           number | null
  litres:       number | null
}

export interface SugarHaulUnit {
  plate:       string
  driver:      string | null
  /** Where these loads went. The commonest destination, and how many distinct. */
  destination: string | null
  destinations: number
  runs:        number
  /** Runs that produced a measurable trip — the population behind `km`. */
  runsMeasured: number
  /** Runs carrying a weight — the population behind `tonnes`. Short of `runs`
   *  wherever the transport team raised the paperwork. */
  runsWeighed: number
  /** Null, not 0, when none of this unit's runs was weighed. */
  tonnes:      number | null
  bags:        number | null
  km:          number | null
  /** Litres per kilometre over the runs whose tank balance closed. Null when
   *  none did — most often because the unit refuelled mid-run. */
  litresPerKm: number | null
  /** Newest sign-out among these runs. */
  lastRunAt:   string
  /** This unit's runs, newest first. */
  history:     SugarHaulRun[]
}

export interface SugarHauls {
  /** The factory these loads left from, when the window has just the one. */
  origin:  string | null
  days:    SugarHaulDay[]
  units:   SugarHaulUnit[]
  totals:  {
    runs: number
    /** Of those, the ones carrying a weight — see the header. */
    runsWeighed: number
    tonnes: number | null
    bags: number | null
    km: number | null
    units: number
  }
}

const t1 = (t: number) => Math.round(t * 10) / 10

/**
 * The fleet-local calendar day a moment belongs to, as YYYY-MM-DD.
 *
 * `fleetDayKey` returns the day as a UTC-midnight Date; the charts key on the
 * string, so the conversion happens once, here, rather than at each use.
 */
const dayKey = (d: Date): string => fleetDayKey(d).toISOString().slice(0, 10)

/** Window days, oldest → newest, on the fleet's own calendar. */
function windowDays(days: number, to: Date): string[] {
  const out: string[] = []
  for (let i = days - 1; i >= 0; i--) {
    out.push(dayKey(new Date(to.getTime() - i * 86_400_000)))
  }
  return out
}

export async function getSugarHauls(
  orgId: string,
  days = 30,
  to?: Date,
  vehicleIds: string[] | null = null,
): Promise<SugarHauls> {
  const end   = to ?? new Date()
  const start = new Date(fleetDayStart(end).getTime() - (days - 1) * 86_400_000)

  const runs = await prisma.dispatch.findMany({
    where: {
      organisationId: orgId,
      dispatchedAt:   { gte: start, lte: end },
      // Either office. A sales run is sugar out of a gate by definition,
      // whichever gate; a transport dispatch is only sugar out when it left a
      // gate that ships sugar — see the header, and SUGAR_GATES.
      OR: [
        { kind: 'SALES' },
        { kind: 'CANE', factoryCode: { in: SUGAR_GATES } },
      ],
      ...(vehicleIds == null ? {} : { vehicleId: { in: vehicleIds } }),
    },
    select: {
      id: true, plate: true, driverName: true, destination: true,
      dispatchedAt: true, actualReturnAt: true, status: true, kind: true,
      tonnageT: true, factoryCode: true, vehicleId: true,
    },
    orderBy: { dispatchedAt: 'asc' },
  })

  // Distance and fuel come from the trip built off each run, where one exists.
  // Joined on dispatchId rather than re-measured: the trip builder already did
  // the measurement under its own guards, and doing it twice invites two
  // answers to one question.
  const trips = runs.length
    ? await prisma.trip.findMany({
        where:  { dispatchId: { in: runs.map(r => r.id) } },
        select: { dispatchId: true, mileageKm: true, consumedMl: true },
      })
    : []
  const km1 = (km: number) => Math.round(km * 10) / 10
  const tripByDispatch = new Map(trips.map(t => [t.dispatchId!, t]))

  const byDay  = new Map<string, { runs: number; tonnes: number }>()
  const byUnit = new Map<string, {
    plate: string; driver: string | null; runs: number; runsMeasured: number
    runsWeighed: number; tonnes: number; km: number; ml: number; kmForFuel: number
    dests: Map<string, number>; lastRunAt: Date; history: SugarHaulRun[]
  }>()

  const factories = new Set<string>()

  for (const r of runs) {
    // Null, not 0. An unweighed transport run must not sum into a tonnage, and
    // must not be counted in the population the tonnage describes.
    const t = r.tonnageT != null && r.tonnageT > 0 ? r.tonnageT : null
    if (r.factoryCode) factories.add(r.factoryCode)

    const key = dayKey(r.dispatchedAt)
    const d = byDay.get(key) ?? { runs: 0, tonnes: 0 }
    d.runs += 1; d.tonnes += t ?? 0
    byDay.set(key, d)

    const u = byUnit.get(r.plate) ?? {
      plate: r.plate, driver: r.driverName, runs: 0, runsMeasured: 0, runsWeighed: 0,
      tonnes: 0, km: 0, ml: 0, kmForFuel: 0, dests: new Map(), lastRunAt: r.dispatchedAt,
      history: [] as SugarHaulRun[],
    }
    u.runs += 1
    if (t != null) { u.runsWeighed += 1; u.tonnes += t }
    // Most recent crew wins — the provider names whoever took the keys on the
    // run, and the newest is the one an operator is asking about.
    if (r.dispatchedAt >= u.lastRunAt) { u.lastRunAt = r.dispatchedAt; u.driver = r.driverName }
    if (r.destination) u.dests.set(r.destination, (u.dests.get(r.destination) ?? 0) + 1)

    const trip = tripByDispatch.get(r.id)
    let runLitres: number | null = null
    if (trip) {
      u.runsMeasured += 1
      u.km += trip.mileageKm
      // Litres per km is summed as a RATIO OF TOTALS, not a mean of per-trip
      // rates: a 2 km repositioning move and a 240 km haul are not two equal
      // opinions about what a kilometre costs. Only the runs whose tank
      // balance closed contribute to either side.
      if (trip.consumedMl != null && trip.mileageKm > 0) {
        u.ml        += trip.consumedMl
        u.kmForFuel += trip.mileageKm
        runLitres    = Math.round((trip.consumedMl / 1000) * 100) / 100
      }
    }

    u.history.push({
      id:           r.id,
      kind:         r.kind,
      driver:       r.driverName,
      destination:  r.destination,
      dispatchedAt: r.dispatchedAt.toISOString(),
      // The gate's own sign-in. Null while the run is open, which is a state
      // the table shows as "still out" rather than as a missing timestamp.
      returnedAt:   r.actualReturnAt?.toISOString() ?? null,
      status:       r.status,
      tonnes:       t == null ? null : t1(t),
      bags:         bagsFromTonnes(t),
      km:           trip ? km1(trip.mileageKm) : null,
      litres:       runLitres,
    })

    byUnit.set(r.plate, u)
  }

  const dayRows: SugarHaulDay[] = windowDays(days, end).map(day => {
    const v = byDay.get(day)
    return {
      day,
      runs:   v?.runs ?? 0,
      tonnes: t1(v?.tonnes ?? 0),
      bags:   bagsFromTonnes(v?.tonnes ?? 0) ?? 0,
    }
  })

  const unitRows: SugarHaulUnit[] = [...byUnit.values()]
    .map(u => ({
      plate:        u.plate,
      driver:       u.driver,
      destination:  [...u.dests.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      destinations: u.dests.size,
      runs:         u.runs,
      runsMeasured: u.runsMeasured,
      runsWeighed:  u.runsWeighed,
      tonnes:       u.runsWeighed > 0 ? t1(u.tonnes) : null,
      bags:         u.runsWeighed > 0 ? bagsFromTonnes(u.tonnes) : null,
      km:           u.runsMeasured > 0 ? km1(u.km) : null,
      litresPerKm:  u.kmForFuel > 0 ? Math.round((u.ml / 1000 / u.kmForFuel) * 100) / 100 : null,
      lastRunAt:    u.lastRunAt.toISOString(),
      // Newest first: the run an operator is asking about is almost always the
      // last one, and it should not be at the bottom of a list of forty.
      history:      u.history.slice().reverse(),
    }))
    // Nulls last, in a descending sort by weight — a unit nobody weighed is not
    // a unit that carried the least. Run count breaks the tie and also orders
    // the unweighed tail, which would otherwise come back in map order.
    .sort((a, b) => (b.tonnes ?? -1) - (a.tonnes ?? -1) || b.runs - a.runs)

  const weighedRuns = unitRows.reduce((s, u) => s + u.runsWeighed, 0)
  const totalT  = unitRows.reduce((s, u) => s + (u.tonnes ?? 0), 0)
  const totalKm = unitRows.reduce((s, u) => s + (u.km ?? 0), 0)
  const measured = unitRows.some(u => u.km != null)

  return {
    // Named only when the whole window came from one gate; two factories in a
    // window is a legitimate state and naming one of them would be wrong.
    origin: factories.size === 1
      ? factoryOf([...factories][0]!)?.label ?? [...factories][0]!
      : null,
    days:   dayRows,
    units:  unitRows,
    totals: {
      runs:        runs.length,
      runsWeighed: weighedRuns,
      tonnes:      weighedRuns > 0 ? t1(totalT) : null,
      bags:        weighedRuns > 0 ? bagsFromTonnes(totalT) : null,
      km:          measured ? km1(totalKm) : null,
      units:       unitRows.length,
    },
  }
}
