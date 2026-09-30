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
 * The vehicle filter to hand downstream — NULL while shadow mode is on.
 *
 * Shadow mode has to be genuinely observational. A denial it merely logs is
 * harmless, but the vehicle SCOPE is not a denial: it is a filter the
 * repositories and the SSE fan-out apply silently. Leaving it live while
 * nothing else is enforced would blank the map for anyone whose membership does
 * not already cover the organisation they are looking at — and under
 * AUTH_BYPASS, which is how production runs today, that is every organisation
 * except the bypass account's own. The rollout would present as an outage.
 *
 * The scope is still computed, and LOGGED when it would have bitten, which is
 * the information the shadow pass exists to collect.
 */
function scopeToApply(
  subject: Parameters<typeof vehicleScopeIn>[0],
  orgId: string,
  where: string,
): Set<string> | null {
  const scope = vehicleScopeIn(subject, orgId)
  if (scope === null) return null
  if (env.AUTHZ_ENFORCE) return scope
  logger.warn(
    { userId: subject.userId, orgId, visibleVehicles: scope.size, where },
    'authz: WOULD NARROW to a vehicle subset (shadow mode) — showing the whole fleet',
  )
  return null
}

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
        req.authz = {
          userId,
          orgId,
          isPlatform: subject.isPlatform,
          // null = the whole fleet. Distinct from an empty set, which is a
          // membership narrowed to nothing and must return nothing.
          vehicleIds: scopeToApply(subject, orgId, 'requirePermission'),
        }
      }

      next()
    } catch (err) {
      next(err)
    }
  }
}

/**
 * Require a permission, with NO shadow mode.
 *
 * `requirePermission` above is deliberately observational while
 * `AUTHZ_ENFORCE=false`: it covers ~90 endpoints that were written before any
 * of them had a permission, and the way to find the ones mapped wrongly is to
 * watch real traffic rather than to guess. That reasoning is sound for routes
 * that already existed and were already reachable.
 *
 * It is exactly wrong for a route that did not exist yesterday. An endpoint
 * that creates accounts, changes roles or suspends people has no legacy
 * traffic to observe and no mapping to discover — it is new, its permission is
 * known, and shipping it in a mode that logs "WOULD DENY" and then creates the
 * user anyway would be shipping an open door with a diary.
 *
 * So: new privileged routes use this. It always denies, and it always applies
 * the real vehicle scope rather than shadow mode's null. Everything else is
 * identical, including the platform-surface rule for routes with no :orgId.
 *
 * Note this closes an AUTHORIZATION hole only. While `AUTH_BYPASS` is on, the
 * caller is whoever that flag names and no token is checked at all, so these
 * checks grade the bypass account. Authentication has to be real for any of
 * this to mean anything.
 */
export function requirePermissionStrict(slug: string | PermissionResolver): RequestHandler {
  return async (req, _res, next) => {
    try {
      const userId = req.user?.id
      if (!userId) throw new UnauthorizedError('Not authenticated')

      const need = typeof slug === 'string' ? slug : slug(req)
      const orgId = (req.params['orgId'] as string | undefined) ?? null
      const subject = await resolveSubject(userId)

      const allowed = orgId === null
        ? subject.isPlatform && can(subject, null, need)
        : canReachOrg(subject, orgId) && can(subject, orgId, need)

      if (!allowed) {
        logger.info(
          {
            userId, orgId, need,
            route: `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`,
            scope: orgId === null ? 'platform' : 'organisation',
          },
          'authz: denied (strict)',
        )
        throw new ForbiddenError(`Missing permission: ${need}`)
      }

      if (orgId) {
        req.authz = {
          userId,
          orgId,
          isPlatform: subject.isPlatform,
          // The REAL scope, not scopeToApply's shadow-mode null.
          vehicleIds: vehicleScopeIn(subject, orgId),
        }
      }

      next()
    } catch (err) {
      next(err)
    }
  }
}

/**
 * Does the caller hold `slug` in the path organisation? A question, not a
 * gate: for rules that widen with a permission rather than stop without one
 * (repairs.authz requireWorkableJob: `repair:work_any` lifts the
 * accepted-assignment rule).
 */
export async function holdsPermission(req: Parameters<RequestHandler>[0], slug: string): Promise<boolean> {
  const userId = req.user?.id
  const orgId = (req.params['orgId'] as string | undefined) ?? null
  if (!userId || !orgId) return false
  const subject = await resolveSubject(userId)
  return canReachOrg(subject, orgId) && can(subject, orgId, slug)
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
      vehicleIds: scopeToApply(subject, orgId, 'attachAuthz'),
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
