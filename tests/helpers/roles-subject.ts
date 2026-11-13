/**
 * `resolveSubject` for integration tests that describe people by their ROLE
 * rows (prismaMock.userRole.findMany).
 *
 * Since 2026-11-14 the account rules (who may assign a triage, delete or edit
 * an account, see the directory…) ask for RIGHTS through resolveSubject, where
 * they used to read role slugs straight off userRole. These tests already say
 * "the caller is an admin" by mocking those rows; this turns the same rows
 * into the rights the shipped roles give, so the tests keep saying it once.
 *
 * Use:
 *   vi.mock('../../src/lib/authz/subject.js', async (orig) => {
 *     const { withRoleRowSubjects } = await import('../helpers/roles-subject.js')
 *     return withRoleRowSubjects(await orig<object>())
 *   })
 *
 * A role row with no organisationId answers for every organisation.
 */

import { ROLE_DEFINITIONS } from '../../src/lib/permissions.js'
import type { Subject } from '../../src/lib/authz/subject.js'

type RoleRow = { role: { slug: string; organisationId?: string | null } }
type OrgGrant = { permissions: Set<string>; vehicleIds: Set<string> | null }

/** A Map that answers every organisation it was not told about with one grant. */
class EveryOrg extends Map<string, OrgGrant> {
  constructor(private readonly fallback: OrgGrant | null) { super() }
  override get(key: string) { return super.get(key) ?? this.fallback ?? undefined }
  override has(key: string) { return super.has(key) || this.fallback !== null }
}

export function subjectFromRoleRows(userId: string, rows: RoleRow[]): Subject {
  const platformPermissions = new Set<string>()
  const anywhere = new Set<string>()
  const byOrg = new Map<string, Set<string>>()
  let anyOrgRole = false
  for (const { role } of rows ?? []) {
    const def = ROLE_DEFINITIONS.find((r) => r.slug === role.slug)
    const perms = def?.permissions ?? []
    if (def?.platform) { for (const p of perms) platformPermissions.add(p); continue }
    if (role.organisationId) {
      const set = byOrg.get(role.organisationId) ?? new Set<string>()
      for (const p of perms) set.add(p)
      byOrg.set(role.organisationId, set)
    } else {
      anyOrgRole = true
      for (const p of perms) anywhere.add(p)
    }
  }
  const orgs = new EveryOrg(anyOrgRole ? { permissions: anywhere, vehicleIds: null } : null)
  for (const [org, set] of byOrg) orgs.set(org, { permissions: set, vehicleIds: null })
  return { userId, isPlatform: platformPermissions.size > 0, platformPermissions, orgs, denied: new Map() } as Subject
}

/** The subject module with resolveSubject read from the mocked role rows. */
export function withRoleRowSubjects<T extends object>(real: T): T {
  return {
    ...real,
    resolveSubject: async (userId: string) => {
      // Read at call time: importing the (mocked) prisma module while the
      // subject module is still being mocked stalls the module graph.
      const { prisma } = await import('../../src/lib/prisma.js')
      const rows = await (prisma as unknown as { userRole: { findMany: (a: unknown) => unknown } }).userRole.findMany({
        where:  { userId, revokedAt: null },
        select: { role: { select: { slug: true, organisationId: true } } },
      })
      return subjectFromRoleRows(userId, (rows ?? []) as RoleRow[])
    },
  }
}
