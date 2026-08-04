import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
// Estate resolution hits the geofence tables; the place label is not what these
// tests are about.
vi.mock('../../src/lib/zone-presence.js', () => ({ resolveEstatePlaces: vi.fn(async () => []) }))

import { prismaMock } from '../helpers/prisma.mock.js'
import { eventBus } from '../../src/lib/event-bus.js'
import { ingestWialonNotifications } from '../../src/modules/webhooks/wialon-notifications.service.js'

const KASULU_ID = 'org_kasulu'
const SUKARI_ID = 'org_sukari'

/** The org lookup is the FALLBACK path only — it resolves KASULU by code. */
const orgLookup = () => ({ id: KASULU_ID })

function alertCreateArgs() {
  const call = prismaMock.providerAlert.create.mock.calls.at(-1)
  return (call?.[0] as { data: Record<string, unknown> }).data
}

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.organisation.findUnique as any).mockResolvedValue(orgLookup())
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.providerAlert.findUnique as any).mockResolvedValue(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.providerAlert.create as any).mockResolvedValue({ id: 'pa_1' })
  vi.spyOn(eventBus, 'publish').mockImplementation(() => undefined as never)
})

describe('tenancy — the alert follows the vehicle, not a hardcoded org', () => {
  it('files a Sukari unit\'s notification under SUKARI', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.vehicle.findUnique as any).mockResolvedValue({
      id: 'veh_sukari', registrationPlate: 'KDE 156W', organisationId: SUKARI_ID,
    })

    const out = await ingestWialonNotifications([
      { notification: 'Fuel theft', unitId: 123456, time: '2026-08-02 09:00:00' },
    ] as never)

    expect(out.created).toBe(1)
    // The whole point: before this, every Wialon notification was attributed to
    // KASULU, putting Sukari's alerts in another company's feed.
    expect(alertCreateArgs()['organisationId']).toBe(SUKARI_ID)
  })

  it('falls back to KASULU when the unit cannot be matched', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.vehicle.findUnique as any).mockResolvedValue(null)

    await ingestWialonNotifications([
      { notification: 'Geofence exit', unitId: 999999, time: '2026-08-02 09:00:00' },
    ] as never)

    expect(alertCreateArgs()['organisationId']).toBe(KASULU_ID)
    expect(alertCreateArgs()['vehicleId']).toBeNull()
  })

  it('refuses to link a plate held by more than one org', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.vehicle.findMany as any).mockResolvedValue([
      { id: 'veh_a', registrationPlate: 'KDE 156W', organisationId: SUKARI_ID },
      { id: 'veh_b', registrationPlate: 'KDE 156W', organisationId: KASULU_ID },
    ])

    await ingestWialonNotifications([
      { notification: 'Fuel filling', unit: 'KDE 156W', time: '2026-08-02 09:00:00' },
    ] as never)

    // Ambiguous — no vehicle link, and the fallback org rather than a coin toss.
    expect(alertCreateArgs()['vehicleId']).toBeNull()
    expect(alertCreateArgs()['organisationId']).toBe(KASULU_ID)
  })
})

describe('severity from the rule name', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.vehicle.findUnique as any).mockResolvedValue({
      id: 'veh_1', registrationPlate: 'CTR 03', organisationId: KASULU_ID,
    })
  })

  const severityFor = async (name: string) => {
    await ingestWialonNotifications([
      { notification: name, unitId: 1, time: '2026-08-02 09:00:00' },
    ] as never)
    return alertCreateArgs()['severity']
  }

  it('treats drains and siphoning as critical', async () => {
    expect(await severityFor('Fuel drain')).toBe('critical')
    expect(await severityFor('Siphoning detected')).toBe('critical')
    expect(await severityFor('Fuel theft')).toBe('critical')
    expect(await severityFor('Sudden fuel drop')).toBe('critical')
  })

  it('treats fillings as info', async () => {
    expect(await severityFor('Fuel filling')).toBe('info')
    expect(await severityFor('Refuel event')).toBe('info')
  })

  it('does not let "Fuel filling stop" be read as a stop event', async () => {
    // The generic rule maps stop/start to info as well, so this only proves the
    // fuel branch runs first — but a "Fuel drain stop" must stay critical.
    expect(await severityFor('Fuel drain stop')).toBe('critical')
  })

  it('leaves unmatched rules as a warning rather than downgrading them', async () => {
    expect(await severityFor('Harsh cornering')).toBe('warning')
  })
})

describe('the amount is what makes a fuel alert actionable', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.vehicle.findUnique as any).mockResolvedValue({
      id: 'veh_1', registrationPlate: 'CTR 03', organisationId: KASULU_ID,
    })
  })

  it('renders the volume and tank level when the template sends them', async () => {
    await ingestWialonNotifications([
      { notification: 'Fuel theft', unitId: 1, time: '2026-08-02 09:00:00', volumeL: 80.83, fuelLevelL: 679.09 },
    ] as never)

    const message = String(alertCreateArgs()['message'])
    expect(message).toContain('80.8 L')
    expect(message).toContain('tank 679.1 L')
  })

  it('renders a whole number without false precision', async () => {
    await ingestWialonNotifications([
      { notification: 'Fuel filling', unitId: 1, time: '2026-08-02 09:00:00', volumeL: 40 },
    ] as never)

    expect(String(alertCreateArgs()['message'])).toContain('40 L')
  })

  it('still produces a usable alert when no volume is sent', async () => {
    const out = await ingestWialonNotifications([
      { notification: 'Fuel theft', unitId: 1, time: '2026-08-02 09:00:00' },
    ] as never)

    expect(out.created).toBe(1)
    const message = String(alertCreateArgs()['message'])
    expect(message).toContain('Fuel theft')
    expect(message).not.toContain('L')
  })
})
