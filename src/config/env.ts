import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(32),

  AUTH_BYPASS: z.string().optional().default('false').transform(v => v === 'true'),

  // Set to 'false' to run this instance API-only (no telemetry poller / sim).
  // Use for a local dev server reading a DB that another deployment is already
  // simulating into — two concurrent sims write conflicting positions and
  // duplicate trips.
  POLL_ENABLED: z.string().optional().default('true').transform(v => v === 'true'),

  // Comma-separated org codes this instance simulates (e.g.
  // "MENENGAI,TIMSALES,KABRAS"). Unset = all orgs in SIM_FLEET_COMPOSITION.
  // Lets two deployments split the sim fleet org-wise over one shared DB.
  SIM_ORGS: z.string().optional(),

  CORS_ORIGIN: z.string().default('*'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  INGEST_RATE_LIMIT_MAX: z.coerce.number().default(500),

  // OpenWeather — powers the route weather card (server-side proxy; key never ships to the client)
  OPENWEATHER_API_KEY: z.string().optional().default(''),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  console.error('❌  Invalid environment variables:\n', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data
