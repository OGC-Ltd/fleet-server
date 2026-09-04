/**
 * Per-IP request limits.
 *
 * The global limit was 100 requests per SIXTY SECONDS — 1.7 a second — which is
 * below what the dashboard needs to draw itself once. A single load fans out
 * across the snapshot, the feed, the geofences, the dashboard summary and a
 * dozen analytics endpoints, so a few page views inside a minute exhausted the
 * whole budget and the app started 429ing itself. It is 100 a SECOND now, which
 * is what the number was always meant to say.
 *
 * ## Whose IP
 *
 * `app.set('trust proxy', 1)` in app.ts is what makes this per-CLIENT rather
 * than per-nginx: with one proxy hop trusted, `req.ip` resolves through the
 * `X-Forwarded-For` that deploy/nginx/fleet.conf sets. Without it every request
 * would arrive as 127.0.0.1 and the whole platform would share one bucket —
 * the first user through the door would spend everyone's allowance.
 *
 * ## Fixed windows
 *
 * express-rate-limit counts in fixed windows, so a client can send 100 in the
 * last instant of one window and 100 in the first of the next: 200 inside a
 * moment, straddling the boundary. That is inherent to the algorithm and is
 * fine here — the limit exists to stop a runaway client, not to shape traffic
 * to the millisecond.
 *
 * ## Any number of processes
 *
 * The counter lives in Redis, not in the process, so these numbers mean what
 * they say however many workers serve traffic — see rate-limit-store, which
 * also explains what happens when Redis is not there.
 *
 * This does NOT make the app safe to run multi-instance. The SSE registry, the
 * pollers and several dedupe and cooldown maps are still per-process, and some
 * of them fail far less visibly than a loose rate limit would.
 */

import { rateLimit } from 'express-rate-limit'
import { env } from '../config/env.js'
import { createRateLimitStore } from './rate-limit-store.js'

const shared = {
  standardHeaders: 'draft-8' as const,
  legacyHeaders: false,
  message: { statusCode: 429, status: 'error', message: 'Too many requests, please try again later' },
}

/** Everything, unless a route below overrides it. Default: 100 per second. */
export const globalLimiter = rateLimit({
  ...shared,
  store:    createRateLimitStore('rl:global:'),
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit:    env.RATE_LIMIT_MAX,
})

/**
 * Sign-in attempts. Deliberately NOT relaxed with the global limit — this one
 * is not about capacity, it is the only thing standing between an exposed login
 * endpoint and an offline-speed password guess. Twenty attempts in fifteen
 * minutes is generous for a person and useless to a script.
 */
export const authLimiter = rateLimit({
  ...shared,
  store:    createRateLimitStore('rl:login:'),
  windowMs: 15 * 60_000,
  limit:    env.LOGIN_RATE_LIMIT_MAX,
})

/**
 * Password-reset requests, on their own budget.
 *
 * Same reasoning as the refresh limiter below: asking for a reset link is not
 * a sign-in attempt, and sharing the login bucket would mean a few reset
 * requests spend the password allowance and the user is then told they have
 * made too many sign-in attempts — for something that was not a sign-in.
 *
 * Tight, because this route sends mail to an address the caller chose. The
 * per-ACCOUNT cooldown in tokens.service.ts covers what an IP limit cannot: a
 * mail-bomb aimed at one inbox from many sources.
 */
export const passwordResetLimiter = rateLimit({
  ...shared,
  store:    createRateLimitStore('rl:pwreset:'),
  windowMs: 15 * 60_000,
  limit:    env.PASSWORD_RESET_RATE_LIMIT_MAX,
})

/**
 * Authenticated actions that verify a credential — today, changing your own
 * password.
 *
 * Tighter than the general limit because the request carries the CURRENT
 * password: without this, an attacker holding a stolen access token could
 * brute-force it at the global 100/s.
 */
export const sensitiveLimiter = rateLimit({
  ...shared,
  store:    createRateLimitStore('rl:sensitive:'),
  windowMs: 15 * 60_000,
  limit:    10,
})

/**
 * Token refresh, which is NOT a credential guess and must not share the login
 * budget.
 *
 * A browser refreshes on every page load and again whenever the access token
 * ages out, so several tabs open across a working session add up quickly. On
 * the old shared limit a user with a few tabs could exhaust the login allowance
 * without ever typing a password, and be told they had made too many sign-in
 * attempts.
 */
export const refreshLimiter = rateLimit({
  ...shared,
  store:    createRateLimitStore('rl:refresh:'),
  windowMs: 15 * 60_000,
  limit:    env.REFRESH_RATE_LIMIT_MAX,
})

/**
 * Device telemetry ingestion (POST /ingest/telemetry, /trips,
 * /engine-sessions, /fuel/fillings, /fuel/thefts) — called by GPS/FLS hardware
 * per event.
 *
 * Its window is stated here rather than inherited, so that turning the global
 * knob cannot silently redefine what INGEST_RATE_LIMIT_MAX means. It is a rate
 * per MINUTE and always has been.
 */
export const ingestLimiter = rateLimit({
  ...shared,
  store:    createRateLimitStore('rl:ingest:'),
  windowMs: 60_000,
  limit:    env.INGEST_RATE_LIMIT_MAX,
})
