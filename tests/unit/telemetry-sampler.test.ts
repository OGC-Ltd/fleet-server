import { describe, it, expect } from 'vitest'
import { ROOT_CONTEXT, SpanKind, TraceFlags, trace } from '@opentelemetry/api'
import { SamplingDecision } from '@opentelemetry/sdk-trace'
import { FleetRootSampler, backgroundRatio, fleetSampler, DEFAULT_BACKGROUND_RATIO } from '../../src/telemetry/sampler.js'

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

describe('fleetSampler', () => {
  const parent = (isRemote: boolean, sampled: boolean) =>
    trace.setSpanContext(ROOT_CONTEXT, {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
      isRemote,
    })
  const decide = (ctx: ReturnType<typeof parent>, kind: SpanKind) =>
    fleetSampler(0).shouldSample(ctx, '4bf92f3577b34da6a3ce929d0e0e4736', 'x', kind, {}, []).decision

  it('keeps a request whose client sent traceparent with the not-sampled flag', () => {
    expect(decide(parent(true, false), SpanKind.SERVER)).toBe(SamplingDecision.RECORD_AND_SAMPLED)
    expect(decide(parent(true, true), SpanKind.SERVER)).toBe(SamplingDecision.RECORD_AND_SAMPLED)
  })

  it('lets a client-sent sampled flag keep nothing but requests', () => {
    expect(decide(parent(true, true), SpanKind.INTERNAL)).toBe(SamplingDecision.NOT_RECORD)
  })

  it('children follow their in-process parent', () => {
    expect(decide(parent(false, true), SpanKind.CLIENT)).toBe(SamplingDecision.RECORD_AND_SAMPLED)
    expect(decide(parent(false, false), SpanKind.CLIENT)).toBe(SamplingDecision.NOT_RECORD)
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
