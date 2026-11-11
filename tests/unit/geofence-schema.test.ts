import { describe, it, expect } from 'vitest'
import { createGeofenceSchema, updateGeofenceSchema } from '../../src/modules/geofences/geofence.schema.js'
import { categoryOf } from '../../src/lib/zone-taxonomy.js'

const ring: Array<[number, number]> = [[34.7, 0.28], [34.71, 0.28], [34.71, 0.29], [34.7, 0.28]]

describe('createGeofenceSchema', () => {
  it('takes a purpose and a colour', () => {
    const r = createGeofenceSchema.parse({ type: 'POLYGON', name: ' Yard ', polygonCoords: ring, purpose: 'gate', color: '#AABBCC' })
    expect(r).toMatchObject({ name: 'Yard', purpose: 'gate', color: '#AABBCC', mode: 'ALLOWLIST' })
  })
  it('refuses an unknown purpose and a colour that is not #rrggbb', () => {
    expect(createGeofenceSchema.safeParse({ type: 'POLYGON', name: 'A', polygonCoords: ring, purpose: 'castle' }).success).toBe(false)
    expect(createGeofenceSchema.safeParse({ type: 'POLYGON', name: 'A', polygonCoords: ring, color: 'red' }).success).toBe(false)
  })
  it('takes a corridor: a line of two points or more and a width', () => {
    expect(createGeofenceSchema.safeParse({ type: 'LINE', name: 'Road', polygonCoords: ring.slice(0, 2), widthM: 40 }).success).toBe(true)
    expect(createGeofenceSchema.safeParse({ type: 'LINE', name: 'Road', polygonCoords: ring.slice(0, 2) }).success).toBe(false)
  })
})

describe('updateGeofenceSchema', () => {
  it('lets purpose and colour be cleared', () => {
    expect(updateGeofenceSchema.parse({ purpose: null, color: null })).toEqual({ purpose: null, color: null })
  })
  it('wants the whole shape with its type', () => {
    expect(updateGeofenceSchema.safeParse({ radiusM: 50 }).success).toBe(false)
    expect(updateGeofenceSchema.safeParse({ type: 'CIRCLE', radiusM: 50 }).success).toBe(false)
    expect(updateGeofenceSchema.safeParse({ type: 'CIRCLE', radiusM: 50, centerLat: 0.3, centerLng: 34.7 }).success).toBe(true)
    expect(updateGeofenceSchema.safeParse({ type: 'POLYGON', polygonCoords: ring.slice(0, 2) }).success).toBe(false)
  })
})

describe('categoryOf', () => {
  it('takes the chosen purpose over the name', () => {
    expect(categoryOf({ name: 'Main gate', purpose: 'restricted' })).toBe('restricted')
    expect(categoryOf({ name: 'Main gate', purpose: null })).toBe('gate')
    expect(categoryOf({ name: 'Main gate', purpose: 'nonsense' })).toBe('gate')
  })
})

describe('a geofence rule on the API', () => {
  it('takes a rule on create, filling what was left out', () => {
    const r = createGeofenceSchema.parse({
      type: 'LINE', name: 'No-go road', polygonCoords: ring.slice(0, 2), widthM: 40, purpose: 'restricted',
      rule: { vehicleTypes: ['TANKER'] },
    })
    expect(r.rule).toEqual({
      trigger: 'enter', vehicleTypes: ['TANKER'], fleets: [], vehicleIds: [], units: [], hours: null,
      alert: { type: 'nogo', severity: 'critical' },
    })
  })
  it('clears a rule with null on a change, and refuses a bad one', () => {
    expect(updateGeofenceSchema.parse({ rule: null }).rule).toBeNull()
    expect(updateGeofenceSchema.safeParse({ rule: { trigger: 'leave' } }).success).toBe(false)
    expect(updateGeofenceSchema.safeParse({ rule: { alert: { type: 'parking' } } }).success).toBe(false)
  })
})
