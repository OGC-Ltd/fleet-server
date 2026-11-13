/**
 * A resolved access subject (lib/authz/subject) built from role slugs, as the
 * shipped role definitions give them. For tests of rules that ask for a RIGHT
 * (since 2026-11-14) where they used to ask for a role name: mock
 * `resolveSubject` with this and say which roles the person holds.
 */

import { ROLE_DEFINITIONS } from '../../src/lib/permissions.js'
import type { Subject } from '../../src/lib/authz/subject.js'

export interface SubjectExtras {
  /** Rights given to the person in `orgId` on top of their roles (IAM allow). */
  allow?: string[]
  /** Rights taken from the person in `orgId` (IAM deny). */
  deny?: string[]
  /** Vehicles they are limited to in `orgId`; omitted = the whole fleet. */
  vehicleIds?: string[]
}

export function subjectFromRoles(
  orgId: string,
  roleSlugs: string[],
  extras: SubjectExtras = {},
  userId = 'u',
): Subject {
  const platformPermissions = new Set<string>()
  const orgPermissions = new Set<string>()
  let member = false
  for (const slug of roleSlugs) {
    const def = ROLE_DEFINITIONS.find((r) => r.slug === slug)
    if (!def) { member = true; continue }
    if (def.platform) for (const p of def.permissions) platformPermissions.add(p)
    else { member = true; for (const p of def.permissions) orgPermissions.add(p) }
  }
  for (const p of extras.allow ?? []) { orgPermissions.add(p); member = true }
  for (const p of extras.deny ?? []) orgPermissions.delete(p)
  const orgs = new Map<string, { permissions: Set<string>; vehicleIds: Set<string> | null }>()
  if (member) orgs.set(orgId, { permissions: orgPermissions, vehicleIds: extras.vehicleIds ? new Set(extras.vehicleIds) : null })
  return {
    userId,
    isPlatform: platformPermissions.size > 0,
    platformPermissions,
    orgs,
    denied: new Map(extras.deny?.length && platformPermissions.size > 0 ? [[orgId, new Set(extras.deny)]] : []),
  } as Subject
}
