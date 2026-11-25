/**
 * Today's weighings for the Ops Room Operator's pop-ups (2026-11-25): one line
 * per weighing, and each ticket's place among its unit's tickets today.
 */
import { describe, it, expect } from 'vitest'

const { weighingsOf } = await import('../../src/modules/weighments/weighment.recent.js')

const dayStart = new Date('2026-11-24T21:00:00Z') // 25 Nov, 00:00 EAT
const t = (id: string, plate: string, tokenAt: string, stamps: Partial<Record<'tareAt' | 'grossAt' | 'factoryTareAt' | 'factoryGrossAt', string>> = {}) => ({
  id, vehiclePlate: plate, vehicleNo: plate, driverName: 'D', centerName: 'Ndhiwa', category: 'CANE_DELIVERY',
  tokenNumber: BigInt(id.replace(/\D/g, '') || '1'), tokenAt: new Date(tokenAt), netWeightKg: null,
  tareAt: stamps.tareAt ? new Date(stamps.tareAt) : null, tareWeightKg: 9000, tareBridgeNo: 1,
  grossAt: stamps.grossAt ? new Date(stamps.grossAt) : null, grossWeightKg: 30000, grossBridgeNo: 2,
  factoryTareAt: stamps.factoryTareAt ? new Date(stamps.factoryTareAt) : null, factoryTareWeightKg: null, factoryTareBridgeNo: null,
  factoryGrossAt: stamps.factoryGrossAt ? new Date(stamps.factoryGrossAt) : null, factoryGrossWeightKg: null, factoryGrossBridgeNo: null,
})

describe('today’s weighings', () => {
  it('gives one line per weighing, newest first, with stable ids', () => {
    const out = weighingsOf([t('w1', 'KDA1', '2026-11-25T05:00:00Z', { grossAt: '2026-11-25T05:00:00Z', tareAt: '2026-11-25T06:00:00Z' })], dayStart, null)
    expect(out.map((w) => w.id)).toEqual(['w1:tare', 'w1:gross'])
    expect(out[1]).toMatchObject({ stamp: 'gross', kg: 30000, bridgeNo: 2, nthToday: 1 })
  })

  it('numbers a unit’s tickets in the order they were opened today', () => {
    const out = weighingsOf([
      t('w2', 'KDA1', '2026-11-25T10:00:00Z', { grossAt: '2026-11-25T10:00:00Z' }),
      t('w1', 'KDA1', '2026-11-25T05:00:00Z', { grossAt: '2026-11-25T05:00:00Z' }),
      t('w3', 'KBB2', '2026-11-25T07:00:00Z', { grossAt: '2026-11-25T07:00:00Z' }),
    ], dayStart, null)
    expect(Object.fromEntries(out.map((w) => [w.ticketId, w.nthToday]))).toEqual({ w1: 1, w2: 2, w3: 1 })
  })

  it('keeps yesterday’s ticket weighed after midnight, without counting it as today’s', () => {
    const out = weighingsOf([
      t('w0', 'KDA1', '2026-11-24T20:30:00Z', { grossAt: '2026-11-24T20:30:00Z', tareAt: '2026-11-24T21:30:00Z' }),
      t('w1', 'KDA1', '2026-11-25T05:00:00Z', { grossAt: '2026-11-25T05:00:00Z' }),
    ], dayStart, null)
    expect(out.map((w) => w.id)).toEqual(['w1:gross', 'w0:tare'])
    expect(out.find((w) => w.ticketId === 'w0')!.nthToday).toBeNull()
    expect(out.find((w) => w.ticketId === 'w1')!.nthToday).toBe(1)
  })

  it('gives only weighings after `since`, but still numbers the ticket within the whole day', () => {
    const out = weighingsOf([
      t('w1', 'KDA1', '2026-11-25T05:00:00Z', { grossAt: '2026-11-25T05:00:00Z' }),
      t('w2', 'KDA1', '2026-11-25T10:00:00Z', { grossAt: '2026-11-25T10:00:00Z' }),
    ], dayStart, new Date('2026-11-25T09:00:00Z'))
    expect(out.map((w) => [w.id, w.nthToday])).toEqual([['w2:gross', 2]])
  })
})
