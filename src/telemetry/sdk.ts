/**
 * The OpenTelemetry SDK for fleet-server and the report worker: traces,
 * metrics and logs, all sent as OTLP to the collector in
 * deploy/observability (OTEL_EXPORTER_OTLP_ENDPOINT, e.g. http://otel-collector:4318).
 * Started by telemetry/register.ts, before the app loads.
 *
 * What is captured:
 *   traces   every HTTP request (express handlers, not each middleware or
 *            router), and inside a trace every SQL statement (pg, under
 *            Prisma's adapter), Redis command, outgoing fetch (Wialon, OpenAI,
 *            FactorySuite, Google) and https call (S3, mail); a trace per
 *            poll-loop run and BullMQ job (lib/tracing), a share of them kept.
 *   metrics  request rate/latency by route, runtime (event loop delay, heap,
 *            GC), loop and job durations.
 *   logs     every pino line, with trace_id/span_id, including the one-line
 *            request log (middleware/request-log) that carries the client IP.
 *
 * Sampling: every request trace is recorded; background work (poll loops,
 * jobs, timers) at FLEET_TRACE_BACKGROUND_RATIO (default 5 %), decided when
 * its trace starts (telemetry/sampler). Recording every poll query cost about
 * a core and filled Jaeger in minutes. The collector then tail-samples what
 * reaches Jaeger. Attribute values are cut at 2 KB: the live poll's multi-row
 * INSERTs run to hundreds of placeholders, and Jaeger refused those batches.
 *
 * Secrets: query values that look like credentials (Wialon's token/sid, signed
 * S3 URLs) and the account-setup token in its path are blanked in span
 * attributes before export (lib/scrub-query); SQL is sent without
 * parameter values; Redis spans carry the command name only. Log lines already
 * pass pino's redaction (lib/log-redact) before the instrumentation sees them.
 */
import os from 'node:os'
import { NodeSDK } from '@opentelemetry/sdk-node'
import type { Attributes, AttributeValue } from '@opentelemetry/api'
import type { ExportResult } from '@opentelemetry/core'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { ExpressInstrumentation, ExpressLayerType } from '@opentelemetry/instrumentation-express'
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg'
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis'
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici'
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino'
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node'
import { scrubUrl } from '../lib/scrub-query.js'
import { fleetSampler, backgroundRatio } from './sampler.js'

/** Span attributes that can hold a URL or a query string. */
const URL_ATTRS = ['url.full', 'url.path', 'url.query', 'url.original', 'http.url', 'http.target']

export function scrubAttributes(attrs: Attributes): void {
  for (const k of URL_ATTRS) {
    const v: AttributeValue | undefined = attrs[k]
    if (typeof v === 'string') attrs[k] = scrubUrl(v)
  }
}

/** Blanks credential-looking query values in every span before it is exported. */
class ScrubbingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}
  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    for (const s of spans) scrubAttributes(s.attributes as Attributes)
    this.inner.export(spans, done)
  }
  shutdown(): Promise<void> { return this.inner.shutdown() }
  forceFlush(): Promise<void> { return this.inner.forceFlush?.() ?? Promise.resolve() }
}

function serviceName(): string {
  return /report-worker\.(?:js|ts)$/.test(process.argv[1] ?? '') ? 'fleet-report-worker' : 'fleet-server'
}

export function startTelemetry(): NodeSDK {
  const sdk = new NodeSDK({
    // Named here, not from OTEL_SERVICE_NAME: the server and the report worker
    // share one env file, and each must keep its own name.
    autoDetectResources: false,
    resource: resourceFromAttributes({
      'service.name': serviceName(),
      'service.namespace': 'fleet',
      'service.version': process.env.APP_COMMIT ?? 'unknown',
      'service.instance.id': `${os.hostname()}:${process.pid}`,
      'deployment.environment.name': process.env.OTEL_DEPLOYMENT_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
      'host.name': os.hostname(),
    }),
    sampler: fleetSampler(backgroundRatio(process.env.FLEET_TRACE_BACKGROUND_RATIO)),
    spanLimits: { attributeValueLengthLimit: 2048 },
    spanProcessors: [
      new BatchSpanProcessor({
        exporter: new ScrubbingSpanExporter(new OTLPTraceExporter()),
        maxQueueSize: 8192,
        maxExportBatchSize: 1024,
        scheduledDelayMillis: 2000,
      }),
    ],
    metricReaders: [
      new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 30_000 }),
    ],
    logRecordProcessors: [
      new BatchLogRecordProcessor({ exporter: new OTLPLogExporter(), maxQueueSize: 8192, maxExportBatchSize: 1024, scheduledDelayMillis: 2000 }),
    ],
    instrumentations: [
      new HttpInstrumentation({
        // Docker's health check, every 30 s: noise, not traffic.
        ignoreIncomingRequestHook: (req) => req.url === '/health',
        headersToSpanAttributes: {
          server: { requestHeaders: ['user-agent', 'x-forwarded-for', 'x-real-ip', 'referer', 'origin'] },
        },
      }),
      // Handlers only, not the ~12 middlewares and the nested routers every
      // request passes (helmet, cors, json, /api/v1/organisations/:orgId...):
      // those multiply the spans per request and say nothing the request's
      // own duration does not.
      new ExpressInstrumentation({ ignoreLayersType: [ExpressLayerType.MIDDLEWARE, ExpressLayerType.ROUTER] }),
      // Only inside a trace (a request, a loop run, a job): a statement with no
      // parent would be a one-span trace saying nothing about why it ran.
      // Under a trace that is not kept it costs almost nothing.
      new PgInstrumentation({ requireParentSpan: true, ignoreConnectSpans: true, enhancedDatabaseReporting: false }),
      // Only inside a trace: BullMQ's own blocking reads would otherwise be a
      // root span every second. Command name only; keys and values stay out.
      new IORedisInstrumentation({ requireParentSpan: true, dbStatementSerializer: (cmd) => cmd }),
      new UndiciInstrumentation(),
      new PinoInstrumentation(),
      new RuntimeNodeInstrumentation({ monitoringPrecision: 5000 }),
    ],
  })
  sdk.start()
  ;(globalThis as Record<symbol, unknown>)[Symbol.for('fleet.otel.sdk')] = sdk
  return sdk
}
