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

import { TEST_ORG_ID } from '../helpers/factories.js'
import { authMock, authorizeMock, setTestSubject, resetTestSubject } from '../helpers/auth-mock.js'
vi.mock('../../src/middleware/auth.ts', () => ({ ...authMock(), forgetUser: vi.fn() }))
vi.mock('../../src/middleware/authorize.ts', () => authorizeMock())

// resolveSubject is called directly by assertCanGrantOrgs (not through the
// authorize middleware, which is mocked above). Granting everything here means
// the cross-org check passes and the test reaches the guard it is about.
vi.mock('../../src/lib/authz/subject.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSubject: vi.fn(async () => ({
    userId: 'usr_admin', isPlatform: false,
    platformPermissions: new Set<string>(),
    orgs: new Map([
      [TEST_ORG_ID, { permissions: new Set(['user:create']), vehicleIds: null }],
      ['org_two', { permissions: new Set(['user:create']), vehicleIds: null }],
    ]),
  })),
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

/** Enough doubles for provisionUser to run end to end. */
function happyPath({ existing = null as null | { id: string; deletedAt: null }, hadPassword = false } = {}) {
  prismaMock.user.findFirst.mockResolvedValue(existing as never)
  prismaMock.user.findUnique.mockResolvedValue(
    (existing ? { passwordHash: hadPassword ? '$2a$x' : null } : NEW_USER) as never,
  )
  prismaMock.user.create.mockResolvedValue({ id: NEW_USER.id } as never)
  prismaMock.organisation.findUnique.mockResolvedValue({ id: TEST_ORG_ID, name: 'Sukari Industries' } as never)
  prismaMock.role.findMany.mockResolvedValue([
    { id: 'role_1', slug: 'dispatcher', name: 'Dispatcher', organisationId: TEST_ORG_ID },
  ] as never)
  prismaMock.orgMembership.upsert.mockResolvedValue({ id: 'mem_1' } as never)
  prismaMock.membershipVehicleScope.deleteMany.mockResolvedValue({ count: 0 } as never)
  prismaMock.userRole.updateMany.mockResolvedValue({ count: 0 } as never)
  prismaMock.userRole.findMany.mockResolvedValue([] as never)
  prismaMock.userRole.createMany.mockResolvedValue({ count: 1 } as never)
  prismaMock.orgMembership.findMany.mockResolvedValue([] as never)
  prismaMock.passwordToken.updateMany.mockResolvedValue({ count: 0 } as never)
  prismaMock.passwordToken.create.mockResolvedValue({} as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  resetTestSubject()
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
    expect(res.status).toBe(400)
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

describe('GET /assignable-roles', () => {
  it('never offers a platform role', async () => {
    setTestSubject({ permissions: ['user:assign_role'] })
    prismaMock.role.findMany.mockResolvedValue([
      { id: 'r1', slug: 'dispatcher', name: 'Dispatcher' },
      { id: 'r2', slug: 'admin', name: 'Organisation Administrator' },
    ] as never)

    const res = await request(app).get(`${BASE}/assignable-roles`)

    expect(res.status).toBe(200)
    // The query is what guarantees it: a platform role has organisationId
    // NULL and cannot match an equality filter on this org.
    const where = prismaMock.role.findMany.mock.calls[0]![0]!.where as Record<string, unknown>
    expect(where['organisationId']).toBe(TEST_ORG_ID)
    expect(res.body.data.roles.map((r: { slug: string }) => r.slug)).not.toContain('super_admin')
  })

  it('returns roles the table holds beyond the seeded catalogue', async () => {
    setTestSubject({ permissions: ['user:assign_role'] })
    prismaMock.role.findMany.mockResolvedValue([
      { id: 'r_legacy', slug: 'weighbridge_clerk', name: 'Weighbridge Clerk' },
      { id: 'r_disp', slug: 'dispatcher', name: 'Dispatcher' },
    ] as never)

    const res = await request(app).get(`${BASE}/assignable-roles`)

    // The database decides what exists, not a list in application code: a role
    // an operator added by hand must be assignable.
    const slugs = res.body.data.roles.map((r: { slug: string }) => r.slug)
    expect(slugs).toContain('weighbridge_clerk')
    // ...but the catalogue roles lead, because they are what admins look for.
    expect(slugs[0]).toBe('dispatcher')
    // And no slug filter is sent — the query asks only for this organisation.
    const where = prismaMock.role.findMany.mock.calls[0]![0]!.where as Record<string, unknown>
    expect(where['slug']).toBeUndefined()
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
