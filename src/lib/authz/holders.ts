/**
 * Who HOLDS a right in an organisation: for the people told of something
 * (push, mail) and the people a job can be handed to.
 *
 * Until 2026-11-14 these lists were role names typed into the code (the
 * Control Room was supervisor + fleet analyst + operator, an assignee was a
 * technician, the Fuel Audit went to nine roles…). The user asked for every
 * such hidden rule to be a right in IAM, so each list is now the holders of
 * one permission: from their role, or given to or taken from them in IAM.
 *
 * HOLDING means the slug itself. The wildcard (`platform:admin`) answers
 * every access check, but it does not put the System Administrator on every
 * mailing list or in every assignee picker; that role holds the few notice
 * rights it was sent before, by name (lib/permissions ROLE_DEFINITIONS).
 */

import type { Prisma } from '../../../generated/prisma/client.js'
import { prisma } from '../prisma.js'
import { resolveSubject, vehicleScopeIn, type Subject } from './subject.js'

/** Does this person hold `slug` itself in `orgId`, from a role or their own grant? */
export function holdsOwn(subject: Subject, orgId: string, slug: string): boolean {
  if (subject.orgs.get(orgId)?.permissions.has(slug)) return true
  return subject.isPlatform
    && subject.platformPermissions.has(slug)
    && !subject.denied?.get(orgId)?.has(slug)
}

/** Does this person hold any of `slugs` itself in `orgId`? */
export function holdsAnyOwn(subject: Subject, orgId: string, slugs: readonly string[]): boolean {
  return slugs.some((s) => holdsOwn(subject, orgId, s))
}

export type Holder = { id: string; email: string | null; fullName: string | null }

export interface HolderQuery {
  /** Only holders who can see this unit (their fleet limit, or flagged units). */
  vehicleId?: string
  /** Only accounts with an email address. */
  withEmail?: boolean
  /** ACTIVE accounts only; otherwise every account not suspended or terminated. */
  activeOnly?: boolean
}

/**
 * Everybody who holds any of `slugs` in `orgId`: members of the organisation
 * (home or membership) and holders of a platform role, which reaches every
 * organisation. Sorted by name.
 */
export async function holdersOf(orgId: string, slugs: readonly string[], q: HolderQuery = {}): Promise<Holder[]> {
  const where: Prisma.UserWhereInput = {
    deletedAt: null,
    ...(q.activeOnly ? { status: 'ACTIVE' } : { status: { notIn: ['SUSPENDED', 'TERMINATED'] } }),
    ...(q.withEmail ? { email: { not: null } } : {}),
    OR: [
      { organisationId: orgId },
      { memberships: { some: { organisationId: orgId, revokedAt: null } } },
      { userRoles: { some: { revokedAt: null, role: { organisationId: null } } } },
    ],
  }
  const users = await prisma.user.findMany({
    where,
    select:  { id: true, email: true, fullName: true },
    orderBy: { fullName: 'asc' },
  })
  const out: Holder[] = []
  for (const u of users) {
    const subject = await resolveSubject(u.id)
    if (!holdsAnyOwn(subject, orgId, slugs)) continue
    if (q.vehicleId) {
      const scope = vehicleScopeIn(subject, orgId)
      if (scope && !scope.has(q.vehicleId)) continue
    }
    out.push(u)
  }
  return out
}

/** Does `userId` hold `slug` itself in `orgId`? */
export async function userHolds(userId: string, orgId: string, slug: string): Promise<boolean> {
  return holdsOwn(await resolveSubject(userId), orgId, slug)
}
