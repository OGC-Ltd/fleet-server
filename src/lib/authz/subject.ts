/**
 * Who is asking, what may they do, and which vehicles may they see.
 *
 * Permissions are resolved PER REQUEST rather than carried in the JWT. Three
 * reasons, all of them properties of this deployment:
 *
 *   - pm2 runs more than one instance, so the existing 60-second cache in
 *     middleware/auth.ts cannot be invalidated across processes. A revoked
 *     role would keep working on whichever worker happened to hold it.
 *   - SSE streams live for hours. Claims minted at handshake would outlive any
 *     decision made about that account for the rest of the connection.
 *   - The vehicle scope is a set, not a flag, and on a 486-unit fleet it does
 *     not belong in a header on every request.
 *
 * The cost is a Redis GET per request, which is why the result is cached whole
 * rather than assembled from parts.
 *
 * INVALIDATION comes in two grains. Changing one person's roles or membership
 * drops that person's key. Changing what a ROLE means affects everyone holding
 * it, and finding them would need a scan — so that bumps an epoch embedded in
 * every key, retiring the whole cache at once. Old keys are not deleted; they
 * are simply never read again and expire on their own.
 *
 * REDIS IS OPTIONAL. `getCacheRedis()` returns null when unconfigured and the
 * client is set to `enableOfflineQueue: false`, so a blip throws rather than
 * hanging. Every path here falls back to Postgres. It must never fall back to
 * allowing the request.
 */

import { prisma } from '../prisma.js'
import { getCacheRedis } from '../redis.js'
import { logger } from '../logger.js'
import { FLAGGED_ONLY, WILDCARD } from '../permissions.js'
import { emitAccessChanged } from '../sse.js'

const KEY_PREFIX  = 'authz:v1'
const EPOCH_KEY   = 'authz:epoch'
const SUBJECT_TTL = 300      // seconds
/** How long a process trusts its memo of the epoch before re-reading it. */
const EPOCH_MEMO_MS = 5_000

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export type OrgGrant = {
  /** Permission slugs held in this organisation. */
  permissions: Set<string>
  /** `null` means every vehicle, including ones added later. */
  vehicleIds: Set<string> | null
}

export type Subject = {
  userId: string
  /**
   * Holds at least one role with organisation_id NULL. Such a role's
   * permissions apply in EVERY organisation, and reaching a tenant no longer
   * depends on a membership row.
   */
  isPlatform: boolean
  platformPermissions: Set<string>
  orgs: Map<string, OrgGrant>
  /**
   * Rights taken from this person in ONE organisation that a platform role
   * would otherwise give them there (a personal denial, IAM). Only platform
   * roles need it: an organisation's own set simply has the right removed.
   * Never applied to the holder of the wildcard.
   */
  denied?: Map<string, Set<string>>
}

/** The wire form. Sets and Maps do not survive JSON. */
type Serialised = {
  userId: string
  isPlatform: boolean
  platformPermissions: string[]
  orgs: Record<string, { permissions: string[]; vehicleIds: string[] | null }>
  /** Absent on entries cached before personal grants existed. */
  denied?: Record<string, string[]>
}

const serialise = (s: Subject): Serialised => ({
  userId:              s.userId,
  isPlatform:          s.isPlatform,
  platformPermissions: [...s.platformPermissions],
  orgs: Object.fromEntries(
    [...s.orgs].map(([id, g]) => [id, {
      permissions: [...g.permissions],
      vehicleIds:  g.vehicleIds ? [...g.vehicleIds] : null,
    }]),
  ),
  denied: Object.fromEntries([...(s.denied ?? [])].map(([id, set]) => [id, [...set]])),
})

const deserialise = (r: Serialised): Subject => ({
  userId:              r.userId,
  isPlatform:          r.isPlatform,
  platformPermissions: new Set(r.platformPermissions),
  orgs: new Map(
    Object.entries(r.orgs).map(([id, g]) => [id, {
      permissions: new Set(g.permissions),
      vehicleIds:  g.vehicleIds ? new Set(g.vehicleIds) : null,
    }]),
  ),
  denied: new Map(Object.entries(r.denied ?? {}).map(([id, slugs]) => [id, new Set(slugs)])),
})

// ---------------------------------------------------------------------------
// Epoch
// ---------------------------------------------------------------------------

let epochMemo: { value: string; readAt: number } | null = null

async function currentEpoch(): Promise<string> {
  if (epochMemo && Date.now() - epochMemo.readAt < EPOCH_MEMO_MS) return epochMemo.value
  const redis = getCacheRedis()
  if (!redis) return '0'
  try {
    const value = (await redis.get(EPOCH_KEY)) ?? '0'
    epochMemo = { value, readAt: Date.now() }
    return value
  } catch {
    // Unreachable Redis means no cache, not no epoch. '0' keeps key shapes
    // stable so the cache is usable again the moment Redis returns.
    return epochMemo?.value ?? '0'
  }
}

/**
 * Retire every cached subject. Call after changing what a ROLE grants, or any
 * other edit whose blast radius is wider than one account.
 */
export async function bumpAuthzEpoch(): Promise<void> {
  epochMemo = null
  const redis = getCacheRedis()
  if (!redis) return
  try {
    await redis.incr(EPOCH_KEY)
  } catch (err) {
    // The cache now outlives a permission change by up to SUBJECT_TTL. Loud,
    // because it is a security-relevant staleness rather than a slow read.
    logger.warn({ err }, 'authz: failed to bump epoch — cached permissions stay for up to 5 min')
  }
}

/**
 * Drop one account's cached subject. Use after editing that account's grants.
 *
 * Also tells that account's open dashboards to re-read their access, so a
 * role change shows at once instead of at their next reload. The cache is
 * dropped FIRST: the browser's re-read must not be answered from it.
 */
export async function invalidateSubject(userId: string): Promise<void> {
  const redis = getCacheRedis()
  if (redis) {
    try {
      await redis.del(`${KEY_PREFIX}:${await currentEpoch()}:${userId}`)
    } catch (err) {
      logger.warn({ err, userId }, 'authz: failed to invalidate subject')
    }
  }
  emitAccessChanged(userId)
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

async function loadSubject(userId: string): Promise<Subject> {
  const [memberships, grants, personal] = await Promise.all([
    prisma.orgMembership.findMany({
      where:   { userId, revokedAt: null },
      select:  {
        organisationId: true,
        allVehicles:    true,
        vehicleScopes:  { select: { vehicleId: true, vehicleGroupId: true } },
      },
    }),
    prisma.userRole.findMany({
      where:  { userId, revokedAt: null },
      select: {
        role: {
          select: {
            organisationId: true,
            permissions: { select: { permission: { select: { slug: true } } } },
          },
        },
      },
    }),
    // Rights given to or taken from this one person (IAM).
    prisma.userPermissionGrant.findMany({
      where:  { userId },
      select: { organisationId: true, effect: true, permission: { select: { slug: true } } },
    }),
  ])

  const platformPermissions = new Set<string>()
  const orgPermissions      = new Map<string, Set<string>>()

  for (const { role } of grants) {
    const slugs = role.permissions.map((rp) => rp.permission.slug)
    if (role.organisationId === null) {
      for (const s of slugs) platformPermissions.add(s)
    } else {
      const set = orgPermissions.get(role.organisationId) ?? new Set<string>()
      for (const s of slugs) set.add(s)
      orgPermissions.set(role.organisationId, set)
    }
  }

  // Expand group scopes to concrete vehicle ids, so every downstream filter is
  // one `IN` list rather than a join. Membership in a GROUP is still the thing
  // stored, so a vehicle added to that group is picked up on the next
  // resolution — within SUBJECT_TTL, not immediately, which is the price of
  // caching the expansion.
  const groupIds = memberships.flatMap((m) =>
    m.allVehicles ? [] : m.vehicleScopes.map((s) => s.vehicleGroupId).filter((g): g is string => !!g),
  )
  const groupMembers = groupIds.length
    ? await prisma.vehicle.findMany({
        where:  { vehicleGroupId: { in: [...new Set(groupIds)] } },
        select: { id: true, vehicleGroupId: true },
      })
    : []
  const byGroup = new Map<string, string[]>()
  for (const v of groupMembers) {
    byGroup.set(v.vehicleGroupId, [...(byGroup.get(v.vehicleGroupId) ?? []), v.id])
  }

  const orgs = new Map<string, OrgGrant>()
  for (const m of memberships) {
    let vehicleIds: Set<string> | null = null
    if (!m.allVehicles) {
      vehicleIds = new Set<string>()
      for (const s of m.vehicleScopes) {
        if (s.vehicleId) vehicleIds.add(s.vehicleId)
        if (s.vehicleGroupId) for (const id of byGroup.get(s.vehicleGroupId) ?? []) vehicleIds.add(id)
      }
    }
    orgs.set(m.organisationId, {
      // A membership with no role grants reaches the organisation and can do
      // nothing in it. That is deliberate: membership answers "which tenant",
      // roles answer "what may they do", and neither implies the other.
      // A copy: personal grants below must not write into the role's set.
      permissions: new Set(orgPermissions.get(m.organisationId) ?? []),
      vehicleIds,
    })
  }

  // Platform-ness is decided by ROLES alone, before personal grants touch the
  // set: a grant can widen what somebody does, never where they reach.
  const isPlatform = platformPermissions.size > 0
  const denied = applyPersonalGrants(personal ?? [], { isPlatform, platformPermissions, orgs })

  // Where the person is restricted to flagged units (by role, or by their own
  // grant in IAM since 2026-11-14), the units with an open repair job, read
  // fresh on every resolution. AFTER the personal grants, so IAM can set or
  // clear the restriction. Cached with the rest, and dropped early by
  // refreshFlaggedScopes when a job opens or closes.
  const flaggedOrgs = [...orgs.entries()]
    .filter(([, g]) => g.permissions.has(FLAGGED_ONLY))
    .map(([orgId]) => orgId)
  const flagged = await openRepairVehicles(flaggedOrgs)
  for (const [orgId, open] of flagged) {
    const grant = orgs.get(orgId)
    if (!grant) continue
    const within = grant.vehicleIds
    grant.vehicleIds = new Set([...open].filter((id) => !within || within.has(id)))
  }

  return { userId, isPlatform, platformPermissions, orgs, denied }
}

export type PersonalGrant = { organisationId: string | null; effect: string; permission: { slug: string } }

/**
 * Lay one person's own grants over what their roles gave them.
 *
 * Allowances first, denials last, so a denial always wins. A grant for one
 * organisation applies only where the person already reaches it (a membership,
 * or a platform role): it never opens a tenant. One slug is never personal:
 * the wildcard, which is the System Administrator role and nothing else.
 * `vehicle:flagged_only`, a restriction, may be set or cleared like any
 * other right since 2026-11-14 (the user: no hidden rules).
 *
 * The holder of the wildcard is left exactly as they were. Nothing could be
 * added, and a denial that did not bite would be a lie on the page.
 *
 * Returns the per-organisation denials a platform role still needs applied at
 * question time, since its permissions are one set for every organisation.
 */
export function applyPersonalGrants(
  personal: readonly PersonalGrant[],
  into: { isPlatform: boolean; platformPermissions: Set<string>; orgs: Map<string, OrgGrant> },
): Map<string, Set<string>> {
  const denied = new Map<string, Set<string>>()
  if (personal.length === 0 || into.platformPermissions.has(WILDCARD)) return denied

  const usable = personal.filter((g) => g.permission.slug !== WILDCARD)

  for (const g of usable) {
    if (g.effect !== 'allow') continue
    const slug = g.permission.slug
    if (g.organisationId === null) {
      if (into.isPlatform) into.platformPermissions.add(slug)
      for (const org of into.orgs.values()) org.permissions.add(slug)
    } else {
      let org = into.orgs.get(g.organisationId)
      if (!org && into.isPlatform) {
        // A platform role reaches the organisation without a membership row.
        org = { permissions: new Set<string>(), vehicleIds: null }
        into.orgs.set(g.organisationId, org)
      }
      org?.permissions.add(slug)
    }
  }

  for (const g of usable) {
    if (g.effect !== 'deny') continue
    const slug = g.permission.slug
    if (g.organisationId === null) {
      into.platformPermissions.delete(slug)
      for (const org of into.orgs.values()) org.permissions.delete(slug)
    } else {
      into.orgs.get(g.organisationId)?.permissions.delete(slug)
      if (into.isPlatform) {
        const set = denied.get(g.organisationId) ?? new Set<string>()
        set.add(slug)
        denied.set(g.organisationId, set)
      }
    }
  }
  return denied
}

/** Units with an open repair job, per organisation asked about. */
export async function openRepairVehicles(orgIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>(orgIds.map((id) => [id, new Set<string>()]))
  if (orgIds.length === 0) return out
  const rows = await prisma.repairReportItem.findMany({
    where:    { organisationId: { in: orgIds }, resolvedAt: null },
    select:   { organisationId: true, vehicleId: true },
    distinct: ['organisationId', 'vehicleId'],
  })
  for (const r of rows) out.get(r.organisationId)?.add(r.vehicleId)
  return out
}

/** The open-job units each organisation was last seen with, to skip no-op refreshes. */
const lastFlagged = new Map<string, string>()

/**
 * A repair job changed in this organisation. If that changed WHICH units have
 * an open job, everybody there restricted to flagged units gets their scope
 * re-read now (and, through invalidateSubject, their open map told to reload)
 * rather than when their cache next expires. Never throws.
 */
export async function refreshFlaggedScopes(orgId: string): Promise<void> {
  try {
    const now = [...((await openRepairVehicles([orgId])).get(orgId) ?? [])].sort().join(',')
    if (lastFlagged.get(orgId) === now) return
    lastFlagged.set(orgId, now)
    // Restricted by role, or by their own grant (IAM). Over-inclusive on
    // purpose: one denied by IAM is re-read for nothing, which is cheap.
    const [byRole, byGrant] = await Promise.all([
      prisma.userRole.findMany({
        where: {
          revokedAt: null,
          role: { organisationId: orgId, permissions: { some: { permission: { slug: FLAGGED_ONLY } } } },
        },
        select:   { userId: true },
        distinct: ['userId'],
      }),
      prisma.userPermissionGrant.findMany({
        where:  { effect: 'allow', permission: { slug: FLAGGED_ONLY }, OR: [{ organisationId: orgId }, { organisationId: null }] },
        select: { userId: true },
      }),
    ])
    for (const userId of new Set([...byRole, ...byGrant].map((h) => h.userId))) await invalidateSubject(userId)
  } catch (err) {
    logger.warn({ err, orgId }, 'authz: could not refresh flagged-unit scopes')
  }
}

/** Resolve a subject, from cache when possible. Never throws on cache failure. */
export async function resolveSubject(userId: string): Promise<Subject> {
  const redis = getCacheRedis()
  const key = redis ? `${KEY_PREFIX}:${await currentEpoch()}:${userId}` : null

  if (redis && key) {
    try {
      const hit = await redis.get(key)
      if (hit) return deserialise(JSON.parse(hit) as Serialised)
    } catch (err) {
      logger.debug({ err, userId }, 'authz: cache read failed, falling back to Postgres')
    }
  }

  const subject = await loadSubject(userId)

  if (redis && key) {
    try {
      await redis.set(key, JSON.stringify(serialise(subject)), 'EX', SUBJECT_TTL)
    } catch (err) {
      logger.debug({ err, userId }, 'authz: cache write failed')
    }
  }
  return subject
}

// ---------------------------------------------------------------------------
// Questions asked of a subject
// ---------------------------------------------------------------------------

/** May this subject address this organisation at all? */
export function canReachOrg(subject: Subject, orgId: string): boolean {
  return subject.isPlatform || subject.orgs.has(orgId)
}

/**
 * The permissions in force for one organisation: those granted there, plus any
 * held through a platform role, which apply everywhere by definition.
 */
export function permissionsIn(subject: Subject, orgId: string | null): Set<string> {
  const merged = new Set(subject.platformPermissions)
  if (orgId) for (const p of subject.orgs.get(orgId)?.permissions ?? []) merged.add(p)
  // A personal denial in this one organisation, against a platform role.
  if (orgId && !merged.has(WILDCARD)) for (const p of subject.denied?.get(orgId) ?? []) merged.delete(p)
  return merged
}

/** Does the subject hold `slug` in this organisation? `platform:admin` is a wildcard. */
export function can(subject: Subject, orgId: string | null, slug: string): boolean {
  const held = permissionsIn(subject, orgId)
  return held.has(WILDCARD) || held.has(slug)
}

/**
 * The vehicles visible in this organisation — `null` meaning no restriction.
 *
 * Null and an empty set are very different answers and must not be conflated:
 * null is "the whole fleet", an empty set is "nothing", which is what a
 * membership narrowed to vehicles that were later deleted correctly yields.
 */
export function vehicleScopeIn(subject: Subject, orgId: string): Set<string> | null {
  if (subject.isPlatform) return null
  const grant = subject.orgs.get(orgId)
  if (!grant) return new Set()
  return grant.vehicleIds
}

/** What a Live Feed limited to repair notices always carries: the repair
 *  workflow's own notices. The restricted sources ride on their rights. */
export const FLAGGED_ONLY_FEED_SOURCES = ['repair'] as const

/** The restricted feed sources (notifications/restricted-sources) these rights open. */
function restrictedSourcesHeld(subject: Subject, orgId: string): string[] {
  return [
    ...(can(subject, orgId, 'notification:repair_tickets') ? ['repair_ticket'] : []),
    ...(can(subject, orgId, 'notification:repair_flags') ? ['repair_flag', 'repair_verified'] : []),
  ]
}

/**
 * The feed sources this person is limited to in an organisation, or null for
 * every source. Somebody restricted to flagged units who does NOT hold
 * `notification:all_events` sees the repair notices on those units rather
 * than the tracking feed (operator, 2026-10-27, for technicians; a right in
 * IAM since 2026-11-14, held by every role to start with).
 */
export async function feedSourcesFor(userId: string, orgId: string): Promise<string[] | null> {
  const subject = await resolveSubject(userId)
  if (subject.isPlatform) return null
  if (!subject.orgs.get(orgId)?.permissions.has(FLAGGED_ONLY)) return null
  if (can(subject, orgId, 'notification:all_events')) return null
  return [...FLAGGED_ONLY_FEED_SOURCES, ...restrictedSourcesHeld(subject, orgId)]
}

/**
 * The restricted feed sources this person may see in an organisation beyond
 * the common feed: repair tickets (`notification:repair_tickets`), and units
 * flagged and repairs verified (`notification:repair_flags`). Both were the
 * role by name until 2026-11-14: tickets for the operator, supervisor and
 * security, flags for the technicians.
 */
export async function feedGrantsFor(userId: string, orgId: string): Promise<string[]> {
  return restrictedSourcesHeld(await resolveSubject(userId), orgId)
}
