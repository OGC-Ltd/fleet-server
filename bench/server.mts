/**
 * The real Fleet Server, booted for benchmarking only.
 *
 * Differs from src/index.ts in three deliberate ways, each of which would
 * otherwise corrupt the measurement:
 *
 *  1. NO BACKGROUND WORK. index.ts starts the poller, six event-bus workers,
 *     the cache warmer, the Wialon adapter, the retention sweep and the trip
 *     builder. Those compete for the same event loop the benchmark is trying
 *     to measure, and the Wialon adapter makes OUTBOUND calls to a third
 *     party — a local benchmark has no business generating provider traffic.
 *     This boots createApp() and nothing else.
 *
 *  2. NO DATABASE. globalThis.prisma is seeded with the stub BEFORE the app is
 *     imported, so src/lib/prisma.ts's singleton picks it up and never builds
 *     a pg pool. See bench/stub-prisma.mjs for why that matters here
 *     specifically: the only DATABASE_URL on this machine points down a tunnel
 *     at the PRODUCTION RDS.
 *
 *  3. RATE LIMITS RAISED. The global limiter ships at 100 requests per second.
 *     Left alone, any load worth calling load measures express-rate-limit and
 *     nothing else — the run would report a flat 100 rps and a wall of 429s,
 *     which is a fact about the limiter, not about the server. They are raised
 *     here so the app's own ceiling is what answers. To benchmark the LIMITER
 *     instead, run with --keep-limits and they are left at their defaults.
 *
 * Everything else is the shipped stack: the same createApp(), the same
 * middleware in the same order, the same routes, the same validation.
 */

import { createStubPrisma } from './stub-prisma.mjs'

const keepLimits = process.argv.includes('--keep-limits')
const port = Number(process.env['BENCH_PORT'] ?? 3100)

// ── before ANY app import ───────────────────────────────────────────────────
// src/lib/prisma.ts reads `globalThis.prisma` at module-evaluation time, so
// this has to be in place before the first import that reaches it.
;(globalThis as unknown as { prisma?: unknown }).prisma = createStubPrisma()

// env.ts validates at import time and requires DATABASE_URL to be non-empty.
// It is never dialled — the stub above is already in the singleton — but it
// has to parse. Pointed at an unroutable host so that a future change which
// DOES construct a client fails loudly instead of quietly finding a tunnel.
process.env['DATABASE_URL'] ??= 'postgresql://bench:bench@127.0.0.1:1/bench'
process.env['DIRECT_URL']   ??= process.env['DATABASE_URL']
process.env['NODE_ENV']       = 'development'
process.env['PORT']           = String(port)

// Authenticated routes without a sign-in. AUTH_BYPASS attaches a user with no
// token; the stub answers the user lookup with BENCH_USER. This is a dev-only
// flag that refuses to boot under NODE_ENV=production, and it is why this
// server must never be exposed beyond localhost.
process.env['AUTH_BYPASS'] ??= 'true'
delete process.env['AUTH_BYPASS_EMAIL']   // fall back to the stub's user
process.env['AUTHZ_ENFORCE'] = 'false'    // env refuses AUTH_BYPASS + enforce together

if (!keepLimits) {
  process.env['RATE_LIMIT_WINDOW_MS']            = '1000'
  process.env['RATE_LIMIT_MAX']                  = '1000000'
  process.env['INGEST_RATE_LIMIT_MAX']           = '1000000'
  process.env['LOGIN_RATE_LIMIT_MAX']            = '1000000'
  process.env['REFRESH_RATE_LIMIT_MAX']          = '1000000'
  process.env['REFRESH_IP_RATE_LIMIT_MAX']       = '1000000'
  process.env['SETUP_RATE_LIMIT_MAX']            = '1000000'
  process.env['SETUP_IP_RATE_LIMIT_MAX']         = '1000000'
  process.env['PASSWORD_RESET_RATE_LIMIT_MAX']   = '1000000'
  process.env['PASSWORD_RESET_IP_RATE_LIMIT_MAX'] = '1000000'
}

// Quiet: per-request logging is real work and would be measured as if it were
// the handler's. Production logs nothing per request anyway (see the traffic
// visibility note in the runbook), so silencing it is closer to production.
process.env['LOG_LEVEL'] ??= 'error'

const { createApp } = await import('../src/app.js')

const app = createApp()

// Bound to loopback ON PURPOSE. This process runs with authentication bypassed
// — every request is an authenticated user — so it must not be reachable off
// this machine.
const server = app.listen(port, '127.0.0.1', () => {
  process.stdout.write(
    `bench server listening on http://127.0.0.1:${port}  `
    + `(db=stub, auth=bypass, limits=${keepLimits ? 'DEFAULT' : 'raised'})\n`,
  )
})

// The default 5 s keep-alive closes sockets mid-run and turns a throughput
// test into a reconnection test.
server.keepAliveTimeout = 120_000
server.headersTimeout   = 125_000

// ── Synthetic fleet (--fleet N [--tick S]) ─────────────────────────────────
// Stands in for the poller: every tick, one position event per vehicle goes
// through the REAL emitDashboardPosition, so the SSE fan-out, the replay on
// connect and the heartbeat are the production code paths. The batch is sent
// in one burst at the top of the tick, as the poller's cycle does. Each payload
// carries `sentAt` so a client can measure delivery lag. A payload is the shape
// telemetry.worker emits, ~600 bytes once serialised.
const argVal = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const fleet = Number(argVal('--fleet') ?? 0)
const tickS = Number(argVal('--tick') ?? 30)
if (fleet > 0) {
  const { emitDashboardPosition } = await import('../src/lib/sse.js')
  const orgId = 'bench-org-0000-0000-000000000000'
  // Two in three vehicles are driving: every tick moves them, turns them a
  // little, burns fuel and adds distance. The rest are parked and only their
  // fix time advances. This matters for --delta measurements: a fleet whose
  // frames never change would flatter the deltas.
  const bootMs = Date.now()
  let tick = 0
  const emitAll = () => {
    const now = Date.now()
    tick++
    for (let v = 0; v < fleet; v++) {
      const moving = v % 3 !== 0
      const step = moving ? tick : 0
      emitDashboardPosition(orgId, {
        vehicleId: `bench-veh-${v}`, vehicleName: `BENCH - KXX ${String(v).padStart(3, '0')}A`,
        plate: `KXX ${String(v).padStart(3, '0')}A`, deviceId: `dev-${v}`,
        capturedAt: new Date(now).toISOString(), sentAt: now,
        lat: +(-0.8 + (v % 50) * 0.01 + step * 0.0021).toFixed(6),
        lng: +(34.4 + Math.floor(v / 50) * 0.01 + step * 0.0013).toFixed(6),
        headingDeg: moving ? (v * 37 + step * 7) % 360 : (v * 37) % 360,
        speedKmh: moving ? 30 + ((v + step) % 25) : 0, engineOn: moving,
        fuelLevelMl: 143000 - step * 180, fuelLevelPct: +(71.5 - step * 0.09).toFixed(1),
        odometerKm: +(120334.2 + step * 0.42).toFixed(1), engineHours: +(5321.4 + step * 0.008).toFixed(3),
        driverName: 'Bench Driver', vehicleType: 'TRUCK', connectionOnline: true,
        movement: { state: moving ? 'moving' : 'resting', since: new Date(bootMs - 600_000).toISOString() },
        zones: { inside: [], violations: [] }, alerts: [], ignition: moving,
      })
    }
  }
  emitAll()   // seeds lastPositions, so every connect replays a full fleet
  setInterval(emitAll, tickS * 1000)
}

// Event-loop delay, CPU and memory every 5 s on stdout: the server's own view
// of how it is coping, which the client cannot see.
{
  const { monitorEventLoopDelay } = await import('node:perf_hooks')
  const h = monitorEventLoopDelay({ resolution: 10 })
  h.enable()
  let cpu = process.cpuUsage(), at = Date.now()
  setInterval(() => {
    const d = process.cpuUsage(cpu), ms = Date.now() - at
    cpu = process.cpuUsage(); at = Date.now()
    const pctCpu = ((d.user + d.system) / 1000 / ms) * 100
    process.stdout.write(`[stats] loopDelay p50 ${(h.percentile(50) / 1e6).toFixed(1)}ms `
      + `p99 ${(h.percentile(99) / 1e6).toFixed(1)}ms max ${(h.max / 1e6).toFixed(0)}ms  `
      + `cpu ${pctCpu.toFixed(0)}%  rss ${(process.memoryUsage().rss / 1048576).toFixed(0)}MB\n`)
    h.reset()
  }, 5000).unref()
}

const shutdown = () => { server.close(() => process.exit(0)) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
