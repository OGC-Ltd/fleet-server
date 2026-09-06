/**
 * The organisation roster, cached.
 *
 * ## Why this page and not others
 *
 * Reading the roster is expensive out of proportion to how often it changes.
 * The query walks `users` (553 rows in this deployment), and for each one joins
 * live roles, live memberships and the newest invitation — four relations, to
 * answer a question whose answer changes when an administrator invites
 * somebody, which is a handful of times a week. Everything else on the
 * Maintenance page is read straight through.
 *
 * ## Freshness
 *
 * A cache that can serve a stale roster is worse than no cache: an admin who
 * suspends an account and still sees it ACTIVE will suspend it again, and an
 * admin who grants a role and does not see it will grant it twice. So a write
 * is not merely allowed to invalidate — it MUST, before the response that
 * reports it succeeded is sent.
 *
 * Invalidation bumps a per-organisation VERSION rather than deleting keys. One
 * roster is cached under several keys at once (page, limit, status filter,
 * access mode), and Redis cannot delete by pattern without a SCAN. The version
 * is part of every key, so bumping it orphans all of them at once; the orphans
 * are never read again and expire on their own. This is the same shape
 * `lib/authz/subject.ts` uses for its epoch, for the same reason.
 *
 * The TTL is the backstop, not the mechanism. If a bump is ever lost — Redis
 * blipped between the write and the bump — the stale entry dies within a
 * minute rather than living until the next write.
 *
 * ## Redis is optional
 *
 * `getCacheRedis()` returns null when it is not configured, and the client runs
 * with `enableOfflineQueue: false` so a blip throws instead of hanging. Every
 * path here degrades to reading Postgres. None of them may fail the request:
 * a cache that can break the page it accelerates is a liability.
 */

import { getCacheRedis } from '../../lib/redis.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'

const KEY_PREFIX = 'roster:v1'
/** Short. The version bump is what keeps this correct; the clock is insurance. */
const ROSTER_TTL_S = 60

const versionKey = (orgId: string) => `${KEY_PREFIX}:ver:${orgId}`

/**
 * This organisation's current cache version.
 *
 * Not memoised, unlike the authz epoch. That one is read on every single
 * request and is allowed to lag five seconds; this one is read a few times a
 * minute, and lagging would mean serving a roster an administrator has just
 * changed — the exact failure the cache must not have.
 */
async function currentVersion(orgId: string): Promise<string> {
  const redis = getCacheRedis()
  if (!redis) return '0'
  try {
    return (await redis.get(versionKey(orgId))) ?? '0'
  } catch {
    // Unreachable Redis means no cache, not no version. '0' keeps the key
    // shape stable so the cache works again the moment Redis returns.
    return '0'
  }
}

/** Cache key for one roster query. The variant covers everything that narrows it. */
async function keyFor(orgId: string, variant: string): Promise<string> {
  return `${KEY_PREFIX}:${orgId}:${await currentVersion(orgId)}:${variant}`
}

export async function readRoster<T>(orgId: string, variant: string): Promise<T | null> {
  const redis = getCacheRedis()
  if (!redis) return null
  try {
    const hit = await redis.get(await keyFor(orgId, variant))
    return hit ? (JSON.parse(hit) as T) : null
  } catch (err) {
    // A read that cannot use the cache still has a database behind it.
    logger.debug({ err, orgId }, 'roster cache: read failed, falling through to the database')
    return null
  }
}

export async function writeRoster(orgId: string, variant: string, value: unknown): Promise<void> {
  const redis = getCacheRedis()
  if (!redis) return
  try {
    await redis.set(await keyFor(orgId, variant), JSON.stringify(value), 'EX', ROSTER_TTL_S)
  } catch (err) {
    logger.debug({ err, orgId }, 'roster cache: write failed')
  }
}

/**
 * Retire everything cached for these organisations.
 *
 * Takes a list because one write reaches several rosters: suspending a person
 * who works at three sites changes what all three administrators see, and
 * bumping only the organisation whose URL was called would leave the other two
 * showing an account that is no longer active.
 *
 * Deduplicated and bumped in one pipeline, so a person in four organisations
 * costs one round trip rather than four.
 */
export async function invalidateRoster(...orgIds: (string | null | undefined)[]): Promise<void> {
  const ids = [...new Set(orgIds.filter((id): id is string => Boolean(id)))]
  if (ids.length === 0) return

  const redis = getCacheRedis()
  if (!redis) return
  try {
    const pipeline = redis.pipeline()
    for (const id of ids) pipeline.incr(versionKey(id))
    await pipeline.exec()
  } catch (err) {
    // Loud. Until the TTL expires, administrators are looking at a roster that
    // does not match the database — and they were just told their change took.
    logger.warn({ err, orgIds: ids }, 'roster cache: failed to invalidate — the roster may lag by up to a minute')
  }
}

/**
 * Retire every roster this person appears in.
 *
 * Which ones those are is a question only the database can answer: somebody
 * employed by one organisation and granted two others shows up in three
 * rosters, and a change to their status or their password affects all three.
 * That is one indexed query on a write path — cheap next to serving an
 * administrator a roster that contradicts the change they were just told
 * succeeded.
 *
 * `extraOrgIds` covers the organisation being written to when it is not yet
 * one of theirs: granting a NEW membership has to retire the roster the person
 * is about to appear in, and at the moment of the call they are not in it.
 */
export async function invalidateRosterForUser(
  userId: string,
  ...extraOrgIds: (string | null | undefined)[]
): Promise<void> {
  let owned: string[] = []
  try {
    const user = await prisma.user.findUnique({
      where:  { id: userId },
      select: {
        organisationId: true,
        memberships: { where: { revokedAt: null }, select: { organisationId: true } },
      },
    })
    if (user) owned = [user.organisationId, ...user.memberships.map((m) => m.organisationId)]
  } catch (err) {
    // Whatever the write was, it succeeded. Failing it now because the cache
    // could not be told would turn a working change into an error.
    logger.warn({ err, userId }, 'roster cache: could not resolve organisations to invalidate')
  }
  await invalidateRoster(...owned, ...extraOrgIds)
}
