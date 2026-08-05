/**
 * RaiFactorySuite operational events — dispatches and gate movements.
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
 * Both are narrated into the Live Feed. Alerts live in
 * raifactorysuite-alerts.service.ts.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { eventBus } from '../../lib/event-bus.js'
import { parseProviderTime, parseProviderTimeOr } from '../../lib/provider-time.js'

/** Provider factoryCode → our organisation code (mirrors the sync scripts). */
const FACTORY_TO_ORG: Record<string, string> = { NDHIWA: 'SUKARI' }

const orgIdCache = new Map<string, string | null>()
async function resolveOrgId(factoryCode: string): Promise<string | null> {
  if (orgIdCache.has(factoryCode)) return orgIdCache.get(factoryCode) ?? null
  const code = FACTORY_TO_ORG[factoryCode]
  if (!code) { orgIdCache.set(factoryCode, null); return null }
  const org = await prisma.organisation.findUnique({ where: { code }, select: { id: true } })
  orgIdCache.set(factoryCode, org?.id ?? null)
  return org?.id ?? null
}

const norm = (s: string | null | undefined): string =>
  (s ?? '').trim().toUpperCase().replace(/\s+/g, ' ')

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
  const organisationId = await resolveOrgId(d.factoryCode)
  if (!organisationId) return false

  // Provider timestamps are offsetless EAT — see lib/provider-time.
  const when = parseProviderTimeOr(d.dispatchTime)

  const vehicle = await prisma.vehicle.findFirst({
    where: { organisationId, registrationPlate: norm(d.vehicleNumberPlate) },
    select: { id: true },
  })

  // The dispatch ITSELF, kept whether or not the plate and driver resolve.
  //
  // Two things need it. The map tooltip needs the open one per vehicle (where
  // is this truck going, since when, when is it due). The duration statistics
  // need the closed ones — and `/dispatches` is a 1000-row sliding window with
  // no pagination, so anything not persisted here is lost the moment the
  // provider's window moves past it.
  const row = {
    organisationId,
    vehicleId:        vehicle?.id ?? null,
    plate:            norm(d.vehicleNumberPlate),
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
    `${d.vehicleNumberPlate} · ${d.driverName} signed out${dest} — left the premises.`,
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
 * RETURN is left alone: nothing else observes a vehicle coming home, the
 * provider records it at the weighbridge, and it is not duplicated by anything.
 */
export async function handleMovement(m: MovementEvent): Promise<boolean> {
  const organisationId = await resolveOrgId(m.factoryCode)
  if (!organisationId) return false

  const when = parseProviderTimeOr(m.timestamp)

  const exiting = (m.direction ?? '').toUpperCase() === 'EXIT'
  if (exiting) {
    const echoed = await prisma.dispatch.findFirst({
      where: {
        plate:        m.vehicleNumberPlate,
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
