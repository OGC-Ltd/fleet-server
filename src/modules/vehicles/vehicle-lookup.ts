/**
 * "Which of my organisations is this unit in?"
 *
 * Every other vehicle read on this server is scoped to one organisation,
 * because every screen is. The units list is not a screen, though — it is a
 * SEARCH, and an operator who holds three tenants does not know which of them
 * a plate lives in before they look. Asked in Sukari for a West Kenya truck,
 * the org-scoped list can only answer "no such unit", which is false: the unit
 * exists and this account may see it.
 *
 * So this one endpoint spans the caller's memberships. It returns identity and
 * nothing else — id, plate, name, type, and the organisation the unit belongs
 * to — so the dashboard can switch to that organisation and open the unit
 * there. No position, no fuel, no telemetry: those stay behind the org-scoped
 * routes, which is where the permission that guards them is checked per org.
 *
 * ## Authorisation is enforced here, not shadowed
 *
 * `/bootstrap` narrows its roster only when AUTHZ_ENFORCE is on, because
 * narrowing it wrongly would empty the org switcher — a visible regression
 * worth seeing in a log first. This endpoint has no such legacy: it is new, so
 * there is no previous behaviour to preserve, and the failure mode of being
 * permissive is handing one tenant another tenant's plates. Orgs the subject
 * cannot reach, or holds no `vehicle:read` in, are dropped. A membership with
 * a narrowed vehicle scope searches only the vehicles in it.
 */

import type { RequestHandler } from 'express'
import { prisma } from '../../lib/prisma.js'
import { sendSuccess, sendError } from '../../core/response/response.js'
import { resolveSubject, can, vehicleScopeIn, type Subject } from '../../lib/authz/subject.js'
import type { Prisma } from '../../../generated/prisma/client.js'

/** Below this a query matches most of a fleet, and the answer is noise. */
const MIN_QUERY = 2
const MAX_QUERY = 64
const LIMIT = 20

export interface VehicleLookupHit {
  vehicleId: string
  plate:     string
  name:      string | null
  type:      string
  orgId:     string
  orgCode:   string
  orgName:   string
}

/**
 * Which organisations this subject may search, and with which vehicles in
 * scope. One `OR` clause per org, so the whole lookup is a single query.
 */
export function lookupScopes(subject: Subject, orgIds: string[]): Prisma.VehicleWhereInput[] {
  const clauses: Prisma.VehicleWhereInput[] = []
  for (const orgId of orgIds) {
    if (!can(subject, orgId, 'vehicle:read')) continue
    const scope = vehicleScopeIn(subject, orgId)
    // `null` is "every vehicle, including ones added later"; an EMPTY set is a
    // membership that reaches no vehicle at all, and must not widen to the org.
    if (scope && scope.size === 0) continue
    clauses.push(scope ? { organisationId: orgId, id: { in: [...scope] } } : { organisationId: orgId })
  }
  return clauses
}

export async function lookupVehicles(userId: string, q: string): Promise<VehicleLookupHit[]> {
  const term = q.trim().slice(0, MAX_QUERY)
  if (term.length < MIN_QUERY) return []

  const subject = await resolveSubject(userId)

  // A platform role reaches every tenant by definition, so its search is the
  // whole table; everyone else searches the orgs they are a member of.
  const orgIds = subject.isPlatform
    ? (await prisma.organisation.findMany({ select: { id: true } })).map((o) => o.id)
    : [...subject.orgs.keys()]

  const scopes = lookupScopes(subject, orgIds)
  if (scopes.length === 0) return []

  const rows = await prisma.vehicle.findMany({
    where: {
      isActive: true,
      OR: scopes,
      // Plate and name both, because half this platform's fleets are named
      // things like "125F Bell 38 KHMA 858U" and an operator types whichever
      // one is painted on the machine in front of them.
      AND: [{
        OR: [
          { registrationPlate: { contains: term, mode: 'insensitive' } },
          { name:              { contains: term, mode: 'insensitive' } },
        ],
      }],
    },
    select: {
      id: true, name: true, registrationPlate: true, vehicleType: true,
      organisationId: true,
      organisation: { select: { code: true, name: true } },
    },
    orderBy: { registrationPlate: 'asc' },
    take: LIMIT,
  })

  return rows.map((v) => ({
    vehicleId: v.id,
    plate:     v.registrationPlate,
    name:      v.name,
    type:      v.vehicleType,
    orgId:     v.organisationId,
    orgCode:   v.organisation.code,
    orgName:   v.organisation.name,
  }))
}

export const lookup: RequestHandler = async (req, res) => {
  try {
    const userId = req.user?.id
    if (!userId) return sendError(res, 401, 'Unauthenticated')
    const q = typeof req.query['q'] === 'string' ? req.query['q'] : ''
    sendSuccess(res, await lookupVehicles(userId, q))
  } catch {
    // A failed lookup is a search that found nothing extra, not a broken page —
    // the org-scoped list the operator is already looking at still stands.
    sendError(res, 503, 'Vehicle lookup unavailable')
  }
}
