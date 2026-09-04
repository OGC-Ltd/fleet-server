/**
 * The authentication/authorization middleware, replaced for integration tests.
 *
 * This exists because `vi.mock` with a factory replaces a module WHOLESALE.
 * Nine integration tests each carried their own copy of the auth factory, so
 * the moment any router imported one more export from `middleware/auth`, all
 * nine failed at once with "No export named …" — a breakage with no relation
 * to the thing being tested. One definition here means one edit when the
 * middleware surface grows.
 *
 * These are DELIBERATELY permissive: they answer "does this route do the right
 * thing for a caller who is allowed in", which is what the route tests are
 * about. The middleware's own decisions — token verification, rotation, reuse
 * detection, cross-org denial, vehicle scoping — are pinned separately in
 * tests/unit, against the real implementations.
 */

import { vi } from 'vitest'
import { TEST_ORG_ID, testAuthUser } from './factories.js'
// The real error classes, not ad-hoc Errors: errorHandler maps AppError to its
// statusCode and turns anything else into a 500, so a mock throwing a plain
// Error would assert 500s where the real middleware returns 403 and 404.
import { ForbiddenError, NotFoundError } from '../../src/core/errors/errors.js'

/** The subject each mocked request is authenticated as. */
export type TestSubject = {
  user: typeof testAuthUser
  /** Permission slugs held. `'*'` satisfies every check. */
  permissions: string[]
  /** Organisations the subject may reach. `'*'` means every one. */
  orgs: string[] | '*'
  /** Vehicles the subject may see. `'all'` means no row filtering. */
  vehicleScope: 'all' | string[]
}

const DEFAULT_SUBJECT: TestSubject = {
  user:         testAuthUser,
  permissions:  ['*'],
  orgs:         [TEST_ORG_ID],
  vehicleScope: 'all',
}

let subject: TestSubject = { ...DEFAULT_SUBJECT }

/**
 * Narrow the subject for one test — e.g. to assert that a route 403s for a
 * caller lacking a permission. Call `resetTestSubject()` in `beforeEach`, or
 * the narrowing leaks into every test after it in the file.
 */
export function setTestSubject(patch: Partial<TestSubject>): void {
  subject = { ...subject, ...patch }
}

export function resetTestSubject(): void {
  subject = { ...DEFAULT_SUBJECT }
}

export function currentTestSubject(): TestSubject {
  return subject
}

/** Factory for `vi.mock('../../src/middleware/auth.ts', …)`. */
export function authMock() {
  return {
    authenticate: vi.fn((req: Record<string, unknown>, _res: unknown, next: () => void) => {
      req['user'] = subject.user
      next()
    }),
    requireOrgAccess: vi.fn((req: Record<string, unknown>, _res: unknown, next: (err?: unknown) => void) => {
      if (subject.orgs === '*') return next()
      const params = (req['params'] ?? {}) as Record<string, string | undefined>
      const orgId = params['orgId']
      // Mirrors the real middleware's fail-CLOSED rule: a route mounted under
      // an org prefix with no :orgId resolved is a routing mistake, not a
      // public route.
      if (orgId && !subject.orgs.includes(orgId)) {
        return next(new ForbiddenError('Access to this organisation is denied'))
      }
      next()
    }),
  }
}

/** Factory for `vi.mock('../../src/middleware/authorize.ts', …)`. */
export function authorizeMock() {
  return {
    // Accepts the resolver form as well as a plain slug, because the real
    // middleware does: /reports/pdf/:kind picks its permission from the request,
    // and a mock that stringified the function would assert against
    // "Missing permission: (req) => ..." and pass while proving nothing.
    requirePermission: vi.fn((slug: string | ((req: unknown) => string)) =>
      vi.fn((req: Record<string, unknown>, _res: unknown, next: (err?: unknown) => void) => {
        const need = typeof slug === 'string' ? slug : slug(req)
        const held = subject.permissions
        const params = (req['params'] ?? {}) as Record<string, string | undefined>
        const orgId = params['orgId']

        // Mirrors the real rule: a route with no :orgId is PLATFORM surface,
        // and an org-scoped grant cannot satisfy it. "fleet_manager at SUKARI"
        // is not an answer to "may you edit the tenant list".
        if (!orgId && subject.orgs !== '*') {
          return next(new ForbiddenError(`Missing permission: ${need}`))
        }
        if (!held.includes('*') && !held.includes(need)) {
          return next(new ForbiddenError(`Missing permission: ${need}`))
        }
        req['authz'] = {
          userId:     subject.user.id,
          orgId:      ((req['params'] ?? {}) as Record<string, string>)['orgId'] ?? '',
          isPlatform: subject.orgs === '*',
          vehicleIds: subject.vehicleScope === 'all' ? null : new Set(subject.vehicleScope),
        }
        next()
      }),
    ),
    // The strict variant shares requirePermission's decision entirely — the
    // real difference is that it never falls through to shadow mode, and the
    // mock has no shadow mode to fall through to. Declared as its own export
    // because `vi.mock` replaces the module wholesale: a router importing a
    // name this factory does not return fails every test in the file at
    // import time, which is the breakage this helper exists to prevent.
    requirePermissionStrict: vi.fn((slug: string | ((req: unknown) => string)) =>
      vi.fn((req: Record<string, unknown>, _res: unknown, next: (err?: unknown) => void) => {
        const need = typeof slug === 'string' ? slug : slug(req)
        const held = subject.permissions
        const params = (req['params'] ?? {}) as Record<string, string | undefined>
        const orgId = params['orgId']

        if (!orgId && subject.orgs !== '*') {
          return next(new ForbiddenError(`Missing permission: ${need}`))
        }
        if (subject.orgs !== '*' && orgId && !subject.orgs.includes(orgId)) {
          return next(new ForbiddenError(`Missing permission: ${need}`))
        }
        if (!held.includes('*') && !held.includes(need)) {
          return next(new ForbiddenError(`Missing permission: ${need}`))
        }
        req['authz'] = {
          userId:     subject.user.id,
          orgId:      orgId ?? '',
          isPlatform: subject.orgs === '*',
          vehicleIds: subject.vehicleScope === 'all' ? null : new Set(subject.vehicleScope),
        }
        next()
      }),
    ),
    requireVehicleInScope: vi.fn((req: Record<string, unknown>, _res: unknown, next: (err?: unknown) => void) => {
      if (subject.vehicleScope === 'all') return next()
      const params = (req['params'] ?? {}) as Record<string, string | undefined>
      const vehicleId = params['vehicleId']
      if (vehicleId && !subject.vehicleScope.includes(vehicleId)) {
        // 404 rather than 403, matching the real guard: a caller must not be
        // able to tell "not yours" from "does not exist".
        return next(new NotFoundError('Vehicle not found'))
      }
      next()
    }),
    attachAuthz: vi.fn((req: Record<string, unknown>, _res: unknown, next: () => void) => {
      req['authz'] = {
        userId:     subject.user.id,
        orgId:      ((req['params'] ?? {}) as Record<string, string>)['orgId'] ?? '',
        isPlatform: subject.orgs === '*',
        vehicleIds: subject.vehicleScope === 'all' ? null : new Set(subject.vehicleScope),
      }
      next()
    }),
  }
}
