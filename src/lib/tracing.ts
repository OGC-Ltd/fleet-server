/**
 * What the app itself adds to OpenTelemetry (telemetry/sdk.ts does the rest).
 *
 * Requests are traced by the http/express instrumentations; everything the
 * server does on its own clock is not, because no request starts it. These
 * give that work a trace of its own, so a poll cycle, a fuel pass or a mail
 * job shows up in Jaeger as one tree with every query and outside call under
 * it, instead of hundreds of loose database spans.
 *
 * All of it goes through @opentelemetry/api, which is a no-op until the SDK is
 * registered. With OTEL_EXPORTER_OTLP_ENDPOINT unset (tests, dev, pm2) these
 * cost a function call and record nothing.
 */
import { metrics, SpanKind, SpanStatusCode, trace, type Attributes } from '@opentelemetry/api'
import { Worker, type Job, type Processor, type WorkerOptions } from 'bullmq'

const tracer = trace.getTracer('fleet-server')
const meter = metrics.getMeter('fleet-server')

/**
 * Runs `fn` inside a new span. `root: true` starts a new trace rather than
 * hanging the span under whatever happened to be active (a timer callback can
 * inherit the context of the request that armed it).
 */
export async function inSpan<T>(
  name: string,
  attributes: Attributes,
  fn: () => Promise<T>,
  opts: { root?: boolean; kind?: SpanKind } = {},
): Promise<T> {
  return tracer.startActiveSpan(name, { root: opts.root, kind: opts.kind ?? SpanKind.INTERNAL, attributes }, async (span) => {
    try {
      return await fn()
    } catch (err) {
      span.recordException(err as Error)
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message })
      throw err
    } finally {
      span.end()
    }
  })
}

/** Background loops (lib/poll-loop): how long each run took, and the ticks skipped. */
export const loopRunDuration = meter.createHistogram('fleet.loop.run.duration', {
  description: 'Duration of one run of a background poll loop',
  unit: 'ms',
  advice: { explicitBucketBoundaries: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 300000] },
})
export const loopTicksSkipped = meter.createCounter('fleet.loop.ticks.skipped', {
  description: 'Ticks skipped because the previous run was still in flight',
})

/** BullMQ jobs: one trace per job, named after the queue and the job. */
export const jobDuration = meter.createHistogram('fleet.job.duration', {
  description: 'Duration of one BullMQ job',
  unit: 'ms',
  advice: { explicitBucketBoundaries: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 300000, 900000] },
})

function tracedProcessor<D, R, N extends string>(queue: string, fn: Processor<D, R, N>): Processor<D, R, N> {
  return (job: Job<D, R, N>, token?: string, signal?: AbortSignal) => {
    const t0 = performance.now()
    let outcome = 'ok'
    return inSpan(
      `job ${queue}:${job.name}`,
      { 'messaging.system': 'bullmq', 'messaging.destination.name': queue, 'messaging.operation.name': 'process', 'messaging.message.id': job.id ?? '', 'fleet.job.attempt': job.attemptsMade + 1 },
      async () => {
        try {
          return await fn(job, token, signal)
        } catch (err) {
          outcome = 'error'
          throw err
        } finally {
          jobDuration.record(performance.now() - t0, { queue, job: job.name, outcome })
        }
      },
      { root: true, kind: SpanKind.CONSUMER },
    )
  }
}

/**
 * A BullMQ Worker whose processor runs in its own trace. Imported in place of
 * bullmq's (`import { TracedWorker as Worker }`) so call sites do not change.
 * A sandboxed processor (a file path) is passed through untouched.
 */
export class TracedWorker<D = unknown, R = unknown, N extends string = string> extends Worker<D, R, N> {
  constructor(name: string, processor?: string | URL | null | Processor<D, R, N>, opts?: WorkerOptions) {
    super(name, typeof processor === 'function' ? tracedProcessor(name, processor) : processor, opts)
  }
}

const SDK_KEY = Symbol.for('fleet.otel.sdk')

/** Exports what is still buffered. Called on shutdown; resolves at once when telemetry is off. */
export async function flushTelemetry(timeoutMs = 3000): Promise<void> {
  const sdk = (globalThis as Record<symbol, { shutdown(): Promise<void> } | undefined>)[SDK_KEY]
  if (!sdk) return
  await Promise.race([sdk.shutdown().catch(() => {}), new Promise((r) => setTimeout(r, timeoutMs).unref())])
}
