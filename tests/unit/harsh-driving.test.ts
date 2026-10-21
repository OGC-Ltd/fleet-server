import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/zone-presence.js', () => ({ resolveEstatePlaces: vi.fn(async () => [{ name: 'FARM#212' }]) }))

import { prismaMock } from '../helpers/prisma.mock.js'
import { eventBus, type HarshDrivingEvent } from '../../src/lib/event-bus.js'
import { readHarshDriving } from '../../src/providers/wialon/wialon.sensors.js'
import { recordHarshEvent, harshMessage } from '../../src/lib/workers/harsh-driving.worker.js'

describe('readHarshDriving — Teltonika Green Driving, io_253/io_254', () => {
  it('reads the kind and the force in m/s²', () => {
    expect(readHarshDriving({ io_253: 1, io_254: 312 })).toEqual({ kind: 'ACCELERATION', ms2: 3.12 })
    expect(readHarshDriving({ io_253: 2, io_254: '275' })).toEqual({ kind: 'BRAKING', ms2: 2.75 })
    expect(readHarshDriving({ io_253: 3 })).toEqual({ kind: 'CORNERING', ms2: null })
  })

  it('is no event on an ordinary message', () => {
    expect(readHarshDriving({ io_17: 0.01, pwr_ext: 27.5 })).toBeNull()
    expect(readHarshDriving({ io_253: 0, io_254: 0 })).toBeNull()
    expect(readHarshDriving({ io_253: 9 })).toBeNull()
    expect(readHarshDriving(null)).toBeNull()
  })
})

describe('harshMessage', () => {
  it('says what, which unit, where, how fast and how hard', () => {
    expect(harshMessage('Harsh braking', 'KDA 123X', 'FARM#212', 41.6, 3.1))
      .toBe('Harsh braking — KDA 123X at FARM#212 42 km/h (3.1 m/s²)')
    expect(harshMessage('Harsh acceleration', 'KDA 123X', null, 0, null))
      .toBe('Harsh acceleration — KDA 123X')
  })
})

describe('recordHarshEvent', () => {
  const event = (kind: HarshDrivingEvent['kind']): HarshDrivingEvent => ({
    deviceId: 'wialon:42', unitName: 'MUFINDI - FT 13', at: new Date('2026-10-21T08:15:30Z'),
    kind, ms2: 3.1, lat: -4.9, lng: 30.1, speedKmh: 38,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.providerAlert.findUnique as any).mockResolvedValue(null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.providerAlert.create as any).mockResolvedValue({ id: 'pa_9' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.vehicle.findUnique as any).mockResolvedValue({ id: 'veh_1', registrationPlate: 'FT 13', organisationId: 'org_k' })
    vi.spyOn(eventBus, 'publish').mockImplementation(() => undefined as never)
  })

  it('records a harsh brake as a warning and sends it to the feed', async () => {
    await recordHarshEvent(event('BRAKING'))
    const data = (prismaMock.providerAlert.create.mock.calls[0]![0] as { data: Record<string, unknown> }).data
    expect(data).toMatchObject({
      type: 'HARSH_BRAKING', severity: 'warning', vehicleId: 'veh_1', organisationId: 'org_k', plate: 'FT 13',
      externalId: `harsh:wialon:42:HARSH_BRAKING:${Date.parse('2026-10-21T08:15:30Z') / 1000}`,
      message: 'Harsh braking — FT 13 at FARM#212 38 km/h (3.1 m/s²)',
    })
    expect(eventBus.publish).toHaveBeenCalledWith('provider:alert', expect.objectContaining({
      alertType: 'HARSH_BRAKING', severity: 'warning', vehicleId: 'veh_1', id: 'wn-pa_9',
    }))
  })

  it('records a harsh acceleration the same way', async () => {
    await recordHarshEvent(event('ACCELERATION'))
    const data = (prismaMock.providerAlert.create.mock.calls[0]![0] as { data: Record<string, unknown> }).data
    expect(data['type']).toBe('HARSH_ACCELERATION')
  })

  it('writes nothing twice for the same event', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.providerAlert.findUnique as any).mockResolvedValue({ id: 'pa_9' })
    await recordHarshEvent(event('BRAKING'))
    expect(prismaMock.providerAlert.create).not.toHaveBeenCalled()
    expect(eventBus.publish).not.toHaveBeenCalled()
  })

  it('leaves cornering and units we do not hold alone', async () => {
    await recordHarshEvent(event('CORNERING'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.vehicle.findUnique as any).mockResolvedValue(null)
    await recordHarshEvent(event('BRAKING'))
    expect(prismaMock.providerAlert.create).not.toHaveBeenCalled()
  })
})
