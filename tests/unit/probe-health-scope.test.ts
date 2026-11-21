/**
 * Probes for a caller limited to some units (operator, 2026-11-21: technicians
 * "on the probes they will only see the flagged units"): only those units'
 * rows, and the tallies counted over them alone.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/modules/fuel/probe-report.service.js', () => ({
  getProbeReport: vi.fn(async () => [
    { vehicleId: 'v1', needsAttention: true, fuelProbe: { state: 'DIED' }, fuelSensor: { uncalibrated: false }, trackerSilent: false },
    { vehicleId: 'v2', needsAttention: false, fuelProbe: { state: 'OK' }, fuelSensor: { uncalibrated: false }, trackerSilent: false },
    { vehicleId: 'v3', needsAttention: true, fuelProbe: { state: 'SILENT' }, fuelSensor: { uncalibrated: true }, trackerSilent: false },
  ]),
}))

const { listProbeHealth } = await import('../../src/modules/fuel/fuel.controller.js')

type Sent = { rows: { vehicleId: string }[]; summary: { total: number; needsAttention: number } }

async function call(vehicleIds: Set<string> | null) {
  const json = vi.fn()
  const res = { status: vi.fn(() => res), json } as unknown as Parameters<typeof listProbeHealth>[1]
  const next = vi.fn()
  const req = { params: { orgId: 'o1' }, query: {}, authz: { vehicleIds } } as unknown as Parameters<typeof listProbeHealth>[0]
  await listProbeHealth(req, res, next)
  expect(next).not.toHaveBeenCalled()
  return (json.mock.calls[0]![0] as { data: Sent }).data
}

describe('probe health for a caller limited to some units', () => {
  it('sends only the units in scope, and counts only them', async () => {
    const sent = await call(new Set(['v1', 'v2']))
    expect(sent.rows.map((r) => r.vehicleId)).toEqual(['v1', 'v2'])
    expect(sent.summary.total).toBe(2)
    expect(sent.summary.needsAttention).toBe(1)
  })

  it('sends the whole fleet to an unlimited caller', async () => {
    const sent = await call(null)
    expect(sent.rows).toHaveLength(3)
    expect(sent.summary.total).toBe(3)
  })
})
