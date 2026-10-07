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
 *
 * ## Which reported event is which row
 *
 * The hard part is not fetching the events, it is deciding whether one has been
 * seen before. An overlapping window re-reports the same event every cycle, and
 * the provider MOVES an in-progress event's timestamps between reports — so a
 * timestamp is not an identity, and treating it as one made the ledger grow a
 * fresh row per cycle for one physical drain. See fuel-event-match.ts for the
 * rule that replaced it and the live measurements behind it.
 *
 * Matching stops duplicates being written. It cannot remove what the provider
 * has RETRACTED, which is what `SyncOptions.reconcile` is for.
 */

import type { WialonClient } from '../../providers/wialon/wialon.client.js'
import { fetchUnitFuelEvents, listReportTemplates } from '../../providers/wialon/wialon.reports.js'
import { sameDrain, sameFilling, matchRow } from './fuel-event-match.js'
import { getOrCreatePeriodFor } from '../../lib/reporting-period.js'
// The AWAITED publish. `publishNotification` detaches its Postgres write so a
// 2-second poll cycle is never blocked by the pooler; nothing here is on that
// clock, and awaiting means a finished cycle really has stored what it says it
// published — which also makes the backfill CLI safe, since a process that
// exits would otherwise race its own detached writes.
import { publishNotificationDurable } from '../../lib/notifications/notification.store.js'
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { shortPlaceLabel } from '../../lib/place-label.js'
import {
  KASULU_WIALON_ACCOUNT_ID,
  MENENGAI_WIALON_ACCOUNT_ID,
  WEST_SUGAR_REPORT_RESOURCE_ID,
  AQUAMIST_RESOURCE_ID,
} from '../../providers/wialon/wialon.account.js'

/**
 * Which Wialon resource holds each org's fuel templates.
 *
 * Kasulu's and Menengai's resource ids equal their account ids (see
 * wialon.account). Sukari's and West Sugar's do NOT: both fleets bill to the
 * shared RAI GROUP account while their REPORTS sit on resources of their own,
 * and RAI GROUP carries no per-unit fuel template at all. So every id is stated
 * rather than derived from the account — deriving would have silently pointed
 * two of the four orgs at a resource with nothing to read.
 *
 * Menengai and West Sugar added 2026-08-31. Both resources were confirmed to
 * carry the template `TEMPLATE_PREFERENCE` asks for first, so nothing else here
 * had to change:
 *
 *     25601229  template  8  "Menengai1-Advanced Fuel Analysis Report (Per Vehicle)"
 *     28842931  template  4  "West Kenya- Advanced Fuel Analysis Report (Per Vehicle)"
 *
 * An org missing from this list has no fuel ledger and no fuel feed items,
 * however well instrumented its vehicles are — which is exactly what those two
 * fleets looked like between onboarding and this line.
 */
export const ORG_RESOURCES: ReadonlyArray<{ code: string; resourceId: number }> = [
  { code: 'KASULU',    resourceId: KASULU_WIALON_ACCOUNT_ID },
  { code: 'SUKARI',    resourceId: 28843152 },
  { code: 'MENENGAI',  resourceId: MENENGAI_WIALON_ACCOUNT_ID },
  { code: 'WESTSUGAR', resourceId: WEST_SUGAR_REPORT_RESOURCE_ID },
  // Kabras units moved out of WESTSUGAR 2026-10-07; same West Kenya resource.
  { code: 'KABRAS',    resourceId: WEST_SUGAR_REPORT_RESOURCE_ID },
  // 2026-10-07: template 1 "Aquamist Advanced Fuel Analysis Report Per Vehicle".
  // TIMSALES is absent: the token sees no resource for its account.
  { code: 'AQUAMIST',  resourceId: AQUAMIST_RESOURCE_ID },
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
  /**
   * Treat the provider's answer for this window as COMPLETE, and delete ledger
   * rows inside it that the provider no longer reports.
   *
   * The matcher stops duplicates being created, but it cannot remove what the
   * provider has since RETRACTED — a candidate drain that a wider, settled
   * window no longer considers an event at all. Measured on MUFINDI: DZ 04,
   * eight of its 29 stored drains had no counterpart in Wialon's settled answer
   * for the same day; nothing in an insert-and-update sync would ever clear
   * them, so they inflated the loss figure permanently.
   *
   * ONLY safe on a window that has finished maturing. On a live window an event
   * Wialon has not yet recognised would be deleted and re-inserted on every
   * cycle, churning the feed. The caller owns that judgement — see the settle
   * pass in lib/queues/fuel-events.ts.
   */
  reconcile?: boolean
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
  /**
   * Ledger rows deleted because the provider no longer reports them. Always 0
   * unless `reconcile` was asked for.
   */
  removed:    number
}

const EMPTY: SyncOutcome = { fillings: 0, thefts: 0, dupFill: 0, dupTheft: 0, published: 0, deduped: 0, corrected: 0, removed: 0 }

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
  // Every cycle re-reads an overlapping window, so the same events come back
  // over and over and almost all of them are already in the ledger — this used
  // to be a `findFirst` per event, each a round trip over the pooler, all of
  // them answering the same question about one window. Range-scan the window
  // once and match in memory.
  //
  // The fuel LEVELS are selected because they are half the identity of a
  // filling (see fuel-event-match): a re-report of one fill drifts in time but
  // still describes the same tank state.
  const [knownFills, knownThefts] = await Promise.all([
    prisma.fuelFilling.findMany({
      where:  { vehicleId: vehicle.id, filledAt: { gte: opts.from, lte: opts.to } },
      select: { id: true, filledAt: true, filledMl: true, initialFuelLevelMl: true, finalFuelLevelMl: true },
    }),
    prisma.fuelTheft.findMany({
      where:  { vehicleId: vehicle.id, beganAt: { gte: opts.from, lte: opts.to } },
      select: { id: true, beganAt: true, detectedAt: true, stolenMl: true, finalFuelLevelMl: true, dismissedAt: true },
    }),
  ])
  // Rows this pass has already bound to a reported event. Two distinct drains
  // can both overlap one stale row; without this they would both rewrite it and
  // the second would erase the first.
  const claimedFills  = new Set<string>()
  const claimedThefts = new Set<string>()

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
    const known = matchRow(
      knownFills, claimedFills,
      row => sameFilling(f, row),
      row => Math.abs(row.filledAt.getTime() - f.filledAt.getTime()),
    )
    // The row this event lives on, once it exists — the feed key below hangs off
    // it so a drifting timestamp cannot spawn a second item for one event.
    let ledgerId: string | null = known?.id ?? null

    if (known) {
      claimedFills.add(known.id)
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
      // the provider computes the event, we record its current answer. `filledAt`
      // is part of that answer now: the provider moves it, and a row pinned to
      // the first timestamp it was seen at is the same staleness in a different
      // column. Guarded on a real change so a settled event is not rewritten
      // every cycle.
      const changed = known.filledMl           !== f.filledMl
                   || known.finalFuelLevelMl   !== f.finalFuelLevelMl
                   || known.initialFuelLevelMl !== f.initialFuelLevelMl
                   || known.filledAt.getTime() !== f.filledAt.getTime()
      if (opts.apply && changed) {
        await prisma.fuelFilling.update({
          where: { id: known.id },
          data:  {
            filledAt:           f.filledAt,
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
      out.fillings++
      if (opts.apply) {
        const created = await prisma.fuelFilling.create({
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
        ledgerId = created?.id ?? null
        // Visible to the rest of THIS pass: one report can return the same event
        // twice across tables, and nothing else stops a double insert now that
        // the check is not a fresh query per event.
        if (created) {
          knownFills.push({
            id: created.id, filledAt: f.filledAt, filledMl: f.filledMl,
            initialFuelLevelMl: f.initialFuelLevelMl, finalFuelLevelMl: f.finalFuelLevelMl,
          })
          claimedFills.add(created.id)
        }
      }
    }

    if (opts.apply && opts.notify && (!cutoff || f.filledAt >= cutoff)) {
      const { published } = await publishNotificationDurable({
        orgId:     source.orgId,
        // Keyed on the LEDGER ROW, not on the timestamp: the provider moves an
        // in-progress event's clock, and a timestamp key turned one refuelling
        // into a fresh feed line every cycle. Falls back to the timestamp only
        // in a dry run, where no row exists to key on.
        id:        `fuel-fill-${vehicle.id}-${ledgerId ?? `t${f.filledAt.getTime()}`}`,
        source:    'wialon',
        alertType: 'fuelFilling',
        severity:  'info',
        // Shortened for the feed, not for the ledger — the row above keeps the
        // provider's full address. The feed line is one row on a panel over a
        // map, and "Ndhiwa-Uriri Rd., Kenya, Kanyikela Ward, Ndhiwa Sub County,
        // Homa Bay County, Riat Centre" wrapped it to four lines to say what
        // "Ndhiwa-Uriri, Riat Centre" says.
        text: `${vehicle.registrationPlate} refuelled ${L(f.filledMl)}`
          + (f.location ? ` at ${shortPlaceLabel(f.location)}` : '')
          + (f.finalFuelLevelMl != null ? `. The tank now holds ${L(f.finalFuelLevelMl)}.` : '.'),
        at:        f.filledAt,
        plate:     vehicle.registrationPlate,
        vehicleId: vehicle.id,
      })
      if (published) out.published++
      else           out.deduped++
    }
  }

  for (const t of events.thefts) {
    const knownTheft = matchRow(
      knownThefts, claimedThefts,
      row => sameDrain(t, row),
      row => Math.abs(row.beganAt.getTime() - t.beganAt.getTime()),
    )
    let ledgerId: string | null = knownTheft?.id ?? null

    if (knownTheft) {
      claimedThefts.add(knownTheft.id)
      out.dupTheft++
      // Same refinement, and it matters more here: a drain's volume is the
      // number an operator would act on. `beganAt` is included because it is
      // exactly what the provider re-clamps while a drain is still running —
      // the drift that used to manufacture a new row every cycle.
      const changed = knownTheft.stolenMl           !== t.stolenMl
                   || knownTheft.finalFuelLevelMl   !== t.finalFuelLevelMl
                   || knownTheft.beganAt.getTime()  !== t.beganAt.getTime()
                   || knownTheft.detectedAt.getTime() !== t.detectedAt.getTime()
      if (opts.apply && changed) {
        await prisma.fuelTheft.update({
          where: { id: knownTheft.id },
          data:  {
            beganAt:            t.beganAt,
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
      out.thefts++
      if (opts.apply) {
        // A drain an operator has already deleted must not come back as a new
        // alert. The provider re-clamps a running drain's start, so a re-report
        // can land outside this pass's window (knownThefts is keyed on beganAt)
        // and miss the row it belongs to. Looked up without the window, and
        // only here — a genuinely new drain is a few a day.
        const deleted = await prisma.fuelTheft.findFirst({
          where: {
            vehicleId:  vehicle.id,
            dismissedAt: { not: null },
            beganAt:    { lte: t.detectedAt },
            detectedAt: { gte: t.beganAt },
          },
          select: { dismissedAt: true, dismissedById: true, reviewedAt: true, reviewedById: true },
        })
        const created = await prisma.fuelTheft.create({
          data: {
            ...(deleted ? {
              dismissedAt:   deleted.dismissedAt,
              dismissedById: deleted.dismissedById,
              reviewStatus:  'DISMISSED' as const,
              reviewedAt:    deleted.reviewedAt ?? deleted.dismissedAt,
              reviewedById:  deleted.reviewedById ?? deleted.dismissedById,
            } : {}),
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
        ledgerId = created?.id ?? null
        if (created) {
          knownThefts.push({
            id: created.id, beganAt: t.beganAt, detectedAt: t.detectedAt,
            stolenMl: t.stolenMl, finalFuelLevelMl: t.finalFuelLevelMl,
            dismissedAt: created.dismissedAt ?? null,
          })
          claimedThefts.add(created.id)
        }
      }
    }

    // NOT announced here. A drain reaches the feed only once it has survived
    // adjudication — see modules/fuel/fuel-adjudication.service. Announcing on
    // the provider's claim is what put the false flags in front of the
    // operator: measured over the 250 most recent drains per org, 40% (KASULU)
    // and 50% (SUKARI) of decidable loss volume came back with no filling to
    // explain it. The 20-minute settle window is the agreed cost of not
    // asserting a theft the next twenty minutes will contradict.
    void ledgerId
  }

  // Anything in the window the provider did NOT report this time is something
  // it has retracted — a candidate event that a settled read no longer counts.
  // Only reached when the caller has vouched that the window has matured; see
  // SyncOptions.reconcile.
  if (opts.reconcile) {
    const staleFills  = knownFills.filter(r => !claimedFills.has(r.id)).map(r => r.id)
    // Never a drain an operator deleted: that row carries who deleted it and
    // its follow-up, and deleting it here is how a retracted-then-re-reported
    // drain used to return as a fresh alert with no memory of the deletion.
    const staleThefts = knownThefts
      .filter(r => !claimedThefts.has(r.id) && r.dismissedAt == null)
      .map(r => r.id)
    // Counted even in a dry run. This is the one branch that DELETES, so
    // "--reconcile without --apply" has to be able to answer "how much?"
    // before anyone runs it for real.
    out.removed = staleFills.length + staleThefts.length
    if (opts.apply) {
      if (staleFills.length > 0) {
        await prisma.fuelFilling.deleteMany({ where: { id: { in: staleFills } } })
      }
      if (staleThefts.length > 0) {
        await prisma.fuelTheft.deleteMany({ where: { id: { in: staleThefts } } })
      }
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
  // No `tank_capacity_litres IS NOT NULL` filter. It was standing in for "has a
  // fuel probe", but the lateral join already establishes that far better — a
  // vehicle with no fuel readings has a NULL spread and drops out regardless.
  // All the capacity test added was a blind spot: 19 KASULU and 23 SUKARI
  // instrumented vehicles were excluded from fuel sync entirely because nobody
  // had filled in their tank size.
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
      AND s.spread >= ${thresholdMl}
    ORDER BY v.registration_plate
  `
}

/**
 * A deterministic slice of the org's instrumented vehicles, for the settle pass.
 *
 * The movement trigger above is a good filter and a poor guarantee: it can only
 * see vehicles whose OWN telemetry moved, so a unit reporting sparsely is never
 * asked about. Measured on 2026-08-02, MUFINDI: 009 sent a single fuel reading
 * all day and Wialon held a 957.9 L drain for it that we never recorded — a
 * spread computed from one sample is zero, so it could not become a candidate.
 *
 * This closes that by rotation rather than by cleverness: every instrumented
 * vehicle comes up in turn, whatever its telemetry did. `slice` is derived from
 * the clock by the caller, so the rotation survives restarts and needs no
 * cursor to be stored anywhere.
 */
export async function listVehicleSlice(
  orgId: string,
  slice: number,
  size:  number,
): Promise<SyncVehicle[]> {
  const all = await prisma.vehicle.findMany({
    where:   { organisationId: orgId, deviceId: { startsWith: 'wialon:' } },
    select:  { id: true, deviceId: true, registrationPlate: true },
    orderBy: { id: 'asc' },        // stable across cycles; plate can be edited
  })
  if (all.length === 0) return []
  const slices = Math.ceil(all.length / size)
  const start  = (((slice % slices) + slices) % slices) * size
  return all.slice(start, start + size)
}
