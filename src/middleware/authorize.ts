/**
 * Permission enforcement.
 *
 * Sits after `authenticate` (who are you) and `requireOrgAccess` (may you
 * address this tenant) and answers the third question: may you do THIS, HERE.
 *
 * The organisation is taken from `req.params.orgId` — the PATH org — and never
 * from `req.user.organisationId`. That is not a preference: telemetry.controller
 * documents at length why the path org is authoritative, and a user may now hold
 * different roles in several organisations, so their home org says nothing about
 * the request in front of us.
 *
 * SHADOW MODE. With `AUTHZ_ENFORCE=false` every check still runs and every
 * denial is logged at warn with the route and the missing slug — then the
 * request proceeds. The permission map below covers ~90 endpoints written
 * before any of them had a permission, and the way to find the ones mapped
 * wrongly is to watch real traffic hit them, not to guess. Turning this on
 * without that pass would lock out an operator to discover a typo.
 */

import type { RequestHandler } from 'express'
import { env } from '../config/env.js'
import { ForbiddenError, UnauthorizedError, NotFoundError } from '../core/errors/errors.js'
import { logger } from '../lib/logger.js'
import { resolveSubject, can, canReachOrg, vehicleScopeIn } from '../lib/authz/subject.js'

/** Chooses the permission from the request, for endpoints that serve several. */
export type PermissionResolver = (req: Parameters<RequestHandler>[0]) => string

/**
 * Require a permission for this route.
 *
 * On a route carrying `:orgId` the permission must be held IN that
 * organisation, whether through a role granted there or through a platform
 * role. On a route without one — `/api/v1/organisations`, the admin surface —
 * only a platform role can satisfy it, because there is no tenant for an
 * org-scoped grant to be measured against.
 */
export function requirePermission(slug: string | PermissionResolver): RequestHandler {
  return async (req, _res, next) => {
    try {
      const userId = req.user?.id
      if (!userId) throw new UnauthorizedError('Not authenticated')

      // Resolved per request where the answer depends on the request itself —
      // /reports/pdf/:kind is one endpoint serving reports with quite different
      // audiences, and the operations report is the one a dispatcher may take.
      const need = typeof slug === 'string' ? slug : slug(req)
      const orgId = (req.params['orgId'] as string | undefined) ?? null
      const subject = await resolveSubject(userId)

      // A route with no :orgId is platform surface. An org-scoped grant cannot
      // reach it: "fleet_manager at SUKARI" is not an answer to "may you edit
      // the tenant list".
      const allowed = orgId === null
        ? subject.isPlatform && can(subject, null, need)
        : canReachOrg(subject, orgId) && can(subject, orgId, need)

      if (!allowed) {
        const detail = {
          userId, orgId, need,
          route:  `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`,
          scope:  orgId === null ? 'platform' : 'organisation',
        }
        if (!env.AUTHZ_ENFORCE) {
          logger.warn(detail, 'authz: WOULD DENY (shadow mode) — allowing')
        } else {
          logger.info(detail, 'authz: denied')
          throw new ForbiddenError(`Missing permission: ${need}`)
        }
      }

      // Hand the row filter downstream. Repositories read this rather than
      // re-resolving, so one request cannot see two different fleets.
      if (orgId) {
        const vehicleIds = vehicleScopeIn(subject, orgId)
        req.authz = {
          userId,
          orgId,
          isPlatform: subject.isPlatform,
          // null = the whole fleet. Distinct from an empty set, which is a
          // membership narrowed to nothing and must return nothing.
          vehicleIds,
        }
      }

      next()
    } catch (err) {
      next(err)
    }
  }
}

/**
 * Populate `req.authz` without demanding a particular permission.
 *
 * For routes whose access is settled by `requireOrgAccess` alone but which
 * still have to be filtered to the caller's vehicles — the SSE handshake is the
 * one that matters, since a stream is a subscription rather than a read.
 */
export const attachAuthz: RequestHandler = async (req, _res, next) => {
  try {
    const userId = req.user?.id
    if (!userId) return next()
    const orgId = (req.params['orgId'] as string | undefined) ?? null
    if (!orgId) return next()

    const subject = await resolveSubject(userId)
    req.authz = {
      userId,
      orgId,
      isPlatform: subject.isPlatform,
      vehicleIds: vehicleScopeIn(subject, orgId),
    }
    next()
  } catch (err) {
    next(err)
  }
}

/**
 * Is the vehicle in the path one this caller may see?
 *
 * One guard covering every `/vehicles/:vehicleId/...` route — track, playback,
 * telemetry history, the brief, the per-vehicle stream, service records. The
 * alternative was threading the scope set through a dozen service and
 * repository signatures to reach the same decision, and a filter that has to be
 * remembered in twelve places is a filter that will be forgotten in one.
 *
 * Must run after requireOrgAccess or requirePermission, either of which
 * populates `req.authz`.
 *
 * 404, not 403: a restricted caller asking about a vehicle outside their scope
 * should not be able to tell it apart from one that does not exist, or the
 * error becomes a way to enumerate the fleet.
 */
export const requireVehicleInScope: RequestHandler = (req, _res, next) => {
  const scope = req.authz?.vehicleIds
  if (!scope) return next()          // null = the whole fleet

  const vehicleId = req.params['vehicleId'] as string | undefined
  if (!vehicleId) return next()

  if (!scope.has(vehicleId)) {
    const detail = { userId: req.authz?.userId, orgId: req.authz?.orgId, vehicleId }
    if (!env.AUTHZ_ENFORCE) {
      logger.warn(detail, 'authz: WOULD DENY vehicle (shadow mode) — allowing')
      return next()
    }
    return next(new NotFoundError('Vehicle not found'))
  }
  next()
}
