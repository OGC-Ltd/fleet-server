/**
 * The OpenTelemetry SDK for fleet-server and the report worker: traces,
 * metrics and logs, all sent as OTLP to the collector in
 * deploy/observability (OTEL_EXPORTER_OTLP_ENDPOINT, e.g. http://otel-collector:4318).
 * Started by telemetry/register.ts, before the app loads.
 *
 * What is captured:
 *   traces   every HTTP request (express routes, not each middleware), every
 *            SQL statement (pg, under Prisma's adapter), Redis commands made
 *            inside a trace, every outgoing fetch (Wialon, OpenAI,
 *            FactorySuite, Google) and https call (S3, mail), plus a trace per
 *            poll-loop run and BullMQ job (lib/tracing).
 *   metrics  request rate/latency by route, runtime (event loop delay, heap,
 *            GC), loop and job durations.
 *   logs     every pino line, with trace_id/span_id, including the one-line
 *            request log (middleware/request-log) that carries the client IP.
 *
 * Sampling happens in the collector (tail sampling), not here: the app sends
 * every span, so the decision can look at the whole trace (errors and slow
 * ones are always kept).
 *
 * Secrets: query values that look like credentials (Wialon's token/sid, signed
 * S3 URLs) are blanked in span attributes before export; SQL is sent without
 * parameter values; Redis spans carry the command name only. Log lines already
 * pass pino's redaction (lib/log-redact) before the instrumentation sees them.
 */
import os from 'node:os'
import { NodeSDK } from '@opentelemetry/sdk-node'
import type { Attributes, AttributeValue } from '@opentelemetry/api'
import type { ExportResult } from '@opentelemetry/core'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, ParentBasedSampler, AlwaysOnSampler, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace'
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
import { scrubQuery } from '../lib/scrub-query.js'

/** Span attributes that can hold a URL or a query string. */
const URL_ATTRS = ['url.full', 'http.url', 'url.query', 'http.target', 'url.original']

export function scrubAttributes(attrs: Attributes): void {
  for (const k of URL_ATTRS) {
    const v: AttributeValue | undefined = attrs[k]
    if (typeof v === 'string') attrs[k] = scrubQuery(v)
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
    sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
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
      // Routers and handlers, not each of the ~12 middlewares every request
      // passes (helmet, cors, json...): those would triple the spans per
      // request and say nothing the request's own duration does not.
      new ExpressInstrumentation({ ignoreLayersType: [ExpressLayerType.MIDDLEWARE] }),
      // Every statement, inside a trace or not (setInterval jobs have none).
      new PgInstrumentation({ requireParentSpan: false, ignoreConnectSpans: true, enhancedDatabaseReporting: false }),
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
