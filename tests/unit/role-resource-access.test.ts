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

describe('screen access named on 2026-10-26', () => {
  it('gives supervisors every sidebar screen except Analytics', () => {
    const permissions = permissionsFor('supervisor')
    for (const permission of [
      'map:read', 'map:filter', 'alerts:read', 'driver:read', 'sensor:read', 'repair:read',
      'weighbridge:read', 'logbook:read', 'fuel_audit:read', 'fuel_filling:read', 'fuel_review:read',
    ]) {
      expect(permissions.has(permission), permission).toBe(true)
    }
    expect(permissions.has('analytics:read')).toBe(false)
    expect(permissions.has('analytics:export')).toBe(false)
  })

  it('gives operators maintenance, audit and vehicle fuel analysis, not the logbook, performance or workshop', () => {
    const permissions = permissionsFor('operator')
    for (const permission of [
      'map:read', 'map:filter', 'alerts:read', 'driver:read', 'weighbridge:read',
      'sensor:read', 'fuel_audit:read', 'fuel_filling:read',
    ]) {
      expect(permissions.has(permission), permission).toBe(true)
    }
    for (const permission of ['logbook:read', 'fuel_review:read', 'repair:read', 'analytics:read']) {
      expect(permissions.has(permission), permission).toBe(false)
    }
  })

  it('gives technicians the map restricted to flagged units, Maintenance and the ControlTech queue', () => {
    // Map and Maintenance added 2026-10-27.
    const permissions = permissionsFor('technician')
    for (const permission of ['repair:read', 'repair:claim', 'map:read', 'vehicle:flagged_only', 'sensor:read']) {
      expect(permissions.has(permission), permission).toBe(true)
    }
    for (const permission of [
      'map:filter', 'map:fuel_alerts', 'driver:read', 'weighbridge:read', 'analytics:read',
      'alerts:read', 'fuel_theft:read', 'fuel_audit:read', 'fuel_filling:read', 'logbook:read',
      'repair:flag', 'repair:assess', 'repair:book', 'repair:verify', 'repair:work_any',
    ]) {
      expect(permissions.has(permission), permission).toBe(false)
    }
  })

  it('keeps the logbook and performance view for every role that could open them before', () => {
    for (const role of ROLE_DEFINITIONS) {
      const permissions = new Set(role.permissions)
      if (role.platform && role.slug === 'super_admin') continue
      if (permissions.has('telemetry:read') && !['operator', 'technician'].includes(role.slug)) {
        expect(permissions.has('logbook:read'), `${role.slug} logbook`).toBe(true)
      }
      if (permissions.has('fuel_filling:read') && role.slug !== 'operator') {
        expect(permissions.has('fuel_review:read'), `${role.slug} performance`).toBe(true)
      }
    }
  })
})

describe('vehicle:flagged_only', () => {
  it('is held by the technician alone, so no other role is narrowed by it', () => {
    const holders = ROLE_DEFINITIONS.filter((r) => r.permissions.includes('vehicle:flagged_only')).map((r) => r.slug)
    expect(holders).toEqual(['technician'])
  })
})
