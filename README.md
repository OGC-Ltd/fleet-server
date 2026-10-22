# fleet-server

The API behind the Rai Operations fleet dashboard (`new-ui`, served at
logistics.raioperations.com). It polls the telemetry providers, keeps the live
fleet state, and serves vehicles, trips, fuel, weighments, repairs, analytics
and reports to every organisation on the platform.

Node + TypeScript, Express, Prisma on PostgreSQL (PostGIS), Redis + BullMQ for
queues, SSE for live updates.

**Contents:** [Quick start](#quick-start) · [How it fits together](#how-it-fits-together) ·
[Configuration](#configuration) · [Scripts](#scripts) · [Code layout](#code-layout) ·
[Database and migrations](#database-and-migrations) · [Deployment](#deployment) ·
[Troubleshooting](#troubleshooting) · [Further docs](#further-docs)

---

## Quick start

```bash
npm install          # also runs prisma generate
npm run dev          # tsx watch on src/index.ts, port 3000
curl http://localhost:3000/health
```

> **`npm run dev` loads `.env.example`, not `.env`.** The dev script sets
> `DOTENV_CONFIG_PATH=.env.example`, so a flag changed only in `.env` has no
> effect in dev. Several `prisma/*` scripts read `.env` instead; check the
> script's `DOTENV_CONFIG_PATH` in `package.json`.

Local dev needs the production database (private RDS in af-south-1) through an
SSH tunnel on `localhost:15432`. See **[guide.md](guide.md)** for starting and
diagnosing it. For one-off queries and migrations it is usually easier to run
on the box itself.

Do **not** run the poller locally (`POLL_ENABLED=false` in dev). The production
box already polls, and two pollers would write to the same shared database.
new-ui's dev server talks to the production API for exactly that reason.

## How it fits together

```
Wialon ──────────── poll ──────────┐
RaiFactorySuite ─── poll + webhook ┼──▶ fleet-server ──▶ PostgreSQL (RDS, PostGIS)
Ingest API (devices) ──────────────┘         │    │
                                             │    └───▶ Redis (BullMQ queues, rate limits)
                                             ▼
                         /api/v1/…  and  SSE live stream ──▶ new-ui
```

- **Providers** (`src/providers`): Wialon (every org; Sukari through Control Tech),
  RaiFactorySuite (dispatches, weighments, machines register), Mailtrap (mail).
- **Poller** (`src/lib/poller.ts`, `poll-loop.ts`): the only source of each
  unit's `connectionOnline` and current movement state.
- **Queues and workers** (`src/lib/queues`, `src/lib/workers`): fuel events,
  parked-fall and theft rules, trips, alerts, notifications, push, retention.
- **API:** `/api/v1/auth`, `/api/v1/account`, `/api/v1/organisations`, and
  per-organisation routes under `/api/v1/organisations/:orgId/…`; admins manage
  organisation-specific groups there, and super admins can manage across
  organisations at `/api/v1/user-groups`. Webhooks are
  mounted at `/webhook` (root, not under `/api/v1`). Health check: `GET /health`.

### User groups

Admins manage organisation-specific groups through
`/api/v1/organisations/:orgId/user-groups`. Super admins can manage groups
across organisations through `/api/v1/user-groups`:

- `GET /` lists groups and their member counts; `POST /` creates a group in
  the route organisation.
- `PATCH /:groupId` renames or edits a description; `DELETE /:groupId` removes
  a group without deleting its users.
- `PUT /:groupId/users/:userId` adds a user; `DELETE` on the same path removes
  that membership.
- `PUT /users/:userId` with `{ "groupIds": [...] }` atomically replaces all of
  a user's group memberships in the current organisation. An empty array
  leaves them ungrouped there. A super admin must pass `organisationId` when
  creating a group through the global route.

Admins create groups at runtime; group names and memberships are not seeded
or inferred from email domains. Users can belong to multiple groups per
organisation. An administrator's management roster includes users sharing any
of their groups in that organisation.

## Configuration

Read from the env file named by `DOTENV_CONFIG_PATH` (see the note above) and
validated in `src/config/env.ts`. The production box's `~/prod/fleet-server/.env`
is the authoritative copy; never paste values into issues or chat.

| Group | Variables |
|---|---|
| Server | `NODE_ENV`, `PORT`, `CORS_ORIGIN`, `APP_BASE_URL`, `TRUSTED_PROXY_IPS`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `INGEST_RATE_LIMIT_MAX` |
| Auth | `JWT_SECRET`, `AUTHZ_ENFORCE`, `AUTH_BYPASS`, `AUTH_BYPASS_EMAIL` (dev only) |
| Data stores | `DATABASE_URL`, `DIRECT_URL`, `REDIS_URL` |
| Wialon | `WIALON_API_URL`, `WIALON_TOKEN` (takes precedence over `access_token`), `POLL_INTERVAL_MS` |
| Control Tech | `CONTROLTECH_API_URL` |
| RaiFactorySuite | `RAIFACTORYSUITE_API_URL`, `RAIFACTORYSUITE_API_KEY`, `RAIFACTORYSUITE_POLL_MS`, `FACTORY_SUITE_HOOK` |
| Mail | `MAILTRAP_API_TOKEN`, `MAILTRAP_SMTP_*`, `MAIL_FROM_EMAIL`, `MAIL_FROM_NAME`, `REPAIR_NOTIFY_EMAILS` |
| Other APIs | `OPENWEATHER_API_KEY`, `OPENAI_API_KEY` |
| Feature switches | `POLL_ENABLED`, `RAIFACTORYSUITE_POLL_ENABLED`, `FUEL_SYNC_ENABLED`, `FUEL_SETTLE_ENABLED`, `FUEL_ADJUDICATION_ENABLED`, `TRIP_BUILD_ENABLED`, `RETENTION_SWEEP_ENABLED`, `NIGHTLY_ROLLUPS_ENABLED`, `INCIDENT_CAPTURE_ENABLED` |
| Retention | `NOTIFICATION_RETENTION_DAYS`, `NOTIFICATION_CACHE_MAX` |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Watch mode on port 3000 (reads `.env.example`) |
| `npm run build` | `prisma generate` + `tsc` into `dist/` |
| `npm start` | Run the compiled server (`dist/src/index.js`) |
| `npm test` | Vitest, all suites |
| `npm run test:unit` / `test:integration` | One suite |
| `npm run test:db` | SQL tests against `TEST_DATABASE_URL` (run `test:db:setup` once) |
| `npm run migrate` | `prisma migrate deploy` (see below before running) |
| `npm run generate` | Regenerate the Prisma client |

Operational scripts live in `prisma/*.ts` and run through `npm run <name>`:

- **Sync from providers:** `sync:wialon` (Kasulu), `sync:menengai`,
  `sync:westsugar`, `sync:kabras`, `sync:nzoia`, `sync:timsales`,
  `sync:aquamist`, `sync:sukari-gps`, `sync:geofences`, `sync:machines`,
  `sync:drivers`, `sync:dispatches`, `sync:fuel`, `sync:alerts`
- **Seeding and access:** `seed:orgs`, `seed:org`, `seed:rbac`,
  `seed:superadmin`, `seed:admins`
- **Backfills and repairs:** `backfill:*`, `fix:*`, `repair:home-orgs`,
  `build:trips`, `fuel:adjudicate`
- **Fuel and sensor analysis:** `fuel:health`, `accel:*`, `sim:fuel`

These write to the shared production database. Read the script before running
it.

## Code layout

```
src/
├── index.ts          process entry: server, poller, workers
├── app.ts            Express app and route mounting
├── config/env.ts     environment schema (zod)
├── core/             error types, response helpers, shared types
├── middleware/       auth, authorization, validation, rate limits, webhook/ingest auth
├── modules/          one folder per API area: auth, vehicles, telemetry, trips,
│                     fuel, weighments, dispatches, repairs, incidents, analytics,
│                     reports, usage-review, notifications, users, roles, …
├── lib/              poller, SSE, geofences, movement state, trip builder,
│   ├── queues/       BullMQ producers (fuel events, trips, retention, …)
│   └── workers/      queue consumers and worker threads
└── providers/        wialon, raifactorysuite, mailtrap, telemetry-provider.ts

prisma/               schema.prisma, migrations/, seed/sync/backfill/measure scripts
tests/                unit/, integration/, fixtures/, helpers/
bench/                realtime load benchmark (see bench/README.md)
deploy/nginx/         nginx config for the box
docs/                 design notes and runbooks (see Further docs)
```

## Database and migrations

- PostgreSQL with PostGIS on RDS in **af-south-1**. Everything in us-east-1 is
  retired; any host or database there is stale, not a fallback.
- Schema: `prisma/schema.prisma`; migrations in `prisma/migrations/`.
- **Migrations are never run by the deploy.** Apply them by hand, before
  deploying the code that needs them, preferably on the box (which holds the
  right `.env`) and with a `lock_timeout` so a busy table cannot stall the API.

## Deployment

**Every push to `main` deploys to production** via
`.github/workflows/deploy.yml`:

1. compiles and runs the unit tests on a clean runner;
2. pushes the commit into the box's checkout at `~/prod/fleet-server` (the box
   cannot pull; it has no GitHub key). The push is refused if the box's working
   tree has local edits;
3. builds on the box and restarts the pm2 app **`server`** (not
   `fleet-server`), then shows its logs.

Required secrets (`EC2_SSH_KEY`, `EC2_HOST`, `EC2_HOST_KEY`) and their setup
are in [docs/ci-deploy.md](docs/ci-deploy.md). The box is reached with
`keys/ustawi.pem`. It has no Elastic IP, so `EC2_HOST` must be updated when its
address changes.

Box setup (nginx in `conf.d`, nvm-only Node, home directory permissions,
HTTPS) is covered in [docs/af-south-1-deployment.md](docs/af-south-1-deployment.md)
and [docs/ec2-devops-setup.md](docs/ec2-devops-setup.md).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every Prisma query fails with `ECONNREFUSED` locally | DB tunnel is down: [guide.md](guide.md) |
| `password authentication failed for user "fleet_app"` | Tunnel works, but the local env file holds an old password; the box's `.env` is authoritative |
| A flag change has no effect in dev | Dev reads `.env.example`; change it there too |
| Deploy step "push to box" refused | Someone edited files on the box; resolve those first |
| Deploy finished but old behaviour persists | pm2 restarted the wrong app or `dist/` was not rebuilt; check `pm2 logs server` |
| Wialon calls fail with error 8 | Token rejected; replace `WIALON_TOKEN` (setting `access_token` alone is ignored) |
| Client IPs all look the same in rate limits | The LiteSpeed proxy in front of nginx is not in `TRUSTED_PROXY_IPS` |
| No request logs from the app | The app does not log requests; read nginx's `access.log` (SSE viewers do not appear there) |

## Further docs

- [guide.md](guide.md): dev database tunnel, step by step
- [docs/ci-deploy.md](docs/ci-deploy.md): automated deploy and its secrets
- [docs/af-south-1-deployment.md](docs/af-south-1-deployment.md): the production box
- [docs/LIVE_INTEGRATION.md](docs/LIVE_INTEGRATION.md), [docs/live-telemetry-design.md](docs/live-telemetry-design.md): live telemetry
- `docs/fuel-*.md`: fuel ledger, consumption rates and theft detection
- [docs/postgis-setup.md](docs/postgis-setup.md): PostGIS
- [bench/README.md](bench/README.md): realtime load benchmark
