/**
 * Per-machine and per-IP request limits.
 *
 * The global limit was 100 requests per SIXTY SECONDS — 1.7 a second — which is
 * below what the dashboard needs to draw itself once. A single load fans out
 * across the snapshot, the feed, the geofences, the dashboard summary and a
 * dozen analytics endpoints, so a few page views inside a minute exhausted the
 * whole budget and the app started 429ing itself. It is 100 a SECOND now, which
 * is what the number was always meant to say.
 *
 * ## Whose IP, and when the IP is the wrong question
 *
 * An IP is the right key for a CAPACITY limit and the wrong key for a limit a
 * handful of people have to share. A company sits behind one NAT, so an office
 * is one address: `PASSWORD_RESET_RATE_LIMIT_MAX` read per-IP was five requests
 * for the whole building, and a password setup costs two of them. Measured on
 * the box before this change: 115 requests to /api/v1/account/setup, 102 of
 * them 429, all from one address. Every 429 the platform served was this.
 *
 * So the narrow limiters key on `ip|device` — see middleware/device-id.ts —
 * and colleagues at the same desk stop spending each other's allowance.
 *
 * The device id is held by the CLIENT, so a caller who discards it gets a fresh
 * bucket. It is therefore never the whole defence:
 *
 *   · Where the limit protects CAPACITY (setup, refresh), per-machine is the
 *     real limit and a loose per-IP ceiling sits over it to bound a rotating
 *     caller.
 *   · Where the limit protects a CREDENTIAL, per-machine would simply hand a
 *     brute-forcer an unlimited supply of buckets. `authLimiter` and
 *     `sensitiveLimiter` stay per-IP for exactly that reason, and the LAN cost
 *     is accepted: twenty sign-in attempts per office per fifteen minutes has
 *     never produced a single 429 in the access log, so there is nothing here
 *     to fix and widening it would be a real loss for no gain.
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

import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import type { Request } from 'express'
import { env } from '../config/env.js'
import { createRateLimitStore } from './rate-limit-store.js'

const shared = {
  standardHeaders: 'draft-8' as const,
  legacyHeaders: false,
  message: { statusCode: 429, status: 'error', message: 'Too many requests, please try again later' },
}

/**
 * The client's address, normalised.
 *
 * `ipKeyGenerator` rather than `req.ip`: express-rate-limit v7 collapses IPv6
 * to a /56 because a single residential IPv6 allocation hands out more
 * addresses than there are keys worth counting, and a raw `req.ip` key would
 * let one subscriber walk through a limit one address at a time. Using the raw
 * value in a custom keyGenerator is a validation error in v8, not merely a
 * weakness.
 */
const ipOf = (req: Request): string => ipKeyGenerator(req.ip ?? '')

/**
 * One bucket per browser per address.
 *
 * The IP stays in the key rather than being replaced by the device id. Two
 * reasons: a laptop that moves between networks SHOULD get a fresh allowance,
 * and a forged id then cannot reach into another address's space — it can only
 * make more buckets inside its own, which is what the per-IP ceiling bounds.
 *
 * The `?? ip` fallback is load-bearing, not defensive padding. device-id.ts
 * leaves `deviceId` unset for a caller that offered no usable id, so every such
 * caller collapses into ONE shared per-IP bucket rather than being handed a
 * fresh one each time. A browser is in that state for exactly its first
 * request; a client that never keeps cookies stays there, which is the point.
 */
const machineKey = (req: Request): string => {
  const ip = ipOf(req)
  return `${ip}|${req.deviceId ?? ip}`
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
 *
 * STAYS PER-IP, and must. Keying this per-machine would let a brute-forcer mint
 * a new device id per attempt and have the limit back to no limit at all — the
 * cookie is the attacker's to throw away. The LAN cost is real and accepted: an
 * office shares twenty attempts, which the access log says has never once been
 * reached. If it ever is, the fix is a per-ACCOUNT lockout, not a per-machine
 * key; the account is the thing under attack and is the only identifier here
 * the attacker cannot choose.
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
 * per-ACCOUNT cooldown in tokens.service.ts covers what neither of these can: a
 * mail-bomb aimed at one inbox from many sources.
 *
 * ## It no longer guards /account/setup
 *
 * It used to guard all three public account routes, which is the defect that
 * sent this file back to the shop. `GET /setup/:token` and `POST /setup` send
 * no mail and require a single-use 32-byte token the caller must already hold;
 * they have nothing in common with this route but their router. Sharing one
 * five-request budget meant a setup — which costs two requests — could be done
 * two and a half times per address per fifteen minutes, and the invited user
 * was told they had made too many requests for doing the one thing the mail
 * asked them to do. They are on `setupLimiter` now.
 */
export const passwordResetLimiter = rateLimit({
  ...shared,
  store:        createRateLimitStore('rl:pwreset:'),
  keyGenerator: machineKey,
  windowMs:     15 * 60_000,
  limit:        env.PASSWORD_RESET_RATE_LIMIT_MAX,
})

/**
 * The per-IP ceiling over `passwordResetLimiter`.
 *
 * Mounted IN FRONT of it on the same route, so the pair reads left to right as
 * "this address, then this machine". A caller who throws away device ids to
 * mint fresh per-machine buckets is still stopped here, and an office of
 * fifteen people onboarding together never comes close to it.
 */
export const passwordResetIpLimiter = rateLimit({
  ...shared,
  store:        createRateLimitStore('rl:pwreset-ip:'),
  keyGenerator: ipOf,
  windowMs:     15 * 60_000,
  limit:        env.PASSWORD_RESET_IP_RATE_LIMIT_MAX,
})

/**
 * Opening and submitting an emailed set-password link.
 *
 * Split out of `passwordResetLimiter`, and much looser, because the threat is
 * different in kind. Nothing here sends mail. Both routes demand a token that
 * is 32 random bytes, single-use, revoked when superseded and expiring in an
 * hour, so there is no guessing attack for a request budget to slow down — the
 * token itself is the defence, and a limit this side of the universe cannot
 * help or hurt it. What is left is capacity, and capacity is what this bounds.
 *
 * Generous enough that the honest flow cannot reach it. A setup costs two
 * requests; a second attempt after a weak-password rejection costs one more;
 * an expired link costs one more again for the re-send. Thirty leaves room for
 * all of that several times over on one machine.
 */
export const setupLimiter = rateLimit({
  ...shared,
  store:        createRateLimitStore('rl:setup:'),
  keyGenerator: machineKey,
  windowMs:     15 * 60_000,
  limit:        env.SETUP_RATE_LIMIT_MAX,
})

/** The per-IP ceiling over `setupLimiter`. Same pairing, same reason. */
export const setupIpLimiter = rateLimit({
  ...shared,
  store:        createRateLimitStore('rl:setup-ip:'),
  keyGenerator: ipOf,
  windowMs:     15 * 60_000,
  limit:        env.SETUP_IP_RATE_LIMIT_MAX,
})

/**
 * Authenticated actions that verify a credential — today, changing your own
 * password.
 *
 * Tighter than the general limit because the request carries the CURRENT
 * password: without this, an attacker holding a stolen access token could
 * brute-force it at the global 100/s.
 *
 * Per-IP for the reason `authLimiter` is. It guards a credential, so the key
 * must not be one the caller gets to choose.
 */
export const sensitiveLimiter = rateLimit({
  ...shared,
  store:    createRateLimitStore('rl:sensitive:'),
  windowMs: 15 * 60_000,
  limit:    100,
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
 *
 * Per-machine for the same reason the setup routes are: a refresh is capacity,
 * not a credential guess — it is refused outright without a valid refresh
 * token, and no number of fresh device ids produces one. An office sharing 120
 * refreshes per fifteen minutes between everybody's tabs is the same latent
 * NAT bug the setup routes hit, found while fixing them and not yet reported by
 * anyone.
 */
export const refreshLimiter = rateLimit({
  ...shared,
  store:        createRateLimitStore('rl:refresh:'),
  keyGenerator: machineKey,
  windowMs:     15 * 60_000,
  limit:        env.REFRESH_RATE_LIMIT_MAX,
})

/** The per-IP ceiling over `refreshLimiter`. */
export const refreshIpLimiter = rateLimit({
  ...shared,
  store:        createRateLimitStore('rl:refresh-ip:'),
  keyGenerator: ipOf,
  windowMs:     15 * 60_000,
  limit:        env.REFRESH_IP_RATE_LIMIT_MAX,
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
