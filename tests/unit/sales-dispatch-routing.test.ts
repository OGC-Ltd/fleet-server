/**
 * A sales run reaches the feed of the unit's OWNER, not the factory's operator.
 *
 * Naitiri is a West Kenya Sugar factory, so `NAITIRI → WESTSUGAR` was used to
 * route every event the site produced. Menengai trucks load there. Measured on
 * 2026-09-09, the provider's own `/vehicles` registry lists KCP 134P — a
 * Menengai unit — as `factoryCode: NAITIRI`, and of its 625 vehicles 624 are
 * NDHIWA and that one is NAITIRI. So the provider cannot be asked who owns the
 * truck: it does not model Menengai at all, and the enrichment call that looks
 * like the obvious fix returns the same wrong answer the factory code does.
 *
 * Only our own `vehicles` table knows, and these pin that it is what decides.
 *
 * The second group covers the narration rule, which differs from a cane
 * dispatch's on purpose: a sales row mutates (sales office raises it, guard
 * signs it out, guard signs it back in) and the same id is delivered for each
 * moment, so "narrate on first sight" would announce the departure and then
 * lose the return.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/event-bus.js', () => ({ eventBus: { publish: vi.fn() } }))

import { prismaMock } from '../helpers/prisma.mock.js'
import { eventBus } from '../../src/lib/event-bus.js'
import { handleSale, bagsFromTonnes } from '../../src/modules/webhooks/raifactorysuite-events.service.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A real row off GET /sales?factoryCode=NAITIRI, read 2026-09-09. */
const sale = (over: Record<string, unknown> = {}) => ({
  id:                 '4eebde3e-cb58-403b-8f35-926a603e318e',
  factoryCode:        'NAITIRI',
  vehicleNumberPlate: 'KCP 134P',
  driverName:         'Duncan Mwangi',
  tonnage:            29.0,
  destination:        'Raiply',
  status:             'RETURNED',
  // Offsetless EAT, exactly as the provider sends it.
  signOutTime:        '2026-09-09T09:58:18.775629',
  signOutPhotoUrl:    null,
  returnTime:         null,
  returnPhotoUrl:     null,
  ...over,
}) as Parameters<typeof handleSale>[0]

const published = () =>
  (eventBus.publish as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls

/** KCP 134P as our registry holds it: a MENENGAI truck. */
const MENENGAI_TRUCK = {
  id: 'veh_kcp134p', organisationId: 'org_menengai', registrationPlate: 'KCP 134P',
}

beforeEach(() => {
  vi.mocked(eventBus.publish).mockClear()
  // WESTSUGAR — the factory's operator, and the org this used to route to.
  ;(prismaMock.organisation.findUnique as any).mockResolvedValue({ id: 'org_westsugar' })
  ;(prismaMock.vehicle.findFirst as any).mockResolvedValue(MENENGAI_TRUCK)
  ;(prismaMock.dispatch.findUnique as any).mockResolvedValue(null)
  ;(prismaMock.dispatch.upsert as any).mockResolvedValue({})
  ;(prismaMock.user.findMany as any).mockResolvedValue([])
})

describe('sales run routing', () => {
  it('routes a Menengai unit at Naitiri to MENENGAI, not WESTSUGAR', async () => {
    const ok = await handleSale(sale())
    expect(ok).toBe(true)

    expect(published()).toHaveLength(1)
    expect(published()[0]![1]['orgId']).toBe('org_menengai')
  })

  it('stores the run against the owner too, not just the feed line', async () => {
    await handleSale(sale())

    const written = (prismaMock.dispatch.upsert as any).mock.calls[0][0].create
    expect(written.organisationId).toBe('org_menengai')
    expect(written.vehicleId).toBe('veh_kcp134p')
    expect(written.kind).toBe('SALES')
  })

  it('falls back to the factory operator for a unit we do not hold', async () => {
    // No row in our registry, and none once punctuation is ignored either.
    ;(prismaMock.vehicle.findFirst as any).mockResolvedValue(null)

    await handleSale(sale())

    expect(published()[0]![1]['orgId']).toBe('org_westsugar')
    expect((prismaMock.dispatch.upsert as any).mock.calls[0][0].create.vehicleId).toBeNull()
  })

  it('matches the plate even when the provider omits the space', async () => {
    // The written form is what we store ("KCP 134P"); the provider is not
    // consistent about it. A miss here falls through to the factory and
    // silently reinstates the misrouting for exactly the units this exists for.
    ;(prismaMock.vehicle.findFirst as any).mockResolvedValue(null)
    ;(prismaMock.$queryRaw as any).mockResolvedValue([MENENGAI_TRUCK])

    await handleSale(sale({ vehicleNumberPlate: 'KCP134P' }))

    expect(published()[0]![1]['orgId']).toBe('org_menengai')
    // Stored in the WRITTEN form regardless of how it arrived, so every
    // downstream lookup on `plate` matches.
    expect((prismaMock.dispatch.upsert as any).mock.calls[0][0].create.plate).toBe('KCP 134P')
  })

  it('refuses to route by plate when two vehicles collide on punctuation', async () => {
    // Three West Sugar machines share a registration with Sukari plant (see
    // prisma/fix-plate-format.ts). Which org owns a loader is not a question a
    // tie-break gets to answer, so it falls back to the factory.
    ;(prismaMock.vehicle.findFirst as any).mockResolvedValue(null)
    ;(prismaMock.$queryRaw as any).mockResolvedValue([
      MENENGAI_TRUCK,
      { id: 'veh_other', organisationId: 'org_sukari', registrationPlate: 'KCP-134P' },
    ])

    await handleSale(sale({ vehicleNumberPlate: 'KCP134P' }))

    expect(published()[0]![1]['orgId']).toBe('org_westsugar')
  })
})

describe('sales run narration', () => {
  it('names the load in bags at the factory it left', async () => {
    await handleSale(sale())

    expect(published()[0]![1]['text']).toBe(
      'KCP 134P · Duncan Mwangi signed out at Naitiri with 29.0t (580 × 50 kg bags) bound for Raiply — left the premises.',
    )
    expect(published()[0]![1]['alertType']).toBe('SALE_DISPATCH')
  })

  it('narrates the departure once, however many times the run is re-offered', async () => {
    // The reconciler re-reads the whole window every cycle and `/sales` ignores
    // its own `status` filter, so there is no way to ask for only what changed.
    ;(prismaMock.dispatch.findUnique as any).mockResolvedValue({ id: 'd1', actualReturnAt: null })

    await handleSale(sale())

    expect(eventBus.publish).not.toHaveBeenCalled()
  })

  it('narrates the return when the guard signs the unit back in', async () => {
    // Already held, open. This delivery adds the return.
    ;(prismaMock.dispatch.findUnique as any).mockResolvedValue({ id: 'd1', actualReturnAt: null })

    await handleSale(sale({ returnTime: '2026-09-09T10:30:26.796874' }))

    expect(published()).toHaveLength(1)
    expect(published()[0]![1]['alertType']).toBe('SALE_RETURN')
    expect(published()[0]![1]['text']).toBe(
      'KCP 134P · Duncan Mwangi signed back in at Naitiri — sales run bound for Raiply complete.',
    )
  })

  it('does not narrate the return twice', async () => {
    ;(prismaMock.dispatch.findUnique as any).mockResolvedValue({
      id: 'd1', actualReturnAt: new Date('2026-09-09T07:30:26.796Z'),
    })

    await handleSale(sale({ returnTime: '2026-09-09T10:30:26.796874' }))

    expect(eventBus.publish).not.toHaveBeenCalled()
  })

  it('says both when a run arrives already closed', async () => {
    // The reconciler's first sight of a run that opened and closed between two
    // passes. Both moments are news; neither has been told.
    await handleSale(sale({ returnTime: '2026-09-09T10:30:26.796874' }))

    expect(published().map(c => c[1]['alertType'])).toEqual(['SALE_DISPATCH', 'SALE_RETURN'])
  })

  it('stores nothing before the guard signs the unit out', async () => {
    // dispatched_at means "when did this unit go". Inventing one would put a
    // truck on the map that is standing in the yard.
    const ok = await handleSale(sale({ signOutTime: null, status: 'PENDING' }))

    expect(ok).toBe(false)
    expect(prismaMock.dispatch.upsert).not.toHaveBeenCalled()
    expect(eventBus.publish).not.toHaveBeenCalled()
  })

  it('omits the load phrase when the sale carries no tonnage', async () => {
    await handleSale(sale({ tonnage: null }))

    expect(published()[0]![1]['text']).toBe(
      'KCP 134P · Duncan Mwangi signed out at Naitiri bound for Raiply — left the premises.',
    )
  })

  it('honours the reconciler veto on its first pass', async () => {
    await handleSale(sale(), { narrate: false, source: 'reconciler' })

    expect(prismaMock.dispatch.upsert).toHaveBeenCalled()   // stored
    expect(eventBus.publish).not.toHaveBeenCalled()          // but silent
  })
})

describe('bagsFromTonnes', () => {
  it('counts 50 kg bags in a load', () => {
    expect(bagsFromTonnes(29.0)).toBe(580)
    expect(bagsFromTonnes(1)).toBe(20)
    expect(bagsFromTonnes(28.7)).toBe(574)
  })

  it('refuses a weight that is not one', () => {
    // A run whose tonnage has not been entered is not a run carrying nothing,
    // so these produce no bag count rather than "0 bags".
    expect(bagsFromTonnes(null)).toBeNull()
    expect(bagsFromTonnes(undefined)).toBeNull()
    expect(bagsFromTonnes(0)).toBeNull()
    expect(bagsFromTonnes(-5)).toBeNull()
    expect(bagsFromTonnes(Number.NaN)).toBeNull()
  })
})
