/**
 * Fuel fillings and drains from Wialon's reports — the shared core.
 *
 * Two callers, one implementation: `prisma/sync-fuel-events.ts` (the backfill
 * CLI) and `lib/queues/fuel-events.ts` (the in-process repeatable job). They
 * differ only in WHICH vehicles they ask about and how often.
 *
 * ## Why this had to move in-process
 *
 * The CLI wrote notifications to Postgres and nothing else, because
 * `cacheNotification` is a no-op without Redis and the CLI has none. The read
 * path (notification.reader) serves the first page from the Redis cache
 * whenever the cache holds enough items and never reaches Postgres — so on the
 * production box the fuel items existed in the database and were invisible in
 * the dashboard. Measured 2026-08-02: the same request returned 21 fuel items
 * with `?before=` (Postgres) and 0 without it (cache).
 *
 * Publishing from inside the server fixes that at the root: `publishNotification`
 * emits SSE, writes Redis and writes Postgres in one call, so the live feed,
 * the cached first page and the durable history cannot disagree.
 *
 * Nothing here derives a volume from our own telemetry. Wialon computes these
 * events with the probe's own filtering; we read its answer.
 */

import type { WialonClient } from '../../providers/wialon/wialon.client.js'
import { fetchUnitFuelEvents, listReportTemplates } from '../../providers/wialon/wialon.reports.js'
import { getOrCreatePeriodFor } from '../../lib/reporting-period.js'
// The AWAITED publish. `publishNotification` detaches its Postgres write so a
// 2-second poll cycle is never blocked by the pooler; nothing here is on that
// clock, and awaiting means a finished cycle really has stored what it says it
// published — which also makes the backfill CLI safe, since a process that
// exits would otherwise race its own detached writes.
import { publishNotificationDurable } from '../../lib/notifications/notification.store.js'
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'

/**
 * Which Wialon resource holds each org's fuel templates.
 *
 * Kasulu's resource id equals its account id (see wialon.account). Sukari's
 * units live under the shared RAI GROUP account but its REPORTS sit on a
 * resource of its own, so the two ids are unrelated and both are stated rather
 * than derived.
 */
export const ORG_RESOURCES: ReadonlyArray<{ code: string; resourceId: number }> = [
  { code: 'KASULU', resourceId: 30394506 },
  { code: 'SUKARI', resourceId: 28843152 },
]

/**
 * Template preference, best first. "Advanced Fuel Analysis" carries BOTH the
 * fillings and the thefts tables; the standalone theft report is the fallback
 * for a resource that lacks it and covers drains only.
 */
const TEMPLATE_PREFERENCE: readonly RegExp[] = [
  /advanced\s+fuel\s+analysis/i,
  /fuel\s+theft/i,
  /journey\s+and\s+fuel/i,
]

export interface OrgFuelSource {
  orgId:        string
  code:         string
  resourceId:   number
  templateId:   number
  templateName: string
}

/** Wialon unit id out of our `wialon:<id>` device key. */
export const wialonUnitId = (deviceId: string | null | undefined): number | null => {
  const m = /^wialon:(\d+)$/.exec(deviceId ?? '')
  return m ? Number(m[1]) : null
}

/**
 * Resolve each org's report template.
 *
 * Matched by NAME, not id: the ids are per-resource (both orgs have a template
 * 2 meaning different things) and an operator reordering their reports would
 * otherwise silently repoint us at the wrong report.
 */
export async function resolveOrgFuelSources(client: WialonClient): Promise<OrgFuelSource[]> {
  const out: OrgFuelSource[] = []

  for (const { code, resourceId } of ORG_RESOURCES) {
    const org = await prisma.organisation.findUnique({ where: { code }, select: { id: true } })
    if (!org) { logger.warn({ code }, 'Fuel sync: organisation not found'); continue }

    const templates = await listReportTemplates(client, resourceId)
    let chosen: { id: number; n?: string } | null = null
    for (const pattern of TEMPLATE_PREFERENCE) {
      // Per-unit templates only — a group template takes a group id as its
      // subject and would fail for every vehicle.
      const hit = templates.find(t => pattern.test(t.n ?? '') && (t.ct ?? 'avl_unit') === 'avl_unit')
      if (hit) { chosen = hit; break }
    }
    if (!chosen) {
      logger.warn({ code, resourceId }, 'Fuel sync: no per-unit fuel template on this resource')
      continue
    }

    out.push({ orgId: org.id, code, resourceId, templateId: chosen.id, templateName: chosen.n ?? '?' })
  }

  return out
}

export interface SyncVehicle {
  id:                string
  deviceId:          string | null
  registrationPlate: string
}

export interface SyncOptions {
  from:   Date
  to:     Date
  /** Write ledger rows. False makes the whole call a dry run. */
  apply:  boolean
  /** Publish feed items for events at or after `notifyCutoff`. */
  notify: boolean
  notifyCutoff?: Date
}

export interface SyncOutcome {
  fillings:   number
  thefts:     number
  dupFill:    number
  dupTheft:   number
  published:  number
  /**
   * Events re-offered to the feed that were suppressed as exact republishes.
   *
   * Publication is decided by AGE (see below), so every event inside the notify
   * window is offered again on each cycle — up to eight times for one filling
   * at a quarter-hourly cadence. That is intentional and now costs nothing, but
   * it should be VISIBLE: a cycle logging `published: 0, deduped: 6` is the
   * difference between "the dedupe is working" and "the sync has stopped".
   */
  deduped:    number
  /**
   * Ledger rows rewritten because the provider revised the event.
   *
   * Not an error count — Wialon narrowing 55.1 L to 52.8 L as settled readings
   * arrive is it doing its job. It is here because a cycle that suddenly starts
   * correcting everything means the report window or the probe changed.
   */
  corrected:  number
}

const EMPTY: SyncOutcome = { fillings: 0, thefts: 0, dupFill: 0, dupTheft: 0, published: 0, deduped: 0, corrected: 0 }

/** litres, without the false precision of "40.0" for a whole number. */
const L = (ml: number): string => {
  const l = ml / 1000
  return `${Number.isInteger(l) ? l : l.toFixed(1)} L`
}

/**
 * Pull one vehicle's fuel events for the window, store them, and optionally
 * put the recent ones on the Live Feed.
 *
 * Feed publication is decided by the event's AGE, never by whether the ledger
 * row happened to be new. Tying the two together meant a nightly backfill
 * would swallow an event before any notify run could surface it, and the feed
 * stayed permanently empty. The stable `feedId` upsert is what makes
 * republishing harmless.
 */
export async function syncVehicleFuelEvents(
  client:  WialonClient,
  source:  OrgFuelSource,
  vehicle: SyncVehicle,
  opts:    SyncOptions,
): Promise<SyncOutcome> {
  const unitId = wialonUnitId(vehicle.deviceId)
  if (unitId == null) return { ...EMPTY }

  const events = await fetchUnitFuelEvents(client, {
    resourceId: source.resourceId,
    templateId: source.templateId,
    unitId,
    from: opts.from,
    to:   opts.to,
  })

  const out: SyncOutcome = { ...EMPTY }
  const cutoff = opts.notifyCutoff

  // Existence in ONE query per table instead of one per event.
  //
  // Every cycle re-reads a 3-hour window, so the same events come back over and
  // over and almost all of them are already in the ledger — this used to be a
  // `findFirst` per event, each a round trip over the pooler, all of them
  // answering the same question about one window. Range-scan the window once
  // and compare in memory. Timestamps come straight back from Postgres, so
  // exact equality on the epoch is the same test the per-event query made.
  const [knownFills, knownThefts] = await Promise.all([
    prisma.fuelFilling.findMany({
      where:  { vehicleId: vehicle.id, filledAt: { gte: opts.from, lte: opts.to } },
      select: { id: true, filledAt: true, filledMl: true, finalFuelLevelMl: true },
    }),
    prisma.fuelTheft.findMany({
      where:  { vehicleId: vehicle.id, beganAt: { gte: opts.from, lte: opts.to } },
      select: { id: true, beganAt: true, stolenMl: true, finalFuelLevelMl: true },
    }),
  ])
  const seenFills  = new Map(knownFills.map(r => [r.filledAt.getTime(), r]))
  const seenThefts = new Map(knownThefts.map(r => [r.beganAt.getTime(), r]))

  // One reporting period covers a month, so a 3-hour window resolves to one or
  // two of them — not one lookup per event.
  const periods = new Map<number, Promise<string>>()
  const periodFor = (at: Date): Promise<string> => {
    const k = Date.UTC(at.getUTCFullYear(), at.getUTCMonth())
    let p = periods.get(k)
    if (!p) { p = getOrCreatePeriodFor(source.orgId, at); periods.set(k, p) }
    return p
  }

  for (const f of events.fillings) {
    const known = seenFills.get(f.filledAt.getTime())
    if (known) {
      out.dupFill++
      // Wialon REFINES an event as more settled readings arrive: one filling on
      // 2026-08-02 was reported as 55.1 L, then 53.9 L, then 52.8 L across three
      // cycles. The ledger stored the first glimpse and never looked again while
      // the notification was upserted every time, so the two disagreed about the
      // same event — measured on the live box, KTCB 466U's 17:52 fill was 27.9 L
      // in the ledger and 47.0 L on the feed. Analytics and driver scoring read
      // the LEDGER, so the stale side was the one that mattered.
      //
      // Overwriting is the whole principle of this module applied consistently:
      // the provider computes the event, we record its current answer. Guarded
      // on a real change so a settled event is not rewritten every cycle.
      if (opts.apply && (known.filledMl !== f.filledMl || known.finalFuelLevelMl !== f.finalFuelLevelMl)) {
        await prisma.fuelFilling.update({
          where: { id: known.id },
          data:  {
            filledMl:           f.filledMl,
            initialFuelLevelMl: f.initialFuelLevelMl,
            finalFuelLevelMl:   f.finalFuelLevelMl,
            location:           f.location,
            mileageAtFillKm:    f.mileageAtFillKm,
          },
        })
        out.corrected++
      }
    }
    else {
      // Guard the in-memory map too: a report can legitimately return the same
      // event twice across tables, and nothing else stops a double insert now
      // that the check is not a fresh query each time.
      seenFills.set(f.filledAt.getTime(), {
        id: '', filledAt: f.filledAt, filledMl: f.filledMl, finalFuelLevelMl: f.finalFuelLevelMl,
      })
      out.fillings++
      if (opts.apply) {
        await prisma.fuelFilling.create({
          data: {
            vehicleId:          vehicle.id,
            reportingPeriodId:  await periodFor(f.filledAt),
            filledAt:           f.filledAt,
            filledMl:           f.filledMl,
            initialFuelLevelMl: f.initialFuelLevelMl,
            finalFuelLevelMl:   f.finalFuelLevelMl,
            location:           f.location,
            mileageAtFillKm:    f.mileageAtFillKm,
          },
        })
      }
    }

    if (opts.apply && opts.notify && (!cutoff || f.filledAt >= cutoff)) {
      const { published } = await publishNotificationDurable({
        orgId:     source.orgId,
        id:        `fuel-fill-${vehicle.id}-${f.filledAt.getTime()}`,
        source:    'wialon',
        alertType: 'fuelFilling',
        severity:  'info',
        text: `${vehicle.registrationPlate} refuelled ${L(f.filledMl)}`
          + (f.location ? ` at ${f.location}` : '')
          + (f.finalFuelLevelMl != null ? `. Tank now ${L(f.finalFuelLevelMl)}.` : '.'),
        at:        f.filledAt,
        plate:     vehicle.registrationPlate,
        vehicleId: vehicle.id,
      })
      if (published) out.published++
      else           out.deduped++
    }
  }

  for (const t of events.thefts) {
    const knownTheft = seenThefts.get(t.beganAt.getTime())
    if (knownTheft) {
      out.dupTheft++
      // Same refinement, and it matters more here: a drain's volume is the
      // number an operator would act on.
      if (opts.apply && (knownTheft.stolenMl !== t.stolenMl || knownTheft.finalFuelLevelMl !== t.finalFuelLevelMl)) {
        await prisma.fuelTheft.update({
          where: { id: knownTheft.id },
          data:  {
            stolenMl:           t.stolenMl,
            detectedAt:         t.detectedAt,
            initialFuelLevelMl: t.initialFuelLevelMl,
            finalFuelLevelMl:   t.finalFuelLevelMl,
            initialLocation:    t.initialLocation,
            initialSpeedKmh:    t.initialSpeedKmh,
          },
        })
        out.corrected++
      }
    }
    else {
      seenThefts.set(t.beganAt.getTime(), {
        id: '', beganAt: t.beganAt, stolenMl: t.stolenMl, finalFuelLevelMl: t.finalFuelLevelMl,
      })
      out.thefts++
      if (opts.apply) {
        await prisma.fuelTheft.create({
          data: {
            vehicleId:         vehicle.id,
            reportingPeriodId: await periodFor(t.beganAt),
            // No driver: the report names a unit, not a person, and who was
            // assigned during a drain days ago is not something the current
            // roster can answer.
            driverId:           null,
            beganAt:            t.beganAt,
            detectedAt:         t.detectedAt,
            stolenMl:           t.stolenMl,
            initialFuelLevelMl: t.initialFuelLevelMl,
            finalFuelLevelMl:   t.finalFuelLevelMl,
            initialLocation:    t.initialLocation,
            initialSpeedKmh:    t.initialSpeedKmh,
            finalSpeedKmh:      null,
          },
        })
      }
    }

    if (opts.apply && opts.notify && (!cutoff || t.beganAt >= cutoff)) {
      const { published } = await publishNotificationDurable({
        orgId:     source.orgId,
        id:        `fuel-drain-${vehicle.id}-${t.beganAt.getTime()}`,
        source:    'wialon',
        alertType: 'fuelInconsistency',
        severity:  'critical',
        // No "Security alerted." — the rule the rest of the feed follows: no
        // escalation path exists, so none is claimed. The wording states what
        // Wialon measured and nothing more.
        text: `FUEL DROP: ${vehicle.registrationPlate} — ${L(t.stolenMl)} lost`
          + (t.initialLocation ? ` at ${t.initialLocation}` : '')
          + (t.finalFuelLevelMl != null ? `. Tank now ${L(t.finalFuelLevelMl)}.` : '.'),
        at:        t.beganAt,
        plate:     vehicle.registrationPlate,
        vehicleId: vehicle.id,
      })
      if (published) out.published++
      else           out.deduped++
    }
  }

  return out
}

/**
 * Vehicles whose OWN fuel readings moved enough to be worth asking Wialon about.
 *
 * This is what makes a frequent job affordable. One report execution per
 * vehicle takes seconds and Wialon serialises them per session, so sweeping all
 * ~460 instrumented vehicles takes tens of minutes — far too slow to run every
 * quarter hour, and far too heavy for a t3.micro that is already swapping.
 *
 * The poller already stores a calibrated level every couple of minutes, so a
 * tank whose level has not moved cannot have been filled or drained. Comparing
 * the window's min and max costs one indexed scan and typically leaves a
 * handful of candidates.
 *
 * This is strictly a TRIGGER: the threshold decides who to ask about, never
 * what happened. Every published volume, time and place still comes from
 * Wialon's own report, so a crude threshold here cannot put a wrong number on
 * the feed — at worst it asks about a vehicle that turns out to have no event,
 * or waits for the next sweep to catch a slow drain.
 */
export async function findFuelCandidates(
  orgId:       string,
  since:       Date,
  thresholdMl: number,
): Promise<SyncVehicle[]> {
  return prisma.$queryRaw<SyncVehicle[]>`
    SELECT v.id, v.device_id AS "deviceId", v.registration_plate AS "registrationPlate"
    FROM vehicles v
    JOIN LATERAL (
      SELECT MAX(t.fuel_level_ml) - MIN(t.fuel_level_ml) AS spread
      FROM vehicle_telemetries t
      WHERE t.vehicle_id = v.id
        AND t.captured_at >= ${since}
        AND t.fuel_level_ml IS NOT NULL
    ) s ON TRUE
    WHERE v.organisation_id = ${orgId}
      AND v.device_id LIKE 'wialon:%'
      AND v.tank_capacity_litres IS NOT NULL
      AND s.spread >= ${thresholdMl}
    ORDER BY v.registration_plate
  `
}
