/**
 * The Alarms tab's data: VSS evidence for an organisation's devices, shaped
 * for the dashboard, with VSS's rate limit respected.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/config/env.js', async (orig) => {
  const real = await orig<typeof import('../../src/config/env.js')>()
  return { ...real, env: { ...real.env, VSS_TIMEZONE: 'Africa/Nairobi' } }
})

const vss = vi.hoisted(() => ({
  devices: [] as unknown[],
  calls: [] as { path: string; body: Record<string, unknown> }[],
  respond: (_path: string, _body: Record<string, unknown>): unknown => ({}),
}))
vi.mock('../../src/providers/vss/index.js', async (orig) => {
  const real = await orig<typeof import('../../src/providers/vss/index.js')>()
  return {
    ...real,
    vssAvailable: () => true,
    listDevices: async () => vss.devices,
    vssCall: async (path: string, body: Record<string, unknown>) => { vss.calls.push({ path, body }); return vss.respond(path, body) },
  }
})

import { prismaMock } from '../helpers/prisma.mock.js'
const { VssError, VSS_TOO_FREQUENT, parseChannels } = await import('../../src/providers/vss/index.js')
const svc = await import('../../src/modules/dashcam/dashcam.service.js')

const ORG = 'org_1'
const file = (guid: string, type: number, ch: number, url: string) =>
  ({ deviceID: '70462493', alarmGuid: guid, alarmType: null, fileType: type, channel: ch, downUrl: url, fileStartTime: '2026-10-23 17:45:17' })

beforeEach(() => {
  svc.resetDashcamState(0)
  vss.calls = []
  vss.devices = [
    { deviceId: '70462493', name: 'SUKARI - KCJ 099T', plate: '', accessMode: 1, channels: parseChannels('ROAD;IN CABIN;CH3', 3) },
    { deviceId: '99999999', name: 'OTHERCO - KDA 111A', plate: '', accessMode: 1, channels: parseChannels('', 1) },
  ]
  prismaMock.vehicle.findMany.mockResolvedValue([
    { id: 'veh_1', registrationPlate: 'KCJ 099T', name: 'Tipper 7' },
    { id: 'veh_2', registrationPlate: 'KCJ 555X', name: 'No camera' },
  ] as never)
  vss.respond = (path, body) => {
    if (path.endsWith('findRecords.action')) {
      return { dataList: [
        file('A1', 2, 1, 'https://vss.controltech-ea.com:9988/fileSrv/fileDown.php?filePath=x&token=SECRET1'),
        file('A1', 4, 2, 'https://vss.controltech-ea.com:9988/fileSrv/fileDown.php?filePath=y&token=SECRET2'),
        { ...file('B2', 4, 1, 'https://vss.controltech-ea.com:9988/z&token=SECRET3'), deviceID: '99999999' },
      ] }
    }
    if (path.endsWith('getAlarmByIds.action')) {
      return (body.guidList as string[]).map((g) => ({ guid: g, alarmtype: 214, createtime: '2026-10-23 17:45:17', AlarmGps: '34.382572,-0.82014', Speed: '10.89' }))
    }
    return {}
  }
})

describe('cameras', () => {
  it('counts the organisation’s vehicles that have a VSS device', async () => {
    expect(await svc.cameraCount(ORG, null)).toBe(1)
  })
  it('only the vehicles in the caller’s scope', async () => {
    expect(await svc.cameraCount(ORG, new Set(['veh_2']))).toBe(0)
  })
})

describe('alarms', () => {
  it('shapes VSS evidence for the dashboard', async () => {
    const a = await svc.getAlarms(ORG, null, '2026-10-23T00:00:00Z')
    expect(a.cameras).toBe(1)
    expect(a.incidents).toHaveLength(1)                     // the other company's device is not searched or shown
    const i = a.incidents[0]
    expect(i).toMatchObject({
      id: 'A1', code: 214, label: 'Harsh turn', category: 'braking', severity: 'warning',
      vehicleId: 'veh_1', plate: 'KCJ 099T', lat: -0.82014, lng: 34.382572, speed: 11,
      occurredAt: '2026-10-23T14:45:17Z',                    // 17:45:17 in Nairobi
    })
    expect(i.videos.map((v) => v.label)).toEqual(['Road camera'])
    expect(i.photos.map((v) => v.label)).toEqual(['In cabin'])
    expect(JSON.stringify(a)).not.toContain('SECRET')       // VSS links never leave the server
    const search = vss.calls.find((c) => c.path.endsWith('findRecords.action'))!
    expect(search.body.deviceIdList).toEqual(['70462493'])
  })

  it('a private link opens its file only for the organisation it was listed for', async () => {
    const a = await svc.getAlarms(ORG, null, '2026-10-23T00:00:00Z')
    const k = new URL(a.incidents[0].videos[0].url, 'http://x').searchParams.get('k')!
    expect(svc.fileFor(ORG, k)).toContain('token=SECRET1')
    expect(svc.fileFor('org_other', k)).toBeNull()
  })

  it('dashboards opening together share one VSS search, and a repeat is served from memory', async () => {
    await Promise.all([svc.getAlarms(ORG, null, '2026-10-23T00:00:00Z'), svc.getAlarms(ORG, null, '2026-10-23T00:01:00Z')])
    await svc.getAlarms(ORG, null, '2026-10-23T00:02:00Z')
    expect(vss.calls.filter((c) => c.path.endsWith('findRecords.action'))).toHaveLength(1)
  })

  it('keeps the pages that arrived when VSS refuses a later one', async () => {
    const big = Array.from({ length: 2000 }, (_, n) => file(`G${n}`, 4, 1, `https://vss.controltech-ea.com:9988/p${n}`))
    let page = 0
    const base = vss.respond
    vss.respond = (path, body) => {
      if (path.endsWith('findRecords.action')) {
        page++
        if (page === 2) throw new VssError('Requests too frequent', VSS_TOO_FREQUENT)
        return { dataList: big }
      }
      return base(path, body)
    }
    const a = await svc.getAlarms(ORG, null, '2026-10-23T00:00:00Z')
    expect(a.partial).toBe(true)
    expect(a.incidents).toHaveLength(2000)
  })

  it('VSS busy on the first search: the error reaches the route (which says "slow down")', async () => {
    vss.respond = () => { throw new VssError('Requests too frequent', VSS_TOO_FREQUENT) }
    await expect(svc.getAlarms(ORG, null, '2026-10-23T00:00:00Z')).rejects.toMatchObject({ status: VSS_TOO_FREQUENT })
  })
})

describe('time and place', () => {
  it('VSS local time ↔ UTC', () => {
    expect(svc.fromVssTime('2026-10-23 17:45:17', 'Africa/Nairobi')).toBe(Date.parse('2026-10-23T14:45:17Z'))
    expect(svc.vssTime(Date.parse('2026-10-23T14:45:17Z'), 'Africa/Nairobi')).toBe('2026-10-23 17:45:17')
    expect(svc.fromVssTime('not a time')).toBeNull()
  })
  it('"lng,lat", and no fix', () => {
    expect(svc.vssGps('34.382572,-0.82014')).toEqual([-0.82014, 34.382572])
    expect(svc.vssGps('0,0')).toEqual([null, null])
    expect(svc.vssGps('')).toEqual([null, null])
  })
})
