/**
 * Weighbridge day shaping, and the provider's two awkward conventions.
 *
 * The repository is mocked: what is under test is what the service SAYS about
 * a set of tickets — the day-wide stats, the per-lorry sequence and the gaps
 * between weighments — none of which is a SELECT, and all of which would be
 * wrong in a way that still renders if computed from the filtered rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/modules/weighments/weighment.repository.js', () => ({
  findDay:            vi.fn(),
  findCapturedRange:  vi.fn(),
  findOrgCentres:     vi.fn(),
  countByCategory:    vi.fn(),
}))

import { findDay, findCapturedRange, findOrgCentres } from '../../src/modules/weighments/weighment.repository.js'
import { getWeighmentDay } from '../../src/modules/weighments/weighment.service.js'
import { weighmentAt, normaliseWeighment, WEIGHBRIDGE_FACTORIES, siteCodeOf } from '../../src/modules/weighments/weighment.ingest.js'
import fixtures from '../fixtures/weighment-rows.json' with { type: 'json' }

const ORG = 'org_01'
const DAY = '2026-09-09'

/** A ticket, with only what a test cares about spelled out. */
let token = 1_000_000_000
function ticket(over: Record<string, unknown> = {}): never {
  const t = {
    id:            `w_${token}`,
    category:      'CANE_DELIVERY',
    tokenNumber:   BigInt(token++),
    tokenAt:       new Date('2026-09-09T06:00:00+03:00'),
    vehicleNo:     'KTCC 849B',
    vehiclePlate:  'KTCC849B',
    vehicleId:     null,
    driverName:    'TAISHON OTIENO OBONYO',
    centerCode:    101,
    centerName:    'FACTORY',
    grossWeightKg: 12180,
    grossAt:       new Date('2026-09-09T11:38:00+03:00'),
    grossOperator: 'WBF',
    grossBridgeNo: 1,
    tareWeightKg:  6020,
    tareAt:        new Date('2026-09-09T03:49:00+03:00'),
    tareOperator:  'LAU',
    tareBridgeNo:  2,
    netWeightKg:   6160,
    factoryGrossWeightKg: null, factoryGrossAt: null, factoryGrossOperator: null, factoryGrossBridgeNo: null,
    factoryTareWeightKg:  null, factoryTareAt:  null, factoryTareOperator:  null, factoryTareBridgeNo:  null,
    factoryNetWeightKg:   null,
    productName:   null,
    ...over,
  }
  return t as never
}

beforeEach(() => {
  vi.clearAllMocks()
  token = 1_000_000_000
  // A captured span by default, because every test below that supplies a
  // ticket implies one: a row cannot exist in an organisation whose history is
  // empty. The default used to be `null`, which let a test assert the tab strip
  // of a fleet that had simultaneously weighed something and never weighed
  // anything — and that impossible pair is what hid the real bug, where the
  // four bridge names were seeded onto companies that own no bridges. The
  // no-history case sets it back to null explicitly.
  vi.mocked(findCapturedRange).mockResolvedValue({
    first: new Date('2026-09-08T00:02:00+03:00'),
    last:  new Date('2026-09-09T19:31:00+03:00'),
  } as never)
  // The org's OWN bridges, as its own tickets report them. Sukari's four are
  // the default here because these tests are about Sukari; nothing in the
  // service knows that list any more.
  vi.mocked(findOrgCentres).mockResolvedValue([
    { code: 101, name: 'FACTORY' },
    { code: 102, name: 'OPAPO' },
    { code: 103, name: 'OYANI' },
    { code: 104, name: 'NYAONDO' },
  ] as never)
})

describe('weighmentAt — the provider sends the date and the clock apart', () => {
  it('reads the time as HHMM, not as minutes past midnight', () => {
    // 1138 is 11:38. Read as minutes it would be 18:58 — plausible, wrong, and
    // invisible on a chart.
    expect(weighmentAt('2026-09-09T00:00:00', 1138)?.toISOString()).toBe('2026-09-09T08:38:00.000Z')
  })

  it('handles the small-hours values that have no leading zero', () => {
    // `2` is 00:02, and these bridges really do work then — the earliest
    // ticket in the day measured was exactly that.
    expect(weighmentAt('2026-09-09T00:00:00', 2)?.toISOString()).toBe('2026-09-08T21:02:00.000Z')
  })

  it('stamps EAT rather than resolving against the host clock', () => {
    // 06:00 in Ndhiwa is 03:00Z. Without the explicit offset this test would
    // pass on a dev machine in EAT and fail on the production box in UTC —
    // which is exactly how a whole page ends up three hours out.
    expect(weighmentAt('2026-09-09T00:00:00', 600)?.toISOString()).toBe('2026-09-09T03:00:00.000Z')
  })

  it('keeps the ticket when the clock is unusable', () => {
    // A ticket with a broken time is still a ticket that happened on a day.
    expect(weighmentAt('2026-09-09T00:00:00', 2599)?.toISOString()).toBe('2026-09-08T21:00:00.000Z')
    expect(weighmentAt(null, 600)).toBeNull()
  })
})

describe('the day s stats describe every bridge, not the one on screen', () => {
  it('counts tickets and distinct lorries across all centres while the grid shows one', async () => {
    vi.mocked(findDay).mockResolvedValue([
      ticket({ centerCode: 101, centerName: 'FACTORY', vehicleNo: 'KTCC 849B', vehiclePlate: 'KTCC849B' }),
      ticket({ centerCode: 102, centerName: 'OPAPO',   vehicleNo: 'KDL 708E',  vehiclePlate: 'KDL708E' }),
      ticket({ centerCode: 103, centerName: 'OYANI',   vehicleNo: 'KTCC 784D', vehiclePlate: 'KTCC784D' }),
    ] as never)

    const res = await getWeighmentDay(ORG, { day: DAY, centre: 101 })

    expect(res.rows).toHaveLength(1)          // the grid narrowed…
    expect(res.stats.weighments).toBe(3)      // …the strip did not
    expect(res.stats.uniqueVehicles).toBe(3)
    expect(res.total).toBe(3)
    expect(res.matched).toBe(1)
  })

  it('names the ticket behind the heaviest load', async () => {
    vi.mocked(findDay).mockResolvedValue([
      ticket({ netWeightKg: 6160 }),
      ticket({ netWeightKg: 27400, centerName: 'OPAPO', centerCode: 102, vehicleNo: 'KDL 182X', vehiclePlate: 'KDL182X' }),
      ticket({ netWeightKg: 11680 }),
    ] as never)

    const res = await getWeighmentDay(ORG, { day: DAY })

    expect(res.stats.heaviestNetKg).toBe(27400)
    expect(res.stats.heaviest?.vehicleNo).toBe('KDL 182X')
    expect(res.stats.heaviest?.centerName).toBe('OPAPO')
    expect(res.stats.totalNetKg).toBe(6160 + 27400 + 11680)
  })

  it('lists a centre that weighed nothing rather than dropping its tab', async () => {
    vi.mocked(findDay).mockResolvedValue([ticket()] as never)

    const res = await getWeighmentDay(ORG, { day: DAY })

    // A quiet bridge is information — closed, or its feed stopped — and a tab
    // that disappears cannot say so.
    expect(res.centres.map(c => c.name)).toEqual(['FACTORY', 'OPAPO', 'OYANI', 'NYAONDO'])
    expect(res.centres.find(c => c.name === 'OYANI')?.count).toBe(0)
    expect(res.centres.find(c => c.name === 'FACTORY')?.count).toBe(1)
  })
})

describe('an organisation with no weighbridges at all', () => {
  it('offers no centre tabs, rather than four bridges that were never its own', async () => {
    // The tab exists on every fleet in the platform; the bridges belong to one.
    // Seeding the four names unconditionally put FACTORY · OPAPO · OYANI ·
    // NYAONDO on the screen of a company that has never owned a weighbridge,
    // each reading 0 — which says "your bridges have stopped reporting" about
    // bridges that were never theirs. Caught in production 2026-09-10 on the
    // Menengai company.
    vi.mocked(findDay).mockResolvedValue([] as never)
    vi.mocked(findCapturedRange).mockResolvedValue(null)
    vi.mocked(findOrgCentres).mockResolvedValue([] as never)

    const res = await getWeighmentDay(ORG, { day: DAY })

    expect(res.centres).toEqual([])
    expect(res.captured).toBeNull()
    expect(res.stats.weighments).toBe(0)
  })

  it('lists the organisation s OWN bridges, never another fleet s', async () => {
    // The tab strip is built from this org's own tickets. A second fleet with
    // one bridge of its own must see that one — not Sukari's four, which is
    // what a hardcoded list would have handed it the moment it weighed
    // anything.
    vi.mocked(findDay).mockResolvedValue([] as never)
    vi.mocked(findOrgCentres).mockResolvedValue([{ code: 201, name: 'NAITIRI' }] as never)

    const res = await getWeighmentDay(ORG, { day: DAY })

    expect(res.centres).toEqual([{ code: 201, name: 'NAITIRI', count: 0 }])
  })

  it('counts a centre that appears in the day but not yet in the history read', async () => {
    // A bridge that weighs its FIRST ticket today is in the day's rows before
    // the two reads can agree about it. It must still get a tab and a count
    // rather than being dropped for not being on the list.
    vi.mocked(findOrgCentres).mockResolvedValue([{ code: 101, name: 'FACTORY' }] as never)
    vi.mocked(findDay).mockResolvedValue([
      ticket({ centerCode: 105, centerName: 'RANGWE' }),
    ] as never)

    const res = await getWeighmentDay(ORG, { day: DAY })

    expect(res.centres).toEqual([
      { code: 101, name: 'FACTORY', count: 0 },
      { code: 105, name: 'RANGWE',  count: 1 },
    ])
  })

  it('still lists a quiet bridge for an organisation that HAS history', async () => {
    // The distinction the test above exists for: no history is not the same as
    // a quiet day, and a fleet with bridges keeps its tabs when they are idle.
    vi.mocked(findDay).mockResolvedValue([] as never)
    vi.mocked(findCapturedRange).mockResolvedValue({
      first: new Date('2026-09-08T00:02:00+03:00'),
      last:  new Date('2026-09-09T19:31:00+03:00'),
    } as never)

    const res = await getWeighmentDay(ORG, { day: DAY })

    expect(res.centres.map(c => c.name)).toEqual(['FACTORY', 'OPAPO', 'OYANI', 'NYAONDO'])
    expect(res.centres.every(c => c.count === 0)).toBe(true)
    expect(res.captured).not.toBeNull()
  })
})

describe('a lorry s day belongs to the lorry, not to the bridge', () => {
  it('numbers a lorry s tickets and measures the gap between them across centres', async () => {
    const plate = { vehicleNo: 'KTCC 849B', vehiclePlate: 'KTCC849B' }
    vi.mocked(findDay).mockResolvedValue([
      ticket({ ...plate, tokenAt: new Date('2026-09-09T05:00:00+03:00'), centerCode: 102, centerName: 'OPAPO' }),
      ticket({ ...plate, tokenAt: new Date('2026-09-09T08:30:00+03:00'), centerCode: 101, centerName: 'FACTORY' }),
      ticket({ ...plate, tokenAt: new Date('2026-09-09T12:00:00+03:00'), centerCode: 101, centerName: 'FACTORY' }),
    ] as never)

    // Ask for ONE centre: the sequence must still be the lorry's whole day.
    const res = await getWeighmentDay(ORG, { day: DAY, centre: 101 })

    // Newest first in the grid.
    expect(res.rows.map(r => r.seq)).toEqual([3, 2])
    expect(res.rows.every(r => r.vehicleTickets === 3)).toBe(true)
    expect(res.rows[0]!.sincePreviousMs).toBe(3.5 * 3_600_000)
    expect(res.rows[1]!.sincePreviousMs).toBe(3.5 * 3_600_000)
  })

  it('reports no gap at all on a lorry s first ticket', async () => {
    vi.mocked(findDay).mockResolvedValue([ticket()] as never)

    const res = await getWeighmentDay(ORG, { day: DAY })

    // Not zero: there is no earlier ticket to measure from, and a zero would
    // read as "it weighed twice at once".
    expect(res.rows[0]!.sincePreviousMs).toBeNull()
    expect(res.rows[0]!.seq).toBe(1)
  })

  it('treats the two spellings of one plate as one lorry', async () => {
    // The scale operators type it both ways; a sequence split across the two
    // would report every ticket as a first with no gap behind it.
    vi.mocked(findDay).mockResolvedValue([
      ticket({ vehicleNo: 'KTCC 849B', vehiclePlate: 'KTCC849B', tokenAt: new Date('2026-09-09T05:00:00+03:00') }),
      ticket({ vehicleNo: 'KTCC849B',  vehiclePlate: 'KTCC849B', tokenAt: new Date('2026-09-09T09:00:00+03:00') }),
    ] as never)

    const res = await getWeighmentDay(ORG, { day: DAY })

    expect(res.stats.uniqueVehicles).toBe(1)
    expect(res.rows[0]!.seq).toBe(2)
    expect(res.rows[0]!.sincePreviousMs).toBe(4 * 3_600_000)
  })

  it('measures loading time whichever way round the lorry was weighed', async () => {
    vi.mocked(findDay).mockResolvedValue([
      // The normal order here: empty first, loaded later (715 of 729 tickets).
      ticket({
        tareAt:  new Date('2026-09-09T03:49:00+03:00'),
        grossAt: new Date('2026-09-09T11:38:00+03:00'),
      }),
      // And the 14 that did the opposite. A subtraction written one way round
      // would report these as negative hours.
      ticket({
        vehicleNo: 'KBB 001A', vehiclePlate: 'KBB001A',
        tareAt:  new Date('2026-09-09T14:00:00+03:00'),
        grossAt: new Date('2026-09-09T12:00:00+03:00'),
      }),
    ] as never)

    const res = await getWeighmentDay(ORG, { day: DAY })
    const byPlate = Object.fromEntries(res.rows.map(r => [r.vehiclePlate, r.turnaroundMs]))

    expect(byPlate['KTCC849B']).toBe((7 * 60 + 49) * 60_000)
    expect(byPlate['KBB001A']).toBe(2 * 3_600_000)
  })
})

describe('search', () => {
  it('matches a token, a driver, or a plate typed without its space', async () => {
    vi.mocked(findDay).mockResolvedValue([
      ticket({ tokenNumber: 1000893559n, vehicleNo: 'KTCC 849B', vehiclePlate: 'KTCC849B', driverName: 'TAISHON OTIENO OBONYO' }),
      ticket({ tokenNumber: 1000893693n, vehicleNo: 'KTCC 784D', vehiclePlate: 'KTCC784D', driverName: 'GEORGE MORARA OSITU' }),
    ] as never)

    const byToken  = await getWeighmentDay(ORG, { day: DAY, q: '1000893693' })
    const byPlate  = await getWeighmentDay(ORG, { day: DAY, q: 'ktcc849b' })
    const byDriver = await getWeighmentDay(ORG, { day: DAY, q: 'george' })

    expect(byToken.rows.map(r => r.token)).toEqual(['1000893693'])
    expect(byPlate.rows.map(r => r.vehicleNo)).toEqual(['KTCC 849B'])
    expect(byDriver.rows.map(r => r.vehicleNo)).toEqual(['KTCC 784D'])
    // The stats still describe the day, not the search.
    expect(byToken.stats.weighments).toBe(2)
  })
})

describe('the fleet day', () => {
  it('reads a day boundary in Ndhiwa, not in UTC', async () => {
    vi.mocked(findDay).mockResolvedValue([] as never)

    await getWeighmentDay(ORG, { day: DAY })

    // 00:00–24:00 EAT. A UTC boundary would file the first three hours of
    // every shift under yesterday — and the shift starts at 00:02.
    const [, from, to] = vi.mocked(findDay).mock.calls[0]!
    expect((from as Date).toISOString()).toBe('2026-09-08T21:00:00.000Z')
    expect((to as Date).toISOString()).toBe('2026-09-09T21:00:00.000Z')
  })

  it('rejects a day it cannot parse instead of quietly serving today', async () => {
    await expect(getWeighmentDay(ORG, { day: 'yesterday' } as never)).rejects.toThrow(/YYYY-MM-DD/)
  })
})

/**
 * The parser, against the provider's own bytes.
 *
 * `tests/fixtures/weighment-rows.json` was captured verbatim from
 * factorysuite.org on 2026-09-10 and is not hand-written. That matters for
 * this format specifically: both of its awkward parts — the HHMM clock, and a
 * transfer that names its centre by a bare code — read plausibly when parsed
 * wrongly, so a fixture invented alongside the parser would agree with it and
 * prove nothing.
 */
describe('normaliseWeighment — real payloads', () => {
  it('maps a cane delivery, recombining each split date and clock', () => {
    const [row] = fixtures.delivery
    const f = normaliseWeighment(row as never, ORG, null)

    expect(f.category).toBe('CANE_DELIVERY')
    expect(f.tokenNumber).toBe(1000893559n)
    expect(f.vehiclePlate).toBe('KTCC849B')      // written "KTCC 849B"
    expect(f.centerName).toBe('FACTORY')
    // 1138 → 11:38 EAT → 08:38Z, and 349 → 03:49 EAT.
    expect((f.grossAt as Date).toISOString()).toBe('2026-09-09T08:38:00.000Z')
    expect((f.tareAt as Date).toISOString()).toBe('2026-09-09T00:49:00.000Z')
    expect(f.grossWeightKg).toBe(12180)
    expect(f.tareWeightKg).toBe(6020)
    expect(f.netWeightKg).toBe(6160)
    expect(f.grossBridgeNo).toBe(1)
    expect(f.tareBridgeNo).toBe(2)
    // Nothing weighed a delivery at the factory a second time.
    expect(f.factoryNetWeightKg ?? null).toBeNull()
  })

  it('puts a transfer s centre legs in the shared columns and its factory legs beside them', () => {
    const [row] = fixtures.transfer
    const f = normaliseWeighment(row as never, ORG, null)

    expect(f.category).toBe('CANE_TRANSFER')
    // The payload names its origin as `centerFrom: 102` and no name at all.
    expect(f.centerCode).toBe(102)
    expect(f.centerName).toBe('OPAPO')
    // Shared columns = the CENTRE weighing, so a grid row reads the same
    // whichever feed produced it.
    expect(f.tareWeightKg).toBe(21260)
    expect(f.grossWeightKg).toBe(48060)
    expect(f.netWeightKg).toBe(26800)
    // …and the factory's own second weighing sits beside it, disagreeing by
    // 260 kg, which is the reason a transfer is weighed twice at all.
    expect(f.factoryGrossWeightKg).toBe(47900)
    expect(f.factoryTareWeightKg).toBe(21360)
    expect(f.factoryNetWeightKg).toBe(26540)
    expect(f.factoryTareBridgeNo).toBe(1)
    // A factory tare taken the day BEFORE the rest of the ticket. Real, and
    // the reason the grid prints a date beside an off-day stamp.
    expect((f.factoryTareAt as Date).toISOString()).toBe('2026-09-06T21:28:00.000Z')
  })

  it('parses every captured row without inventing a timestamp', () => {
    for (const row of [...fixtures.delivery, ...fixtures.transfer]) {
      const f = normaliseWeighment(row as never, ORG, null)
      expect(f.tokenNumber > 0n).toBe(true)
      expect(f.vehiclePlate).toMatch(/^[A-Z0-9]+$/)
      expect(f.tokenAt).toBeInstanceOf(Date)
      expect(Number.isNaN((f.tokenAt as Date).getTime())).toBe(false)
    }
  })
})

describe('normaliseWeighment: one feed, three factories', () => {
  // Captured from the live feed 2026-09-25.
  const kabrasDelivery = {
    category: 'CANE_DELIVERY', factoryCode: 'KABRAS', tokenNumber: 20061084370,
    tokenDate: '2026-09-25', tokenTime: 2021, vehicleNo: 'KTCC 743A', driverName: 'JOSEPH AYOO  OMAR',
    grossDate: '2026-09-25', grossTime: 2025, grossOperator: null, grossWeight: 16840, grossWeighbridgeNo: null,
    tareDate: '2026-09-25', tareTime: 2044, tareOperator: null, tareWeight: 6820, tareWeighbridgeNo: null,
    netWeight: 10020, centerCode: 103, centerName: 'BUSIA YARD', productCode: null, productName: null,
  }
  const kabrasTransfer = {
    category: 'CANE_TRANSFER', factoryCode: 'KABRAS', tokenNumber: 236271724,
    tokenDate: '2026-09-25', tokenTime: 1850, vehicleNo: 'KDE 583S', driverName: 'JOTHAM WEKESA  NYONGESA',
    centerFrom: null, grossWeight: 48320, tareWeight: 22820, netWeight: 25500,
    status: 'In Transit', centerCode: 104, centerName: 'MISIKHU YARD',
  }

  it('stores the factory, and gives its yards codes of their own', () => {
    const f = normaliseWeighment(kabrasDelivery as never, ORG, null)
    expect(f.factoryCode).toBe('KABRAS')
    // Kabras's 103 is Busia, not Sukari's Oyani and not Nzoia's Weyeta.
    expect(f.centerCode).toBe(1103)
    expect(f.centerName).toBe('BUSIA YARD')
  })

  it('reads a Kabras transfer, which names its yard in centerCode and carries its weights at the top', () => {
    const f = normaliseWeighment(kabrasTransfer as never, ORG, null)
    expect(f.centerCode).toBe(1104)
    expect(f.centerName).toBe('MISIKHU YARD')
    expect(f.grossWeightKg).toBe(48320)
    expect(f.tareWeightKg).toBe(22820)
    expect(f.netWeightKg).toBe(25500)
  })

  it('keeps Ndhiwa rows, which name no factory, on the codes Sukari has always had', () => {
    const [row] = fixtures.delivery
    const f = normaliseWeighment(row as never, ORG, null)
    expect(f.factoryCode).toBe('NDHIWA')
    expect(f.centerCode).toBe(101)
  })

  it('maps Kabras and Nzoia to West Kenya and Ndhiwa to Sukari', () => {
    expect(WEIGHBRIDGE_FACTORIES.KABRAS.orgCode).toBe('WESTSUGAR')
    expect(WEIGHBRIDGE_FACTORIES.NZOIA.orgCode).toBe('WESTSUGAR')
    expect(WEIGHBRIDGE_FACTORIES.NDHIWA.orgCode).toBe('SUKARI')
    expect(siteCodeOf('NZOIA', 101)).not.toBe(siteCodeOf('KABRAS', 101))
  })
})
