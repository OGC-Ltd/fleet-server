/**
 * Who may hand a triage to whom — the operator's rule, pinned.
 *
 * These are requirement tests, not code tests. Each one restates a sentence
 * the operator gave in the form that would catch it being quietly undone:
 *
 *   - an administrator of THIS organisation hands a triage out;
 *   - the platform administrator may hand one out anywhere;
 *   - it goes to a TECHNICIAN, and to nobody else — not to a fellow
 *     administrator, and not to the assigner themselves;
 *   - and always to somebody in that same organisation.
 *
 * The case that matters most is the one the server previously allowed without
 * comment: naming a DRIVER — a row synced from the registry, holding no role
 * and unable to sign in — as the owner of a repair job, and mailing them about
 * it. The repository asked only whether the id existed in the tenant.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  user:     { findFirst: vi.fn() },
  userRole: { findMany: vi.fn() },
}))
vi.mock('../../src/lib/prisma.js', () => ({ prisma: prismaMock }))

import {
  canAssignTriage, canReceiveTriage,
  TRIAGE_ASSIGNER_ROLE_SLUGS, TRIAGE_ASSIGNEE_ROLE_SLUGS,
} from '../../src/modules/repairs/repairs.authz.js'

const ORG = 'org-menengai'

/** Roles the next lookup should report, as the query's shape returns them. */
function holding(...slugs: string[]) {
  prismaMock.userRole.findMany.mockResolvedValue(slugs.map((slug) => ({ role: { slug } })))
}

/** Membership and account status, in the order the module asks for them. */
function member(is: boolean, active = true) {
  prismaMock.user.findFirst.mockReset()
  prismaMock.user.findFirst
    .mockResolvedValueOnce(is ? { id: 'u' } : null)      // isMemberOf
    .mockResolvedValueOnce(active ? { id: 'u' } : null)  // not suspended
}

beforeEach(() => {
  prismaMock.userRole.findMany.mockReset()
  prismaMock.user.findFirst.mockReset()
})

describe('handing a triage out', () => {
  it('lets the organisation’s system administrator assign', async () => {
    holding('admin'); member(true)
    await expect(canAssignTriage('u1', ORG)).resolves.toEqual({ ok: true })
  })

  it('lets the platform administrator assign WITHOUT a membership here', async () => {
    // The operator said this in as many words. A platform role reaching every
    // tenant is the definition of the role, so requiring a membership row
    // would lock the one account that administers all of them out of all of
    // them.
    holding('super_admin')
    prismaMock.user.findFirst.mockResolvedValue(null)
    await expect(canAssignTriage('u1', ORG)).resolves.toEqual({ ok: true })
    expect(prismaMock.user.findFirst).not.toHaveBeenCalled()
  })

  it('refuses an admin who is not a member of THIS organisation', async () => {
    holding('admin'); member(false)
    await expect(canAssignTriage('u1', ORG)).resolves.toEqual({ ok: false, reason: 'not_a_member' })
  })

  it.each(['manager', 'hos', 'fleet_manager', 'dispatcher', 'operator', 'technician'])(
    'refuses %s, who runs the fleet but does not administer it', async (slug) => {
      holding(slug); member(true)
      await expect(canAssignTriage('u1', ORG)).resolves.toEqual({ ok: false, reason: 'wrong_role' })
    })

  it('refuses somebody holding no role at all', async () => {
    holding(); member(true)
    await expect(canAssignTriage('u1', ORG)).resolves.toEqual({ ok: false, reason: 'wrong_role' })
  })

  it('asks only for roles granted HERE or platform-wide', async () => {
    // An `admin` of Kabras must not answer for Menengai. The filter is in the
    // query rather than in a post-filter, so this asserts the query.
    holding('admin'); member(true)
    await canAssignTriage('u1', ORG)
    const where = prismaMock.userRole.findMany.mock.calls[0][0].where
    expect(where.revokedAt).toBeNull()
    expect(where.role.OR).toEqual([{ organisationId: ORG }, { organisationId: null }])
  })
})

describe('being handed one', () => {
  it('accepts a technician who is a member here', async () => {
    holding('technician'); member(true)
    await expect(canReceiveTriage('u2', ORG)).resolves.toEqual({ ok: true })
  })

  it.each(['admin', 'super_admin'])('refuses %s — an administrator hands work out, it is not handed to them', async (slug) => {
    // The narrowing the operator asked for: "can only assign a triage to only
    // a technician". These two used to be accepted, which let an administrator
    // park a job under their own name or a colleague's.
    holding(slug); member(true)
    await expect(canReceiveTriage('u2', ORG)).resolves.toEqual({ ok: false, reason: 'wrong_role' })
  })

  it('accepts an administrator who ALSO holds technician', async () => {
    // The escape hatch, and the only one: an administrator who really does
    // work jobs is reached by the role that says so.
    holding('admin', 'technician'); member(true)
    await expect(canReceiveTriage('u2', ORG)).resolves.toEqual({ ok: true })
  })

  it('refuses a driver — the row the old server would have accepted', async () => {
    // Synced from the registry: no role, no password, never signed in. It
    // existed in the tenant, and that was the entire test the repository ran.
    holding(); member(true)
    await expect(canReceiveTriage('u2', ORG)).resolves.toEqual({ ok: false, reason: 'wrong_role' })
  })

  it.each(['manager', 'operator', 'accountant', 'hr'])('refuses %s', async (slug) => {
    holding(slug); member(true)
    await expect(canReceiveTriage('u2', ORG)).resolves.toEqual({ ok: false, reason: 'wrong_role' })
  })

  it('refuses a technician from another organisation', async () => {
    holding('technician'); member(false)
    await expect(canReceiveTriage('u2', ORG)).resolves.toEqual({ ok: false, reason: 'not_a_member' })
  })

  it('refuses a platform administrator on the ROLE, membership or not', async () => {
    // Deliberately the opposite of the assigner rule above, and the asymmetry
    // is the point: assigning is an act performed upon an organisation, which
    // a platform remit covers. Being assigned is being made responsible for a
    // job inside one, and only a technician is.
    holding('super_admin'); member(false)
    await expect(canReceiveTriage('u2', ORG)).resolves.toEqual({ ok: false, reason: 'wrong_role' })
  })

  it('refuses a suspended technician', async () => {
    // They cannot sign in to work it, and the job would sit open under their
    // name being mailed to an account nobody reads.
    holding('technician'); member(true, false)
    await expect(canReceiveTriage('u2', ORG)).resolves.toEqual({ ok: false, reason: 'not_a_member' })
  })
})

describe('the two lists', () => {
  it('keeps the two sides DISJOINT', async () => {
    // The rule in one assertion: nobody who may hand a triage out may also be
    // given one. This is what "a system administrator can only assign a triage
    // to only a technician" means once it is written down.
    for (const slug of TRIAGE_ASSIGNER_ROLE_SLUGS) {
      expect(TRIAGE_ASSIGNEE_ROLE_SLUGS as readonly string[]).not.toContain(slug)
    }
  })

  it('does not let a technician assign, and lets nobody else receive', async () => {
    expect(TRIAGE_ASSIGNER_ROLE_SLUGS as readonly string[]).not.toContain('technician')
    expect(TRIAGE_ASSIGNEE_ROLE_SLUGS as readonly string[]).toEqual(['technician'])
  })
})

describe('no automatic triage', () => {
  it('rejects a body with no technicianId at all', async () => {
    // The whole of the change at the edge. This body used to be accepted and
    // read as "server, choose somebody" — answered by ranking every user in
    // the tenant, drivers included, by open-item count.
    const { assignRepairItemSchema } = await import('../../src/modules/repairs/repairs.schema.js')
    expect(assignRepairItemSchema.safeParse({ reason: 'Please look at this' }).success).toBe(false)
  })

  it('still accepts null, which means unassign', async () => {
    const { assignRepairItemSchema } = await import('../../src/modules/repairs/repairs.schema.js')
    expect(assignRepairItemSchema.safeParse({ technicianId: null }).success).toBe(true)
  })

  it('accepts a named person', async () => {
    const { assignRepairItemSchema } = await import('../../src/modules/repairs/repairs.schema.js')
    expect(assignRepairItemSchema.safeParse({ technicianId: 'u2' }).success).toBe(true)
  })
})

describe('signing a job off', () => {
  // canSignOffTriage falls through to canAssignTriage for the administrator
  // arm, so the role mocks below drive that.
  const JOB = { assignedToId: 'tech-1', reportedById: 'filer-1' }

  it('lets the person it was assigned to sign it off', async () => {
    const { canSignOffTriage } = await import('../../src/modules/repairs/repairs.authz.js')
    await expect(canSignOffTriage('tech-1', ORG, JOB)).resolves.toEqual({ ok: true, as: 'assignee' })
    // Decided without touching the database: the two ids are already in hand.
    expect(prismaMock.userRole.findMany).not.toHaveBeenCalled()
  })

  it('lets whoever filed the report close their own ticket', async () => {
    // They raised the fault. If it turns out to be nothing, or they fixed it on
    // the spot, they should not need somebody to hand it back to them first.
    const { canSignOffTriage } = await import('../../src/modules/repairs/repairs.authz.js')
    await expect(canSignOffTriage('filer-1', ORG, JOB)).resolves.toEqual({ ok: true, as: 'reporter' })
  })

  it('refuses a different technician', async () => {
    // The whole point: a sign-off is a claim about work somebody did.
    holding('technician'); member(true)
    const { canSignOffTriage } = await import('../../src/modules/repairs/repairs.authz.js')
    await expect(canSignOffTriage('tech-2', ORG, JOB)).resolves.toEqual({ ok: false, reason: 'not_yours' })
  })

  it('lets an administrator of this organisation close an orphaned job', async () => {
    // Without this arm one person leaving, or being suspended, strands a job
    // permanently — nobody else could ever close it.
    holding('admin'); member(true)
    const { canSignOffTriage } = await import('../../src/modules/repairs/repairs.authz.js')
    await expect(canSignOffTriage('boss', ORG, JOB)).resolves.toEqual({ ok: true, as: 'administrator' })
  })

  it('lets the platform administrator close one anywhere', async () => {
    holding('super_admin')
    prismaMock.user.findFirst.mockResolvedValue(null)
    const { canSignOffTriage } = await import('../../src/modules/repairs/repairs.authz.js')
    await expect(canSignOffTriage('root', ORG, JOB)).resolves.toEqual({ ok: true, as: 'administrator' })
  })

  it('refuses an admin of ANOTHER organisation', async () => {
    holding('admin'); member(false)
    const { canSignOffTriage } = await import('../../src/modules/repairs/repairs.authz.js')
    await expect(canSignOffTriage('boss', ORG, JOB)).resolves.toEqual({ ok: false, reason: 'not_yours' })
  })

  it('does not let a passer-by close an UNASSIGNED job', async () => {
    // A job nobody was sent to, recorded as resolved, is a fault that was never
    // looked at. Only the filer and an administrator may close one.
    holding('technician'); member(true)
    const { canSignOffTriage } = await import('../../src/modules/repairs/repairs.authz.js')
    await expect(canSignOffTriage('tech-2', ORG, { assignedToId: null, reportedById: 'filer-1' }))
      .resolves.toEqual({ ok: false, reason: 'not_yours' })
  })

  it('does not treat a null assignee as matching a null user', async () => {
    // `null === null` would hand an unassigned job to anybody the id of whom
    // failed to resolve.
    holding('operator'); member(true)
    const { canSignOffTriage } = await import('../../src/modules/repairs/repairs.authz.js')
    await expect(canSignOffTriage(null as unknown as string, ORG, { assignedToId: null, reportedById: null }))
      .resolves.toEqual({ ok: false, reason: 'not_yours' })
  })
})
