/**
 * One organisation's failure does not cost the others their sweep.
 *
 * On 2026-11-24 the probe report timed out for one organisation, the loop over
 * organisations threw on it, and every organisation after it in the list went
 * unswept on every 15-minute run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../../src/lib/event-bus.js', () => ({ eventBus: { publish: vi.fn(), subscribe: vi.fn() } }))
vi.mock('../../src/modules/fuel/probe-report.service.js', () => ({ getProbeReport: vi.fn() }))

import { prismaMock } from '../helpers/prisma.mock.js'
import { env } from '../../src/config/env.js'
import { getProbeReport } from '../../src/modules/fuel/probe-report.service.js'
import { sweepAllOrgs } from '../../src/modules/telemetry/sensor-fault-sweep.service.js'

beforeEach(() => {
  env.INCIDENT_CAPTURE_ENABLED = true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.organisation.findMany as any).mockResolvedValue([{ id: 'org_a' }, { id: 'org_b' }, { id: 'org_c' }])
  vi.mocked(getProbeReport).mockReset()
})

describe('sweepAllOrgs', () => {
  it('sweeps every organisation even when one fails, then reports the failure', async () => {
    vi.mocked(getProbeReport).mockImplementation(async (orgId?: string) => {
      if (orgId === 'org_b') throw new Error('canceling statement due to statement timeout')
      return []
    })

    await expect(sweepAllOrgs()).rejects.toThrow('failed for 1 of 3 organisations: org_b')
    expect(vi.mocked(getProbeReport).mock.calls.map(c => c[0])).toEqual(['org_a', 'org_b', 'org_c'])
  })

  it('returns the totals when every organisation succeeds', async () => {
    vi.mocked(getProbeReport).mockResolvedValue([])
    await expect(sweepAllOrgs()).resolves.toEqual({ opened: 0, closed: 0, skipped: 0 })
  })
})
