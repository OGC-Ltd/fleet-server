/**
 * Controltech EA operational events — dispatches and gate movements.
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
 * controltech-alerts.service.ts.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { emitDashboardFeed } from '../../lib/sse.js'

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

const FLEET_TZ = 'Africa/Nairobi'
const clockFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: FLEET_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
})

function feed(orgId: string, id: string, at: Date, type: 'info' | 'success' | 'warning', text: string, extra: Record<string, unknown> = {}) {
  emitDashboardFeed(orgId, {
    id, time: clockFmt.format(at), ts: at.toISOString(),
    type, text, source: 'controltech', ...extra,
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
export async function handleDispatch(d: DispatchEvent): Promise<boolean> {
  const organisationId = await resolveOrgId(d.factoryCode)
  if (!organisationId) return false

  const at = d.dispatchTime ? new Date(d.dispatchTime) : new Date()
  const when = Number.isNaN(at.getTime()) ? new Date() : at

  const vehicle = await prisma.vehicle.findFirst({
    where: { organisationId, registrationPlate: norm(d.vehicleNumberPlate) },
    select: { id: true },
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
    const returned = d.actualReturnTime ? new Date(d.actualReturnTime) : null
    const payload = {
      vehicleId:      vehicle.id,
      userId:         drivers[0]!.id,
      assignmentType: 'PRIMARY' as const,
      assignedAt:     when,
      unassignedAt:   returned && !Number.isNaN(returned.getTime()) ? returned : null,
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

  const dest = d.destinationOrPurpose ? ` to ${d.destinationOrPurpose}` : ''
  feed(
    organisationId, `dp-${d.id}`, when, 'info',
    `${d.vehicleNumberPlate} · ${d.driverName} dispatched${dest}.`,
    { alertType: 'DISPATCH', plate: d.vehicleNumberPlate, vehicleId: vehicle?.id ?? null },
  )
  return true
}

/** Narrate a gate crossing. No coordinates are involved. */
export async function handleMovement(m: MovementEvent): Promise<boolean> {
  const organisationId = await resolveOrgId(m.factoryCode)
  if (!organisationId) return false

  const at = m.timestamp ? new Date(m.timestamp) : new Date()
  const when = Number.isNaN(at.getTime()) ? new Date() : at

  const exiting = (m.direction ?? '').toUpperCase() === 'EXIT'
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
