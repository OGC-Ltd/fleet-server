/**
 * Probe hold (operator, 2026-10-01): a unit flagged for a fuel probe repair is
 * never flagged for a critical fuel theft until the issue is resolved.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/zone-presence.js', () => ({ resolveEstatePlaces: vi.fn(async () => []) }))

import { prismaMock } from '../helpers/prisma.mock.js'
import { eventBus } from '../../src/lib/event-bus.js'
import { PROBE_REPORTED_NOTE, probeHoldVehicleIds } from '../../src/modules/fuel/probe-hold.js'
import { ingestWialonNotifications } from '../../src/modules/webhooks/wialon-notifications.service.js'

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.organisation.findUnique as any).mockResolvedValue({ id: 'org_kasulu' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.providerAlert.findUnique as any).mockResolvedValue(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.providerAlert.create as any).mockResolvedValue({ id: 'pa_1' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.vehicle.findUnique as any).mockResolvedValue({ id: 'veh_1', registrationPlate: 'DZ 20', organisationId: 'org_kasulu' })
  vi.spyOn(eventBus, 'publish').mockImplementation(() => undefined as never)
})

const message = () =>
  (prismaMock.providerAlert.create.mock.calls.at(-1)?.[0] as { data: { message: string } }).data.message
const severity = () =>
  (prismaMock.providerAlert.create.mock.calls.at(-1)?.[0] as { data: { severity: string } }).data.severity

describe('units reported for a probe repair', () => {
  it('holds a unit with an open probe job or an open probe-fault case, and asks for both', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.$queryRaw as any).mockResolvedValue([{ vehicle_id: 'veh_1' }])
    const held = await probeHoldVehicleIds(['veh_1', 'veh_2'])
    expect([...held]).toEqual(['veh_1'])
    const sql = (prismaMock.$queryRaw.mock.calls.at(-1)?.[0] as TemplateStringsArray).join('?')
    expect(sql).toContain('resolved_at IS NULL')
    expect(sql).toContain("target_kind = 'probe'")
    expect(sql).toContain("status = 'PROBE_FAULT'")
  })

  it('asks nothing for no vehicles', async () => {
    prismaMock.$queryRaw.mockClear()
    expect((await probeHoldVehicleIds([])).size).toBe(0)
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })

  // Operator, 2026-10-13: "do not put a unit on hold, but we can highlight it
  // was reported". A reported unit's alert keeps its severity and says so.
  it('keeps a provider fuel-drain alert critical on a reported unit, and says it was reported', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.$queryRaw as any).mockResolvedValue([{ vehicle_id: 'veh_1' }])
    await ingestWialonNotifications([{ notification: 'Fuel drain', unitId: 1, time: '2026-10-01 09:00:00' }] as never)
    expect(severity()).toBe('critical')
    expect(message()).toMatch(/Fuel drain — DZ 20/)
    expect(message()).toContain(PROBE_REPORTED_NOTE)
  })

  it('says nothing of a repair on a unit that is not reported', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.$queryRaw as any).mockResolvedValue([])
    await ingestWialonNotifications([{ notification: 'Fuel drain', unitId: 1, time: '2026-10-01 09:01:00' }] as never)
    expect(severity()).toBe('critical')
    expect(message()).not.toContain(PROBE_REPORTED_NOTE)
  })
})
