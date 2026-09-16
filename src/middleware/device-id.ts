/**
 * A stable per-BROWSER id, so a rate limit can mean "this machine" and not
 * "this building".
 *
 * ## The problem it exists for
 *
 * Every limiter in this app keys on `req.ip`, which is the right default and
 * was, for the password-setup routes, wrong in a way that was invisible until
 * an office tried to onboard. A company's staff sit behind one NAT, so one
 * office is one IP and a five-request budget is five requests for everybody in
 * the building. Measured on the box: 115 requests to /api/v1/account/setup,
 * 102 of them 429, and every single one from a single address. Thirteen
 * requests got through, and a setup costs two.
 *
 * So the narrow limiters take a key of `ip|device`, and two colleagues setting
 * their passwords at the same desk stop spending each other's allowance.
 *
 * ## What this is NOT
 *
 * It is not authentication and it is not a fingerprint. The value is minted by
 * the server, stored in a cookie, and handed back by whoever feels like it — a
 * client that discards cookies, or one that invents a new id per request, gets
 * a fresh bucket every time. That is not a flaw to be patched; it is the
 * property of any client-held identifier, and no amount of hashing user agents
 * changes it.
 *
 * It is therefore only ever a SUB-key, never the whole key. Every limiter that
 * uses it is either (a) protecting capacity rather than a credential, or (b)
 * sitting behind a second per-IP limiter that an id-rotating caller cannot
 * escape. `authLimiter` — the one thing standing between an exposed login and
 * an offline-speed password guess — deliberately does not use it at all. See
 * rateLimiter.ts.
 *
 * ## Why a cookie the server mints, not something the browser computes
 *
 * A canvas/UA/screen fingerprint is guesswork that collides across identical
 * corporate laptops — the exact machines this is meant to tell apart — and it
 * is the same population every privacy control is aimed at. A random 16 bytes
 * has none of those problems and is strictly more unique.
 *
 * httpOnly because page scripts have no use for it, and an XSS that can read it
 * gains nothing worth having either way. `Path=/api/v1` so it rides only on API
 * calls and never on the dashboard's own assets.
 *
 * SameSite=Lax and `secure` from COOKIE_SECURE, matching auth.cookies.ts — see
 * that file for why Secure is false today.
 */

import type { RequestHandler } from 'express'
import { randomBytes } from 'node:crypto'
import { env } from '../config/env.js'

export const DEVICE_COOKIE = 'fleet_did'

/** For clients that hold no cookies but can set a header — scripts, native apps. */
export const DEVICE_HEADER = 'x-device-id'

const DEVICE_PATH = '/api/v1'

/** Two years. Long, because a rotating id is a reset budget, not a security win. */
const DEVICE_MAX_AGE_MS = 2 * 365 * 24 * 60 * 60 * 1000

/**
 * Anything longer is a caller trying to blow up the Redis keyspace, and anything
 * outside this alphabet could smuggle a delimiter into a composed key.
 */
const WELL_FORMED = /^[A-Za-z0-9_-]{8,64}$/

const mint = (): string => randomBytes(16).toString('base64url')

/**
 * Resolve the caller's device id, minting and setting one when there is none.
 *
 * Mounted once in app.ts, before the limiters, so `req.deviceId` is always a
 * string by the time any keyGenerator runs and no limiter has to care where the
 * value came from.
 *
 * A header beats the cookie. That ordering is what lets a native client or a
 * test declare its identity without pretending to be a browser, and it costs
 * nothing: a caller who can set a header can also set a cookie, so the header
 * grants no capability the cookie did not already grant.
 */
export const deviceId: RequestHandler = (req, res, next) => {
  const offered = req.get(DEVICE_HEADER) ?? (req.cookies?.[DEVICE_COOKIE] as string | undefined)

  if (offered && WELL_FORMED.test(offered)) {
    req.deviceId = offered
    next()
    return
  }

  // No id, or a malformed one. Mint one and tell the browser to keep it, so the
  // NEXT request from this machine lands in a bucket of its own.
  //
  // `req.deviceId` is deliberately LEFT UNSET for this request, which sends it
  // to the per-IP fallback in `machineKey`. Handing it the id just minted would
  // read as generous and is the opposite: a client that never returns a cookie
  // would then be issued a brand-new bucket on every single request, which is
  // an unlimited supply of them. Leaving it unset collapses every such caller
  // into one shared per-IP bucket, which is exactly where they belong.
  //
  // It costs an honest browser nothing. Its first request shares the address's
  // bucket and every request after it is its own, and the flow this exists for
  // is two requests long with the cookie set on the first.
  const fresh = mint()
  res.cookie(DEVICE_COOKIE, fresh, {
    httpOnly: true,
    secure:   env.COOKIE_SECURE,
    sameSite: 'lax',
    path:     DEVICE_PATH,
    maxAge:   DEVICE_MAX_AGE_MS,
  })
  next()
}
