import { describe, expect, it } from 'vitest'
import { ROLE_DEFINITIONS } from '../../src/lib/permissions.js'

function permissionsFor(roleSlug: string): Set<string> {
  const role = ROLE_DEFINITIONS.find(({ slug }) => slug === roleSlug)
  if (!role) throw new Error(`Unknown role: ${roleSlug}`)
  return new Set(role.permissions)
}

describe('supervisor and operator sidebar access', () => {
  it('gives supervisors report, driver, alert, maintenance and audit access', () => {
    const permissions = permissionsFor('supervisor')
    for (const permission of [
      'report:read',
      'driver:read',
      'alerts:read',
      'repair:read',
      'fuel_audit:read',
    ]) {
      expect(permissions.has(permission), permission).toBe(true)
    }
  })

  it('gives operators live map, alert and unit access without broader analytics access', () => {
    const permissions = permissionsFor('operator')
    for (const permission of ['map:read', 'alerts:read', 'vehicle:read']) {
      expect(permissions.has(permission), permission).toBe(true)
    }
    expect(permissions.has('analytics:read')).toBe(false)
    expect(permissions.has('fuel_theft:read')).toBe(false)
  })
})
