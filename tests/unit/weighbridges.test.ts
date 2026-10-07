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
    const nos = WEIGHBRIDGES.map(b => b.bridgeNo).filter(n => n != null)
    expect(new Set(nos).size).toBe(nos.length)
    expect(bridgeOf(1)!.centerName).toBe('FACTORY')
    expect(bridgeOf(8)!.centerName).toBe('OYANI')
    // 6 and 7 have never appeared in the feed and are deliberately absent.
    expect(bridgeOf(7)).toBeNull()
    expect(bridgeOf(null)).toBeNull()
  })

  it('keeps unnumbered scales out of the provider numbering', () => {
    // Kabras' two were measured from traffic, not read off a ticket, and
    // nothing numbers them. If one ever got a number to make it look like the
    // others, it would answer to a number that is already one of Sukari's —
    // and `bridgeOf` would hand a ticket the wrong yard.
    const unnumbered = WEIGHBRIDGES.filter(b => b.bridgeNo == null)
    expect(unnumbered.length).toBeGreaterThan(0)
    for (const b of unnumbered) {
      // A site code, when it has one, is West Kenya's (factory base 1000+),
      // never one of Ndhiwa's 101-104 that a Sukari ticket could match.
      if (b.centerCode != null) expect(b.centerCode).toBeGreaterThan(1000)
      expect(b.label).not.toMatch(/Bridge/)
      expect(WEIGHBRIDGES.filter(x => x.key === b.key)).toHaveLength(1)
    }
  })

  it('gives every scale a key of its own', () => {
    // The marker's identity. It used to be the bridge number, which stopped
    // working the moment a scale without one could be drawn.
    const keys = WEIGHBRIDGES.map(b => b.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("places Sukari's scales in Sukari's own corner of the country", () => {
    // A sign slip on latitude would put these 180 km away and still look like a
    // coordinate. The fleet's own fixes sit at about -0.82 / 34.38.
    for (const b of WEIGHBRIDGES.filter(b => b.orgCode === 'SUKARI')) {
      expect(b.lat).toBeGreaterThan(-1.2)
      expect(b.lat).toBeLessThan(-0.5)
      expect(b.lng).toBeGreaterThan(34.2)
      expect(b.lng).toBeLessThan(34.8)
    }
  })

  it('places the Kabras scales inside the Kabras site fence', () => {
    // The site plan the dashboard draws spans 0.3761-0.3846 N, 34.8266-34.8400
    // E. A scale outside it is not a scale at this mill, whatever produced the
    // number — and these came from a clustering pass, which is exactly the kind
    // of derivation that can land somewhere plausible and wrong.
    const kabras = WEIGHBRIDGES.filter(b => b.centerName === 'KABRAS')
    expect(kabras).toHaveLength(2)
    for (const b of kabras) {
      expect(b.lat).toBeGreaterThan(0.376144)
      expect(b.lat).toBeLessThan(0.384550)
      expect(b.lng).toBeGreaterThan(34.826559)
      expect(b.lng).toBeLessThan(34.840029)
    }
  })
})

describe("Kabras' and Nzoia's yards", () => {
  it('sit in West Kenya cane country, not on a factory they were confused with', () => {
    // Western Kenya, Bungoma to Kitale: 0.3-1.2 N, 34.4-35.1 E. And no yard on
    // top of another site, which is how the rejected Magut/Khalaba/Makhese
    // derivations failed.
    const west = WEIGHBRIDGES.filter(b => b.orgCode === 'KABRAS' || b.orgCode === 'NZOIA')
    expect(west.length).toBeGreaterThan(0)
    for (const b of west) {
      expect(b.lat).toBeGreaterThan(0.3); expect(b.lat).toBeLessThan(1.2)
      expect(b.lng).toBeGreaterThan(34.4); expect(b.lng).toBeLessThan(35.1)
    }
    const sites = [...new Map(west.map(b => [b.centerCode, b])).values()]
    for (const a of sites) for (const b of sites) {
      if (a === b) continue
      const km = Math.hypot(a.lat - b.lat, (a.lng - b.lng) * Math.cos(a.lat * Math.PI / 180)) * 111
      expect(km).toBeGreaterThan(2)
    }
  })
})

describe('the split out of West Kenya (2026-10-07)', () => {
  it("gives each mill its own feed's sites and leaves West Kenya none", () => {
    expect(WEIGHBRIDGES.filter(b => b.orgCode === 'WESTSUGAR')).toHaveLength(0)
    for (const b of WEIGHBRIDGES.filter(b => (b.centerCode ?? 0) >= 1000 && (b.centerCode ?? 0) < 2000)) expect(b.orgCode).toBe('KABRAS')
    for (const b of WEIGHBRIDGES.filter(b => (b.centerCode ?? 0) >= 2000 && (b.centerCode ?? 0) < 3000)) expect(b.orgCode).toBe('NZOIA')
  })
})

describe("Nzoia's bridges", () => {
  it('are the two the operator gave, at the factory yard site', () => {
    const nz = WEIGHBRIDGES.filter(b => b.centerCode === 2101)
    expect(nz.map(b => b.label).sort()).toEqual(['CW bridge', 'HD bridge'])
    const cw = nz.find(b => b.label === 'CW bridge')!
    // As the operator corrected it, 2026-09-26
    expect(cw.lat).toBeCloseTo(0.5700258, 7)
    expect(cw.lng).toBeCloseTo(34.6544478, 7)
    const hd = nz.find(b => b.label === 'HD bridge')!
    expect(hd.lat).toBeCloseTo(0.5671175, 7)
    expect(hd.lng).toBeCloseTo(34.6562756, 7)
  })
})

describe("Naitiri's bridge", () => {
  it('is where the operator gave it', () => {
    const nt = WEIGHBRIDGES.filter(b => b.centerCode === 1107)
    expect(nt).toHaveLength(1)
    expect(nt[0].lat).toBeCloseTo(0.7813181, 7)
    expect(nt[0].lng).toBeCloseTo(34.8778280, 7)
  })
})

describe('getWeighbridges', () => {
  it('gives an organisation the scales that will never send a ticket', async () => {
    // Kabras' two report to nobody, so no amount of reading the ticket feed
    // finds them. They are claimed by the org named on them and arrive with
    // `last` null permanently — which is the truthful answer, not a gap.
    ;(prismaMock.organisation.findUnique as any).mockResolvedValue({ code: 'KABRAS' })
    const out = await getWeighbridges('org_kabras')
    expect(out.filter(b => b.centerName === 'KABRAS').map(b => b.label).sort()).toEqual(['East scale', 'West scale'])
    expect(out.every(b => b.last === null)).toBe(true)
    expect(out.every(b => b.bridgeNo === null)).toBe(true)
    // And not one of Sukari's, which have tickets and are a county away.
    expect(out.every(b => b.lat > 0)).toBe(true)
  })

  it("hangs a Kabras yard's newest weighing on that yard's pin", async () => {
    ;(prismaMock.organisation.findUnique as any).mockResolvedValue({ code: 'KABRAS' })
    ;(prismaMock.weighment.findMany as any).mockResolvedValue([
      ticket({ factoryCode: 'KABRAS', centerCode: 1104, grossBridgeNo: null, tareBridgeNo: null,
               grossAt: new Date('2026-09-25T08:00:00Z'), tareAt: new Date('2026-09-25T09:30:00Z') }),
      // Kabras's own 101 must not be read as Sukari's bridge 1 or its factory.
      ticket({ factoryCode: 'KABRAS', centerCode: 1101, grossBridgeNo: 1, tareBridgeNo: 1,
               grossAt: new Date('2026-09-25T07:00:00Z'), tareAt: null }),
    ])
    const out = await getWeighbridges('org_kabras')
    const misikhu = out.find(b => b.id === 'misikhu')!
    expect(misikhu.last?.at).toBe('2026-09-25T09:30:00.000Z')
    expect(misikhu.last?.stage).toBe('tare')
    // Both Kabras lanes show the yard's weighing; neither is claimed by bridge 1.
    expect(out.filter(b => b.centerName === 'KABRAS').every(b => b.last?.at === '2026-09-25T07:00:00.000Z')).toBe(true)
    expect(out.some(b => b.bridgeNo === 1)).toBe(false)
  })

  it('does not hand one mill the other mill\'s unticketed scales', async () => {
    ;(prismaMock.organisation.findUnique as any).mockResolvedValue({ code: 'SUKARI' })
    ;(prismaMock.weighment.findMany as any).mockResolvedValue([
      ticket({ grossBridgeNo: 1, tareBridgeNo: 1 }),
    ])
    const out = await getWeighbridges('org_1')
    expect(out.every(b => b.centerName !== 'KABRAS')).toBe(true)
  })

  it('still scopes by tickets when the organisation cannot be resolved', async () => {
    // An unresolvable org is a reason to return less, never a reason to guess:
    // the ticket-derived scoping stands on its own.
    ;(prismaMock.organisation.findUnique as any).mockResolvedValue(null)
    ;(prismaMock.weighment.findMany as any).mockResolvedValue([
      ticket({ grossBridgeNo: 1, tareBridgeNo: 1 }),
    ])
    const out = await getWeighbridges('org_1')
    expect(out.map(b => b.bridgeNo).sort()).toEqual([1, 2])
  })

  it('draws nothing for an organisation that weighs nowhere', async () => {
    // Every scale we know belongs to one mill group. Handing them to whoever
    // asks put six pins over somebody else's yards, a hundred kilometres from
    // the asking fleet — and an empty array is what removes the switch
    // entirely rather than leaving it to draw them.
    expect(await getWeighbridges('org_1')).toEqual([])
  })

  it("keeps a yard's quiet scale beside its busy one", async () => {
    // Factory runs two. One ticket on bridge 1 makes the whole yard this
    // organisation's, so bridge 2 keeps its pin with `last` null — a scale
    // idle for a month is not a scale that has moved away.
    ;(prismaMock.weighment.findMany as any).mockResolvedValue([
      ticket({ grossBridgeNo: 1, tareBridgeNo: 1 }),
    ])
    const out = await getWeighbridges('org_1')
    expect(out.map(b => b.bridgeNo).sort()).toEqual([1, 2])
    expect(of(out, 2).last).toBeNull()
  })

  it('scopes by the scale\'s own yard, not the ticket\'s', async () => {
    // A transfer raised at Opapo is weighed again on the factory's scale. The
    // ticket says centre 102; the second weighing happened at 101, and reading
    // the centre off the ticket would claim the wrong yard for it.
    ;(prismaMock.weighment.findMany as any).mockResolvedValue([
      ticket({
        category: 'CANE_TRANSFER', centerCode: 102, centerName: 'OPAPO',
        grossBridgeNo: 3, tareBridgeNo: null,
        factoryGrossBridgeNo: 1, factoryGrossAt: new Date('2026-09-11T09:00:00Z'),
      }),
    ])
    const out = await getWeighbridges('org_1')
    // Opapo's own scale, and both of the factory's.
    expect(out.map(b => b.bridgeNo).sort()).toEqual([1, 2, 3])
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
    // And nothing else is claimed for this organisation on the strength of a
    // ticket we could not place.
    expect(out).toEqual([])
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
