import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1),

  // HS256 signing secret for the app's own access/refresh JWTs (auth.service.ts)
  JWT_SECRET: z.string().min(32),

  // Skips TOKEN verification only, never authorisation: a bypassed request is
  // still resolved to a real user and still checked against that user's roles.
  // Refuses to boot under NODE_ENV=production (see the guard below).
  AUTH_BYPASS: z.string().optional().default('false').transform(v => v === 'true'),

  // WHICH user AUTH_BYPASS attaches. Without it the middleware took whatever
  // `findFirst` returned - no orderBy, so an arbitrary row, and in practice a
  // driver belonging to one organisation. That made local behaviour depend on
  // physical row order.
  AUTH_BYPASS_EMAIL: z.string().optional(),

  // Staged rollout switch. FALSE = shadow mode: permission checks run and every
  // denial is logged, but the request proceeds. It exists so a mis-mapped route
  // is found by reading a log rather than by locking an operator out, and it
  // MUST become true - the boot warning in app.ts says so on every start.
  AUTHZ_ENFORCE: z.string().optional().default('false').transform(v => v === 'true'),

  // `Secure` on the auth cookies. False only because the box serves plain HTTP
  // today; every credential is sniffable on the wire until TLS terminates in
  // front of it, at which point this becomes true.
  COOKIE_SECURE: z.string().optional().default('false').transform(v => v === 'true'),

  // Access-token lifetime. Short, because a revoked account keeps working until
  // its current access token expires.
  ACCESS_TTL_S: z.coerce.number().int().positive().optional().default(900),
  REFRESH_TTL_S: z.coerce.number().int().positive().optional().default(60 * 60 * 24 * 30),

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

  // ── Transactional mail (Mailtrap) ────────────────────────────────────────
  // Every one of these is optional with a default, so an unconfigured
  // deployment BOOTS and simply does not send — the same treatment
  // OPENAI_API_KEY and WIALON_TOKEN get. A mailer that refused to start would
  // take the whole API down over a feature most requests never touch.
  //
  // APP_BASE_URL counts toward "configured" on purpose: every mail this system
  // sends carries a link, and a mail with a broken link is worse than no mail.
  //
  // NOTE: `npm run dev` loads .env.example, not .env, so the token belongs in
  // BOTH if you want to exercise mail locally — or run with
  // DOTENV_CONFIG_PATH=.env. The real token never belongs in .env.example,
  // which is committed.
  MAILTRAP_API_TOKEN: z.string().optional().default(''),
  MAILTRAP_API_URL:   z.string().optional().default('https://send.api.mailtrap.io/api/send'),
  MAIL_FROM_EMAIL:    z.string().optional().default(''),
  MAIL_FROM_NAME:     z.string().optional().default('Rai Group Fleet'),
  /** Dashboard origin, used to build the links in invite and reset mails. */
  APP_BASE_URL:       z.string().optional().default(''),

  // How long an emailed link stays good. An invite is generous because it may
  // wait for someone's Monday; a reset is short because it is a live
  // credential for an account that already exists.
  INVITE_TTL_S:         z.coerce.number().int().positive().optional().default(604_800), // 7 days
  PASSWORD_RESET_TTL_S: z.coerce.number().int().positive().optional().default(3_600),   // 1 hour

  /** Password-reset requests allowed per IP per 15 minutes. */
  PASSWORD_RESET_RATE_LIMIT_MAX: z.coerce.number().int().positive().optional().default(5),

  CORS_ORIGIN: z.string().default('*'),
  // 100 requests per SECOND, per client IP.
  //
  // These two were 100 per 60_000 ms — 1.7 a second — which is less than one
  // dashboard load costs: a single page fans out across the snapshot, the feed,
  // the geofences, the summary and a dozen analytics endpoints, so a few views
  // inside a minute spent the whole budget and the platform 429'd its own
  // users. Per-client rather than per-nginx because app.ts trusts one proxy
  // hop; see middleware/rateLimiter.
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(1_000),
  RATE_LIMIT_MAX: z.coerce.number().default(100),

  // Sign-in attempts per 15 minutes. NOT scaled with the global limit — this
  // one is brute-force defence, not capacity, and is meant to be tight.
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().default(20),

  // Token refreshes per 15 minutes. Separate from LOGIN because a refresh is
  // not a credential guess: a browser refreshes on load and again on expiry, so
  // several open tabs would otherwise spend the sign-in budget and report "too
  // many attempts" to somebody who never typed a password.
  REFRESH_RATE_LIMIT_MAX: z.coerce.number().default(120),

  // Device telemetry per MINUTE — its window is fixed in rateLimiter rather
  // than shared, so the global knob above cannot redefine this one's meaning.
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

  // How long the RAW provider envelope behind each telemetry row is kept.
  //
  // Separate from the parsed row, and much shorter, because the two are read
  // completely differently. `vehicle_telemetries` is scanned across weeks by
  // trips, analytics and playback; `vehicle_telemetry_raws` is read for a
  // vehicle's LATEST row (the dashboard, the map ping, tank state, the probe
  // report) or for the hours around a fuel drain — never across a long window.
  //
  // Seven days, and the payload is why. Measured 2026-08-31 over 200,000 rows,
  // it averages 716 bytes of which 21 carry anything not already held as a
  // column — `odometer_km`, whose absence from `vehicle_telemetries` the schema
  // notes itself. The rest is envelope:
  //
  //   flags   214 B   ten booleans; only fuelProbeFault is read
  //   pos     141 B   duplicates lat / lng / speed_kmh / heading_deg
  //   name     35 B   duplicates vehicles.name
  //   …plus `ignition_known` and `engine_hours`, both promoted to columns by
  //   backfill-telemetry-ignition; `doorStatus`, which has ONE distinct value
  //   ("UNKNOWN") across the sample; and `panicButtonPressed`, never once true.
  //
  // Every consumer of the payload — db-follower, probe-report, tank state, the
  // map's ping lateral — reads a vehicle's LATEST row, and the sweep spares
  // that unconditionally at any age. The only window-sensitive reader is fuel
  // adjudication's drain evidence, spanning -30 min to +3 h. Seven days is
  // about fifty times the longest real need.
  TELEMETRY_RAW_RETENTION_DAYS: z.coerce.number().optional().default(7),

  // How long a parsed telemetry fix is kept.
  //
  // 30 days because that is the longest window anything reads, and the API
  // already says so: `/track` REFUSES a request longer than
  // TRACK_MAX_WINDOW_DAYS rather than clamping it. Every other consumer is
  // shorter — probe health 30, fuel adjudication's repeat window 30 and its
  // profile 21, tank-state trend 14, fuel rates 7, machine operations and the
  // dozer area one fleet day, fleet-state 24 h, the snapshot a single row.
  //
  // What this DOES change: five endpoints take a client-chosen from/to with no
  // maximum span — /analytics/fuel-efficiency, /analytics/speeding, the
  // /telemetry ping list, the zone timeline and sampled fixes. Beyond the
  // window they return nothing instead of data. The dashboard calls none of
  // them, but they are public API.
  //
  // And the replay scripts — build:trips, readjudicate-fuel, fuel-cause-replay
  // — reconstruct history from raw fixes. Trips already built are unaffected
  // (they are derived rows); re-running those over older dispatches would find
  // nothing rather than erroring, which is the sharp edge here.
  TELEMETRY_RETENTION_DAYS: z.coerce.number().optional().default(30),

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

  /**
   * The speed above which a unit is overspeeding, km/h.
   *
   * 80 is not a new number: `analytics.repository` has applied it to the
   * Speeding screen and to the driver-suspension policy since long before the
   * live feed could report it. Stated here so both read one value.
   *
   * It is CONFIGURATION, not an inference from the payload — which is the
   * distinction the Wialon adapter's flag block was drawing when it refused to
   * raise this flag on a guess. An operator sets a limit; we apply it.
   */
  OVERSPEED_LIMIT_KMH: z.coerce.number().optional().default(80),

  /**
   * Per-vehicle-type overrides, `TYPE:kmh` comma-separated —
   * e.g. `TRACTOR:50,PLANT:40`.
   *
   * Empty by default, deliberately. One limit across a fleet mixing cane
   * tractors, haulage trucks and saloons is crude, but the right number per
   * class is an operator's judgement about their own roads and machines, not
   * something to infer from telemetry. The mechanism ships ready; the values
   * are set by whoever owns the policy, without a deploy.
   */
  OVERSPEED_LIMIT_BY_TYPE: z.string().optional().default(''),

  /**
   * Consecutive frames over the limit before the flag rises.
   *
   * A single fix at 95 km/h is as likely to be a GPS artefact as a speeding
   * driver, and raising an alert on one is exactly the fabrication the adapter
   * was guarding against. At a 2-second cadence three frames is a few seconds
   * of sustained speed — cheap to satisfy when real, impossible to satisfy by
   * accident. Measured on 24 h of live telemetry, nothing reported above
   * 140 km/h on any fleet, so the channel itself is clean.
   */
  OVERSPEED_MIN_FRAMES: z.coerce.number().optional().default(3),

  /** Tank percentage at or below which `lowFuel` rises. Needs a known tank. */
  LOW_FUEL_PCT: z.coerce.number().optional().default(10),

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

  // Adjudicate the provider's drain claims against our own tank readings
  // before they count as a loss or reach the feed. Measured over the 250 most
  // recent drains per org, 40% (KASULU) and 50% (SUKARI) of decidable loss
  // volume came back with no filling to explain it — fuel that moved off the
  // probe on a slope and returned. Off means the ledger records Wialon's claim
  // verbatim, as it did before; nothing is deleted either way.
  FUEL_ADJUDICATION_ENABLED: z.string().optional().default('true').transform(v => v === 'true'),

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
  // AUTH_BYPASS attaches a user with no token at all, so in production it is an
  // open door rather than a convenience.
  //
  // This is FATAL only once AUTHZ_ENFORCE is on, because the two together are
  // incoherent - enforcing permissions on a request that skipped authentication
  // decides nothing. It is deliberately NOT fatal on its own: the live box runs
  // AUTH_BYPASS=true today, and a deploy that refused to boot would take the
  // fleet down to fix a door that has been open for months. app.ts warns about
  // it on every start until it is closed.
  if (cfg.AUTH_BYPASS && cfg.AUTHZ_ENFORCE) {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_BYPASS'],
      message: 'cannot be true when AUTHZ_ENFORCE is true - authorising a request that skipped authentication is meaningless',
    })
  }
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
