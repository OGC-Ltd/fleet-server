/**
 * The scales, and what each one last did.
 *
 * What these pin is the argument the service makes: a WEIGHING is the unit, not
 * a ticket, because one ticket is two crossings that can land on two different
 * scales. Get that wrong and a bridge that has taken nothing but tares reads as
 * idle, or one centre's newest ticket appears on both of its pins and claims
 * work a scale never did.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')

import { prismaMock } from '../helpers/prisma.mock.js'
import { getWeighbridges } from '../../src/modules/weighments/weighbridge.service.js'
import { WEIGHBRIDGES, bridgeOf } from '../../src/modules/weighments/weighbridge.geography.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

let token = 1_000_000_000

/** A ticket, with only what a test cares about spelled out. */
const ticket = (over: Record<string, unknown> = {}) => ({
  tokenNumber:   BigInt(token++),
  category:      'CANE_DELIVERY',
  tokenAt:       new Date('2026-09-11T06:00:00Z'),
  vehicleNo:     'KTCC 849B',
  vehiclePlate:  'KTCC849B',
  vehicleId:     null,
  driverName:    'TAISHON OTIENO OBONYO',
  grossWeightKg: 12180, grossAt: new Date('2026-09-11T08:38:00Z'),
  grossOperator: 'WBF',  grossBridgeNo: 1,
  tareWeightKg:  6020,   tareAt: new Date('2026-09-11T00:49:00Z'),
  tareOperator:  'WBT',  tareBridgeNo: 1,
  netWeightKg:   6160,   productName: null,
  factoryGrossAt: null, factoryGrossOperator: null, factoryGrossBridgeNo: null,
  factoryTareAt:  null, factoryTareOperator:  null, factoryTareBridgeNo:  null,
  ...over,
})

const of = (out: Awaited<ReturnType<typeof getWeighbridges>>, bridgeNo: number) =>
  out.find(b => b.bridgeNo === bridgeNo)!

beforeEach(() => {
  ;(prismaMock.weighment.findMany as any).mockResolvedValue([])
})

describe('weighbridge geography', () => {
  it('numbers scales globally, not per centre', () => {
    // 1 and 2 are Factory's; 3 Opapo's; 4 and 8 Oyani's; 5 Nyaondo's. A bridge
    // number is unique on its own, which is what lets the service key on it.
    const nos = WEIGHBRIDGES.map(b => b.bridgeNo)
    expect(new Set(nos).size).toBe(nos.length)
    expect(bridgeOf(1)!.centerName).toBe('FACTORY')
    expect(bridgeOf(8)!.centerName).toBe('OYANI')
    // 6 and 7 have never appeared in the feed and are deliberately absent.
    expect(bridgeOf(7)).toBeNull()
    expect(bridgeOf(null)).toBeNull()
  })

  it("places every scale in Sukari's own corner of the country", () => {
    // A sign slip on latitude would put these 180 km away and still look like a
    // coordinate. The fleet's own fixes sit at about -0.82 / 34.38.
    for (const b of WEIGHBRIDGES) {
      expect(b.lat).toBeGreaterThan(-1.2)
      expect(b.lat).toBeLessThan(-0.5)
      expect(b.lng).toBeGreaterThan(34.2)
      expect(b.lng).toBeLessThan(34.8)
    }
  })
})

describe('getWeighbridges', () => {
  it('returns every known scale, even one that has weighed nothing', () => {
    // A marker that vanishes on a quiet month is a map that looks broken. The
    // pin stays; `last` is null and the page says so.
    return getWeighbridges('org_1').then((out) => {
      expect(out).toHaveLength(WEIGHBRIDGES.length)
      expect(out.every(b => b.last === null)).toBe(true)
    })
  })

  it("keeps each centre's scales apart", async () => {
    // Factory runs two. A ticket on bridge 1 must not appear on bridge 2.
    ;(prismaMock.weighment.findMany as any).mockResolvedValue([
      ticket({ grossBridgeNo: 1, tareBridgeNo: 1, vehicleNo: 'ON ONE' }),
    ])
    const out = await getWeighbridges('org_1')
    expect(of(out, 1).last!.vehicleNo).toBe('ON ONE')
    expect(of(out, 2).last).toBeNull()
  })

  it('counts a tare as a weighing, so a scale that only weighs empties is not idle', async () => {
    // Reading gross alone would leave bridge 3 blank here.
    ;(prismaMock.weighment.findMany as any).mockResolvedValue([
      ticket({ grossBridgeNo: 1, tareBridgeNo: 3 }),
    ])
    const out = await getWeighbridges('org_1')
    expect(of(out, 3).last!.stage).toBe('tare')
    expect(of(out, 1).last!.stage).toBe('gross')
  })

  it('takes the newest weighing per scale across tickets', async () => {
    ;(prismaMock.weighment.findMany as any).mockResolvedValue([
      ticket({ vehicleNo: 'NEWER', grossBridgeNo: 5, tareBridgeNo: null,
               grossAt: new Date('2026-09-11T10:00:00Z') }),
      ticket({ vehicleNo: 'OLDER', grossBridgeNo: 5, tareBridgeNo: null,
               grossAt: new Date('2026-09-10T10:00:00Z') }),
    ])
    const out = await getWeighbridges('org_1')
    expect(of(out, 5).last!.vehicleNo).toBe('NEWER')
  })

  it('prefers the newest CROSSING, not the newest ticket', async () => {
    // The newer ticket's stamp on this scale is older than the older ticket's.
    // Keying on tokenAt would show the wrong one.
    ;(prismaMock.weighment.findMany as any).mockResolvedValue([
      ticket({ vehicleNo: 'NEW TICKET', tokenAt: new Date('2026-09-11T12:00:00Z'),
               grossBridgeNo: 4, grossAt: new Date('2026-09-11T01:00:00Z'), tareBridgeNo: null }),
      ticket({ vehicleNo: 'OLD TICKET', tokenAt: new Date('2026-09-10T12:00:00Z'),
               grossBridgeNo: 4, grossAt: new Date('2026-09-11T09:00:00Z'), tareBridgeNo: null }),
    ])
    const out = await getWeighbridges('org_1')
    expect(of(out, 4).last!.vehicleNo).toBe('OLD TICKET')
  })

  it("folds in a transfer's second weighing at the factory", async () => {
    // A CANE_TRANSFER is weighed at the outstation and again on arrival. That
    // second pair physically happened on the factory's scale.
    ;(prismaMock.weighment.findMany as any).mockResolvedValue([
      ticket({
        category: 'CANE_TRANSFER', vehicleNo: 'TRANSFER',
        grossBridgeNo: 3, grossAt: new Date('2026-09-11T06:00:00Z'), tareBridgeNo: null,
        factoryGrossBridgeNo: 2, factoryGrossAt: new Date('2026-09-11T09:00:00Z'),
        factoryGrossOperator: 'WBX',
      }),
    ])
    const out = await getWeighbridges('org_1')
    expect(of(out, 2).last!.atFactoryLeg).toBe(true)
    expect(of(out, 2).last!.category).toBe('CANE_TRANSFER')
    expect(of(out, 2).last!.operator).toBe('WBX')
    // And the outstation's own weighing still stands on its own scale.
    expect(of(out, 3).last!.atFactoryLeg).toBe(false)
  })

  it('omits a scale it cannot place rather than guessing a position', async () => {
    // Bridge 7 has no derived coordinate. A pin at an invented position is a
    // worse answer than a missing pin.
    ;(prismaMock.weighment.findMany as any).mockResolvedValue([
      ticket({ grossBridgeNo: 7, tareBridgeNo: 7 }),
    ])
    const out = await getWeighbridges('org_1')
    expect(out.some(b => b.bridgeNo === 7)).toBe(false)
    expect(out.every(b => b.last === null)).toBe(true)
  })

  it('carries the vehicle link only when the plate resolves to one we track', async () => {
    // Most of this traffic is contractors' lorries and farmers' tractors with
    // no tracker, so the map's "show me this unit" link has to be conditional.
    ;(prismaMock.weighment.findMany as any).mockResolvedValue([
      ticket({ grossBridgeNo: 1, tareBridgeNo: null, vehicleId: 'veh_7' }),
      ticket({ grossBridgeNo: 3, tareBridgeNo: null, vehicleId: null }),
    ])
    const out = await getWeighbridges('org_1')
    expect(of(out, 1).last!.vehicleId).toBe('veh_7')
    expect(of(out, 3).last!.vehicleId).toBeNull()
  })

  it('carries all three weights and the product, absent or not', async () => {
    ;(prismaMock.weighment.findMany as any).mockResolvedValue([
      ticket({ grossBridgeNo: 1, tareBridgeNo: null, productName: null }),
    ])
    const last = of(await getWeighbridges('org_1'), 1).last!
    expect(last.grossWeightKg).toBe(12180)
    expect(last.tareWeightKg).toBe(6020)
    expect(last.netWeightKg).toBe(6160)
    // Null on every delivery row observed upstream. The page renders the
    // absence; it must not be turned into a name here.
    expect(last.productName).toBeNull()
  })

  it('sends the token as a string, never as a number', async () => {
    // Ten digits and climbing. JSON numbers stop being exact before a bigint
    // does, and the page treats this as an identifier.
    ;(prismaMock.weighment.findMany as any).mockResolvedValue([
      ticket({ tokenNumber: BigInt('1234567890123'), grossBridgeNo: 1, tareBridgeNo: null }),
    ])
    expect(of(await getWeighbridges('org_1'), 1).last!.token).toBe('1234567890123')
  })
})
