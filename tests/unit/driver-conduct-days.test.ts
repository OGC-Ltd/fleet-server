/**
 * Driver Conduct a fleet day at a time (modules/reports/driver-conduct-days):
 * built from notifications and the saved dashcam alarms, read by the month,
 * cleared on the 5th of the next month.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { vi } from 'vitest'

vi.mock('../../src/lib/prisma.js')
import { prismaMock } from '../helpers/prisma.mock.js'
const days = await import('../../src/modules/reports/driver-conduct-days.js')

const at = (s: string) => new Date(`${s}+03:00`)
const NOW = Date.parse('2026-11-25T10:00:00+03:00')

beforeEach(() => {
  days.resetConductDaysState()
  ;(prismaMock.$queryRaw as any).mockResolvedValue([{ ok: true }])
  ;(prismaMock.driverConductDay.deleteMany as any).mockResolvedValue({ count: 0 })
  ;(prismaMock.driverConductBuiltDay.deleteMany as any).mockResolvedValue({ count: 0 })
  ;(prismaMock.driverConductDay.createMany as any).mockResolvedValue({ count: 0 })
  ;(prismaMock.driverConductBuiltDay.upsert as any).mockResolvedValue({})
  ;(prismaMock.dashcamCaptureDay.findUnique as any).mockResolvedValue(null)
})

describe('how long the days are kept (operator, 2026-11-25: the 5th of every new month)', () => {
  it('a month’s days stay until the 5th of the next, then go', () => {
    expect(days.keepFrom(Date.parse('2026-11-25T10:00:00+03:00'))).toBe('2026-11-01')
    expect(days.keepFrom(Date.parse('2026-12-04T23:59:00+03:00'))).toBe('2026-11-01')
    expect(days.keepFrom(Date.parse('2026-12-05T00:00:00+03:00'))).toBe('2026-12-01')
    // In Nairobi time: 21:30 UTC on 4 Dec is already the 5th
    expect(days.keepFrom(Date.parse('2026-12-04T21:30:00Z'))).toBe('2026-12-01')
    expect(days.keepFrom(Date.parse('2027-01-03T12:00:00+03:00'))).toBe('2026-12-01')
  })

  it('clears what has expired, and builds no day before it', async () => {
    ;(prismaMock.driverConductDay.deleteMany as any).mockResolvedValue({ count: 412 })
    ;(prismaMock.organisation.findMany as any).mockResolvedValue([{ id: 'o1', code: 'SUKARI' }])
    const c = await days.runConductDays({ now: Date.parse('2026-12-06T03:00:00+03:00') })
    expect(prismaMock.driverConductDay.deleteMany).toHaveBeenCalledWith({ where: { day: { lt: '2026-12-01' } } })
    expect(prismaMock.driverConductBuiltDay.deleteMany).toHaveBeenCalledWith({ where: { day: { lt: '2026-12-01' } } })
    expect(c.expired).toBe(412)
    expect(c.built.map((b) => b.day)).toEqual(['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05'])
  })
})

describe('one vehicle-day', () => {
  it('a row per vehicle, each incident by its time; alarms of other kinds and unpaired plates handled', () => {
    const rows = days.vehicleDays(
      [
        { vehicleId: 'v1', plate: 'KCS 082M', alertType: 'HARSH_BRAKING', occurredAt: at('2026-11-20T09:00:00') },
        { vehicleId: 'v1', plate: 'KCS 082M', alertType: 'HARSH_ACCELERATION', occurredAt: at('2026-11-20T08:00:00') },
        { vehicleId: 'v1', plate: 'KCS 082M', alertType: 'HARSH_BRAKING', occurredAt: at('2026-11-20T07:00:00') },
      ],
      [
        { vehicleId: 'v1', plate: 'KCS 082M', code: 116, occurredAt: at('2026-11-20T10:00:00') },
        { vehicleId: null, plate: 'KCN 901F', code: 125, occurredAt: at('2026-11-20T11:00:00') },
        { vehicleId: 'v1', plate: 'KCS 082M', code: 214, occurredAt: at('2026-11-20T12:00:00') },
      ],
    )
    expect([...rows.keys()]).toEqual(['v1', 'plate:KCN901F'])
    expect(rows.get('v1')!.times).toEqual({
      accel: [at('2026-11-20T08:00:00').getTime()],
      brake: [at('2026-11-20T07:00:00').getTime(), at('2026-11-20T09:00:00').getTime()],
      seatbelt: [], phone: [at('2026-11-20T10:00:00').getTime()], covered: [],
    })
    expect(rows.get('plate:KCN901F')).toMatchObject({ vehicleId: null, plate: 'KCN 901F' })
  })

  it('building a day replaces its rows and marks it built, whole only when its capture was', async () => {
    ;(prismaMock.notification.findMany as any).mockResolvedValue([
      { vehicleId: 'v1', plate: 'KCS 082M', alertType: 'HARSH_BRAKING', occurredAt: at('2026-11-20T09:00:00') },
    ])
    ;(prismaMock.dashcamAlarm.findMany as any).mockResolvedValue([{ vehicleId: 'v1', plate: 'KCS 082M', code: 123, occurredAt: at('2026-11-20T10:00:00') }])
    ;(prismaMock.dashcamCaptureDay.findUnique as any).mockResolvedValue({ capturedAt: at('2026-11-21T01:30:00'), partial: false, untyped: 4 })
    const b = await days.buildDay('o1', '2026-11-20', NOW)
    expect(b).toMatchObject({ vehicles: 1, harsh: 1, alarms: 1, captured: true })
    const where = (prismaMock.notification.findMany as any).mock.calls[0][0].where
    expect(where.occurredAt).toEqual({ gte: new Date('2026-11-19T21:00:00Z'), lt: new Date('2026-11-20T21:00:00Z') })
    expect(prismaMock.driverConductDay.deleteMany).toHaveBeenCalledWith({ where: { organisationId: 'o1', day: '2026-11-20' } })
    expect((prismaMock.driverConductDay.createMany as any).mock.calls[0][0].data[0]).toMatchObject({ vehicleKey: 'v1', brake: 1, covered: 1 })
    expect((prismaMock.driverConductBuiltDay.upsert as any).mock.calls[0][0].create).toMatchObject({ captured: true, untyped: 4 })

    ;(prismaMock.dashcamCaptureDay.findUnique as any).mockResolvedValue({ capturedAt: at('2026-11-21T01:30:00'), partial: true, untyped: 0 })
    expect((await days.buildDay('o1', '2026-11-20', NOW)).captured).toBe(false)
    ;(prismaMock.dashcamCaptureDay.findUnique as any).mockResolvedValue(null)
    expect((await days.buildDay('o1', '2026-11-20', NOW)).captured).toBe(false)
  })

  it('never builds a day that has not ended', async () => {
    await expect(days.buildDay('o1', '2026-11-25', NOW)).rejects.toThrow('has not ended')
  })
})

describe('which days a cycle builds', () => {
  const cands = ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24']
  it('missing days, the last few again, and days whose capture is newer than their build', () => {
    const built = new Map([
      ['2026-11-20', { captureAt: at('2026-11-21T01:30:00') }],
      ['2026-11-21', { captureAt: at('2026-11-22T01:30:00') }],
      ['2026-11-23', { captureAt: null }],
      ['2026-11-24', { captureAt: null }],
    ])
    const captures = new Map([
      ['2026-11-20', { capturedAt: at('2026-11-21T01:30:00') }],
      ['2026-11-21', { capturedAt: at('2026-11-24T01:30:00') }],
    ])
    expect(days.daysToBuild(cands, built, captures, 2)).toEqual(['2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24'])
  })

  it('a month back at most, and nothing before the tables exist', async () => {
    ;(prismaMock.organisation.findMany as any).mockResolvedValue([{ id: 'o1', code: 'SUKARI' }])
    const c = await days.runConductDays({ now: Date.parse('2026-12-20T03:00:00+03:00') })
    expect(c.built[0]!.day).toBe('2026-12-01')
    expect(c.built.at(-1)!.day).toBe('2026-12-19')
    days.resetConductDaysState()
    ;(prismaMock.$queryRaw as any).mockResolvedValue([{ ok: false }])
    expect((await days.runConductDays({ now: NOW })).skipped).toBe('no-tables')
  })

  it('one day failing does not stop the rest', async () => {
    ;(prismaMock.organisation.findMany as any).mockResolvedValue([{ id: 'o1', code: 'SUKARI' }])
    ;(prismaMock.notification.findMany as any).mockImplementation(async ({ where }: any) => {
      if (where.occurredAt.gte.getTime() === new Date('2026-11-22T21:00:00Z').getTime()) throw new Error('timeout')
      return []
    })
    const c = await days.runConductDays({ now: NOW })
    expect(c.failed).toEqual([{ org: 'SUKARI', day: '2026-11-23', error: 'timeout' }])
    expect(c.built.map((b) => b.day)).toContain('2026-11-24')
  })
})

describe('reading the days', () => {
  it('from the first day still kept, a scoped reader seeing only its vehicles', async () => {
    ;(prismaMock.driverConductBuiltDay.findMany as any).mockResolvedValue([{ day: '2026-11-20', builtAt: at('2026-11-21T02:30:00'), captured: true, untyped: 2 }])
    ;(prismaMock.driverConductDay.findMany as any).mockResolvedValue([{ day: '2026-11-20', vehicleId: 'v1', plate: 'KCS 082M', times: { accel: [1], brake: [], seatbelt: [], phone: [], covered: [] } }])
    const r = await days.readConductDays('o1', '2026-10-26', '2026-11-24', new Set(['v1']), NOW)
    const where = (prismaMock.driverConductDay.findMany as any).mock.calls[0][0].where
    expect(where.day).toEqual({ gte: '2026-11-01', lte: '2026-11-24' })
    expect(where.vehicleId).toEqual({ in: ['v1'] })
    expect(r).toMatchObject({ keepFrom: '2026-11-01', days: [{ day: '2026-11-20', captured: true, untyped: 2 }], rows: [{ vehicleId: 'v1' }] })
  })

  it('nothing for a stretch that has expired', async () => {
    const r = await days.readConductDays('o1', '2026-10-01', '2026-10-31', null, NOW)
    expect(r.days).toEqual([])
    expect(prismaMock.driverConductDay.findMany).not.toHaveBeenCalled()
  })
})
