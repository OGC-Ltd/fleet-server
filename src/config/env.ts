import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1),

  // HS256 signing secret for the app's own access/refresh JWTs (auth.service.ts)
  JWT_SECRET: z.string().min(32),

  AUTH_BYPASS: z.string().optional().default('false').transform(v => v === 'true'),

  // Set to 'false' to run this instance API-only (no telemetry poller / sim).
  // Use for a local dev server reading a DB that another deployment is already
  // simulating into — two concurrent sims write conflicting positions and
  // duplicate trips.
  POLL_ENABLED: z.string().optional().default('true').transform(v => v === 'true'),

  // API-only instances only (POLL_ENABLED=false): tail the shared DB's latest
  // telemetry (written by the deployment that DOES run the sim) and re-emit
  // dashboard SSE (positions + live feed) locally, read-only — otherwise the
  // local /live stream is silent and the dev dashboard shows a frozen map and
  // an empty feed. Set 'false' for a truly passive API instance.
  FOLLOW_DB: z.string().optional().default('true').transform(v => v === 'true'),

  // Comma-separated org codes this instance simulates (e.g.
  // "MENENGAI,TIMSALES,KABRAS"). Unset = all orgs in SIM_FLEET_COMPOSITION.
  // Lets two deployments split the sim fleet org-wise over one shared DB.
  SIM_ORGS: z.string().optional(),

  // RaiFactorySuite — the live vehicle/driver/alert provider (factorysuite).
  // There is no on-prem GPS hardware: vehicles and their operational data are
  // provisioned entirely by this API. Used by sync:vehicles, sync:drivers,
  // sync:alerts and the reconcile poller.
  //
  // RAIFACTORYSUITE_* are canonical; the CONTROLTECH_* names are kept as
  // fallbacks so the deployed .env on the EC2 box keeps working through the
  // rename (see `raiFactorySuiteApi` below for the resolution order).
  RAIFACTORYSUITE_API_URL: z.string().optional().default(''),
  RAIFACTORYSUITE_API_KEY: z.string().optional().default(''),
  CONTROLTECH_API_URL: z.string().optional().default(''),
  CONTROLTECH_API_KEY: z.string().optional().default(''),

  // Cadence for the RaiFactorySuite reconcile poller (providers/raifactorysuite).
  // Alerts normally arrive by webhook; this loop is the safety net for the
  // deliveries their sender gives up on, so minutes — not seconds — is right.
  RAIFACTORYSUITE_POLL_MS: z.coerce.number().optional().default(5 * 60_000),
  // Set 'false' to run webhook-only (e.g. a second instance that must not
  // duplicate the reconcile traffic against the provider's API).
  RAIFACTORYSUITE_POLL_ENABLED: z.string().optional().default('true').transform(v => v === 'true'),

  // Wialon Hosting — the GPS/telemetry provider for KASULU (Tanzania).
  // Sukari's data comes from RaiFactorySuite instead; the two do not overlap.
  WIALON_API_URL: z.string().optional().default('https://hst-api.wialon.com'),
  WIALON_TOKEN:   z.string().optional().default(''),

  // Telemetry poll cadence. Wialon's avl_evts is designed to be called every
  // couple of seconds — that both delivers updates and keeps the session
  // alive (it lapses after ~5 min idle). Lower = finer tracks; the adapter
  // only emits genuinely new fixes, so the write load follows the devices,
  // not this interval.
  POLL_INTERVAL_MS: z.coerce.number().optional().default(30_000),

  // Shared signing secret for the inbound alert webhook (POST /webhook/rai).
  // FACTORY_SUITE_HOOK is the canonical name (it is what the provider calls
  // it); CONTROLTECH_WEBHOOK_SECRET is accepted as a legacy alias. UNSET =
  // the receiver rejects every delivery, so alerts can't be spoofed into the
  // operations feed.
  FACTORY_SUITE_HOOK:         z.string().optional().default(''),
  CONTROLTECH_WEBHOOK_SECRET: z.string().optional().default(''),

  // Fleet AI Insight (dashboard/ai-insight.ts). Unset key = the endpoint
  // reports { configured: false } and clients fall back to the local summary.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL:   z.string().default('gpt-5-nano'),

  CORS_ORIGIN: z.string().default('*'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  INGEST_RATE_LIMIT_MAX: z.coerce.number().default(500),

  // OpenWeather — powers the route weather card (server-side proxy; key never ships to the client)
  OPENWEATHER_API_KEY: z.string().optional().default(''),

  // ── notification cache + retention (lib/redis, lib/queues) ───────────────
  // UNSET is a supported production state: the notification cache degrades to
  // Postgres and the BullMQ retention sweep does not run. The box is a
  // t3.micro that is already swapping, so Redis only appears after a resize.
  // e.g. redis://127.0.0.1:6379
  REDIS_URL: z.string().optional().default(''),

  // How long a notification is kept before the retention sweep deletes it.
  NOTIFICATION_RETENTION_DAYS: z.coerce.number().optional().default(90),

  // How many notifications per org the Redis cache holds. The read endpoint
  // serves from cache up to this depth and falls through to Postgres beyond
  // it, so this is a latency knob, not a data-loss one.
  NOTIFICATION_CACHE_MAX: z.coerce.number().optional().default(200),

  // Set 'false' on additional instances so only ONE runs the retention sweep.
  // BullMQ's repeatable jobs already de-duplicate on a shared Redis, so this
  // is belt-and-braces for the case where instances point at different Redises.
  RETENTION_SWEEP_ENABLED: z.string().optional().default('true').transform(v => v === 'true'),

  // Fuel fillings and drains from Wialon's own reports onto the Live Feed.
  // Like the retention sweep this needs Redis and is inert without it; unlike
  // it, this one MUST run in-process, because the notification read path
  // serves its first page from the Redis cache and an external CLI cannot
  // write that cache — see lib/queues/fuel-events.ts.
  // Set 'false' on additional instances so only ONE runs it.
  FUEL_SYNC_ENABLED: z.string().optional().default('true').transform(v => v === 'true'),

  // Every 15 minutes. The job executes a Wialon report only for vehicles whose
  // own fuel readings actually moved, so a quiet cycle costs nothing.
  FUEL_SYNC_CRON: z.string().optional().default('*/15 * * * *'),

  // The settle pass — see lib/queues/fuel-events.ts. Each cycle re-reads a
  // rotating slice of vehicles over a window that has finished maturing and
  // makes the ledger EQUAL the provider's answer for it, deleting events
  // Wialon has since retracted. Without it the ledger only ever grows, and
  // retracted candidates inflated the fuel-loss figure permanently.
  FUEL_SETTLE_ENABLED: z.string().optional().default('true').transform(v => v === 'true'),

  // Vehicles per cycle. At the default cadence and ~460 instrumented vehicles
  // this brings every one round in under six hours, for roughly a minute of
  // extra Wialon time per cycle. Raise it to converge faster on a box that can
  // afford it; 0 is the same as disabling the pass.
  FUEL_SETTLE_BATCH: z.coerce.number().int().nonnegative().optional().default(20),

  // Completed dispatches → measured Trip rows (lib/queues/trips.ts). The trips
  // table had no writer once the simulator was retired, so every surface
  // reading it — the delivery half of Analytics, the Drivers roster, the org
  // reports — reported zero against a fleet running thousands of dispatches.
  // Set 'false' on additional instances so only ONE runs it.
  TRIP_BUILD_ENABLED: z.string().optional().default('true').transform(v => v === 'true'),

  // Every 10 minutes. A cycle only looks at dispatches closed in a short
  // trailing window and does nothing when none have closed.
  TRIP_BUILD_CRON: z.string().optional().default('*/10 * * * *'),

  // Pump price for costing the fuel ledger (analytics/fuel-cost). NOTHING in
  // the schema records what fuel cost — a filling stores litres, not money —
  // so cost is always litres × a price supplied here, and the endpoint echoes
  // the price it used. The default is the EPRA Nairobi diesel rate; set this
  // on the box when the rate moves rather than editing the frontend constant
  // the dashboard used to hardcode. A caller can still override per request.
  FUEL_PRICE_PER_LITRE: z.coerce.number().positive().optional().default(179.36),
  FUEL_CURRENCY:        z.string().optional().default('KES'),
})

// Production must talk to the real (remote) database endpoint. localhost URLs
// are the SSH-tunnel entrance used from dev machines outside the VPC — booting
// prod against one means the tunnel config leaked into a deployment.
const isLocalDbUrl = (url: string) => /@(localhost|127\.0\.0\.1)[:/]/.test(url)

const guarded = schema.superRefine((cfg, ctx) => {
  if (cfg.NODE_ENV !== 'production') return
  for (const key of ['DATABASE_URL', 'DIRECT_URL'] as const) {
    if (isLocalDbUrl(cfg[key])) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: 'points at localhost (SSH tunnel) — production must use the remote RDS endpoint',
      })
    }
  }
})

const parsed = guarded.safeParse(process.env)

if (!parsed.success) {
  console.error('❌  Invalid environment variables:\n', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data

/**
 * Resolved RaiFactorySuite API credentials.
 *
 * The provider is still reachable under its old configuration names on the
 * deployed box, so the canonical RAIFACTORYSUITE_* value wins and the
 * CONTROLTECH_* one is the fallback. Both being unset means the reconcile
 * poller stays off rather than hammering the default URL unauthenticated.
 */
export const raiFactorySuiteApi = {
  url: env.RAIFACTORYSUITE_API_URL || env.CONTROLTECH_API_URL || 'https://factorysuite.org/api/external/v1',
  key: env.RAIFACTORYSUITE_API_KEY || env.CONTROLTECH_API_KEY || '',
} as const
