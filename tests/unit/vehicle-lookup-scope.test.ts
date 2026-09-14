/**
 * The cross-org unit lookup must never widen anyone's reach.
 *
 * It is the one vehicle read that is not pinned to an :orgId, so the scoping
 * that middleware does elsewhere has to be done by hand — and the failure mode
 * of getting it wrong is one tenant seeing another tenant's plates. These
 * cases pin the three ways an organisation can fail to qualify: no membership,
 * no `vehicle:read` in it, and a membership whose vehicle scope is empty.
 */

import { describe, it, expect } from 'vitest'
import { lookupScopes } from '../../src/modules/vehicles/vehicle-lookup.js'
import type { Subject } from '../../src/lib/authz/subject.js'

const ORG_A = 'org_a'
const ORG_B = 'org_b'
const ORG_C = 'org_c'

const subject = (
  orgs: Record<string, { perms: string[]; vehicles?: string[] | null }>,
  isPlatform = false,
  platformPermissions: string[] = [],
): Subject => ({
  userId: 'u1',
  isPlatform,
  platformPermissions: new Set(platformPermissions),
  orgs: new Map(
    Object.entries(orgs).map(([id, g]) => [id, {
      permissions: new Set(g.perms),
      vehicleIds:  g.vehicles === undefined ? null : g.vehicles === null ? null : new Set(g.vehicles),
    }]),
  ),
})

describe('lookupScopes', () => {
  it('searches every organisation the subject reads vehicles in', () => {
    const s = subject({
      [ORG_A]: { perms: ['vehicle:read'] },
      [ORG_B]: { perms: ['vehicle:read'] },
    })
    expect(lookupScopes(s, [ORG_A, ORG_B])).toEqual([
      { organisationId: ORG_A },
      { organisationId: ORG_B },
    ])
  })

  it('drops an organisation the subject is not a member of', () => {
    const s = subject({ [ORG_A]: { perms: ['vehicle:read'] } })
    expect(lookupScopes(s, [ORG_A, ORG_B, ORG_C])).toEqual([{ organisationId: ORG_A }])
  })

  it('drops an organisation where the subject cannot read vehicles', () => {
    const s = subject({
      [ORG_A]: { perms: ['vehicle:read'] },
      [ORG_B]: { perms: ['report:read'] },
    })
    expect(lookupScopes(s, [ORG_A, ORG_B])).toEqual([{ organisationId: ORG_A }])
  })

  it('narrows to the vehicles a scoped membership may see', () => {
    const s = subject({ [ORG_A]: { perms: ['vehicle:read'], vehicles: ['v1', 'v2'] } })
    expect(lookupScopes(s, [ORG_A])).toEqual([
      { organisationId: ORG_A, id: { in: ['v1', 'v2'] } },
    ])
  })

  it('drops a membership scoped to no vehicle at all, rather than widening it', () => {
    const s = subject({ [ORG_A]: { perms: ['vehicle:read'], vehicles: [] } })
    expect(lookupScopes(s, [ORG_A])).toEqual([])
  })

  it('lets a platform role search every organisation unscoped', () => {
    const s = subject({}, true, ['vehicle:read'])
    expect(lookupScopes(s, [ORG_A, ORG_B])).toEqual([
      { organisationId: ORG_A },
      { organisationId: ORG_B },
    ])
  })
})
