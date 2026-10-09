import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/lib/prisma.js', () => ({ prisma: { geofence: { findMany: vi.fn(async () => []) } } }))
import {
  cleanName, loadSitePlans, nameBySite, spotAt, spotName,
} from '../../src/modules/usage-review/usage-review.siteplans.js'
import { classifyPlaces, STATIC_SITES, type Site } from '../../src/modules/usage-review/usage-review.areas.js'
import type { ReviewPlace, ReviewStop } from '../../src/modules/usage-review/usage-review.compute.js'

// The real surveys, as the server ships them (assets/site-plans).
const plans = loadSitePlans()

const place = (id: number, lat: number, lng: number, extra: Partial<ReviewPlace> = {}): ReviewPlace => ({
  id, lat, lng, hours: 1, visits: 1, days: 1, share: 0, firstSeen: 0, lastSeen: 0,
  name: `Somewhere ${id}`, area: null, county: null, country: null, address: null, ...extra,
})
let sid = 0
const stopAt = (p: ReviewPlace, lat: number, lng: number, hours: number): ReviewStop => ({
  id: ++sid, start: 0, end: hours * 3_600_000, min: hours * 60, lat, lng, place: p.id, overnight: false,
})

const RAIPLY = { lat: 0.535239, lng: 35.251126 }        // inside the fence, away from the gate
const KABRAS_GARAGE = { lat: 0.3773819, lng: 34.8386176 }
const OUTSIDE = { lat: 0.61397, lng: 34.77047 }         // Webuye town, no site

describe('usage-review site plans', () => {
  it('reads every survey shipped with the server', () => {
    expect(plans.length).toBeGreaterThanOrEqual(9)
    expect(plans.map(p => p.name)).toContain('Raiply')
  })

  // The operator's example: inside Raiply is Raiply, not the nearest shop.
  it('names a stop inside a site fence after the site', () => {
    expect(spotAt(RAIPLY.lat, RAIPLY.lng, plans)).toEqual({ site: 'Raiply', area: null, from: 'site-plan' })
  })

  it('names the area within the site where the unit stood', () => {
    const s = spotAt(KABRAS_GARAGE.lat + 0.0001, KABRAS_GARAGE.lng, plans)   // ~11 m off the pin
    expect(s).toEqual({ site: 'Kabras', area: 'Garage', from: 'site-plan' })
    expect(spotName(s!)).toBe('Garage, Kabras')
  })

  it('counts a lorry waiting just outside a gate as at that gate', () => {
    // Raiply's gate pin sits on the fence line; 30 m south of it.
    expect(spotAt(0.5308616 - 0.00027, 35.2493936, plans)).toMatchObject({ site: 'Raiply', area: 'Gate' })
  })

  it('names a surveyed area with no fence round it', () => {
    expect(spotAt(-0.157055, 35.866932, plans)).toEqual({ site: 'Molo River', area: null, from: 'site-plan' })
  })

  it("falls back on the organisation's smallest geofence holding the point", () => {
    const fences: Site[] = [
      { name: 'Big Block', fence: { type: 'CIRCLE', centerLat: OUTSIDE.lat, centerLng: OUTSIDE.lng, radiusM: 2_000 } },
      { name: 'Yard 3', fence: { type: 'CIRCLE', centerLat: OUTSIDE.lat, centerLng: OUTSIDE.lng, radiusM: 200 } },
    ]
    expect(spotAt(OUTSIDE.lat, OUTSIDE.lng, plans, fences)).toEqual({ site: 'Yard 3', area: null, from: 'geofence' })
    expect(spotAt(OUTSIDE.lat, OUTSIDE.lng, plans)).toBe(null)
  })

  it('says the site once when the area already names it', () => {
    expect(spotName({ site: 'Nzoia Sugar', area: 'Nzoia Main Gate' })).toBe('Nzoia Main Gate')
    expect(spotName({ site: 'Raiply', area: 'Gate' })).toBe('Gate, Raiply')
    expect(spotName({ site: 'Raiply', area: null })).toBe('Raiply')
  })

  it('reads survey names as they should read', () => {
    expect(cleanName('Transport &amp; PWH')).toBe('Transport & PWH')
    expect(cleanName('MOLO RIVER 2')).toBe('Molo River 2')
    expect(cleanName('ETP Gate')).toBe('ETP Gate')
  })

  it('names a place by where most of its time was, and marks it work', () => {
    const atRaiply = place(1, RAIPLY.lat, RAIPLY.lng, { exactName: 'Some Shop', activity: 'Retail' })
    const mostlyOut = place(2, OUTSIDE.lat, OUTSIDE.lng)
    const stops = [
      stopAt(atRaiply, RAIPLY.lat, RAIPLY.lng, 3),
      stopAt(atRaiply, RAIPLY.lat + 0.004, RAIPLY.lng + 0.004, 1),     // ~600 m off, outside
      stopAt(mostlyOut, OUTSIDE.lat, OUTSIDE.lng, 3),
      stopAt(mostlyOut, RAIPLY.lat, RAIPLY.lng, 1),
    ]
    expect(nameBySite([atRaiply, mostlyOut], stops, plans)).toBe(1)
    expect(atRaiply).toMatchObject({ exactName: 'Raiply', site: 'Raiply', nameFrom: 'site-plan', activity: 'Work' })
    expect(mostlyOut.nameFrom).toBeUndefined()

    const { byPlace } = classifyPlaces([atRaiply, mostlyOut], stops, { from: '2026-09-01', to: '2026-09-01' }, STATIC_SITES)
    expect(byPlace.get(1)).toMatchObject({ kind: 'work', site: 'Raiply' })
  })

  it('takes the named area that held most of the time inside a site', () => {
    const p = place(1, KABRAS_GARAGE.lat, KABRAS_GARAGE.lng)
    const stops = [
      stopAt(p, KABRAS_GARAGE.lat, KABRAS_GARAGE.lng, 4),
      stopAt(p, 0.3778521, 34.8388042, 1),                              // Scrap Yard
    ]
    nameBySite([p], stops, plans)
    expect(p.exactName).toBe('Garage, Kabras')
  })
})
