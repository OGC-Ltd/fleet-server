import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { UnauthorizedError } from '../../core/errors/errors.js'
import { prisma } from '../../lib/prisma.js'
import { resolveSubject } from '../../lib/authz/subject.js'
import * as authService from './auth.service.js'
import { setAuthCookies, clearAuthCookies, REFRESH_COOKIE } from './auth.cookies.js'
import type { LoginDto, RefreshDto } from './auth.schema.js'

/** Who is asking, for the session row. Best-effort; neither is trusted. */
const context = (req: Parameters<RequestHandler>[0]) => ({
  userAgent: req.get('user-agent') ?? null,
  ip:        req.ip ?? null,
})

/**
 * The refresh token, from the cookie first.
 *
 * A browser sends `fleet_rt` by itself and the page script never sees it. The
 * body field is the fallback for non-browser callers and for the shape the
 * previous API used.
 */
const refreshTokenFrom = (req: Parameters<RequestHandler>[0]): string => {
  const cookies = (req as { cookies?: Record<string, string> }).cookies
  return cookies?.[REFRESH_COOKIE] ?? (req.body as RefreshDto | undefined)?.refreshToken ?? ''
}

export const loginHandler: RequestHandler = async (req, res, next) => {
  try {
    const result = await authService.login(req.body as LoginDto, context(req))
    setAuthCookies(res, result.accessToken, result.refreshToken)
    // The tokens stay in the body too: `fetch` callers send the access token as
    // a Bearer header, and a non-browser client has no cookie jar.
    sendSuccess(res, result, 200)
  } catch (err) {
    next(err)
  }
}

export const refreshHandler: RequestHandler = async (req, res, next) => {
  try {
    const result = await authService.refresh(refreshTokenFrom(req), context(req))
    setAuthCookies(res, result.accessToken, result.refreshToken)
    sendSuccess(res, result, 200)
  } catch (err) {
    // A refused refresh means this browser's cookies are worthless — most often
    // because reuse was detected and the family was revoked. Clearing them stops
    // the client retrying with a token that can only fail.
    clearAuthCookies(res)
    next(err)
  }
}

export const logoutHandler: RequestHandler = async (req, res, next) => {
  try {
    await authService.logout(refreshTokenFrom(req))
    clearAuthCookies(res)
    sendSuccess(res, null, 200)
  } catch (err) {
    next(err)
  }
}

/**
 * Everything the dashboard needs to render itself for this person: who they
 * are, which organisations they may open, what they may do in each, and — where
 * their view is narrowed — which vehicles they may see.
 *
 * One call rather than several, because the client cannot draw its navigation,
 * its organisation switcher or its map controls until it has all of it.
 */
export const meHandler: RequestHandler = async (req, res, next) => {
  try {
    const userId = req.user?.id
    if (!userId) throw new UnauthorizedError('Not authenticated')

    const subject = await resolveSubject(userId)

    // Platform roles reach every organisation without a membership row, so the
    // list has to come from the organisations table rather than from the
    // subject's own memberships.
    const orgIds = subject.isPlatform ? undefined : [...subject.orgs.keys()]
    const orgs = await prisma.organisation.findMany({
      where:   orgIds ? { id: { in: orgIds } } : undefined,
      select:  { id: true, name: true, code: true },
      orderBy: { createdAt: 'asc' },
    })

    sendSuccess(res, {
      user: req.user,
      isPlatform: subject.isPlatform,
      platformPermissions: [...subject.platformPermissions],
      organisations: orgs.map((o) => {
        const grant = subject.orgs.get(o.id)
        return {
          ...o,
          permissions: [
            ...new Set([...subject.platformPermissions, ...(grant?.permissions ?? [])]),
          ],
          // null = the whole fleet. An array, however short, is the complete
          // list of what this person may see in that organisation.
          vehicleIds: subject.isPlatform ? null : (grant?.vehicleIds ? [...grant.vehicleIds] : null),
        }
      }),
    }, 200)
  } catch (err) {
    next(err)
  }
}
