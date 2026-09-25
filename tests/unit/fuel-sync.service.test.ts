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
  // Prisma returns the created row, and the feed id is keyed on it — see the
  // stable-feed-id case.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.fuelFilling.create as any).mockResolvedValue({ id: 'ff_new' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.fuelTheft.create as any).mockResolvedValue({ id: 'ft_new' })
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

  it('stores a re-report of a deleted drain as already deleted', async () => {
    // The provider re-clamped the start, so the report misses the window's
    // rows — but it overlaps a drain an operator deleted, and must not come
    // back as a new alert.
    const deletedAt = new Date(RECENT.getTime() - 60_000)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.fuelTheft.findFirst as any).mockResolvedValue({
      dismissedAt: deletedAt, dismissedById: 'u1', reviewedAt: deletedAt, reviewedById: 'u1',
    })
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [], thefts: [drain(RECENT)] })

    await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts())

    const theft = (prismaMock.fuelTheft.create.mock.calls[0]![0] as { data: Record<string, unknown> }).data
    expect(theft).toMatchObject({ dismissedAt: deletedAt, dismissedById: 'u1', reviewStatus: 'DISMISSED' })
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
    // The stored row and the revised event describe the SAME tank state — same
    // final level, a volume the provider has since narrowed. That overlap is
    // what identifies them as one event now that a timestamp cannot.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.fuelFilling.findMany as any).mockResolvedValue([
      { id: 'ff_1', filledAt: RECENT, filledMl: 55_100, initialFuelLevelMl: 704_900, finalFuelLevelMl: 760_000 },
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
      { id: 'ff_1', filledAt: RECENT, filledMl: 40_000, initialFuelLevelMl: 720_000, finalFuelLevelMl: 760_000 },
    ])

    const out = await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts())

    expect(out).toMatchObject({ dupFill: 1, corrected: 0 })
    expect(prismaMock.fuelFilling.update).not.toHaveBeenCalled()
  })

  it('rewrites a revised drain too', async () => {
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [], thefts: [drain(RECENT)] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.fuelTheft.findMany as any).mockResolvedValue([
      { id: 'ft_1', beganAt: RECENT, detectedAt: RECENT, stolenMl: 60_000, finalFuelLevelMl: 700_000 },
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

    // One, not two: the drain is no longer announced here at all — it waits
    // for adjudication. See fuel-adjudication.service.
    expect(out).toMatchObject({ published: 0, deduped: 1 })
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
    // Keyed on the LEDGER ROW, not the event's clock — see the drift case below.
    // Only the filling reaches the feed from here; the drain is adjudicated
    // first and announced by that pass.
    expect(ids).toEqual(['fuel-fill-veh_1-ff_new', 'fuel-fill-veh_1-ff_new'])
  })

  it('keeps one feed item when the provider moves the event clock', async () => {
    // The regression this whole change exists for, at the feed layer: a drain
    // still in progress comes back with a re-clamped start on every cycle. Keyed
    // on the timestamp, MUFINDI: 008 would have raised nine separate "FUEL DROP"
    // lines for one drain.
    const later = new Date(RECENT.getTime() + 15 * 60_000)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.fuelTheft.findMany as any).mockResolvedValue([
      { id: 'ft_1', beganAt: RECENT, detectedAt: later, stolenMl: 60_000, finalFuelLevelMl: 700_000 },
    ])
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({
      fillings: [], thefts: [{ ...drain(later), detectedAt: later }],
    })

    await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts())

    // The matcher still collapses the re-clamped report onto the one row —
    // which is the point of this case. Nothing is announced from here now.
    expect(prismaMock.fuelTheft.create).not.toHaveBeenCalled()
    expect(published()).toHaveLength(0)
  })
})

describe('reconcile — the provider retracts an event', () => {
  const stale = { id: 'ft_stale', beganAt: OLD, detectedAt: OLD, stolenMl: 90_000, finalFuelLevelMl: 1_000 }

  it('deletes ledger rows the provider no longer reports', async () => {
    // Eight of MUFINDI: DZ 04's 29 stored drains for 2026-08-03 had no
    // counterpart in Wialon's settled answer. Matching cannot reach them —
    // they overlap nothing — so without this they inflate the loss figure for
    // as long as the row exists.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.fuelTheft.findMany as any).mockResolvedValue([stale])
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [], thefts: [] })

    const out = await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts({ reconcile: true }))

    expect(out.removed).toBe(1)
    expect(prismaMock.fuelTheft.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['ft_stale'] } } })
  })

  it('deletes nothing without the flag', async () => {
    // The default path runs against a window that is still maturing, where an
    // event Wialon has not yet recognised would be deleted and re-created every
    // cycle, churning the feed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.fuelTheft.findMany as any).mockResolvedValue([stale])
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [], thefts: [] })

    const out = await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts())

    expect(out.removed).toBe(0)
    expect(prismaMock.fuelTheft.deleteMany).not.toHaveBeenCalled()
  })

  it('keeps a row the provider still reports', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.fuelTheft.findMany as any).mockResolvedValue([
      { id: 'ft_1', beganAt: RECENT, detectedAt: RECENT, stolenMl: 80_830, finalFuelLevelMl: 679_090 },
    ])
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [], thefts: [drain(RECENT)] })

    const out = await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts({ reconcile: true }))

    expect(out.removed).toBe(0)
    expect(prismaMock.fuelTheft.deleteMany).not.toHaveBeenCalled()
  })

  it('never deletes a drain an operator has deleted from the dashboard', async () => {
    // That row carries who deleted it and its follow-up. Removing it is how a
    // retracted-then-re-reported drain used to come back as a fresh alert.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.fuelTheft.findMany as any).mockResolvedValue([{ ...stale, dismissedAt: OLD }])
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [], thefts: [] })

    const out = await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts({ reconcile: true }))

    expect(out.removed).toBe(0)
    expect(prismaMock.fuelTheft.deleteMany).not.toHaveBeenCalled()
  })

  it('counts but does not delete during a dry run', async () => {
    // This is the only branch that destroys data, so the dry run has to be able
    // to answer "how many rows would go?" before anyone runs it for real.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.fuelTheft.findMany as any).mockResolvedValue([stale])
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [], thefts: [] })

    const out = await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts({ reconcile: true, apply: false }))

    expect(out.removed).toBe(1)
    expect(prismaMock.fuelTheft.deleteMany).not.toHaveBeenCalled()
  })
})

describe('one physical event, many reports', () => {
  it('updates the same row as the drain start marches forward', async () => {
    // MUFINDI: 008 verbatim — nine rows 15 minutes apart where the provider
    // reports one drain. Each cycle here must land on the row the last one
    // wrote, not beside it.
    let stored: Record<string, unknown> | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.fuelTheft.findMany as any).mockImplementation(async () => (stored ? [stored] : []))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.fuelTheft.update as any).mockImplementation(async (a: { data: Record<string, unknown> }) => {
      stored = { ...stored, ...a.data }
      return stored
    })

    // The drain is still running throughout, so every re-clamped start sits
    // inside it — 008's nine starts all preceded one 23:30 end.
    const endsAt = new Date('2026-08-02T13:30:00Z')
    for (const minutes of [0, 15, 30, 45]) {
      const began = new Date(RECENT.getTime() + minutes * 60_000)
      vi.mocked(fetchUnitFuelEvents).mockResolvedValue({
        fillings: [], thefts: [{ ...drain(began), detectedAt: endsAt, stolenMl: 60_000 + minutes * 100 }],
      })
      const out = await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts())
      if (minutes === 0) {
        expect(out.thefts).toBe(1)
        stored = { id: 'ft_1', beganAt: began, detectedAt: endsAt, stolenMl: 60_000, finalFuelLevelMl: 679_090 }
      } else {
        expect(out, `cycle at +${minutes}m`).toMatchObject({ thefts: 0, dupTheft: 1 })
      }
    }

    // One insert across four cycles. Before this change it was four.
    expect(prismaMock.fuelTheft.create).toHaveBeenCalledTimes(1)
    expect(stored!['stolenMl']).toBe(64_500)   // the provider's latest answer
  })
})

describe('what the feed item says', () => {
  it('does NOT announce a drain — the claim is adjudicated first', async () => {
    // Measured over the 250 most recent drains per org, 40% (KASULU) and 50%
    // (SUKARI) of decidable loss volume came back with no filling to explain
    // it. Announcing on the provider's claim is what put those in front of the
    // operator. The row is still written; only the feed item waits.
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [], thefts: [drain(RECENT)] })

    const out = await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts())

    expect(out.thefts).toBe(1)
    expect(prismaMock.fuelTheft.create).toHaveBeenCalled()
    expect(publishNotificationDurable).not.toHaveBeenCalled()
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
    vi.mocked(fetchUnitFuelEvents).mockResolvedValue({ fillings: [filling(RECENT)], thefts: [] })

    await syncVehicleFuelEvents({} as never, SOURCE, VEHICLE, opts())

    // No notify/escalate mechanism exists, so the wording must not imply one.
    expect(String(published()[0]![0]['text'])).not.toMatch(/security|alerted|notified|dispatched/i)
  })
})
