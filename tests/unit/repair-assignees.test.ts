/**
 * Who the picker is allowed to offer.
 *
 * The rule the operator gave, in one sentence: a triage may be assigned ONLY
 * to a technician, who must be in the SAME ORGANISATION and NEED NOT BE IN THE
 * SAME GROUP.
 *
 * The last clause is the one worth a test file. The picker used to read the
 * user roster, which IS group-scoped, because group exists to stop one
 * company's administrators administering another's people. Assignment is not
 * administration. ControlTech are contractors in a group of their own who
 * service all four tenants, so under the roster's rule the first administrator
 * to turn USER_GROUP_ENFORCE on would have watched the only technicians they
 * have disappear from the control -- no error, nothing logged.
 *
 * These assert the QUERY, not a result set, because the absence of a clause is
 * what is being checked and an absent clause returns rows that look fine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const prismaMock = vi.hoisted(() => ({ user: { findMany: vi.fn() } }))
vi.mock('../../src/lib/prisma.js', () => ({ prisma: prismaMock }))

import { findAssignees } from '../../src/modules/repairs/repairs.repository.js'

const ORG = 'org-menengai'

/** The `where` the last call was made with. */
async function whereFor(orgId = ORG) {
  prismaMock.user.findMany.mockResolvedValue([])
  await findAssignees(orgId)
  return prismaMock.user.findMany.mock.calls.at(-1)![0].where
}

beforeEach(() => prismaMock.user.findMany.mockReset())

describe('findAssignees — the group is NOT part of it', () => {
  it('asks nothing about groupId, at any depth', async () => {
    const where = await whereFor()
    expect(JSON.stringify(where)).not.toContain('group')
  })

  it('does not filter by the caller at all', async () => {
    // It takes an organisation and nothing else. A list that varied by WHO
    // asked is the shape the roster has, and the shape this must not have.
    expect(findAssignees.length).toBe(1)
  })
})

describe('findAssignees — the organisation IS part of it', () => {
  it('accepts an employee here OR a live membership here', async () => {
    // Two arms, because a contractor is employed by nobody in this tenant and
    // reaches it through a membership. Dropping the second arm would remove
    // precisely the people this list exists to offer.
    const where = await whereFor()
    expect(where.OR).toEqual([
      { organisationId: ORG },
      { memberships: { some: { organisationId: ORG, revokedAt: null } } },
    ])
  })

  it('requires the technician role to be granted IN THIS organisation', async () => {
    // A technician of Kabras is not offered for a Menengai job, and a
    // platform-wide grant (organisation_id NULL) is not accepted either --
    // the only roles carrying one are super_admin and director, and neither
    // may receive a triage.
    const where = await whereFor()
    expect(where.userRoles.some).toEqual({
      revokedAt: null,
      role: { slug: 'technician', organisationId: ORG },
    })
  })

  it('carries the organisation it was asked about, not a fixed one', async () => {
    const where = await whereFor('org-sukari')
    expect(where.OR[0]).toEqual({ organisationId: 'org-sukari' })
    expect(where.userRoles.some.role.organisationId).toBe('org-sukari')
  })
})

describe('findAssignees — only somebody who can work it', () => {
  it('excludes deleted, suspended and terminated accounts', async () => {
    // Mirrors canReceiveTriage, which the assign endpoint enforces. If these
    // two disagree the picker offers a name the next request refuses.
    const where = await whereFor()
    expect(where.deletedAt).toBeNull()
    expect(where.status).toEqual({ notIn: ['SUSPENDED', 'TERMINATED'] })
  })

  it('returns only what a picker needs', async () => {
    prismaMock.user.findMany.mockResolvedValue([])
    await findAssignees(ORG)
    expect(prismaMock.user.findMany.mock.calls.at(-1)![0].select)
      .toEqual({ id: true, fullName: true, email: true })
  })
})
