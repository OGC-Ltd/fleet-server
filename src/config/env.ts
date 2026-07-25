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

  // Controltech EA — the live vehicle/telemetry provider (factorysuite).
  // There is no on-prem GPS hardware: vehicles and their live data are
  // provisioned entirely by this API. Used by sync:vehicles and the live
  // telemetry adapter.
  CONTROLTECH_API_URL: z.string().optional().default('https://factorysuite.org/api/external/v1'),
  CONTROLTECH_API_KEY: z.string().optional().default(''),

  // Shared secret for the inbound alert webhook (POST /api/v1/webhooks/
  // controltech/alerts). The provider either signs the raw body with it
  // (X-Signature: sha256=<hex>) or sends it as X-Webhook-Secret. UNSET =
  // the receiver rejects every delivery, so alerts can't be spoofed into the
  // operations feed.
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
