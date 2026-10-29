import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/notifications/notification.store.js', () => ({
  publishNotification: vi.fn(),
  publishNotificationDurable: vi.fn(async (i: unknown) => ({ item: i, published: true })),
}))
// The real burn, wrapped so one case can make the engine account for a whole fall.
vi.mock('../../src/modules/fuel/fuel-theft-classifier.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/modules/fuel/fuel-theft-classifier.js')>()
  return { ...real, burnDuringFallMl: vi.fn(real.burnDuringFallMl) }
})

import { prismaMock } from '../helpers/prisma.mock.js'
import { env } from '../../src/config/env.js'
import { publishNotificationDurable } from '../../src/lib/notifications/notification.store.js'
import { burnDuringFallMl } from '../../src/modules/fuel/fuel-theft-classifier.js'
import {
  adjudicatePendingDrains, __resetProbeProfileCache, __resetBandCache,
} from '../../src/modules/fuel/fuel-adjudication.service.js'

const BEGAN    = new Date('2026-08-04T13:00:00Z')
const DETECTED = new Date('2026-08-04T13:05:00Z')
const NOW      = new Date('2026-08-04T13:40:00Z')   // past the settle window

const DRAIN = {
  id: 'ft_1', vehicleId: 'veh_1', beganAt: BEGAN, detectedAt: DETECTED,
  stolenMl: 40_000, initialLocation: 'Nyalulanga', finalFuelLevelMl: 160_000,
  vehicle: { organisationId: 'org_1', registrationPlate: 'KDL 182X' },
}

/**
 * Readings at one-minute steps from 12:55, spanning the whole event.
 *
 * Shaped as the RAW SQL rows the service now reads, not as Prisma models: the
 * evidence query joins `vehicle_telemetry_raws` for `ignition_known`, which is
 * the only way to tell a measured engine state from the adapter's
 * `ignition ?? (speed > 0)` fallback. `ignition_known` is false here, so these
 * fixtures assert the ordinary case of a unit that reports no ignition — the
 * majority of the fleet, and the case where the cause classifier must NOT
 * conclude the engine was off.
 */
const levels = (mls: number[]) =>
  mls.map((fuelLevelMl, i) => ({
    captured_at:    new Date(Date.parse('2026-08-04T12:55:00Z') + i * 60_000),
    fuel_level_ml:  fuelLevelMl,
    engine_on:      true,
    speed_kmh:      0,
    ignition_known: true,
  }))

const STEADY = [200_000, 200_000, 200_000, 200_000, 200_000, 200_000]
/**
 * A descent spread over ten minutes, not two.
 *
 * The rate matters now that a CAUSE gates the notification. Falling 42 L in
 * eight minutes implies 315 L/h, which correctly trips
 * MAX_PLAUSIBLE_REMOVAL_LPH and comes back SLOSH — no pump draws that. A
 * fixture has to describe an event that could physically happen, or it tests
 * the guard rather than the rule.
 */
const DRAINING = [
  195_000, 190_000, 185_000, 180_000, 175_000,
  170_000, 165_000, 160_000, 160_000, 160_000,
]

const published = () =>
  (publishNotificationDurable as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls

/**
 * `$queryRaw` now serves TWO different queries — the level series and the
 * probe's parked-swing profile — so the mock dispatches on the SQL rather than
 * returning one shape for both. Routing on the table name is enough to tell
 * them apart and does not couple the test to the rest of the statement.
 */
let telemetryRows: ReturnType<typeof levels> = []
let profileRow = { parked: BigInt(200), swinging: BigInt(0) }
let profileCalls = 0

const installQueryRaw = () =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prismaMock.$queryRaw as any).mockImplementation((strings: unknown) => {
    const sql = Array.isArray(strings) ? strings.join(' ') : String(strings)
    if (sql.includes('vehicle_telemetry_raws')) return Promise.resolve(telemetryRows)
    profileCalls++
    return Promise.resolve([profileRow])
  })

const setLevels = (mls: number[]) => { telemetryRows = levels(mls) }

/**
 * The same series with the engine MEASURED OFF throughout — the only state
 * that can reach SIPHON, which is now the sole announced cause.
 */
const setLevelsParked = (mls: number[]) => {
  telemetryRows = levels(mls).map(r => ({ ...r, engine_on: false }))
}

/**
 * The vehicle's parked-swing profile, which the trust gate reads for any drain
 * that reaches a confirmed DRAIN. Steady by default — the gate is meant to be
 * silent on the 97 of 139 machines that never swing.
 */
const setProbeProfile = (parked: number, swinging: number) => {
  profileRow = { parked: BigInt(parked), swinging: BigInt(swinging) }
}

beforeEach(() => {
  // These cases pin the LIVE wording and gate. The default since 2026-09-27
  // posts FUEL RATE / FUEL DOWN as a daily summary instead — see the block at
  // the end, and lib/queues/fuel-rate-digest.
  env.FUEL_RATE_ALERTS = 'live'
  vi.mocked(publishNotificationDurable).mockClear()
  __resetProbeProfileCache()   // module-global, keyed by vehicle — would leak between cases
  __resetBandCache()           // ...and so would the fleet-wide band lookup
  profileCalls = 0
  installQueryRaw()
  // The cause classifier needs an expected burn band, and since 2026-08-17 the
  // notification gate is the CAUSE rather than the verdict — so without one
  // every case here would reach INDETERMINATE and announce nothing, which
  // would make every publishing assertion vacuously pass.
  //
  // 10 L/h and no lPerKm: a machine judged on engine hours, not distance.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.vehicle.findMany as any).mockResolvedValue([
    { id: 'veh_1', registrationPlate: 'KDL 182X', vehicleType: 'TRUCK',
      organisationId: 'org_1', organisation: { code: 'SUKARI' } },
  ])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.vehicleFuelRate.findMany as any).mockResolvedValue([
    { vehicleId: 'veh_1', lPerHour: 10, lPerKm: null, runs: 5 },
  ])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.fuelTheft.findMany as any).mockResolvedValue([DRAIN])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.fuelTheft.update as any).mockResolvedValue({})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.notification.findMany as any).mockResolvedValue([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.fuelFilling.findFirst as any).mockResolvedValue(null)   // no refuel unless a case sets one
  setProbeProfile(200, 0)
})

describe('adjudicatePendingDrains', () => {
  it('reclassifies a recovered drain and never announces it', async () => {
    // The operator's case. This is the notification that should not exist.
    setLevels([...STEADY, ...DRAINING, 190_000, 198_000, 200_000, 200_000])

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out).toMatchObject({ redistribution: 1, drain: 0, published: 0 })
    expect(out.recoveredMl).toBe(40_000)
    expect(publishNotificationDurable).not.toHaveBeenCalled()
    expect(prismaMock.fuelTheft.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ft_1' },
      data:  expect.objectContaining({ verdict: 'REDISTRIBUTION', verdictReason: 'level-recovered' }),
    }))
  })

  it('replaces an existing provisional alert when adjudication clears the report', async () => {
    setLevels([...STEADY, ...DRAINING, 190_000, 198_000, 200_000, 200_000])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.notification.findMany as any).mockResolvedValue([{ feedId: 'fuel-drain-veh_1-ft_1' }])

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out).toMatchObject({ redistribution: 1, published: 1 })
    expect(published()[0]![0]).toMatchObject({
      id: 'fuel-drain-veh_1-ft_1',
      severity: 'info',
    })
    expect(String(published()[0]![0]['text'])).toContain('level recovered')
  })

  it('reports a burn far above the machine’s measured rate, without calling it theft', async () => {
    setLevels([...STEADY, ...DRAINING, 160_000, 159_000, 158_000, 158_000])

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out).toMatchObject({ drain: 1, drainConfirmed: 1, redistribution: 0, published: 1 })
    expect(prismaMock.fuelTheft.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ drainCause: 'UNEXPLAINED_BURN' }),
    }))

    const item = published()[0]![0]
    // States the MEASUREMENT — a rate against an expectation — rather than
    // claiming the drop is "unexplained", which described our own gap and is
    // the wording the operator rejected.
    expect(item['text']).toContain('FUEL RATE: KDL 182X')
    expect(item['text']).toMatch(/L\/h/)
    expect(item['text']).not.toMatch(/theft|stolen|suspicious|loss|lost|unexplained/i)
    expect(item['severity']).toBe('warning')
    expect(item['at']).toEqual(BEGAN)
  })

  it('stores the fall judged and, apart, what left the tank less the idling burn', async () => {
    setLevels([...STEADY, ...DRAINING, 160_000, 159_000, 158_000, 158_000])

    await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (prismaMock.fuelTheft.update as any).mock.calls[0][0].data
    expect(data.measuredDropMl).toBe(42_000)
    // Engine measured on, standing: the idle rate, a quarter of 10 L/h, not 10.
    expect(data.cleanDropMl).toBeLessThan(42_000)
    expect(data.cleanDropMl).toBeGreaterThan(42_000 - 2_500)
    expect(published()[0]![0]['text']).toContain('recorded a drop of ' + (data.cleanDropMl / 1000).toFixed(1))
  })

  it('says nothing about a fall the engine’s burn accounts for in full', async () => {
    setLevels([...STEADY, ...DRAINING, 160_000, 159_000, 158_000, 158_000])
    vi.mocked(burnDuringFallMl).mockReturnValueOnce(1_000_000)

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out.published).toBe(0)
    expect(prismaMock.fuelTheft.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ drainCause: 'UNEXPLAINED_BURN', measuredDropMl: 42_000, cleanDropMl: 0 }),
    }))
  })

  it('says nothing at all about a claim it could not check', async () => {
    // Two readings cannot describe a fall. Until the cause gate shipped this
    // still announced — "reported, not confirmed" — and that class was the
    // bulk of the noise: the provider saw something, we could not look, and an
    // operator was notified anyway. It is now silent, and the row still
    // carries its verdict for the ledger.
    setLevels([200_000, 160_000])

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out).toMatchObject({ drain: 1, drainConfirmed: 0 })
    expect(publishNotificationDurable).not.toHaveBeenCalled()
    expect(prismaMock.fuelTheft.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ verdict: 'DRAIN', drainCause: expect.any(String) }),
    }))
  })

  it('announces a SIPHON — the one thing it will still say out loud', async () => {
    // Engine measured OFF for the whole fall, stationary, sustained — the only
    // route to an operator now.
    //
    // A LINEAR descent, not DRAINING. That series decelerates into a flat tail
    // and is correctly read as SETTLING (kT 1.90): a tank finding its level.
    // A siphon draws at a steady rate and does not ease off, which is the
    // whole distinction the shape test exists to make.
    const SIPHONING = [
      197_000, 194_000, 191_000, 188_000, 185_000, 182_000, 179_000,
      176_000, 173_000, 170_000, 167_000, 164_000, 161_000, 158_000,
    ]
    setLevelsParked([...STEADY, ...SIPHONING])

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out.published).toBe(1)
    const item = published()[0]![0]
    expect(item['alertType']).toBe('fuelInconsistency')
    expect(item['severity']).toBe('critical')
    // The operator's agreed phrase, and the ONLY cause permitted to use it.
    expect(item['text']).toContain('POSSIBLE THEFT: KDL 182X')
    expect(item['text']).toContain('Nyalulanga')
    expect(item['text']).toContain('The tank now holds 160 L')
    // The event's own time, never the moment we got round to judging it.
    expect(item['at']).toEqual(BEGAN)
    // Still no claim that anyone has been sent, told or dispatched.
    expect(String(item['text'])).not.toMatch(/security|alerted|notified|dispatched/i)
  })

  it('stays silent on a drain the machine could plausibly have burned', async () => {
    // The whole point of the gate: a small fall on a running machine is a
    // working day, not an incident, and it used to be a notification.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.fuelTheft.findMany as any).mockResolvedValue([{ ...DRAIN, stolenMl: 2_000 }])
    setLevels([200_000, 200_000, 200_000, 199_500, 199_000, 198_500, 198_000, 198_000, 198_000])

    await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(publishNotificationDurable).not.toHaveBeenCalled()
  })

  it('still judges a drain when a refuel happens LATER in the window', async () => {
    // A filling two hours after the event cannot explain a level that came
    // back five minutes in. 29-35% of live drains have a filling somewhere in
    // the window; discarding them all would forfeit most of what is decidable.
    setLevels([...STEADY, ...DRAINING, 190_000, 198_000, 200_000, 200_000])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.fuelFilling.findFirst as any).mockResolvedValue({
      filledAt: new Date('2026-08-04T15:00:00Z'),
    })

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out).toMatchObject({ redistribution: 1, refill: 0, drain: 0 })
  })

  it('does not narrate a backlog onto the live feed', async () => {
    // The ledger holds 30 days. The first pass over it must record verdicts
    // without replaying every old drain as though it just happened.
    setLevels([...STEADY, ...DRAINING, 160_000, 159_000, 158_000, 158_000])

    const out = await adjudicatePendingDrains({
      apply: true, notify: true, now: NOW,
      notifyCutoff: new Date('2026-08-04T13:30:00Z'),   // after this drain began
    })

    expect(out.drain).toBe(1)                       // still judged
    expect(prismaMock.fuelTheft.update).toHaveBeenCalled()
    expect(publishNotificationDurable).not.toHaveBeenCalled()   // but not announced
  })

  it('will not confirm a drain on a probe that swings while parked', async () => {
    // The operator's DZ 07 case, reached by the route that survives
    // measurement: not "the tank was part full" but "this probe moves 25 L on a
    // machine standing still, in 9 of its 12 parked half-hours".
    setLevels([...STEADY, ...DRAINING, 160_000, 159_000, 158_000, 158_000])
    setProbeProfile(40, 30)

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out).toMatchObject({ drain: 1, drainConfirmed: 0 })
    // Still a DRAIN — the level fell and stayed down. What the gate withdraws
    // is the claim that our own telemetry settles it.
    expect(prismaMock.fuelTheft.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ verdict: 'DRAIN', verdictReason: 'probe-swings' }),
    }))
    // ...and the classifier will not attribute anything measured on an
    // instrument that moves 25 L on a standing machine, so nothing is
    // announced at all. This used to arrive as a warning.
    expect(prismaMock.fuelTheft.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ drainCause: 'INDETERMINATE' }),
    }))
    expect(publishNotificationDurable).not.toHaveBeenCalled()
  })

  it('does not let a filling the tank never received close the window', async () => {
    // Fillings are adjudicated too, and 307 of 5,794 are REDISTRIBUTION — the
    // up-swings of oscillating probes, claiming 13,075 L while those tanks
    // collectively FELL 3,689 L. One of those truncating a drain's recovery
    // window is how `filling-too-soon` reached 438 rows.
    //
    // PENDING fillings must still count: unjudged is not disproved.
    setLevels([...STEADY, ...DRAINING, 160_000, 159_000, 158_000, 158_000])

    await adjudicatePendingDrains({ apply: true, notify: false, now: NOW })

    expect(prismaMock.fuelFilling.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ verdict: { not: 'REDISTRIBUTION' } }),
      }),
    )
  })

  it('does not ask about the probe unless the drain was confirmed', async () => {
    // The profile costs a second query per drain and only a CONFIRMED drain
    // can be downgraded by it — 417 of 2,571 rows on the live ledger.
    setLevels([...STEADY, ...DRAINING, 190_000, 198_000, 200_000, 200_000])

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out.redistribution).toBe(1)
    // The level series IS fetched for every drain; what must not happen is the
    // second, separate profile query — counted rather than inferred from
    // `$queryRaw` being untouched, since both now go through it.
    expect(profileCalls).toBe(0)
  })

  it('writes nothing on a dry run', async () => {
    setLevels([...STEADY, ...DRAINING, 200_000, 200_000, 200_000, 200_000])

    const out = await adjudicatePendingDrains({ apply: false, notify: true, now: NOW })

    expect(out.redistribution).toBe(1)          // still counted, so it can be previewed
    expect(prismaMock.fuelTheft.update).not.toHaveBeenCalled()
    expect(publishNotificationDurable).not.toHaveBeenCalled()
  })

  it('stays quiet when notify is off, but still records the verdict', async () => {
    // The history backfill: judging weeks-old drains must not replay them onto
    // a feed that is meant to show what is happening now.
    setLevels([...STEADY, ...DRAINING, 160_000, 159_000, 158_000, 158_000])

    const out = await adjudicatePendingDrains({ apply: true, notify: false, now: NOW })

    expect(out.drain).toBe(1)
    expect(prismaMock.fuelTheft.update).toHaveBeenCalled()
    expect(publishNotificationDurable).not.toHaveBeenCalled()
  })
})

describe('adjudicatePendingDrains — FUEL RATE / FUEL DOWN as a daily summary', () => {
  // The operator's choice on 2026-09-27 (FUEL_RATE_ALERTS=digest): 800 of these
  // in 30 days, 499 critical, none ever marked a theft.
  beforeEach(() => { env.FUEL_RATE_ALERTS = 'digest' })

  const SIPHONING = [
    197_000, 194_000, 191_000, 188_000, 185_000, 182_000, 179_000,
    176_000, 173_000, 170_000, 167_000, 164_000, 161_000, 158_000,
  ]

  it('records a burn far above the machine’s rate but leaves it to the daily summary', async () => {
    setLevels([...STEADY, ...DRAINING, 160_000, 159_000, 158_000, 158_000])

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out).toMatchObject({ drain: 1, drainConfirmed: 1, published: 0 })
    // The ledger row the summary is built from is written exactly as before.
    expect(prismaMock.fuelTheft.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ drainCause: 'UNEXPLAINED_BURN' }),
    }))
    expect(publishNotificationDurable).not.toHaveBeenCalled()
  })

  it('still posts a SIPHON as it happens, as POSSIBLE THEFT', async () => {
    setLevelsParked([...STEADY, ...SIPHONING])

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out.published).toBe(1)
    const item = published()[0]![0]
    expect(item['severity']).toBe('critical')
    expect(item['text']).toContain('POSSIBLE THEFT: KDL 182X')
  })

  it('says nothing about lateness on a SIPHON judged on time', async () => {
    setLevelsParked([...STEADY, ...SIPHONING])
    await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })
    expect(published()[0]![0]['text']).not.toContain('Reported')
  })

  it('says how late a SIPHON is when it is judged hours on', async () => {
    // Found by the settle pass, as 17 were on 8–22 Oct: still critical
    // inside six hours, and the line says when it was found.
    setLevelsParked([...STEADY, ...SIPHONING])
    await adjudicatePendingDrains({ apply: true, notify: true, now: new Date(BEGAN.getTime() + 2.5 * 3_600_000) })
    const item = published()[0]![0]
    expect(item['severity']).toBe('critical')
    expect(item['text']).toContain("Reported 2.5 hours after it happened: found on a later read of the tracker's data.")
    expect(item['at']).toEqual(BEGAN)
  })

  it('posts a SIPHON found more than six hours on as a warning', async () => {
    setLevelsParked([...STEADY, ...SIPHONING])
    await adjudicatePendingDrains({ apply: true, notify: true, now: new Date(BEGAN.getTime() + 10 * 3_600_000) })
    const item = published()[0]![0]
    expect(item['severity']).toBe('warning')
    expect(item['text']).toContain('POSSIBLE THEFT: KDL 182X')
    expect(item['text']).toContain('Reported 10 hours after it happened')
  })

  /**
   * KDE 585S's shape (27 Sep), on the fixture clock: refuelled from 20 L to
   * 200 L at the pump by 12:48 UTC, standing with the engine off; 30 L gone by
   * 13:01, still standing; then driven off at 13:02, the level easing to 160 L.
   * The drain the provider reports takes in the driving, so the classifier
   * judges it against the road — and the fall at the pump is found by the
   * standing-fall call instead.
   */
  const atThePump = (engineOnWhileStanding: boolean) => {
    const rows: Array<{ min: number; L: number; kmh: number; on: boolean }> = []
    for (let m = -25; m <= -16; m++) rows.push({ min: m, L: 20, kmh: 0, on: false })
    ;[60, 120, 180, 200].forEach((L, i) => rows.push({ min: -15 + i, L, kmh: 0, on: false }))
    for (let m = -11; m <= -2; m++) rows.push({ min: m, L: 200, kmh: 0, on: engineOnWhileStanding })
    ;[185, 172, 170].forEach((L, i) => rows.push({ min: -1 + i, L, kmh: 0, on: engineOnWhileStanding }))
    for (let m = 2; m <= 17; m++) rows.push({ min: m, L: 170 - (m - 2) * (10 / 15), kmh: 30, on: true })
    for (let m = 18; m <= 35; m++) rows.push({ min: m, L: 160, kmh: 0, on: false })
    telemetryRows = rows.map(r => ({
      captured_at: new Date(BEGAN.getTime() + r.min * 60_000), fuel_level_ml: Math.round(r.L * 1000),
      engine_on: r.on, speed_kmh: r.kmh, ignition_known: true,
    }))
  }

  it('posts a fall at the pump as POSSIBLE THEFT, though the drain ran on into driving', async () => {
    atThePump(false)

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out.drain).toBe(1)
    expect(prismaMock.fuelTheft.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ drainCause: 'SIPHON', causeReason: 'fell-after-refuel' }),
    }))
    expect(out.published).toBe(1)
    const item = published()[0]![0]
    expect(item['severity']).toBe('critical')
    // The levels and the times, which can be checked against the gauge and the
    // pump's records — not the drain's figure, which takes in the driving.
    expect(item['text']).toContain('POSSIBLE THEFT: KDL 182X was refuelled to 200 L, then its tank fell to')
    expect(item['text']).toContain('while it stood with its engine off at Nyalulanga')
  })

  it('leaves the same fall to the daily summary when the engine ran and nothing shows it only idled', async () => {
    // No accelerometer on this unit: a running engine at a stand cannot be
    // told from a machine burning its fuel, so no theft is called.
    atThePump(true)

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out.drain).toBe(1)
    expect(prismaMock.fuelTheft.update).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ drainCause: 'SIPHON' }),
    }))
    expect(publishNotificationDurable).not.toHaveBeenCalled()
  })

  it('posts neither when switched off, and still records the verdict', async () => {
    env.FUEL_RATE_ALERTS = 'off'
    setLevels([...STEADY, ...DRAINING, 160_000, 159_000, 158_000, 158_000])

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out).toMatchObject({ drain: 1, published: 0 })
    expect(prismaMock.fuelTheft.update).toHaveBeenCalled()
    expect(publishNotificationDurable).not.toHaveBeenCalled()
  })
})
