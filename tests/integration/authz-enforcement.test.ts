/**
 * The gates, exercised through the real router stack.
 *
 * The unit tests prove the resolver computes the right answer and the matrix
 * grants the right slugs. Neither proves the guard is actually MOUNTED on the
 * route — and ~90 endpoints were wired in one pass, so "we forgot one" is the
 * likeliest way this ships broken. These requests go through app.ts, so a route
 * missing its guard fails here.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { TEST_ORG_ID, makeVehicle } from '../helpers/factories.js'
import { authMock, authorizeMock, setTestSubject, resetTestSubject } from '../helpers/auth-mock.js'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/middleware/auth.ts', () => authMock())
vi.mock('../../src/middleware/authorize.ts', () => authorizeMock())

import { prismaMock } from '../helpers/prisma.mock.js'
import { buildApp } from '../helpers/app.js'

let app: Express
beforeAll(async () => { app = await buildApp() })
beforeEach(() => { resetTestSubject() })

const ORG = `/api/v1/organisations/${TEST_ORG_ID}`

describe('a permission the caller does not hold', () => {
  /**
   * One case per gate the operator named, each hitting the real route. An
   * operator holds tracking and nothing else, so every one of these is a 403.
   */
  const denied: [string, string, string][] = [
    ['analytics',        'analytics:read',   `${ORG}/analytics/overview`],
    ['the drivers page', 'driver:read',      `${ORG}/analytics/drivers`],
    ['fuel refills',     'fuel_filling:read', `${ORG}/fuel/fillings`],
    ['fuel loss cases',  'fuel_theft:read',  `${ORG}/fuel/thefts`],
    ['reports',          'report:read',      `${ORG}/periods`],
    ['journey replay',   'map:playback',     `${ORG}/vehicles/veh_1/playback`],
    ['device API keys',  'ingest_key:read',  `${ORG}/api-keys`],
    ['role management',  'role:read',        `${ORG}/roles`],
  ]

  for (const [what, slug, url] of denied) {
    it(`refuses ${what} without ${slug}`, async () => {
      setTestSubject({ permissions: ['map:read', 'telemetry:read', 'vehicle:read', 'notification:read'] })
      const res = await request(app).get(url)
      expect(res.status).toBe(403)
      expect(res.body.message).toContain(slug)
    })
  }

  it('admits the same route once the permission is held', async () => {
    setTestSubject({ permissions: ['analytics:read'] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.vehicle.count as any).mockResolvedValue(0)
    const res = await request(app).get(`${ORG}/analytics/overview`)
    expect(res.status).not.toBe(403)
  })
})

describe('the reports endpoint serves several audiences', () => {
  const pdf = (kind: string) => `${ORG}/reports/pdf/${kind}`

  /**
   * The rule the operator gave for logistics manager and dispatcher: the
   * operations report, and nothing else on paper.
   */
  it('lets report:operations through to the operations report', async () => {
    setTestSubject({ permissions: ['report:operations'] })
    const res = await request(app).get(pdf('operations'))
    expect(res.status).not.toBe(403)
  })

  it('refuses the analytics PDF to the same caller', async () => {
    setTestSubject({ permissions: ['report:operations'] })
    const res = await request(app).get(pdf('analytics'))
    expect(res.status).toBe(403)
    expect(res.body.message).toContain('report:export')
  })

  it('refuses the drivers PDF to the same caller', async () => {
    setTestSubject({ permissions: ['report:operations'] })
    const res = await request(app).get(pdf('drivers'))
    expect(res.status).toBe(403)
    expect(res.body.message).toContain('driver:export')
  })

  /** An unknown kind must not be a way past the guard. */
  it('still demands a permission for a report kind nobody defined', async () => {
    setTestSubject({ permissions: ['report:operations'] })
    const res = await request(app).get(pdf('made-up'))
    expect(res.status).toBe(403)
  })
})

describe('another organisation', () => {
  it('is refused even when the permission is held', async () => {
    setTestSubject({ permissions: ['*'], orgs: [TEST_ORG_ID] })
    const res = await request(app).get('/api/v1/organisations/org_someone_else/analytics/overview')
    expect(res.status).toBe(403)
    expect(res.body.message).toMatch(/organisation/i)
  })

  it('is reachable by a platform subject', async () => {
    setTestSubject({ permissions: ['*'], orgs: '*' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.vehicle.count as any).mockResolvedValue(0)
    const res = await request(app).get('/api/v1/organisations/org_someone_else/analytics/overview')
    expect(res.status).not.toBe(403)
  })
})

describe('vehicle scope', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.vehicle.findFirst as any).mockResolvedValue(makeVehicle({ id: 'veh_mine' }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.$transaction as any).mockResolvedValue([[], 0])
  })

  it('lets a scoped caller reach a vehicle in its set', async () => {
    setTestSubject({ permissions: ['*'], vehicleScope: ['veh_mine'] })
    const res = await request(app).get(`${ORG}/vehicles/veh_mine`)
    expect(res.status).not.toBe(404)
    expect(res.status).not.toBe(403)
  })

  /**
   * 404 rather than 403, deliberately: a restricted caller must not be able to
   * tell "exists but not yours" from "does not exist", or the error code itself
   * enumerates the fleet.
   */
  it('answers 404 — not 403 — for a vehicle outside its set', async () => {
    setTestSubject({ permissions: ['*'], vehicleScope: ['veh_mine'] })
    const res = await request(app).get(`${ORG}/vehicles/veh_someone_elses`)
    expect(res.status).toBe(404)
  })

  it('applies to the whole per-vehicle surface, not just the detail route', async () => {
    setTestSubject({ permissions: ['*'], vehicleScope: ['veh_mine'] })
    for (const path of [
      `${ORG}/vehicles/veh_other/track`,
      `${ORG}/vehicles/veh_other/playback`,
      `${ORG}/vehicles/veh_other/telemetry`,
      `${ORG}/vehicles/veh_other/brief`,
      `${ORG}/vehicles/veh_other/maintenance/services`,
      `${ORG}/vehicles/veh_other/assignments`,
    ]) {
      const res = await request(app).get(path)
      expect(res.status, path).toBe(404)
    }
  })

  it('does not restrict a caller whose scope is the whole fleet', async () => {
    setTestSubject({ permissions: ['*'], vehicleScope: 'all' })
    const res = await request(app).get(`${ORG}/vehicles/veh_anything`)
    expect(res.status).not.toBe(404)
  })
})

describe('the platform surface', () => {
  /**
   * `/api/v1/organisations` carries no :orgId, so requireOrgAccess cannot guard
   * it — and it used to fail OPEN when the param was absent, which is how any
   * authenticated user could list, read and PATCH every tenant.
   */
  it('refuses the tenant list to an org-scoped caller', async () => {
    setTestSubject({ permissions: ['organisation:read'], orgs: [TEST_ORG_ID] })
    const res = await request(app).get('/api/v1/organisations')
    expect(res.status).toBe(403)
  })

  it('refuses creating a tenant to an org-scoped caller', async () => {
    setTestSubject({ permissions: ['*'], orgs: [TEST_ORG_ID] })
    const res = await request(app).post('/api/v1/organisations').send({ name: 'Sneaky Ltd', code: 'SNEAK' })
    expect(res.status).toBe(403)
  })

  it('admits a platform caller', async () => {
    setTestSubject({ permissions: ['*'], orgs: '*' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.$transaction as any).mockResolvedValue([[], 0])
    const res = await request(app).get('/api/v1/organisations')
    expect(res.status).not.toBe(403)
  })
})
