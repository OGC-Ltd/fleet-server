/**
 * The Alerts page's rules (alerts.rules, alerts.scope): who reads which
 * organisation's alerts, where an alert stands, which decisions it still
 * takes, and one page of results drawn from two tables.
 */

import { describe, it, expect } from 'vitest'
import {
  decodeCursor, encodeCursor, fuelChoices, fuelStatus, likeTerm, mergePage, speedingChoices, speedingStatus,
} from '../../src/modules/alerts/alerts.rules.js'
import { alertScopes } from '../../src/modules/alerts/alerts.scope.js'
import type { Subject } from '../../src/lib/authz/subject.js'

const subject = (
  orgs: Record<string, { perms: string[]; vehicles?: string[] | null }>,
  isPlatform = false,
  platformPermissions: string[] = [],
): Subject => ({
  userId: 'u1',
  isPlatform,
  platformPermissions: new Set(platformPermissions),
  orgs: new Map(Object.entries(orgs).map(([id, g]) => [id, {
    permissions: new Set(g.perms),
    vehicleIds: g.vehicles == null ? null : new Set(g.vehicles),
  }])),
})

describe('alertScopes', () => {
  it('reads each kind only where its permission is held', () => {
    const s = subject({
      a: { perms: ['fuel_theft:read', 'analytics:read'] },
      b: { perms: ['fuel_theft:read'] },
      c: { perms: ['analytics:read'] },
    })
    expect(alertScopes(s, ['a', 'b', 'c'])).toEqual([
      { orgId: 'a', vehicleIds: null, kinds: ['fuel', 'speeding'] },
      { orgId: 'b', vehicleIds: null, kinds: ['fuel'] },
      { orgId: 'c', vehicleIds: null, kinds: ['speeding'] },
    ])
  })

  it('drops an organisation with neither permission, or one the subject is not in', () => {
    const s = subject({ a: { perms: ['map:read'] }, b: { perms: ['fuel_theft:read'] } })
    expect(alertScopes(s, ['a', 'b', 'elsewhere']).map((x) => x.orgId)).toEqual(['b'])
  })

  it('narrows to a scoped membership, and never widens an empty one', () => {
    const s = subject({
      a: { perms: ['fuel_theft:read'], vehicles: ['v1'] },
      b: { perms: ['fuel_theft:read'], vehicles: [] },
    })
    expect(alertScopes(s, ['a', 'b'])).toEqual([{ orgId: 'a', vehicleIds: ['v1'], kinds: ['fuel'] }])
  })

  it('lets a platform role read every organisation unscoped', () => {
    const s = subject({}, true, ['platform:admin'])
    expect(alertScopes(s, ['a', 'b'])).toEqual([
      { orgId: 'a', vehicleIds: null, kinds: ['fuel', 'speeding'] },
      { orgId: 'b', vehicleIds: null, kinds: ['fuel', 'speeding'] },
    ])
  })
})

describe('where an alert stands', () => {
  it('reads fuel review states as open, escalated or de-escalated', () => {
    expect(fuelStatus(null)).toBe('open')
    // Off the map without a decision: still open on the page.
    expect(fuelStatus('DISMISSED')).toBe('open')
    expect(fuelStatus('UNDER_REVIEW')).toBe('open')
    expect(fuelStatus('CONFIRMED_THEFT')).toBe('escalated')
    expect(fuelStatus('PROBE_FAULT')).toBe('escalated')
    expect(fuelStatus('NOT_THEFT')).toBe('deescalated')
  })

  it('reads speeding decisions', () => {
    expect(speedingStatus(null)).toBe('open')
    expect(speedingStatus('ESCALATED')).toBe('escalated')
    expect(speedingStatus('DEESCALATED')).toBe('deescalated')
  })
})

describe('the decisions still open', () => {
  it('offers every fuel decision on an undecided alert, and the other two once decided', () => {
    expect(fuelChoices({ reviewStatus: null })).toEqual(['theft', 'probe_fault', 'not_theft'])
    expect(fuelChoices({ reviewStatus: 'DISMISSED' })).toEqual(['theft', 'probe_fault', 'not_theft'])
    expect(fuelChoices({ reviewStatus: 'CONFIRMED_THEFT' })).toEqual(['probe_fault', 'not_theft'])
    expect(fuelChoices({ reviewStatus: 'NOT_THEFT' })).toEqual(['theft', 'probe_fault'])
  })

  it('leaves a faulty-probe case to Fuel Audit, and a closed case alone', () => {
    expect(fuelChoices({ reviewStatus: 'PROBE_FAULT', followUpStatus: 'PROBE_FAULT' })).toEqual([])
    expect(fuelChoices({ reviewStatus: 'CONFIRMED_THEFT', followUpStatus: 'ESCALATED' })).toEqual([])
  })

  it('decides a case still waiting from the days of Delete as a theft or not', () => {
    expect(fuelChoices({ reviewStatus: 'DISMISSED', followUpStatus: 'OPEN' })).toEqual(['theft', 'not_theft'])
    expect(fuelChoices({ reviewStatus: 'UNDER_REVIEW', followUpStatus: 'ACCEPTED' })).toEqual(['theft', 'not_theft'])
  })

  it('offers both speeding decisions until one is made, then the other', () => {
    expect(speedingChoices(null)).toEqual(['ESCALATED', 'DEESCALATED'])
    expect(speedingChoices('ESCALATED')).toEqual(['DEESCALATED'])
    expect(speedingChoices('DEESCALATED')).toEqual(['ESCALATED'])
  })
})

describe('one page from two tables', () => {
  const at = (iso: string) => new Date(iso)

  it('round-trips a cursor and refuses a malformed one', () => {
    const c = { at: at('2026-10-12T08:00:00.123Z'), id: 'cmabc123' }
    expect(decodeCursor(encodeCursor(c))).toEqual(c)
    expect(decodeCursor('nonsense')).toBeNull()
    expect(decodeCursor('12.')).toBeNull()
    expect(decodeCursor("12.a'; drop")).toBeNull()
    expect(decodeCursor(undefined)).toBeNull()
  })

  it('merges newest first, ties by id in byte order, and pages from the last row taken', () => {
    const fuel = [
      { id: 'f2', at: at('2026-10-12T10:00:00Z') },
      { id: 'b1', at: at('2026-10-12T08:00:00Z') },
    ]
    const speeding = [
      { id: 's9', at: at('2026-10-12T09:00:00Z') },
      { id: 'c1', at: at('2026-10-12T08:00:00Z') },
    ]
    const page = mergePage([fuel, speeding], 3)
    expect(page.rows.map((r) => r.id)).toEqual(['f2', 's9', 'c1'])
    expect(page.hasNextPage).toBe(true)
    expect(page.cursor).toBe(`${at('2026-10-12T08:00:00Z').getTime()}.c1`)
  })

  it('says there is no next page when everything fits', () => {
    const page = mergePage([[{ id: 'a', at: at('2026-10-12T08:00:00Z') }], []], 50)
    expect(page).toMatchObject({ hasNextPage: false, cursor: null })
  })

  it('searches for % and _ literally', () => {
    expect(likeTerm('KD_5%')).toBe('%KD\\_5\\%%')
  })
})
