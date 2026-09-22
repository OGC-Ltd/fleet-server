/**
 * Put a delivery on its truck the moment the paperwork lands.
 *
 * ## What was wrong
 *
 * The declared load already reaches the vehicle: `handleSale` writes the
 * tonnage and destination to a dispatch row, `findOpenTripsByVehicle` turns
 * that into `cargoTonnes`/`cargoBags`/`cargoName`, and `getFleetSnapshot`
 * overrides the vehicle's cargo fields with it (this fleet has no load cells,
 * so the sales office is the only source there is).
 *
 * What it did NOT do was arrive. That path runs through the `open-trips` warm
 * cache, which is swept once a minute and serves the stale entry while it
 * rebuilds — so a truck signed out at 03:22 with 29 t for Raiply could read
 * Empty until 03:24, and nothing in the codebase invalidated a warm cache on a
 * write. The number was in the database the whole time.
 *
 * ## Coalesced, not queued
 *
 * Deliberately in-process and deliberately batched, rather than a job per
 * event:
 *
 *   - The thing being corrected is an IN-MEMORY map in this process. A queue
 *     would hand the work to a worker that has to be this same process to be
 *     any use, and would add a Redis round trip to a path whose whole purpose
 *     is to be immediate.
 *   - Redis is optional here by design (see lib/redis) — `REDIS_URL` is unset
 *     on an instance that has no room for it, and a feature built on BullMQ
 *     would simply not run there.
 *   - Volume is the real risk, and batching answers it better than a queue
 *     does. A reconcile pass re-reads up to 1000 dispatches and 500 sales in
 *     one sweep; that becomes ONE query here, not 1500 jobs.
 *
 * If this ever needs to survive a restart, or to reach a second instance, that
 * is the argument for a queue and for Redis pub/sub on the SSE registry — the
 * two go together, and neither is true of a single box today.
 *
 * ## Nothing here is load-bearing for correctness
 *
 * Every write still lands in Postgres the same way, and the minute sweep still
 * rebuilds the cache from scratch. If this module never ran, the system would
 * behave exactly as it did before: correct, and up to two sweeps late. So a
 * failure is logged and dropped, never retried and never surfaced — the ingest
 * path must not fail because a cache could not be freshened.
 */

import { logger } from '../../lib/logger.js'
import { emitDashboardDispatch } from '../../lib/sse.js'
import { getOpenTripsCached, patchOpenTrips } from './open-trips.cache.js'

/**
 * How long a batch collects before it runs.
 *
 * Short enough to be invisible next to the webhook's own network time, long
 * enough that a burst arriving as separate HTTP requests — which is how the
 * provider delivers a backlog — lands in one query rather than fifty.
 */
const BATCH_MS = 250

/** orgId → vehicles whose paperwork changed since the last flush. */
const pending = new Map<string, Set<string>>()
const timers  = new Map<string, NodeJS.Timeout>()
/** One flush per org at a time; a batch that arrives mid-flush waits its turn. */
const running = new Set<string>()

/**
 * This vehicle's run changed — reflect it on the live fleet now.
 *
 * Fire-and-forget by contract. Callers are ingest paths whose job is to
 * acknowledge the provider quickly, and a 4xx makes the provider retry a few
 * times and then drop the event permanently.
 */
export function markDispatchChanged(orgId: string, vehicleId: string | null | undefined): void {
  if (!orgId || !vehicleId) return

  let set = pending.get(orgId)
  if (!set) { set = new Set(); pending.set(orgId, set) }
  set.add(vehicleId)

  arm(orgId)
}

/** One pending timer per org, whoever asked for it. */
function arm(orgId: string): void {
  if (timers.has(orgId)) return
  const t = setTimeout(() => { timers.delete(orgId); void flush(orgId) }, BATCH_MS)
  // The batch must never be the reason a process stays up; a pending cache
  // freshen is not work worth delaying a shutdown for.
  t.unref?.()
  timers.set(orgId, t)
}

async function flush(orgId: string): Promise<void> {
  if (running.has(orgId)) {
    // Re-arm rather than run concurrently: two patches of the same map racing
    // is the one way this could publish a load the database does not hold.
    arm(orgId)
    return
  }

  const set = pending.get(orgId)
  if (!set?.size) return
  pending.delete(orgId)
  running.add(orgId)

  const vehicleIds = [...set]
  try {
    const changed = await patchOpenTrips(orgId, vehicleIds)
    if (changed.length === 0) return

    const { byVehicle } = await getOpenTripsCached(orgId)

    for (const vehicleId of changed) {
      const run = byVehicle.get(vehicleId)
      emitDashboardDispatch(orgId, {
        vehicleId,
        // Null across the board when the run closed — the truck signed back in
        // and is carrying nothing, which is as much news as the load was.
        externalId:    run?.externalId  ?? null,
        driverName:    run?.driverName  ?? null,
        destination:   run?.destination ?? null,
        dispatchedAt:  run?.dispatchedAt ?? null,
        // The same three fields getFleetSnapshot writes onto the vehicle, in
        // the same units, so the pushed value and the next snapshot cannot
        // disagree about what is on the bed.
        cargoWeightKg: run?.cargoTonnes != null ? run.cargoTonnes * 1000 : null,
        cargoBags:     run?.cargoBags ?? null,
        cargoDesc:     run?.cargoName ?? null,
      })
    }

    logger.debug({ orgId, asked: vehicleIds.length, changed: changed.length }, 'Dispatch refresh published')
  } catch (err) {
    // See the header: the sweep corrects this within the minute.
    logger.warn({ err, orgId, vehicles: vehicleIds.length }, 'Dispatch refresh failed — falling back to the cache sweep')
  } finally {
    running.delete(orgId)
    // Something arrived while we were working. Run it rather than waiting for
    // the next webhook to re-arm the timer.
    if (pending.get(orgId)?.size) arm(orgId)
  }
}

/** Test seam: run every pending batch now and wait for it. */
export async function flushDispatchRefreshNow(): Promise<void> {
  const orgs = [...pending.keys()]
  for (const orgId of orgs) {
    const t = timers.get(orgId)
    if (t) { clearTimeout(t); timers.delete(orgId) }
    await flush(orgId)
  }
}
