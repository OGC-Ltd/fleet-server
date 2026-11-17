/**
 * Which new traces the app records, decided when the trace starts.
 *
 * Every request is kept: those are what people ask about ("what did this
 * address do", "why was that page slow"). Work the server starts on its own
 * clock (the Wialon poll every 2 s, fuel passes, BullMQ jobs, stray timer
 * queries) is kept at a share: the live poll alone runs hundreds of SQL
 * statements a cycle, and recording all of them cost about a core on the
 * 2-vCPU box and filled Jaeger in minutes (2026-11-17). A share still shows
 * their shape; their durations and skipped ticks are counted in full as
 * metrics (lib/tracing), and their warnings and errors as log lines.
 *
 * A trace that is not kept is skipped at the source: its spans are not
 * recorded, so the queries under it cost almost nothing.
 */
import { SpanKind, type Attributes, type Context, type Link } from '@opentelemetry/api'
import { SamplingDecision, TraceIdRatioBasedSampler, type Sampler, type SamplingResult } from '@opentelemetry/sdk-trace'

export const DEFAULT_BACKGROUND_RATIO = 0.05

/** FLEET_TRACE_BACKGROUND_RATIO, 0..1; anything else falls back to the default. */
export function backgroundRatio(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_BACKGROUND_RATIO
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_BACKGROUND_RATIO
}

/** The root sampler: every server span, a share of the rest. Wrapped in ParentBased by the SDK. */
export class FleetRootSampler implements Sampler {
  private readonly background: TraceIdRatioBasedSampler

  constructor(private readonly ratio: number) {
    this.background = new TraceIdRatioBasedSampler(ratio)
  }

  shouldSample(context: Context, traceId: string, _spanName: string, spanKind: SpanKind, _attributes: Attributes, _links: Link[]): SamplingResult {
    if (spanKind === SpanKind.SERVER) return { decision: SamplingDecision.RECORD_AND_SAMPLED }
    return this.background.shouldSample(context, traceId)
  }

  toString(): string {
    return `FleetRootSampler{server=all, background=${this.ratio}}`
  }
}
