/**
 * OpenTelemetry's entry point: loaded BEFORE the app by `node --import` (the
 * image sets NODE_OPTIONS, see Dockerfile), because the instrumentations have
 * to patch express, pg, ioredis, pino and http before the app imports them.
 * The app is ESM, so they patch through import-in-the-middle's loader hook;
 * the hook only wraps the modules an instrumentation asked for (the message
 * channel below), never the rest of the app or the generated Prisma client.
 *
 * Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set. The same image then runs
 * exactly as before: pm2 fallback, CI's boot test, the shadow, local dev.
 * Only the two app processes start it; the image's HEALTHCHECK (`node -e`)
 * shares NODE_OPTIONS and must not open an SDK every 30 s.
 *
 * Never fatal: a telemetry fault is written to stderr and the app starts
 * without it. Losing traces must not take the API down with it.
 */
// Everything below is imported only when telemetry is on, so the health check
// and the other `node` runs that share NODE_OPTIONS load nothing extra.
const APP_ENTRIES = /(?:^|[\\/])(?:index|report-worker)\.(?:js|ts)$/

function wanted(): boolean {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return false
  if (process.env.OTEL_SDK_DISABLED === 'true') return false
  return APP_ENTRIES.test(process.argv[1] ?? '')
}

if (wanted()) {
  try {
    const { register } = await import('node:module')
    const { createAddHookMessageChannel } = await import('import-in-the-middle')
    const { registerOptions, waitForAllMessagesAcknowledged } = createAddHookMessageChannel()
    register('import-in-the-middle/hook.mjs', import.meta.url, registerOptions)
    const { startTelemetry } = await import('./sdk.js')
    startTelemetry()
    await waitForAllMessagesAcknowledged()
  } catch (err) {
    process.stderr.write(`OpenTelemetry did not start; running without it: ${(err as Error)?.stack ?? err}\n`)
  }
}
