/**
 * Creating a user in an organisation, and the invitation that follows.
 *
 * The first test in this file is the one that matters most. Under the old
 * `requirePermission` with `AUTHZ_ENFORCE=false`, a caller holding only
 * `user:read` would have been logged as "WOULD DENY" and then allowed to
 * create the account anyway — a 201, and a green tick, for a request that
 * should have been refused. `requirePermissionStrict` is what makes that a
 * 403, and this asserts it rather than trusting it.
 *
 * The rest defend the invitation itself: never mint a set-password link for an
 * account that already has a password, because that is account takeover by
 * guessing an email address.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/redis.js', () => ({
  getCacheRedis: () => null,
  getQueueRedis: () => null,
  isRedisConfigured: () => false,
  CACHE_DB: 0, QUEUE_DB: 1,
  disconnectRedis: async () => {},
}))
vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn(async () => '$2a$hashed'), compare: vi.fn(async () => true) },
}))

type MailArgs = [string, string | null | undefined, { text: string; html: string; category: string }]
const sendMail = vi.fn(async (..._args: MailArgs) => ({ sent: true }) as { sent: boolean; reason?: string })
vi.mock('../../src/lib/mailer/mailer.js', () => ({ sendMail: (...a: unknown[]) => sendMail(...(a as unknown as MailArgs)) }))

import { TEST_ORG_ID, testAuthUser } from '../helpers/factories.js'
import { authMock, authorizeMock, setTestSubject, resetTestSubject } from '../helpers/auth-mock.js'
vi.mock('../../src/middleware/auth.ts', () => ({ ...authMock(), forgetUser: vi.fn() }))
vi.mock('../../src/middleware/authorize.ts', () => authorizeMock())

// resolveSubject is called directly by assertCanGrantOrgs (not through the
// authorize middleware, which is mocked above). Granting everything here means
// the cross-org check passes and the test reaches the guard it is about.
// A settable override, because two callers have to be told apart here and the
// difference between them IS the security property: an organisation admin and
// a System Administrator get different answers from the same route.
const asPlatformAdmin = vi.hoisted(() => ({ on: false }))

vi.mock('../../src/lib/authz/subject.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSubject: vi.fn(async () =>
    asPlatformAdmin.on
      ? {
          userId: 'usr_root', isPlatform: true,
          platformPermissions: new Set(['platform:admin']),
          orgs: new Map(),
        }
      : {
          userId: 'usr_admin', isPlatform: false,
          platformPermissions: new Set<string>(),
          orgs: new Map([
            [TEST_ORG_ID, { permissions: new Set(['user:create']), vehicleIds: null }],
            ['org_two', { permissions: new Set(['user:create']), vehicleIds: null }],
          ]),
        }),
  invalidateSubject: vi.fn(async () => {}),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { buildApp } from '../helpers/app.js'

let app: Express
beforeAll(async () => { app = await buildApp() })

const BASE = `/api/v1/organisations/${TEST_ORG_ID}/users`

const NEW_USER = {
  id: 'usr_new', organisationId: TEST_ORG_ID, email: 'newbie@fleet.dev',
  fullName: 'New Person', status: 'ACTIVE', createdAt: new Date(),
}

const BODY = { fullName: 'New Person', email: 'newbie@fleet.dev', roleSlugs: ['dispatcher'] }

/**
 * Role grants as user.authz reads them (prisma.userRole, not the subject).
 * The caller is an organisation admin, or super_admin when asPlatformAdmin is
 * on; anyone else holds nothing unless a test says so.
 */
function callerGrants() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prismaMock.userRole.findMany.mockImplementation((async (args: any) =>
    args?.where?.userId === testAuthUser.id
      ? [{ role: { slug: asPlatformAdmin.on ? 'super_admin' : 'admin' } }]
      : []) as never)
}

/** Enough doubles for provisionUser to run end to end. */
function happyPath({ existing = null as null | { id: string; deletedAt: null }, hadPassword = false } = {}) {
  // Caller and target share one group: a non-platform administrator may only
  // manage people in a group of theirs (users/user-group.scope).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prismaMock.user.findFirst.mockImplementation((async (args: any) =>
    args?.select?.groups ? (existing ? { groups: [{ groupId: 'grp_1' }] } : null) : existing) as never)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prismaMock.user.findUnique.mockImplementation((async (args: any) =>
    // The caller's own group lookup (users/user-group.scope) selects `groups`.
    args?.select?.groups
      ? { groups: [{ groupId: 'grp_1' }] }
      : existing ? { passwordHash: hadPassword ? '$2a$x' : null } : NEW_USER) as never)
  prismaMock.user.create.mockResolvedValue({ id: NEW_USER.id } as never)
  prismaMock.organisation.findUnique.mockResolvedValue({ id: TEST_ORG_ID, name: 'Sukari Industries' } as never)
  prismaMock.role.findMany.mockResolvedValue([
    { id: 'role_1', slug: 'dispatcher', name: 'Dispatcher', organisationId: TEST_ORG_ID },
  ] as never)
  prismaMock.orgMembership.upsert.mockResolvedValue({ id: 'mem_1' } as never)
  prismaMock.membershipVehicleScope.deleteMany.mockResolvedValue({ count: 0 } as never)
  prismaMock.userRole.updateMany.mockResolvedValue({ count: 0 } as never)
  callerGrants()
  prismaMock.userRole.createMany.mockResolvedValue({ count: 1 } as never)
  prismaMock.orgMembership.findMany.mockResolvedValue([] as never)
  prismaMock.passwordToken.updateMany.mockResolvedValue({ count: 0 } as never)
  prismaMock.passwordToken.create.mockResolvedValue({} as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  resetTestSubject()
  callerGrants()
})

describe('the hard gate', () => {
  it('403s a caller who lacks user:create — the whole point of requirePermissionStrict', async () => {
    setTestSubject({ permissions: ['user:read'] })
    happyPath()

    const res = await request(app).post(`${BASE}/provision`).send(BODY)

    // Under shadow mode this would have been a 201 with a "WOULD DENY" log.
    expect(res.status).toBe(403)
    expect(prismaMock.user.create).not.toHaveBeenCalled()
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('403s the role picker for a caller without user:assign_role', async () => {
    setTestSubject({ permissions: ['user:read', 'user:create'] })

    const res = await request(app).get(`${BASE}/assignable-roles`)

    expect(res.status).toBe(403)
  })

  it('403s a suspension attempt without user:update', async () => {
    setTestSubject({ permissions: ['user:read'] })

    const res = await request(app).patch(`${BASE}/usr_other/status`).send({ status: 'SUSPENDED' })

    expect(res.status).toBe(403)
    expect(prismaMock.user.update).not.toHaveBeenCalled()
  })
})

describe('POST /provision', () => {
  it('creates the account and mails an invitation', async () => {
    setTestSubject({ permissions: ['user:create'] })
    happyPath()

    const res = await request(app).post(`${BASE}/provision`).send(BODY)

    expect(res.status).toBe(201)
    expect(res.body.data.created).toBe(true)
    expect(res.body.data.invite).toEqual({ sent: true })
    expect(sendMail).toHaveBeenCalledTimes(1)
    // The link must carry a raw token, and it must be a fragment — a query
    // string would land in nginx's access log.
    const mail = sendMail.mock.calls[0]![2]
    expect(mail.category).toBe('invite')
    expect(mail.text).toContain('/#setup=')
  })

  it('REFUSES to invite an address that already has a password', async () => {
    setTestSubject({ permissions: ['user:create'] })
    happyPath({ existing: { id: 'usr_existing', deletedAt: null }, hadPassword: true })

    const res = await request(app).post(`${BASE}/provision`).send(BODY)

    expect(res.status).toBe(201)
    // Added to the organisation, but NOT sent a set-password link: that would
    // be a takeover of somebody else's account via a guessed email.
    expect(res.body.data.created).toBe(false)
    expect(res.body.data.invite).toEqual({ sent: false, reason: 'account-already-active' })
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('rejects a password in the body — org admins invite, they do not set passwords', async () => {
    setTestSubject({ permissions: ['user:create'] })
    happyPath()

    const res = await request(app).post(`${BASE}/provision`).send({ ...BODY, password: 'hunter2hunter2' })

    // The field was removed from the schema; Zod strips it rather than
    // erroring, so the assertion is that it never reached bcrypt.
    expect(res.status).toBe(201)
    expect(prismaMock.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ passwordHash: null }) }),
    )
  })

  it('says so when the mailer is dormant, rather than showing success', async () => {
    setTestSubject({ permissions: ['user:create'] })
    happyPath()
    sendMail.mockResolvedValueOnce({ sent: false, reason: 'unconfigured' })

    const res = await request(app).post(`${BASE}/provision`).send(BODY)

    expect(res.status).toBe(201)
    expect(res.body.data.invite).toMatchObject({ sent: false, reason: 'unconfigured' })
  })
})

describe('granting more than one organisation', () => {
  it('REFUSES an organisation the caller cannot administer', async () => {
    // user:create at the path org — and nothing at all at the other one.
    setTestSubject({ permissions: ['user:create'], orgs: [TEST_ORG_ID] })
    happyPath()

    const res = await request(app).post(`${BASE}/provision`).send({
      ...BODY,
      memberships: [{ organisationId: 'org_somebody_else', roleSlugs: ['operator'] }],
    })

    // requirePermissionStrict grades the PATH org only, so without the extra
    // check this would have been a 201 granting access to another tenant.
    expect(res.status).toBe(403)
    expect(prismaMock.user.create).not.toHaveBeenCalled()
  })

  it('REFUSES a platform role even when granting several organisations', async () => {
    setTestSubject({ permissions: ['user:create'], orgs: '*' })
    happyPath()
    prismaMock.role.findMany.mockResolvedValue([
      // organisationId null = a PLATFORM role, which reaches every tenant.
      { id: 'r_super', slug: 'super_admin', name: 'Super Administrator', organisationId: null },
    ] as never)

    const res = await request(app).post(`${BASE}/provision`).send({
      ...BODY,
      roleSlugs: ['super_admin'],
      memberships: [{ organisationId: 'org_two', roleSlugs: [] }],
    })

    // The multi-org path has to drop restrictToOrgId, and the platform-role
    // guard used to be inferred from exactly that — so this combination
    // silently permitted a super_admin grant from an organisation route.
    // Refused by the role ceiling (an organisation administrator assigns
    // only roles below admin) before the platform-role check is reached.
    expect(res.status).toBe(403)
  })

  it('ignores the path organisation repeated in the extras', async () => {
    setTestSubject({ permissions: ['user:create'], orgs: [TEST_ORG_ID] })
    happyPath()

    const res = await request(app).post(`${BASE}/provision`).send({
      ...BODY,
      memberships: [{ organisationId: TEST_ORG_ID, roleSlugs: ['operator'] }],
    })

    // Naming the path org again is harmless, not a second conflicting grant —
    // and it must not trip the cross-org check against the caller's own org.
    expect(res.status).toBe(201)
  })
})

describe('GET / — the organisations an administrator may see', () => {
  // The requirement: an admin sees the people in the organisations they were
  // added to. All of those, and only those.
  const OTHER_ORG = 'org_somebody_elses'
  const OTHER_BASE = `/api/v1/organisations/${OTHER_ORG}/users`

  it('refuses an organisation the caller was not added to', async () => {
    setTestSubject({ permissions: ['user:read'], orgs: [TEST_ORG_ID] })
    prismaMock.$transaction.mockResolvedValue([[], 0] as never)

    const res = await request(app).get(`${OTHER_BASE}?access=system`)

    // 403, not an empty list. This only holds because the route is STRICT:
    // requireOrgAccess runs in shadow mode while AUTHZ_ENFORCE is false, so it
    // would log "WOULD DENY" and serve the other organisation's roster.
    expect(res.status).toBe(403)
    expect(prismaMock.user.findMany).not.toHaveBeenCalled()
  })

  it('serves every organisation the caller WAS added to', async () => {
    // The other half, and the one a naive "lock it down" fix breaks: being
    // added to two organisations means both, not just the home one.
    setTestSubject({ permissions: ['user:read'], orgs: [TEST_ORG_ID, OTHER_ORG] })
    prismaMock.$transaction.mockResolvedValue([[], 0] as never)

    for (const base of [BASE, OTHER_BASE]) {
      const res = await request(app).get(`${base}?access=system`)
      expect(res.status).toBe(200)
    }
  })

  it('refuses a caller who can reach the organisation but holds no user:read', async () => {
    setTestSubject({ permissions: ['vehicle:read'], orgs: [TEST_ORG_ID] })

    const res = await request(app).get(`${BASE}?access=system`)
    expect(res.status).toBe(403)
  })
})

describe('GET / — who counts as a user', () => {
  const whereOf = () =>
    (prismaMock.user.findMany.mock.calls[0]![0]! as { where: Record<string, unknown> }).where

  it('narrows to invited people when access=system, and says so as AND of two clauses', async () => {
    setTestSubject({ permissions: ['user:read'] })
    prismaMock.$transaction.mockResolvedValue([[], 0] as never)

    await request(app).get(`${BASE}?access=system`)

    // Two independent narrowings that must BOTH hold, which is why they are an
    // AND of two ORs rather than one flat OR: reachable-from-this-organisation
    // and invited-to-the-system. Flattening them would list an invited person
    // from another tenant.
    // The group narrowing (users/user-group.scope) is a third clause of the
    // same AND; it is not what this test is about.
    const and = whereOf()['AND'] as Record<string, unknown>[]
    expect(and).toContainEqual({ OR: [
      { organisationId: TEST_ORG_ID },
      { memberships: { some: { organisationId: TEST_ORG_ID, revokedAt: null } } },
    ] })
    // An invitation counts however it ended — expired, consumed or revoked.
    // Somebody invited three weeks ago who never opened the link is exactly
    // who the roster exists to surface.
    expect(and).toContainEqual({ OR: [
      { passwordTokens: { some: { purpose: 'INVITE' } } },
      { passwordHash: { not: null } },
    ] })
    // Never one flat OR at the top level.
    expect(whereOf()['OR']).toBeUndefined()
  })

  it('scopes by membership, not just the employer column, in every mode', async () => {
    setTestSubject({ permissions: ['user:read'] })
    prismaMock.$transaction.mockResolvedValue([[], 0] as never)

    await request(app).get(BASE)

    // The regression this guards: `users.organisation_id` records who EMPLOYS
    // somebody and never changes. Scoping to it alone meant an administrator
    // could grant a person from another site access to their organisation and
    // then never see them in their own roster — so never take it back.
    expect(whereOf()['AND']).toContainEqual({ OR: [
      { organisationId: TEST_ORG_ID },
      { memberships: { some: { organisationId: TEST_ORG_ID, revokedAt: null } } },
    ] })
  })

  it('never filters suspended accounts out on its own', async () => {
    setTestSubject({ permissions: ['user:read'] })
    prismaMock.$transaction.mockResolvedValue([[], 0] as never)

    await request(app).get(`${BASE}?access=system`)

    // Status is a column to display, not a reason to omit a row: an admin who
    // cannot see a suspended account cannot reinstate one.
    expect(whereOf()['status']).toBeUndefined()
    expect(whereOf()['deletedAt']).toBeNull()
  })
})

describe('GET /assignable-roles', () => {
  it('never offers a platform role to an organisation administrator', async () => {
    // The important half. However complete their power inside their own
    // tenant, an org admin must not be able to appoint a System Administrator
    // — and must not even be shown the option.
    setTestSubject({ permissions: ['user:assign_role'] })
    prismaMock.role.findMany.mockResolvedValue([
      { id: 'r1', slug: 'dispatcher', name: 'Dispatch Manager' },
      { id: 'r2', slug: 'admin', name: 'Admin' },
    ] as never)

    const res = await request(app).get(`${BASE}/assignable-roles`)

    expect(res.status).toBe(200)
    expect(res.body.data.roles.map((r: { slug: string }) => r.slug)).not.toContain('super_admin')
    // Every query it ran was scoped to THIS organisation; none asked for the
    // organisation-less rows where platform roles live.
    for (const call of prismaMock.role.findMany.mock.calls) {
      const where = call[0]!.where as Record<string, unknown>
      expect(where['organisationId']).not.toBeNull()
    }
  })

  it('offers platform roles to a caller who already holds platform:admin', async () => {
    asPlatformAdmin.on = true
    // A System Administrator appointing another. Without this the role is
    // absent from every organisation's picker, because it belongs to none of
    // them — which is exactly why it never appeared.
    setTestSubject({ permissions: ['*'], orgs: '*' })
    prismaMock.role.findMany
      .mockResolvedValueOnce([{ id: 'r1', slug: 'dispatcher', name: 'Dispatch Manager' }] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ id: 'r_super', slug: 'super_admin', name: 'System Administrator' }] as never)

    const res = await request(app).get(`${BASE}/assignable-roles`)

    expect(res.status).toBe(200)
    const roles = res.body.data.roles as { slug: string; platform: boolean }[]
    expect(roles.map((r) => r.slug)).toContain('super_admin')
    // Flagged, so the picker can say what it is: a grant made inside one
    // organisation that reaches all of them.
    expect(roles.find((r) => r.slug === 'super_admin')?.platform).toBe(true)
    expect(roles.find((r) => r.slug === 'dispatcher')?.platform).toBe(false)

    const platformQuery = prismaMock.role.findMany.mock.calls
      .map((c) => c[0]!.where as Record<string, unknown>)
      .find((w) => w['organisationId'] === null)
    expect(platformQuery).toBeDefined()

    asPlatformAdmin.on = false
  })

  it('offers the named catalogue, plus any role somebody actually holds', async () => {
    setTestSubject({ permissions: ['user:assign_role'] })
    // Two queries now: the catalogue, and the roles in use. The mock answers
    // both, so a legacy role nobody in the catalogue names still comes back.
    prismaMock.role.findMany
      .mockResolvedValueOnce([{ id: 'r_disp', slug: 'dispatcher', name: 'Dispatch Manager' }] as never)
      .mockResolvedValueOnce([{ id: 'r_legacy', slug: 'weighbridge_clerk', name: 'Weighbridge Clerk' }] as never)

    const res = await request(app).get(`${BASE}/assignable-roles`)

    const slugs = res.body.data.roles.map((r: { slug: string }) => r.slug)
    // Whatever the in-use query returns is merged into the offer.
    expect(slugs).toContain('weighbridge_clerk')
    // ...but the named catalogue leads, in the order it was named.
    expect(slugs[0]).toBe('dispatcher')

    // The catalogue query is the one that filters by slug; the in-use query
    // filters by live grants instead, which is what lets it find the rest.
    const first  = prismaMock.role.findMany.mock.calls[0]![0]!.where as Record<string, unknown>
    const second = prismaMock.role.findMany.mock.calls[1]![0]!.where as Record<string, unknown>
    expect(first['slug']).toEqual({ in: expect.arrayContaining(['hr', 'operator']) })
    // Nor `admin`: an administrator assigns only roles ranked below admin
    // (lib/permissions ASSIGNABLE_ROLE_SLUGS), so the picker never offers it.
    expect(first['slug']).not.toEqual({ in: expect.arrayContaining(['admin']) })
    // `super_admin` is deliberately NOT on this list any more. It is a PLATFORM
    // role, and the platform arm of this handler queries `organisationId: null`
    // filtered by the same array — so its presence here is what put "System
    // Administrator · all orgs" in every organisation's picker. Asserting its
    // ABSENCE is what stops it being added back by someone reading the list as
    // an inventory of roles rather than as a per-organisation offer.
    expect(first['slug']).not.toEqual({ in: expect.arrayContaining(['super_admin']) })
    // An organisation administrator is offered held roles only from the same
    // assignable list: a person holds one role per organisation, so saving
    // replaces it anyway, and the server refuses any role above the ceiling.
    expect(second['slug']).toEqual(first['slug'])
    expect(second['userRoles']).toEqual({ some: { revokedAt: null, user: { deletedAt: null } } })
  })
})

describe('PATCH /:userId/status', () => {
  it('revokes sessions when suspending, so it takes effect at once', async () => {
    setTestSubject({ permissions: ['user:update'] })
    prismaMock.user.findFirst.mockResolvedValue({ id: 'usr_other', email: 'other@fleet.dev' } as never)
    prismaMock.user.update.mockResolvedValue({ id: 'usr_other', status: 'SUSPENDED' } as never)
    prismaMock.authSession.updateMany.mockResolvedValue({ count: 2 } as never)

    const res = await request(app).patch(`${BASE}/usr_other/status`).send({ status: 'SUSPENDED' })

    expect(res.status).toBe(200)
    // Without this the flag only bites when the access token expires — up to
    // fifteen minutes of a suspended person carrying on working.
    expect(prismaMock.authSession.updateMany).toHaveBeenCalled()
  })

  it('refuses an unknown status rather than writing it', async () => {
    setTestSubject({ permissions: ['user:update'] })

    const res = await request(app).patch(`${BASE}/usr_other/status`).send({ status: 'DELETED' })

    expect(res.status).toBe(400)
    expect(prismaMock.user.update).not.toHaveBeenCalled()
  })
})
