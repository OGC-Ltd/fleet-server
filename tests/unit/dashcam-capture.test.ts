/**
 * Saving dashcam alarms from VSS (modules/dashcam/dashcam-capture and its
 * nightly job): numbers only, one row per alarm, safe to capture again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
const dash = vi.hoisted(() => ({
  answer: { incidents: [] as unknown[], cameras: 3, from: '', to: '' } as Record<string, unknown>,
  cameras: new Map<string, number>(),
  calls: [] as Array<[string, string | undefined, string | undefined]>,
  fail: new Set<string>(),
}))
vi.mock('../../src/modules/dashcam/dashcam.service.js', () => ({
  searchAlarms: vi.fn(async (orgId: string, _scope: unknown, since?: string, until?: string) => {
    dash.calls.push([orgId, since, until])
    if (dash.fail.has(orgId)) throw Object.assign(new Error('Requests too frequent'), { status: 10129 })
    return dash.answer
  }),
  cameraCount: vi.fn(async (orgId: string) => dash.cameras.get(orgId) ?? 0),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
const cap = await import('../../src/modules/dashcam/dashcam-capture.js')
const { runDashcamCapture } = await import('../../src/lib/queues/dashcam-capture.js')

const NOW = Date.parse('2026-11-24T15:00:00+03:00')
const inc = (id: string, at: string, code = 0, extra: Record<string, unknown> = {}) => ({
  id, code, label: code ? 'No seatbelt' : 'Alarm', group: code ? 'Driver' : '', severity: code ? 'warning' : 'informational',
  category: code ? 'driver' : 'other', occurredAt: new Date(`${at}+03:00`).toISOString(),
  vehicleId: 'veh_1', plate: 'KBF 933N', deviceId: 'dev_1', lat: -0.5, lng: 34.6, speed: 40, videos: [], photos: [], ...extra,
})

beforeEach(() => {
  cap.resetCaptureState()
  dash.calls = []
  dash.fail = new Set()
  dash.cameras = new Map()
  dash.answer = { incidents: [], cameras: 3, from: '', to: '' }
  ;(prismaMock.$queryRaw as any).mockResolvedValue([{ ok: true }])
  ;(prismaMock.dashcamAlarm.createMany as any).mockImplementation(async ({ data }: { data: unknown[] }) => ({ count: data.length }))
  ;(prismaMock.dashcamAlarm.updateMany as any).mockResolvedValue({ count: 0 })
  ;(prismaMock.dashcamCaptureDay.upsert as any).mockResolvedValue({})
})

describe('fleet days (Nairobi)', () => {
  it('a day runs from 00:00 EAT, 21:00 UTC the evening before', () => {
    const { from, to } = cap.dayWindow('2026-11-20')
    expect(new Date(from).toISOString()).toBe('2026-11-19T21:00:00.000Z')
    expect(to - from).toBe(86_400_000)
    expect(cap.fleetDayOf(Date.parse('2026-11-19T21:30:00Z'))).toBe('2026-11-20')
  })

  it('the last n days are the days before today, oldest first', () => {
    expect(cap.lastDays(3, NOW)).toEqual(['2026-11-21', '2026-11-22', '2026-11-23'])
  })
})

describe('capturing a day', () => {
  it('asks VSS for that day only, keeps its own alarms, and saves one row each', async () => {
    dash.answer = { cameras: 55, incidents: [
      inc('A1', '2026-11-20T08:00:00', 211),
      inc('A2', '2026-11-20T23:59:30'),
      inc('X9', '2026-11-21T00:00:40', 211),          // just past midnight: the next day's
    ] }
    const r = await cap.captureDay('org_1', '2026-11-20', { now: NOW })
    expect(dash.calls[0]).toEqual(['org_1', '2026-11-19T21:00:00.000Z', '2026-11-20T21:00:00.000Z'])
    expect(r).toMatchObject({ day: '2026-11-20', cameras: 55, alarms: 2, added: 2, untyped: 1, partial: false })
    const data = (prismaMock.dashcamAlarm.createMany as any).mock.calls[0][0]
    expect(data.skipDuplicates).toBe(true)
    expect(data.data.map((d: any) => d.id)).toEqual(['A1', 'A2'])
    expect(data.data[0]).toMatchObject({ organisationId: 'org_1', vehicleId: 'veh_1', plate: 'KBF 933N', code: 211, label: 'No seatbelt', speedKmh: 40 })
    // An untyped alarm is saved without words that could be read as a type
    expect(data.data[1]).toMatchObject({ code: 0, label: '', category: '', typedAt: null })
    expect(prismaMock.dashcamCaptureDay.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { organisationId_day: { organisationId: 'org_1', day: '2026-11-20' } },
      create: expect.objectContaining({ alarms: 2, untyped: 1, partial: false }),
    }))
  })

  it('types an alarm held without a type, and only such alarms', async () => {
    dash.answer = { cameras: 55, incidents: [inc('A1', '2026-11-20T08:00:00', 211), inc('A3', '2026-11-20T09:00:00', 211)] }
    ;(prismaMock.dashcamAlarm.createMany as any).mockResolvedValue({ count: 0 })        // both held already
    ;(prismaMock.dashcamAlarm.updateMany as any).mockResolvedValue({ count: 1 })
    const r = await cap.captureDay('org_1', '2026-11-20', { now: NOW })
    expect(prismaMock.dashcamAlarm.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['A1', 'A3'] }, organisationId: 'org_1', code: 0 },
      data: expect.objectContaining({ code: 211, label: 'No seatbelt', category: 'driver' }),
    })
    expect(r).toMatchObject({ added: 0, typed: 1 })
  })

  it('says when VSS gave only part of the day, so it is captured again', async () => {
    dash.answer = { cameras: 55, partial: true, incidents: [inc('A1', '2026-11-20T08:00:00', 211)] }
    expect((await cap.captureDay('org_1', '2026-11-20', { now: NOW })).partial).toBe(true)
  })

  it('a dry run reads VSS and writes nothing', async () => {
    dash.answer = { cameras: 55, incidents: [inc('A1', '2026-11-20T08:00:00', 211)] }
    const r = await cap.captureDay('org_1', '2026-11-20', { apply: false, now: NOW })
    expect(r).toMatchObject({ alarms: 1, added: 0 })
    expect(prismaMock.dashcamAlarm.createMany).not.toHaveBeenCalled()
    expect(prismaMock.dashcamCaptureDay.upsert).not.toHaveBeenCalled()
  })

  it('does nothing before the migration, for a fleet without dashcams, or for a day not begun', async () => {
    ;(prismaMock.$queryRaw as any).mockResolvedValue([{ ok: false }])
    expect((await cap.captureDay('org_1', '2026-11-20', { now: NOW })).skipped).toBe('no-tables')
    expect(dash.calls).toHaveLength(0)
    cap.resetCaptureState()
    ;(prismaMock.$queryRaw as any).mockResolvedValue([{ ok: true }])
    dash.answer = { cameras: 0, incidents: [] }
    expect((await cap.captureDay('org_1', '2026-11-20', { now: NOW })).skipped).toBe('no-cameras')
    expect((await cap.captureDay('org_1', '2026-11-25', { now: NOW })).skipped).toBe('future')
    expect(prismaMock.dashcamAlarm.createMany).not.toHaveBeenCalled()
  })
})

describe('the nightly cycle', () => {
  beforeEach(() => {
    ;(prismaMock.organisation.findMany as any).mockResolvedValue([{ id: 'o_aq', code: 'AQUAMIST' }, { id: 'o_none', code: 'NOCAMS' }, { id: 'o_su', code: 'SUKARI' }])
    dash.cameras = new Map([['o_aq', 55], ['o_su', 120]])
  })

  it('captures the last days for every organisation with dashcams, and none other', async () => {
    const c = await runDashcamCapture(3, NOW)
    expect(c.days).toEqual(['2026-11-21', '2026-11-22', '2026-11-23'])
    expect(c.orgs.map((o) => o.org)).toEqual(['AQUAMIST', 'SUKARI'])
    expect(dash.calls.map(([o]) => o)).toEqual(['o_aq', 'o_aq', 'o_aq', 'o_su', 'o_su', 'o_su'])
  })

  it('a day VSS refuses does not stop the others', async () => {
    dash.fail = new Set(['o_aq'])
    const c = await runDashcamCapture(2, NOW)
    expect(c.orgs.find((o) => o.org === 'AQUAMIST')?.error).toMatch(/too frequent/)
    expect(c.orgs.find((o) => o.org === 'SUKARI')?.days).toHaveLength(2)
  })

  it('before the migration it captures nothing and says so', async () => {
    ;(prismaMock.$queryRaw as any).mockResolvedValue([{ ok: false }])
    const c = await runDashcamCapture(3, NOW)
    expect(c.skipped).toBe('no-tables')
    expect(dash.calls).toHaveLength(0)
  })
})
