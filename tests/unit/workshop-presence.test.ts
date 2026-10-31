/**
 * When a unit was in the workshop (repairs/workshop-presence): from its
 * booking's arrival to the job's completion, or its closing if never completed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

import { prismaMock } from '../helpers/prisma.mock.js'
import { workshopSpans, inSpans } from '../../src/modules/repairs/workshop-presence.js'

vi.mock('../../src/lib/prisma.js')

const at = (hm: string) => new Date(`2026-10-21T${hm}:00Z`)
const booking = (vehicleId: string, arrived: string, done: { completed?: string; resolved?: string } = {}) => ({
  arrivedAt: at(arrived),
  repairItem: { vehicleId, completedAt: done.completed ? at(done.completed) : null, resolvedAt: done.resolved ? at(done.resolved) : null },
})

describe('workshopSpans / inSpans', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.workshopBooking.findMany as any).mockResolvedValue([
      booking('v1', '08:00', { completed: '12:00', resolved: '15:00' }),   // completed at noon, verified later
      booking('v2', '09:00', { resolved: '10:00' }),                      // voided before completion
      booking('v3', '07:00'),                                             // still in
    ])
  })

  it('runs from arrival to completion, not to the later sign-off', async () => {
    const spans = await workshopSpans(['v1', 'v2', 'v3'], at('00:00'), at('23:00'))
    expect(inSpans(spans, 'v1', at('07:59'))).toBe(false)
    expect(inSpans(spans, 'v1', at('08:00'))).toBe(true)
    expect(inSpans(spans, 'v1', at('11:59'))).toBe(true)
    expect(inSpans(spans, 'v1', at('12:00'))).toBe(false)
    expect(inSpans(spans, 'v1', at('14:00'))).toBe(false)
  })

  it('ends at closing when the job was never completed, and stays open while it is neither', async () => {
    const spans = await workshopSpans(['v1', 'v2', 'v3'], at('00:00'), at('23:00'))
    expect(inSpans(spans, 'v2', at('09:30'))).toBe(true)
    expect(inSpans(spans, 'v2', at('10:30'))).toBe(false)
    expect(inSpans(spans, 'v3', at('22:00'))).toBe(true)
    expect(inSpans(spans, null, at('09:30'))).toBe(false)
  })

  it('asks only for arrived bookings, so a booked unit not yet there is not in it', async () => {
    await workshopSpans(['v1'], at('00:00'), at('23:00'))
    const where = (prismaMock.workshopBooking.findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where
    expect(where).toMatchObject({ status: 'arrived' })
  })
})
