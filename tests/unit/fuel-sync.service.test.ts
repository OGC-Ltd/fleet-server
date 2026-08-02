import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/reporting-period.js', () => ({
  getOrCreatePeriodFor: vi.fn(async () => 'period_1'),
  getOrCreateCurrentPeriod: vi.fn(async () => 'period_1'),
}))
vi.mock('../../src/lib/notifications/notification.store.js', () => ({
  publishNotification: vi.fn(),
  // Returns the store's DurablePublishResult. `published: false` is the store
  // suppressing an exact republish — see the dedupe case below.
  publishNotificationDurable: vi.fn(async (i: unknown) => ({ item: i, published: true })),
}))
vi.mock('../../src/providers/wialon/wialon.reports.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchUnitFuelEvents: vi.fn(),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { fetchUnitFuelEvents } from '../../src/providers/wialon/wialon.reports.js'
import { publishNotificationDurable } from '../../src/lib/notifications/notification.store.js'
import { syncVehicleFuelEvents, wialonUnitId, type OrgFuelSource } from '../../src/modules/fuel/fuel-sync.service.js'

const SOURCE: OrgFuelSource = {
  orgId: 'org_1', code: 'KASULU', resourceId: 30394506, templateId: 26, templateName: 'Advanced Fuel Analysis',
}
const VEHICLE = { id: 'veh_1', deviceId: 'wialon:30287348', registrationPlate: 'CTR 03' }

const NOW    = new Date('2026-08-02T12:00:00Z')
const RECENT = new Date('2026-08-02T11:30:00Z')   // inside a 2 h cutoff
const OLD    = new Date('2026-08-02T06:00:00Z')   // outside it
const CUTOFF = new Date('2026-08-02T10:00:00Z')

const opts = (over: Record<string, unknown> = {}) => ({
  from: new Date('2026-08-02T09:00:00Z'),
  to:   NOW,
  apply: true,
  notify: true,
  notifyCutoff: CUTOFF,
  ...over,
})

const filling = (at: Date) => ({
  filledAt: at, filledMl: 40_000, initialFuelLevelMl: 720_000,
  finalFuelLevelMl: 760_000, location: 'Nyalulanga', mileageAtFillKm: 0.01,
})
const drain = (at: Date) => ({
  beganAt: at, detectedAt: at, stolenMl: 80_830, initialFuelLevelMl: 759_920,
  finalFuelLevelMl: 679_090, initialLocation: 'Nyalulanga', initialSpeedKmh: 0,
})

const published = () => (publishNotificationDurable as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls

beforeEach(() => {
  vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [], thefts: [] })
  // Ledger existence is now ONE range query per table per vehicle, not a
  // findFirst per event — every cycle re-reads the same 3-hour window, so the
  // per-event queries were all asking about the same rows over the pooler.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.fuelFilling.findMany as any).mockResolvedValue([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.fuelTheft.findMany as any).mockResolvedValue([])
  // Reset the IMPLEMENTATION, not just the calls: the dedupe case below swaps
  // in `published: false`, and mockClear would leave that in place for every
  // test after it.
  vi.mocked(publishNotificationDurable).mockReset()
  vi.mocked(publishNotificationDurable).mockImplementation(
    async (i: unknown) => ({ item: i, published: true }) as unknown as Awaited<ReturnType<typeof publishNotificationDurable>>,
  )
})

describe('wialonUnitId', () => {
  it('accepts our device key and nothing else', () => {
    expect(wialonUnitId('wialon:30287348')).toBe(30287348)
    // A factorysuite UUID must never be read as a unit id.
    expect(wialonUnitId('3f1b8c2e-0f4a-4a11-9a1e-2b6d4d8e9c77')).toBeNull()
    expect(wialonUnitId(null)).toBeNull()
  })

  it('makes a vehicle with no Wialon binding a no-op', async () => {
    const out = await syncVehicleFuelEvents(
      {} as never, SOURCE, { ...VEHICLE, deviceId: null }, opts(),
    )
    expect(out.fillings).toBe(0)
    expect(fetchUnitFuelEvents).not.toHaveBeenCalled()
  })
})

describe('ledger writes', () => {
  it('stores a filling and a drain that are new', async () => {
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({
      fillings: [filling(RECENT)], thefts: [drain(RECENT)],
    })

    const out = await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts())

    expect(out).toMatchObject({ fillings: 1, thefts: 1, dupFill: 0, dupTheft: 0 })
    expect(prismaMock.fuelFilling.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.fuelTheft.create).toHaveBeenCalledTimes(1)
    // A drain names a unit, not a person — the roster cannot say who was
    // driving during a drain days ago.
    const theft = (prismaMock.fuelTheft.create.mock.calls[0]![0] as { data: Record<string, unknown> }).data
    expect(theft['driverId']).toBeNull()
    expect(theft['stolenMl']).toBe(80_830)
  })

  it('does not re-store an event already in the ledger', async () => {
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [filling(RECENT)], thefts: [] })
    // The ledger already holds this exact filling — matched on its timestamp,
    // the same test the per-event query made.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.fuelFilling.findMany as any).mockResolvedValue([{ filledAt: RECENT }])

    const out = await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts())

    expect(out).toMatchObject({ fillings: 0, dupFill: 1 })
    expect(prismaMock.fuelFilling.create).not.toHaveBeenCalled()
  })

  it('rewrites a ledger row when the provider revises the figures', async () => {
    // Measured on the live box 2026-08-02: Wialon reported one KCR 714F filling
    // as 55.1 L, then 53.9 L, then 52.8 L over three cycles. The notification
    // was upserted each time but the ledger kept its first glimpse, so the two
    // disagreed about the same event — KTCB 466U's 17:52 fill read 27.9 L in
    // the ledger and 47.0 L on the feed. Analytics read the ledger.
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [filling(RECENT)], thefts: [] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.fuelFilling.findMany as any).mockResolvedValue([
      { id: 'ff_1', filledAt: RECENT, filledMl: 55_100, finalFuelLevelMl: 96_100 },
    ])

    const out = await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts())

    expect(out).toMatchObject({ dupFill: 1, fillings: 0, corrected: 1 })
    const call = prismaMock.fuelFilling.update.mock.calls[0]![0] as { where: { id: string }; data: Record<string, unknown> }
    expect(call.where.id).toBe('ff_1')
    expect(call.data['filledMl']).toBe(40_000)          // the report's current answer
    expect(call.data['finalFuelLevelMl']).toBe(760_000)
    expect(prismaMock.fuelFilling.create).not.toHaveBeenCalled()
  })

  it('leaves a settled event alone', async () => {
    // Most events in a 3-hour window are unchanged; rewriting them every cycle
    // would be a write per event per cycle for no new information.
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [filling(RECENT)], thefts: [] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.fuelFilling.findMany as any).mockResolvedValue([
      { id: 'ff_1', filledAt: RECENT, filledMl: 40_000, finalFuelLevelMl: 760_000 },
    ])

    const out = await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts())

    expect(out).toMatchObject({ dupFill: 1, corrected: 0 })
    expect(prismaMock.fuelFilling.update).not.toHaveBeenCalled()
  })

  it('rewrites a revised drain too', async () => {
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [], thefts: [drain(RECENT)] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.fuelTheft.findMany as any).mockResolvedValue([
      { id: 'ft_1', beganAt: RECENT, stolenMl: 60_000, finalFuelLevelMl: 700_000 },
    ])

    const out = await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts())

    expect(out).toMatchObject({ dupTheft: 1, thefts: 0, corrected: 1 })
    const call = prismaMock.fuelTheft.update.mock.calls[0]![0] as { data: Record<string, unknown> }
    expect(call.data['stolenMl']).toBe(80_830)
  })

  it('checks the ledger once per table, not once per event', async () => {
    // The pooler makes a round trip cost about a second, and a busy vehicle can
    // return a dozen events per cycle over a window that is almost entirely
    // already stored. One range scan answers for all of them.
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({
      fillings: [filling(RECENT), filling(new Date('2026-08-02T11:00:00Z')), filling(new Date('2026-08-02T10:30:00Z'))],
      thefts:   [drain(RECENT), drain(new Date('2026-08-02T11:00:00Z'))],
    })

    await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts())

    expect(prismaMock.fuelFilling.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.fuelTheft.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.fuelFilling.findFirst).not.toHaveBeenCalled()
  })

  it('writes nothing when apply is false', async () => {
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [filling(RECENT)], thefts: [drain(RECENT)] })

    const out = await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts({ apply: false }))

    expect(out).toMatchObject({ fillings: 1, thefts: 1, published: 0 })
    expect(prismaMock.fuelFilling.create).not.toHaveBeenCalled()
    expect(publishNotificationDurable).not.toHaveBeenCalled()
  })
})

describe('feed publication is decided by AGE, not by ledger novelty', () => {
  it('still publishes an event the ledger already holds', async () => {
    // This is the regression that made the feed permanently empty: the nightly
    // backfill stores an event, and a later cycle then has nothing "new" to
    // announce even though the event is minutes old.
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [filling(RECENT)], thefts: [] })
    // The ledger already holds this exact filling — matched on its timestamp,
    // the same test the per-event query made.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.fuelFilling.findMany as any).mockResolvedValue([{ filledAt: RECENT }])

    const out = await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts())

    expect(out.dupFill).toBe(1)
    expect(out.published).toBe(1)
  })

  it('counts a suppressed republish as deduped, not as published', async () => {
    // Publication is by AGE, so one filling is re-offered on every cycle inside
    // the 2-hour window — up to eight times at a quarter-hourly cadence. The
    // store drops the exact repeats; the cycle must report that honestly rather
    // than claim eight publications, or "published: 0" on a quiet cycle becomes
    // indistinguishable from the sync having stopped.
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [filling(RECENT)], thefts: [drain(RECENT)] })
    vi.mocked(publishNotificationDurable).mockResolvedValue(
      { item: {}, published: false } as unknown as Awaited<ReturnType<typeof publishNotificationDurable>>,
    )

    const out = await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts())

    expect(out).toMatchObject({ published: 0, deduped: 2 })
  })

  it('stays silent about events older than the cutoff', async () => {
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [filling(OLD)], thefts: [drain(OLD)] })

    const out = await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts())

    expect(out).toMatchObject({ fillings: 1, thefts: 1, published: 0 })
    expect(publishNotificationDurable).not.toHaveBeenCalled()
  })

  it('publishes nothing at all when notify is off', async () => {
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [filling(RECENT)], thefts: [] })

    await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts({ notify: false }))

    expect(publishNotificationDurable).not.toHaveBeenCalled()
  })

  it('uses a stable feed id so republishing updates one row', async () => {
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [filling(RECENT)], thefts: [drain(RECENT)] })

    await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts())
    await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts())

    const ids = published().map(c => c[0]['id'])
    expect(ids[0]).toBe(`fuel-fill-veh_1-${RECENT.getTime()}`)
    expect(new Set(ids).size).toBe(2)          // one filling id, one drain id
    expect(ids[0]).toBe(ids[2])                // identical across runs
  })
})

describe('what the feed item says', () => {
  it('renders a drain as critical, with the volume and the place', async () => {
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [], thefts: [drain(RECENT)] })

    await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts())

    const item = published()[0]![0]
    expect(item['severity']).toBe('critical')
    expect(item['alertType']).toBe('fuelInconsistency')
    expect(item['text']).toContain('FUEL DROP: CTR 03')
    expect(item['text']).toContain('80.8 L lost')
    expect(item['text']).toContain('Nyalulanga')
    expect(item['text']).toContain('Tank now 679.1 L')
    // The event's own time, never "now".
    expect(item['at']).toEqual(RECENT)
  })

  it('renders a filling as info, without false precision on a whole number', async () => {
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [filling(RECENT)], thefts: [] })

    await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts())

    const item = published()[0]![0]
    expect(item['severity']).toBe('info')
    expect(item['text']).toContain('CTR 03 refuelled 40 L')
    expect(item['text']).not.toContain('40.0 L')
  })

  it('makes no claim of escalation', async () => {
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [], thefts: [drain(RECENT)] })

    await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts())

    // No notify/escalate mechanism exists, so the wording must not imply one.
    expect(String(published()[0]![0]['text'])).not.toMatch(/security|alerted|notified|dispatched/i)
  })
})
