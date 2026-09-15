/**
 * RaiFactorySuite operational events — dispatches, gate movements and sales.
 *
 *   dispatch.created — a unit left with a driver. Same shape as the REST
 *                      /dispatches resource, so this and `sync:drivers`
 *                      produce identical assignment rows (both tag the row
 *                      `controltech:dispatch:<id>`, which is what makes them
 *                      idempotent against each other).
 *
 *   movement.created — a unit crossed the factory gate (EXIT / ENTRY). NOTE:
 *                      it carries NO coordinates — this is a checkpoint
 *                      crossing, not GPS, so it cannot move map markers.
 *
 *   (sales)          — a SALES dispatch: finished sugar leaving for a
 *                      customer, raised by the sales office and then signed
 *                      out and back in by the gate guard. Carries a TONNAGE,
 *                      which nothing else in this integration does. See
 *                      handleSale for why it narrates differently.
 *
 * All are narrated into the Live Feed. Alerts live in
 * raifactorysuite-alerts.service.ts.
 *
 * ## Every one of these routes by the UNIT, not by the factory
 *
 * A factory is a place; the organisation that should see the event is the one
 * that OWNS the truck. Naitiri is a West Kenya Sugar factory where Menengai
 * units load, and routing on `factoryCode` put those on the West Kenya Sugar
 * feed and nowhere else. `resolveEventOrg` is the correction — see
 * factory-map.ts, which also explains why asking the provider about the unit
 * cannot fix it.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { eventBus } from '../../lib/event-bus.js'
import { parseProviderTime, parseProviderTimeOr } from '../../lib/provider-time.js'
import {
  resolveEventOrg, skipUnmappedFactory, bagsFromTonnes, BAG_KG, type EventOrg,
} from './factory-map.js'

/**
 * Narrate an event into the Live Feed via the bus (notification.worker owns the
 * fan-out — see raifactorysuite-alerts.service for why).
 *
 * `notify: false` on every one of these: a dispatch leaving the yard is routine
 * narration, and pushing it to every subscribed device would train people to
 * ignore the notifications that DO matter. They still appear in the feed — and
 * they are still STORED, which is a separate flag and for a while was not: the
 * worker passed notify straight through as `persist`, so none of this narration
 * ever reached the database. See ProviderAlertEvent.
 */
function feed(
  orgId: string,
  id: string,
  at: Date,
  type: 'info' | 'success' | 'warning',
  text: string,
  extra: { alertType: string; plate?: string | null; vehicleId?: string | null },
) {
  eventBus.publish('provider:alert', {
    orgId,
    id,
    source:    'controltech',   // stored value — see provider_alerts.source
    alertType: extra.alertType,
    severity:  type,
    text,
    at,
    plate:     extra.plate ?? null,
    vehicleId: extra.vehicleId ?? null,
    notify:    false,
  })
}

export interface DispatchEvent {
  id: string; factoryCode: string; vehicleNumberPlate: string; driverName: string
  vehicleType?: string | null; destinationOrPurpose?: string | null; status?: string | null
  dispatchTime?: string | null; expectedReturnTime?: string | null; actualReturnTime?: string | null
}

export interface MovementEvent {
  id: string; factoryCode: string; vehicleNumberPlate: string
  driverName?: string | null; direction?: string | null; destination?: string | null
  timestamp?: string | null
}

/**
 * Persist the driver↔vehicle link a dispatch represents, and narrate it.
 * Mirrors sync-drivers.ts so a webhook and a later backfill converge on the
 * same row rather than duplicating.
 */
export async function handleDispatch(
  d: DispatchEvent,
  { narrate = true, source = 'webhook' }: { narrate?: boolean; source?: string } = {},
): Promise<boolean> {
  // Routed by the UNIT, not by the factory. A vehicle from another
  // organisation loading here belongs to ITS owner's feed — see factory-map.
  const org = await resolveEventOrg(d.factoryCode, d.vehicleNumberPlate)
  if (!org) {
    // Was a bare `return false`, and that was the bug. The controller counts
    // the false as "nothing happened" and its summary log line is gated on the
    // counters, so an entire factory's dispatches arrived, parsed, and left no
    // record anywhere that they had ever been offered.
    skipUnmappedFactory(d.factoryCode, 'dispatch', d.id)
    return false
  }
  const { organisationId } = org

  // Provider timestamps are offsetless EAT — see lib/provider-time.
  const when = parseProviderTimeOr(d.dispatchTime)

  const vehicle = org.vehicleId ? { id: org.vehicleId } : null

  // The dispatch ITSELF, kept whether or not the plate and driver resolve.
  //
  // Two things need it. The map tooltip needs the open one per vehicle (where
  // is this truck going, since when, when is it due). The duration statistics
  // need the closed ones — and `/dispatches` is a 1000-row sliding window with
  // no pagination, so anything not persisted here is lost the moment the
  // provider's window moves past it.
  const row = {
    organisationId,
    kind:             'CANE' as const,
    factoryCode:      d.factoryCode,
    vehicleId:        vehicle?.id ?? null,
    plate:            org.plate,
    driverName:       d.driverName.trim(),
    destination:      d.destinationOrPurpose?.trim() || null,
    status:           (d.status ?? 'DISPATCHED').toUpperCase(),
    dispatchedAt:     when,
    expectedReturnAt: parseProviderTime(d.expectedReturnTime),
    actualReturnAt:   parseProviderTime(d.actualReturnTime),
    source,
  }
  // Whether this is the FIRST time we have seen this dispatch decides whether
  // it is narrated below. Checked before the upsert, because after it the row
  // exists either way and the two cases are indistinguishable.
  const alreadyKnown = await prisma.dispatch.findUnique({
    where: { externalId: d.id }, select: { id: true },
  })

  await prisma.dispatch.upsert({
    where:  { externalId: d.id },
    create: { externalId: d.id, ...row },
    // A dispatch is re-read on every reconcile pass and changes as it runs
    // (DISPATCHED → OVERDUE → COMPLETED, and actualReturnTime lands at the
    // end), so the update path is the normal case, not the exception.
    update: row,
  })

  // The driver is identified by name only — the provider sends no id here.
  // A name shared by two people can't be resolved, so leave it unassigned
  // rather than attributing a dispatch to the wrong person.
  const drivers = await prisma.user.findMany({
    where:  { organisationId, fullName: d.driverName.trim(), deletedAt: null },
    select: { id: true },
    take:   2,
  })

  if (vehicle && drivers.length === 1) {
    const marker = `controltech:dispatch:${d.id}`
    const existing = await prisma.vehicleAssignment.findFirst({ where: { notes: marker }, select: { id: true } })
    const payload = {
      vehicleId:      vehicle.id,
      userId:         drivers[0]!.id,
      assignmentType: 'PRIMARY' as const,
      assignedAt:     when,
      unassignedAt:   parseProviderTime(d.actualReturnTime),
      notes:          marker,
    }
    if (existing) await prisma.vehicleAssignment.update({ where: { id: existing.id }, data: payload })
    else          await prisma.vehicleAssignment.create({ data: payload })
  } else {
    logger.debug(
      { plate: d.vehicleNumberPlate, driver: d.driverName, vehicleFound: !!vehicle, driverMatches: drivers.length },
      'Dispatch could not be linked to a unique vehicle+driver',
    )
  }

  // Narrate a dispatch the FIRST time we see it, and never again.
  //
  // The reconcile poller re-reads the same day-wide window every few minutes,
  // so "have I told this story already" cannot be answered by the caller — it
  // is answered by whether the row existed a moment ago. That is what makes it
  // safe for the reconciler to narrate at all, which it must: the
  // `dispatch.created` webhook is not arriving in production, and until this
  // changed the Live Feed had never once carried a dispatch (1,813 on record,
  // zero feed items).
  //
  // Two independent guards, because they stop different things. `narrate` is
  // the caller's own veto — the reconciler's first pass after a restart, which
  // creates a day of backlog rows and must not replay them as fresh news. This
  // one stops the steady-state repeat.
  if (!narrate || alreadyKnown) return true

  // The sign-out IS the departure, and this line is where the feed says so.
  //
  // It used to read "dispatched to X" and leave "has it actually gone" to the
  // telemetry-derived gate line in lib/yard-departure. That reaches only the
  // units with a tracker bound — a minority of this fleet — so for most of the
  // yard the feed narrated the paperwork and then never mentioned the vehicle
  // leaving at all. The yard signs a unit out and it goes; that is the record
  // the operator keeps, and the measured crossing (when there is one) now
  // CONFIRMS this line with a time rather than being the only claim of it.
  const dest = d.destinationOrPurpose ? ` to ${d.destinationOrPurpose}` : ''
  feed(
    organisationId, `dp-${d.id}`, when, 'info',
    `${d.vehicleNumberPlate} · ${d.driverName} signed out${dest} and left the premises.`,
    { alertType: 'DISPATCH', plate: d.vehicleNumberPlate, vehicleId: vehicle?.id ?? null },
  )
  return true
}

/**
 * How close to its dispatch an EXIT event has to be before it is treated as
 * part of the same paperwork rather than as a movement in its own right.
 *
 * Generous against a measured distribution: over seven days, 281 of 283
 * dispatches were followed by their EXIT within one second (median 9 ms, p90
 * 13 ms, max 39 ms). A minute leaves no room for a real gate crossing to be
 * swallowed — a truck that takes under a minute from paperwork to gate has not
 * been observed on this fleet — while comfortably covering webhook redelivery
 * and the one case seen arriving 54 s BEFORE its dispatch.
 */
const DISPATCH_ECHO_MS = 60_000

/**
 * How far apart a measured gate arrival and the provider's RETURN may be and
 * still be the same homecoming.
 *
 * Wider than DISPATCH_ECHO_MS because these two are NOT the same clock the way
 * a dispatch and its EXIT are. That pair is emitted inside one transaction, 9 ms
 * apart. This pair is a barrier crossing and a weighbridge entry — genuinely
 * different moments, separated by however long the unit takes to queue and
 * weigh in. Ten minutes covers that without reaching so far that two separate
 * visits in one shift could be collapsed into one.
 */
const ARRIVAL_ECHO_MS = 10 * 60_000

/**
 * Narrate a gate crossing. No coordinates are involved.
 *
 * An EXIT that echoes its own dispatch is dropped — not because the departure
 * it asserts is doubted (the sign-out is now exactly what the dispatch line
 * above narrates as leaving), but because it is the SAME sign-out arriving
 * twice: the provider emits it inside the dispatch transaction, median 9 ms
 * later. Narrating both would post two sentences about one act, 9 ms apart,
 * on all ~115 sign-outs a day. One event, one line.
 *
 * An EXIT with no dispatch behind it still narrates: then it is the only
 * record of that crossing, and dropping it would lose the departure entirely.
 *
 * RETURN used to be left alone, on the grounds that nothing else observed a
 * vehicle coming home. Since 2026-08-10 something does: lib/yard-departure's
 * `trackYardArrival` measures the crossing off the vehicle's own fixes, so for
 * a tracked unit the same arrival can now reach the feed twice.
 *
 * Where both exist the MEASURED one wins and the RETURN is suppressed, because
 * they are not equally good: the provider stamps its RETURN at the weighbridge,
 * which is where the paperwork happens rather than where the barrier is, while
 * the telemetry line carries the time the unit was actually at the gate.
 *
 * The suppression is conditional on our line having genuinely been published —
 * it looks for the notification, not for a tracker. So a unit whose tracker was
 * dark, or one FactorySuite knows and Wialon does not, still gets its RETURN
 * narrated. Nothing is lost by adding the measured source; it only displaces
 * the provider's line where it actually has something better to say.
 */
export async function handleMovement(m: MovementEvent): Promise<boolean> {
  // By the unit, not the gate it crossed — see handleDispatch above.
  const org = await resolveEventOrg(m.factoryCode, m.vehicleNumberPlate)
  if (!org) {
    skipUnmappedFactory(m.factoryCode, 'movement', m.id)
    return false
  }
  const { organisationId } = org

  const when = parseProviderTimeOr(m.timestamp)

  const exiting = (m.direction ?? '').toUpperCase() === 'EXIT'
  if (exiting) {
    const echoed = await prisma.dispatch.findFirst({
      where: {
        plate:        org.plate,
        dispatchedAt: {
          gte: new Date(when.getTime() - DISPATCH_ECHO_MS),
          lte: new Date(when.getTime() + DISPATCH_ECHO_MS),
        },
      },
      select: { id: true },
    })
    if (echoed) {
      logger.debug(
        { plate: m.vehicleNumberPlate, dispatch: echoed.id },
        'Movement EXIT echoes its dispatch — not narrated; the sign-out line already says it left',
      )
      return true
    }
  } else {
    // RETURN: stand down if we already measured this arrival at the gate.
    //
    // Matched on the notification we published, not on whether the vehicle has
    // a tracker — a dark tracker publishes nothing, finds nothing here, and the
    // provider's line goes out as it always did.
    const measured = await prisma.notification.findFirst({
      where: {
        organisationId: organisationId,
        plate:          org.plate,
        alertType:      'MOVEMENT_ENTRY',
        source:         'telemetry',
        occurredAt: {
          gte: new Date(when.getTime() - ARRIVAL_ECHO_MS),
          lte: new Date(when.getTime() + ARRIVAL_ECHO_MS),
        },
      },
      select: { feedId: true },
    })
    if (measured) {
      logger.debug(
        { plate: m.vehicleNumberPlate, measured: measured.feedId },
        'Movement RETURN superseded by the measured gate arrival — not narrated',
      )
      return true
    }
  }

  const who     = m.driverName ? ` · ${m.driverName}` : ''
  const dest    = m.destination ? ` to ${m.destination}` : ''
  const text    = exiting
    ? `${m.vehicleNumberPlate}${who} left the yard${dest}.`
    : `${m.vehicleNumberPlate}${who} returned to the yard.`

  feed(organisationId, `mv-${m.id}`, when, exiting ? 'info' : 'success', text, {
    alertType: `MOVEMENT_${(m.direction ?? 'UNKNOWN').toUpperCase()}`,
    plate:     m.vehicleNumberPlate,
  })
  return true
}

// ───────────────────────────────────────────────────────────────────────────
// SALES
// ───────────────────────────────────────────────────────────────────────────

export interface SaleEvent {
  id: string; factoryCode: string; vehicleNumberPlate: string
  driverName?: string | null; tonnage?: number | null; destination?: string | null
  status?: string | null
  signOutTime?: string | null; signOutPhotoUrl?: string | null
  returnTime?:  string | null; returnPhotoUrl?:  string | null
  /**
   * The gate's document number, under whichever name the provider gives it.
   *
   * Every one of these is optional and every one is absent today: the observed
   * payload is exactly the eleven fields above (measured against the live
   * /sales response, 2026-09-15). They are declared because the field is one we
   * have been asked to display and there is no way to know in advance which
   * spelling it will arrive under — and reading several costs nothing, whereas
   * guessing wrong means the value lands and is silently dropped.
   */
  serialNumber?: string | null; serialNo?: string | null
  gatePassNo?:   string | null; documentNo?: string | null
  referenceNo?:  string | null
}

/**
 * The run's document number, or null.
 *
 * Trimmed, and an empty string is a null — a provider that models the field
 * without populating it tends to send `""`, and `""` rendered beside a shield
 * icon is a label with nothing after it.
 */
function saleSerial(s: SaleEvent): string | null {
  const raw = s.serialNumber ?? s.serialNo ?? s.gatePassNo ?? s.documentNo ?? s.referenceNo
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed.length > 0 ? trimmed : null
}

/** Re-exported so callers that already import the bag maths from the sales
 *  handler keep working; the single definition lives with the factory table,
 *  beside the commodity it counts. */
export { bagsFromTonnes } from './factory-map.js'

/** "29.0t (580 × 50 kg bags)", or nothing at all. */
function loadPhrase(tonnage: number | null | undefined): string {
  const bags = bagsFromTonnes(tonnage)
  if (bags == null) return ''
  return `${tonnage!.toFixed(1)}t (${bags.toLocaleString('en-GB')} × ${BAG_KG} kg bags)`
}

/**
 * A sales run: sugar out of the factory gate and back.
 *
 * ## Why this cannot reuse handleDispatch's narration rule
 *
 * A cane dispatch is narrated the first time it is seen and never again, and
 * that is right because it tells one story: the paperwork was raised. A SALES
 * row tells two, at different times, and the same `id` is delivered for both —
 * the guard signs the unit out, and later signs it back in. Narrating on first
 * sight would announce the departure and then stay silent on the return, which
 * is the half the weighbridge is waiting for.
 *
 * So the guard here is a TRANSITION check: what did we already hold for this
 * run, and what does this delivery add? Each of the two moments is narrated
 * exactly once however many times the row is re-offered — which the reconciler
 * relies on, because `/sales` ignores its own `status` filter and there is no
 * way to ask it for only what changed.
 *
 * ## The timestamps decide the state, not `status`
 *
 * `status` is recorded but never branched on. Its vocabulary is not published,
 * the only value observed is RETURNED, and the endpoint IGNORES `status` as a
 * query parameter — so a run's state is read off `signOutTime` and `returnTime`,
 * which are unambiguous.
 *
 * ## Nothing is stored before sign-out
 *
 * A sale that exists on paper but has not left has no `signOutTime`, and
 * `dispatches.dispatched_at` is NOT NULL for a good reason: every consumer of
 * that column means "when did this unit go". Inventing a time so the row can be
 * written would put a truck on the map that is standing in the yard. It is
 * skipped, and picked up on the delivery that signs it out.
 */
export async function handleSale(
  s: SaleEvent,
  { narrate = true, source = 'webhook' }: { narrate?: boolean; source?: string } = {},
): Promise<boolean> {
  const org = await resolveEventOrg(s.factoryCode, s.vehicleNumberPlate)
  if (!org) {
    skipUnmappedFactory(s.factoryCode, 'sale', s.id)
    return false
  }

  const signedOutAt = parseProviderTime(s.signOutTime)
  if (!signedOutAt) {
    logger.debug(
      { sale: s.id, plate: org.plate, status: s.status },
      'Sales run not signed out yet — nothing to place on the map; will store when the guard signs it out',
    )
    return false
  }
  const returnedAt = parseProviderTime(s.returnTime)

  const row = {
    organisationId:   org.organisationId,
    kind:             'SALES' as const,
    factoryCode:      s.factoryCode,
    vehicleId:        org.vehicleId,
    plate:            org.plate,
    driverName:       s.driverName?.trim() || 'Unassigned',
    destination:      s.destination?.trim() || null,
    // Mapped into the vocabulary the rest of the system already speaks, so a
    // sales run shows up in the open-runs query and the duration statistics
    // without either of them learning a second set of words. OPEN_STATUSES in
    // dispatches/dispatch.repository is what these have to line up with.
    status:           returnedAt ? 'COMPLETED' : 'DISPATCHED',
    dispatchedAt:     signedOutAt,
    // The sales office sets no due-back commitment, so there is nothing honest
    // to put here. Left null; the tooltip falls through to the measured median
    // for the destination once one exists.
    expectedReturnAt: null,
    actualReturnAt:   returnedAt,
    tonnageT:         s.tonnage ?? null,
    // serialNumber: saleSerial(s) — there is no column to write it to. Adding
    // one to schema.prisma ahead of the migration broke this upsert outright
    // (Prisma returns the whole row, so RETURNING named a column Postgres did
    // not have) and stopped every sign-out landing for forty minutes. See the
    // field's note on OpenTrip in dispatches/dispatch.repository; `saleSerial`
    // returns null for every payload the provider currently sends in any case.
    signOutPhotoUrl:  s.signOutPhotoUrl ?? null,
    returnPhotoUrl:   s.returnPhotoUrl ?? null,
    source,
  }

  // What we held BEFORE this delivery — the two booleans that decide which of
  // the run's two moments are new. Read before the upsert, because afterwards
  // the row carries the new state and the transition is unrecoverable.
  const before = await prisma.dispatch.findUnique({
    where:  { externalId: s.id },
    select: { id: true, actualReturnAt: true },
  })
  const departureIsNew = before == null
  const returnIsNew    = returnedAt != null && before?.actualReturnAt == null

  await prisma.dispatch.upsert({
    where:  { externalId: s.id },
    create: { externalId: s.id, ...row },
    update: row,
  })

  await linkSaleDriver(s, org, signedOutAt, returnedAt)

  if (!narrate) return true

  const who  = `${org.plate} · ${row.driverName}`
  const at   = org.factory ? ` at ${org.factory.label}` : ''
  const load = loadPhrase(s.tonnage)
  const dest = row.destination ? ` bound for ${row.destination}` : ''

  if (departureIsNew) {
    // The guard's sign-out IS the departure — same reasoning as the cane
    // sign-out line above. No ETA: the destination of a sales run is a customer
    // site, not one of the measured cane zones, so there is no median to quote
    // until the fleet has driven the route enough times for sync:destinations
    // to place it. Quoting a distance from the owning org's hub would be worse
    // than silence — for a Menengai unit that hub is ~250 km from this gate.
    feed(
      org.organisationId, `sl-${s.id}`, signedOutAt, 'info',
      `${who} signed out${at}${load ? ` with ${load}` : ''}${dest} and left the premises.`,
      { alertType: 'SALE_DISPATCH', plate: org.plate, vehicleId: org.vehicleId },
    )
  }

  if (returnIsNew) {
    feed(
      org.organisationId, `sl-${s.id}-ret`, returnedAt!, 'success',
      `${who} signed back in${at}; the sales run${dest} is complete.`,
      { alertType: 'SALE_RETURN', plate: org.plate, vehicleId: org.vehicleId },
    )
  }

  return true
}

/**
 * Attach the driver to the vehicle for the duration of the run.
 *
 * Same name-only identification, and the same refusal to guess, as the cane
 * path: the provider sends no driver id on a sale either. The marker differs
 * (`controltech:sale:<id>`) so a sales run and a cane dispatch can never
 * collapse onto one assignment row.
 */
async function linkSaleDriver(
  s: SaleEvent,
  org: EventOrg,
  from: Date,
  to: Date | null,
): Promise<void> {
  const name = s.driverName?.trim()
  if (!org.vehicleId || !name) return

  const drivers = await prisma.user.findMany({
    where:  { organisationId: org.organisationId, fullName: name, deletedAt: null },
    select: { id: true },
    take:   2,
  })
  if (drivers.length !== 1) {
    logger.debug(
      { plate: org.plate, driver: name, driverMatches: drivers.length },
      'Sales run could not be linked to a unique driver',
    )
    return
  }

  const marker   = `controltech:sale:${s.id}`
  const existing = await prisma.vehicleAssignment.findFirst({ where: { notes: marker }, select: { id: true } })
  const payload  = {
    vehicleId:      org.vehicleId,
    userId:         drivers[0]!.id,
    assignmentType: 'PRIMARY' as const,
    assignedAt:     from,
    unassignedAt:   to,
    notes:          marker,
  }
  if (existing) await prisma.vehicleAssignment.update({ where: { id: existing.id }, data: payload })
  else          await prisma.vehicleAssignment.create({ data: payload })
}
