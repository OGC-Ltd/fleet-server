/**
 * The Analytics filter's two selections, and the one list they resolve to.
 *
 * What these pin is not arithmetic — it is the set of answers that look alike
 * and mean opposite things. "Do not filter" is null; "you asked for something
 * this fleet has none of" is the empty array; and the difference between them
 * is a page showing the whole fleet against a page showing zeroes. Every case
 * below is one of those confusions, including the one that matters for access:
 * a vehicle id belonging to another organisation must narrow the answer to
 * nothing, never widen it to everything.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')

import { prismaMock } from '../helpers/prisma.mock.js'
import {
  parseCategories, parseVehicleIds, vehicleIdsFor, vehicleIdsForCategories,
  MAX_VEHICLE_SELECTION, windowCacheKey, parseWindowCacheKey,
  categoriesKey, vehiclesKey,
} from '../../src/modules/analytics/vehicle-filter.js'

/** KASULU's shape: plate-prefixed plant, and a unit with no prefix at all. */
const FLEET = [
  { id: 'v-ex-1',  registrationPlate: 'MUFINDI - EX 26' },
  { id: 'v-ex-2',  registrationPlate: 'MUFINDI - EX 31' },
  { id: 'v-ctr-1', registrationPlate: 'MUFINDI - CTR 04' },
  { id: 'v-bare',  registrationPlate: 'MUFINDI: 013' },
]

beforeEach(() => {
  vi.clearAllMocks()
  prismaMock.vehicle.findMany.mockResolvedValue(FLEET as never)
})

describe('parseVehicleIds', () => {
  it('reads a comma-separated selection', () => {
    expect(parseVehicleIds('v-ex-1,v-ctr-1')).toEqual(['v-ex-1', 'v-ctr-1'])
  })

  it('treats absent and empty as the whole fleet, not as an empty selection', () => {
    // The difference the whole module turns on: null means "do not filter".
    expect(parseVehicleIds(undefined)).toBeNull()
    expect(parseVehicleIds(null)).toBeNull()
    expect(parseVehicleIds('')).toBeNull()
    expect(parseVehicleIds(' , , ')).toBeNull()
  })

  it('keeps one copy of a unit named twice', () => {
    expect(parseVehicleIds('v-ex-1,v-ex-1')).toEqual(['v-ex-1'])
  })

  it('refuses to carry an unbounded list', () => {
    // Every id lands in a cache key and a query parameter. The ceiling is
    // above any real fleet here, so nothing legitimate is ever cut.
    const many = Array.from({ length: MAX_VEHICLE_SELECTION + 50 }, (_, i) => `v${i}`)
    expect(parseVehicleIds(many.join(','))?.length).toBe(MAX_VEHICLE_SELECTION)
  })
})

describe('vehicleIdsFor', () => {
  it('does not filter when neither selection is made', async () => {
    expect(await vehicleIdsFor('org', null, null)).toBeNull()
    expect(prismaMock.vehicle.findMany).not.toHaveBeenCalled()
  })

  it('resolves a type selection to its units', async () => {
    expect(await vehicleIdsFor('org', ['EX'], null)).toEqual(['v-ex-1', 'v-ex-2'])
  })

  it('resolves a unit selection to exactly those units', async () => {
    expect(await vehicleIdsFor('org', null, ['v-ctr-1'])).toEqual(['v-ctr-1'])
  })

  it('intersects the two rather than adding them', async () => {
    // "The units you picked, among the types you left ticked." Union would make
    // ticking a type WIDEN a one-unit answer, which is not what a filter does.
    expect(await vehicleIdsFor('org', ['EX'], ['v-ex-1', 'v-ctr-1'])).toEqual(['v-ex-1'])
  })

  it('answers an impossible pairing with nothing, not with everything', async () => {
    expect(await vehicleIdsFor('org', ['CTR'], ['v-ex-1'])).toEqual([])
  })

  /**
   * The access case. An id from another organisation is not rejected with an
   * error — it simply is not in the fleet this reads, so it falls out of the
   * intersection. What must never happen is the refused selection resolving to
   * null, which every aggregate reads as "the whole fleet".
   */
  it('drops an id this organisation does not own', async () => {
    expect(await vehicleIdsFor('org', null, ['v-ex-1', 'someone-elses-lorry']))
      .toEqual(['v-ex-1'])
  })

  it('resolves a selection of only foreign ids to the empty set', async () => {
    const out = await vehicleIdsFor('org', null, ['someone-elses-lorry'])
    expect(out).toEqual([])
    expect(out).not.toBeNull()
  })

  it('reaches the units whose plates carry no prefix', async () => {
    expect(await vehicleIdsForCategories('org', ['__unprefixed'])).toEqual(['v-bare'])
  })

  it('reads the organisation and only its active units', async () => {
    await vehicleIdsFor('org', null, ['v-ex-1'])
    expect(prismaMock.vehicle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organisationId: 'org', isActive: true } }),
    )
  })
})

describe('cache keys', () => {
  it('round-trips both selections', () => {
    const key = windowCacheKey('org', 30, undefined, ['EX'], ['v-ex-1', 'v-ex-2'])
    expect(parseWindowCacheKey(key)).toEqual({
      orgId: 'org', days: 30, to: undefined,
      categories: ['EX'], vehicles: ['v-ex-1', 'v-ex-2'],
    })
  })

  it('gives the same selection one entry however it was clicked', () => {
    expect(windowCacheKey('org', 7, undefined, ['CTR', 'EX'], ['b', 'a']))
      .toBe(windowCacheKey('org', 7, undefined, ['EX', 'CTR'], ['a', 'b']))
  })

  it('keeps the unfiltered key the one the warmer builds', () => {
    // The whole-fleet key is the one every visitor loads and the one the
    // background sweep holds. A unit selection must extend the key space, not
    // move the entry everyone already shares.
    expect(windowCacheKey('org', 7, undefined, null)).toBe('org|7|now|all|all')
    expect(categoriesKey(null)).toBe('all')
    expect(vehiclesKey(null)).toBe('all')
    expect(vehiclesKey([])).toBe('all')
  })

  it('reads a key written before the unit selection existed', () => {
    // Four parts, from a process that predates this. It must parse as "no unit
    // selection" rather than as a selection of nothing.
    expect(parseWindowCacheKey('org|7|now|EX').vehicles).toBeNull()
  })

  it('still tells the two kinds of nothing apart on the type side', () => {
    expect(parseCategories('')).toBeNull()
    expect(parseWindowCacheKey('org|7|now|all|all').categories).toBeNull()
  })
})
