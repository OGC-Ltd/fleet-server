import { describe, it, expect } from 'vitest'
import { ROOT_CONTEXT, SpanKind } from '@opentelemetry/api'
import { SamplingDecision } from '@opentelemetry/sdk-trace'
import { FleetRootSampler, backgroundRatio, DEFAULT_BACKGROUND_RATIO } from '../../src/telemetry/sampler.js'

// Trace ids spread evenly over the id space (never all zeros, which is not a
// valid id), so a ratio sampler keeps about its share.
const ids = Array.from({ length: 2000 }, (_, i) => (BigInt(i + 1) * (2n ** 128n / 2001n)).toString(16).padStart(32, '0'))
const kept = (s: FleetRootSampler, kind: SpanKind) =>
  ids.filter((id) => s.shouldSample(ROOT_CONTEXT, id, 'x', kind, {}, []).decision === SamplingDecision.RECORD_AND_SAMPLED).length

describe('FleetRootSampler', () => {
  it('keeps every request', () => {
    expect(kept(new FleetRootSampler(0), SpanKind.SERVER)).toBe(ids.length)
  })

  it('keeps a share of background roots (loop runs, jobs, stray calls)', () => {
    const s = new FleetRootSampler(0.05)
    for (const kind of [SpanKind.INTERNAL, SpanKind.CONSUMER, SpanKind.CLIENT]) {
      const n = kept(s, kind)
      expect(n).toBeGreaterThan(ids.length * 0.03)
      expect(n).toBeLessThan(ids.length * 0.07)
    }
  })

  it('drops all background at 0 and keeps all at 1', () => {
    expect(kept(new FleetRootSampler(0), SpanKind.INTERNAL)).toBe(0)
    expect(kept(new FleetRootSampler(1), SpanKind.INTERNAL)).toBe(ids.length)
  })
})

describe('backgroundRatio', () => {
  it.each([
    [undefined, DEFAULT_BACKGROUND_RATIO],
    ['', DEFAULT_BACKGROUND_RATIO],
    ['0.2', 0.2],
    ['0', 0],
    ['1', 1],
    ['1.5', DEFAULT_BACKGROUND_RATIO],
    ['-1', DEFAULT_BACKGROUND_RATIO],
    ['lots', DEFAULT_BACKGROUND_RATIO],
  ])('%s → %s', (raw, want) => {
    expect(backgroundRatio(raw)).toBe(want)
  })
})
