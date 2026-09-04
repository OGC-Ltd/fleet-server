/**
 * Where the tokens live in a browser.
 *
 * Both are httpOnly, so page scripts cannot read them and an XSS cannot walk
 * off with a session the way it can with localStorage.
 *
 * TWO cookies with different paths, not one:
 *
 *   fleet_at  Path=/api/v1        the access token, ~15 minutes.
 *   fleet_rt  Path=/api/v1/auth   the refresh token, 30 days.
 *
 * The narrow path on the refresh cookie means it is attached only to the two
 * endpoints that consume it, and never rides along on the hundreds of ordinary
 * API calls that have no business seeing it.
 *
 * The access token is a cookie AT ALL because of SSE. `EventSource` cannot set
 * an `Authorization` header — there is no API for it — so a long-lived stream
 * has exactly two options: a token in the query string, which nginx writes into
 * access.log for anyone with the box, or a cookie the browser attaches itself.
 * nginx serves the dashboard and proxies /api/ from one server block, so the
 * cookie is same-origin and simply works. It is also returned in the login body,
 * because `fetch` callers still send it as a Bearer header.
 *
 * SameSite=Lax, not Strict: Strict withholds cookies on a top-level navigation
 * INTO the app, so following a link to a deep page would land on a login screen
 * despite a valid session. Lax still blocks the cross-site POST that CSRF needs.
 *
 * `Secure` is driven by COOKIE_SECURE and is FALSE today, because the box
 * serves plain HTTP on port 80. Until TLS terminates in front of this, every
 * credential here is readable by anything on the network path. That is a known,
 * accepted exposure — not an oversight — and the flag is the whole of the fix.
 */

import type { Response } from 'express'
import { env } from '../../config/env.js'

export const ACCESS_COOKIE  = 'fleet_at'
export const REFRESH_COOKIE = 'fleet_rt'

const ACCESS_PATH  = '/api/v1'
const REFRESH_PATH = '/api/v1/auth'

type CookieOpts = {
  httpOnly: true
  secure: boolean
  sameSite: 'lax'
  path: string
  maxAge?: number
}

const base = (path: string): CookieOpts => ({
  httpOnly: true,
  secure:   env.COOKIE_SECURE,
  sameSite: 'lax',
  path,
})

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...base(ACCESS_PATH),
    maxAge: env.ACCESS_TTL_S * 1000,
  })
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...base(REFRESH_PATH),
    maxAge: env.REFRESH_TTL_S * 1000,
  })
}

/**
 * Clear both. The options must match what they were set with — a browser keys a
 * cookie by name AND path, so clearing `fleet_rt` at the wrong path leaves the
 * real one in place and logout silently does nothing.
 */
export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, base(ACCESS_PATH))
  res.clearCookie(REFRESH_COOKIE, base(REFRESH_PATH))
}
