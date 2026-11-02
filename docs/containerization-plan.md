# Containerizing the production box: plan

Status: **phase 0 written and tested on the box, not committed** (2026-11-03).
See section 8 for what was tested and what was found. Docker and the firewall are
already set up on the box. See [server-hardening.md](server-hardening.md).

The goal is to run everything on the production box (`13.247.178.217`) as
containers, built and scanned by CI and deployed as images. Security is the
first requirement. The second is that the live site never goes down for more
than a few seconds.

---

## 1. What runs today

| Piece | How it runs | Notes |
| --- | --- | --- |
| **server** (fleet-server) | pm2, `dist/src/index.js`, node 24.20.0 via nvm, about 1 GB of memory | Poller, webhooks, detectors, REST API and the live SSE stream, all in **one process** |
| **report-worker** | pm2, `dist/src/report-worker.js`, `--max-old-space-size=1536`, restarts at 1.8 GB | Takes BullMQ jobs from Redis and writes saved reports to disk |
| **new-ui** (the live site) | Static files rsynced by CI into `~/prod/dash/build` (despite the folder name, that is new-ui v1.3.4) | The Google Maps key is baked in at build time |
| **nginx** | Host package; `conf.d/fleet.conf` + `fleet/locations.conf` | TLS, `/api/` and `/webhook/` to `127.0.0.1:3000`, the SPA fallback, SSE kept open |
| **certbot** | Host package plus timer; webroot `/var/www/certbot` | The certificate is renewed and nginx reloaded by a deploy hook |
| PostgreSQL + PostGIS | **RDS**, not on the box | Out of scope; it stays managed |
| Redis | **ElastiCache** over TLS, not on the box | Out of scope; it stays managed |
| dash (old dashboard) | Not served any more | Only its folder name lives on; it is not containerized |
| Samad, project-manager | Other boxes, **already on Docker Compose** | Their setups are the models used below |

**State kept on disk** by the server and the worker, in `~/prod/fleet-server/.cache`:
- `reports/`: 33 MB of saved reports. These must survive deploys.
- `investigations/`, `fuel-days/`, `usage-review/`
- `geocode.json` and `road-routes.json`: caches that are filled over time and paid for in Google calls.

**Other things on disk:**
- `/tmp/fleet-server-vss-session.json` holds the dashcam login. VSS rate-limits logins (error 10082), so this must survive restarts too.
- `.env` holds 52 settings, and four old `.env.bak-*` copies sit next to it.

**Box capacity:** 2 vCPU, 3.8 GB of memory plus 4 GB of swap, 7.2 GB of free disk.

## 2. Two facts that shape the design

1. **The live stream only works inside the process that polls.** The event bus
   is an in-process `EventEmitter` (`src/lib/event-bus.ts`). If the API runs
   in a separate container from the poller, its SSE clients get no positions.
   The existing `docker-compose.prod.yml` splits `poller` and `api`, and
   **would break the live map**. So: **one `server` container, one replica**,
   until the bus moves to Redis pub/sub (a separate, later piece of work).
2. **The existing Dockerfile would not run.**
   - It installs production dependencies with `--ignore-scripts` and never
     copies `generated/prisma`, so the Prisma client is missing at runtime.
   - It uses node 22, while production and CI use 24.20.0.
   - It ignores the report worker.
   - The compose memory limit of 512 MB is half of what the server uses now.

   The Docker files have to be rewritten, not just switched on.

## 3. Target layout

```
                    internet
                       │ 80/443 (UFW + security group)
              ┌────────▼────────┐
              │ edge (nginx)    │  TLS, SSE settings, rate limits
              │ + certbot       │  certs volume
              └──┬──────────┬───┘
     /api /webhook          │ /
   ┌──────────▼───┐   ┌─────▼──────┐
   │ server       │   │ web        │  new-ui static files,
   │ 1 replica    │   │ nginx      │  unprivileged, read-only
   └──────┬───────┘   └────────────┘
          │ BullMQ (ElastiCache, TLS)
   ┌──────▼───────┐
   │ report-worker│
   └──────────────┘
   server + worker share the `fleet-cache` volume (.cache)
   both reach RDS and ElastiCache over the VPC (egress already tested)
```

| Container | Image | Exposed | Limits (start) |
| --- | --- | --- | --- |
| `server` | `ghcr.io/ogc-ltd/fleet-server:<sha>` | `127.0.0.1:3001` during migration, then the internal network only | 1.5 GB memory, 1.5 CPU |
| `report-worker` | the same image, different command | none | 1.8 GB memory, 1 CPU |
| `web` | `ghcr.io/ogc-ltd/raitrack:<sha>` (nginx-unprivileged + build) | internal network only | 64 MB |
| `edge` | `nginx:<pinned>` + our config | **80, 443 on the host** (the only public ports) | 128 MB |
| `certbot` | `certbot/certbot:<pinned>` | none | runs on a schedule |

One image serves both the server and the worker, so they can never run
different code versions.

## 4. Security baseline (every container)

**Images**
- **Pinned base images**, by version and digest: `node:24.20.0-bookworm-slim@sha256:…`. Never `latest`. Renovate or Dependabot opens the updates.
- **Multi-stage builds.** The final image has the compiled `dist/`, production `node_modules`, `generated/prisma`, `assets/` and `prisma/` only: no compilers, no source, no `.git`.
- **Non-root user** with a fixed UID (10001), set by `USER` in the image.
- **Scanned in CI** with Trivy. The build **fails on fixable HIGH or CRITICAL** issues. An SBOM is attached to each image.
- **Private registry:** GHCR under OGC-Ltd. The box logs in for the pull with the job's short-lived token and logs out again, as project-manager already does. The box stores no GitHub credential.

**Runtime (compose)**
- **Locked-down containers:**
  - `read_only: true`, with `tmpfs: /tmp` and writable mounts only where needed (`.cache`).
  - `cap_drop: [ALL]`, with no capabilities added back. The edge is unprivileged nginx on 8080/8443, and Docker maps host 80/443 onto those ports. certbot is the one exception: it keeps `CHOWN` and `FOWNER` to manage its own certificate files.
  - `no-new-privileges` (already the daemon default), `pids_limit`, and memory and CPU limits.
  - `init: true`, so signals reach node and zombies are reaped. Both entry points already shut down cleanly on SIGTERM. Give them `stop_grace_period: 30s`.
- **No Docker socket** in any container, and no `privileged` or `network_mode: host`.
- **Secrets stay out of images:**
  - `.env` moves to `/etc/fleet/server.env`, owned by root, mode 600, used as an `env_file`.
  - The four `.env.bak-*` copies get deleted once the move is checked.
  - Later step: move them to AWS SSM Parameter Store and read them at deploy time.
- **Networks:** the edge is the only container with host ports. The internal network is `internal: false` for `server` and `report-worker` only, because they need RDS, ElastiCache, Wialon, FactorySuite, VSS, Google, OpenAI and Mailtrap. `web` gets an internal-only network.

**Deploys**
- **A separate deploy user** (Samad pattern).
  - CI logs in as `deploy`, not `ubuntu`, with a key restricted in `authorized_keys` to a single script (`/usr/local/bin/fleet-deploy <sha>`).
  - That script can only pull a named image tag, run `compose up` and check health.
  - `deploy` needs Docker access, which makes it root-equivalent. The forced command is what keeps that contained.
- **Automatic rollback.** If `/health` fails after the switch, the script brings the previous tag back up.

## 5. Changes to the code (before anything touches the box)

1. **Rewrite `Dockerfile`:**
   - node 24.20.0 bookworm-slim (glibc, so Prisma behaves the same as today).
   - Stages: deps → build (`npm ci`, `prisma generate`, `tsc`) → prune (`npm prune --omit=dev`) → runtime that copies `node_modules`, `generated/`, `dist/`, `assets/`, `prisma/`, `prisma.config.ts` and the two seed cache files.
   - Add `tini`/`init`, `USER 10001` and the `/health` healthcheck.
2. **A migration image target:** a `migrate` stage that keeps the Prisma CLI, run as a one-off job: `docker compose run --rm migrate`. The existing recipe (`lock_timeout`, wait for an idle `pg_stat_activity`) carries over unchanged.
3. **Make the VSS session path configurable** (`VSS_SESSION_FILE`, defaulting to today's path), and point it into the `fleet-cache` volume so a restart doesn't trigger a fresh login.
4. **Rewrite `docker-compose.prod.yml`** to the layout in section 3. Remove the `poller`/`api` split and put a comment there saying why.
5. **Fix dev parity:** `docker-compose.yml` uses `postgres:16-alpine`, which has no PostGIS. Use `postgis/postgis:16-3.5`.
6. **new-ui:**
   - Add a `Dockerfile`: node build stage, then `nginxinc/nginx-unprivileged` serving `build/` with the SPA fallback and cache headers.
   - The Maps key stays a build argument from the CI secret, exactly as now. It is public in the bundle anyway, so this exposes nothing new.
7. **Edge config:**
   - Move `fleet.conf` and `locations.conf` into a repo, as `deploy/edge/`.
   - Upstreams become the container names (`server:3000`, `web:8080`).
   - Keep the SSE settings (`proxy_buffering off`, long `proxy_read_timeout`), the rate-limit and trust-proxy settings for LiteSpeed, the plain-HTTP `default_server` on port 80, and `worker_rlimit_nofile`/`worker_connections` from the 2026-10-06 load work.

Each of these is tested locally with `docker compose` first:
- dev PostGIS
- all background flags **off**
- a full report run through the worker

## 6. Rolling it out (each phase can be undone)

**Phase 0: CI builds images, nothing deployed.**
- fleet-server CI gains build → Trivy scan → push `ghcr.io/…:<sha>`, beside the current pm2 deploy, which carries on unchanged.
- Same for new-ui.
- *Done when:* images build, scan clean, and run locally.

**Before phase 1: disk.**
- On 2026-11-03 a test build and image scan **filled the root disk to 99%** (263 MB free) for about a minute. The live site was not affected: there were no disk errors in the logs, and every report request in that window succeeded.
- The cause was the images (server 0.9 GB, migrate 1.3 GB, web 0.1 GB), their build cache and Trivy's database, on a 19 GB disk with 12 GB already used.
- **Grow the EBS volume to at least 40 GB first** (online resize, then `growpart` + `resize2fs`; no reboot).
- **Never build images on the box again.** It pulls finished images only.
- The deploy script refuses to pull when less than 4 GB is free, keeps only the current and previous tags, and prunes everything else.

**Phase 1: shadow container on the box.**
- Run `server` from the image on `127.0.0.1:3001` with **all fourteen background switches off**:
  - `POLL_ENABLED`, `RAIFACTORYSUITE_POLL_ENABLED`, `VEHICLE_INSIGHT_ENABLED`, `GOOGLE_ROUTING_ENABLED`
  - `RETENTION_SWEEP_ENABLED`, `NIGHTLY_ROLLUPS_ENABLED`, `FUEL_SYNC_ENABLED`, `LIVE_FUEL_WATCH_ENABLED`
  - `INCIDENT_CAPTURE_ENABLED`, `FUEL_SETTLE_ENABLED`, `FUEL_ADJUDICATION_ENABLED`, `PARKED_FALL_VERDICTS_ENABLED`
  - `TRIP_BUILD_ENABLED`, `REPORT_WORKER_ENABLED`
- **The switches are not enough.** These workers start with no switch at all: alerts, speeding, sensor faults, live fuel-drop, harsh driving, notifications, sim-events and the DB follower (seen in the test boot). Some of them write to the database. So the shadow also gets:
  - **a read-only database login**: a new RDS role with `SELECT` only. It is created by the DB owner, and its password lives in the shadow's own env file.
  - **no outside credentials and no `REDIS_URL`**, so nothing it runs can call Wialon, FactorySuite, VSS, Control Tech, OpenAI, Google, Mailtrap or Web Push, or queue a job.
- Read the `… NOT started` lines at boot to confirm. That is the only reliable check: missing it once made two boxes call Wialon on the same account (2026-09-02).
- Compare answers from :3000 and :3001 for a list of read-only API calls.
- No user traffic reaches it.
- *Undo:* `docker compose down`.

**Phase 2: switch the server and worker to containers.** This happens at a quiet hour, with the following steps:
1. Copy `.cache` into the `fleet-cache` volume. Repeat right before the switch to catch new reports.
2. `pm2 stop server report-worker`.
3. Bring `server` and `report-worker` up with the real flags. Nginx on the host now points `/api/` and `/webhook/` at `127.0.0.1:3001`, followed by `nginx -t` and a reload.
4. Check:
   - `/health`
   - the HTTPS API
   - the SSE stream on the map
   - a webhook arriving
   - a report built by the worker
   - new telemetry rows in the database

- Expected gap: seconds. Browsers reconnect SSE on their own, the Wialon poller catches up from its last timestamp, and the FactorySuite hourly reconciler fills any missed webhook.
- The pm2 apps stay installed but stopped for **two weeks**.
- *Undo:* point nginx back at :3000, `pm2 start server report-worker`, and stop the containers. About one minute.
- From here, CI deploys images through the `deploy` user, and the git-push deploy is retired.

**Phase 3: new-ui as a container.**
- `web` runs on the internal network. Host nginx sends `/` to it through a loopback port while the host nginx still exists.
- New-ui CI pushes an image instead of rsyncing files.
- *Undo:* point `/` back at `~/prod/dash/build`, which stays in place until phase 4.

**Phase 4: the edge goes into a container, and the host is cleaned up.**
1. Start `edge` and `certbot` containers with the certificates copied into a volume. Stop host nginx and start `edge` in the same minute, since both need ports 80/443.
2. Renew the certificate (dry run) from the container. Check the LiteSpeed path over plain HTTP by IP.
3. After two quiet weeks, remove pm2 from boot (`pm2-ubuntu.service`), the nvm node, the host nginx and certbot packages, and the old checkouts.

The containers' 127.0.0.1 port publishing becomes unnecessary here, since only the edge publishes.
- *Undo, before the cleanup:* stop `edge` and start host nginx.

**Phase 5: further hardening** (each one is independent).
- Secrets in SSM Parameter Store.
- An Elastic IP.
- Moving SSH to SSM Session Manager, so port 22 can close. The SSM agent already runs on the box.
- Redis pub/sub for the event bus, which is what allows more than one `server` replica.

## 7. Risks

| Risk | What stops it |
| --- | --- |
| Two pollers writing the same telemetry, or two instances calling Wialon | One `server` only. The shadow runs with all six flags off, confirmed from the boot log. pm2 is stopped *before* the real container starts. |
| The live map going quiet | The server is never split from the poller (section 2). SSE is checked in the phase 2 checklist. |
| Saved reports or caches lost | A named volume, copied twice before the switch. The old `.cache` is kept until phase 4. |
| A VSS login storm after restarts | The session file moves into the volume (section 5, item 3). |
| Running out of memory during the shadow phase | The shadow runs without background jobs (a few hundred MB). The box has 2 GB free plus 4 GB swap. Memory limits stop one container starving the others. |
| Disk filling with images | Keep the last 3 tags and run `docker image prune` in the deploy script. Logs are capped (3 × 10 MB). |
| Deploy credentials being root-equivalent | A forced-command `deploy` user that can only run the deploy script. Images are pulled by digest. |
| Certificate renewal breaking in phase 4 | A dry-run renewal from the container before host certbot is removed. The current certificate is good until 2027-01-04. |

## 8. Phase 0: what was built and tested (2026-11-03)

**Files**
- fleet-server:
  - `Dockerfile` (deps → build → migrate / runtime) and `.dockerignore`
  - `docker-compose.prod.yml` and `docker-compose.phase3.yml`
  - `deploy/edge/` (nginx.conf, conf.d, fleet/locations.conf)
  - `.github/workflows/images.yml`
  - `VSS_SESSION_FILE` setting
  - `xlsx` moved into `dependencies` and upgraded to 0.20.3
  - dev compose on PostGIS
- new-ui: `Dockerfile`, `.dockerignore`, `deploy/web.conf`, `.github/workflows/images.yml`.

**Tested on the box** in a scratch folder, against a throwaway PostGIS container on an internal network. Only test ports on 127.0.0.1 were used, and nothing touched production data. The live `/health` was sampled every 15 s through every build, and all samples returned 200.

| Check | Result |
| --- | --- |
| Server image boots, all switches off, no outside credentials | healthy after about 40 s, 220–240 MB of memory |
| Runs as | uid 10001; all capabilities 0; `NoNewPrivs` 1 |
| File system | `/` and `/app/dist` read-only; `/app/.cache` writable |
| Loopback port (as host nginx will use it) | 200 on `127.0.0.1`; refused on the private IP |
| Migrate image | Prisma engine runs read-only and non-root; applied 52 migrations |
| Edge config | `nginx -t` passes; runs as uid 101 with no capabilities |
| Routes through the edge | `/`, SPA routes, `/api/…`, `/webhook/…` (answered by the app), ACME path, 301 to https, HTTPS with HTTP/2 |
| Cache headers | same as today for `/assets/` and `index.html` |
| Edge after the server is recreated on a new address | reconnected within about 6 s, with no edge restart |
| Web container | uid 101, no outside network; serves the same files as today, `.php` and `.htaccess` included |
| Maps key | not in the web image's history or config |
| Compose files | parse with every profile; services whose profile is off no longer block the others |

**Found and fixed**
- **`xlsx` was a devDependency used at runtime.** The production-only image could not start. The box works today only because its deploy installs development packages too.
  - Moved to `dependencies`, and upgraded from 0.18.5 to 0.20.3. 0.18.5 is npm's last release and has two known flaws (CVE-2023-30533, CVE-2024-22363).
  - 0.20.3 is installed from SheetJS's own site (`cdn.sheetjs.com`), pinned in the lock file by its checksum. npm has no newer release.
  - Checked on a real 30-day review (41,273 GPS points): all 379,555 cells, types, values and number formats are identical, read back by both versions.
  - The one byte-level change: filter ranges are now written as `Summary!$A$1:$D$23`, the form Excel itself writes.
- **The migration history cannot rebuild a database from empty.** Migration 53 alters `vehicle_alerts`, which no earlier migration creates. Production is unaffected, because it is already past that point, but a fresh environment needs `prisma db push` rather than `migrate deploy`. This is worth fixing separately with a baseline migration.
- **The full disk** is described under "Before phase 1" in section 6.

**Not yet verified**
- Trivy's result: the scan ran out of disk on the box. CI is the first real run, and it may fail on base-image findings that need triage.
- The workflows themselves: they have not run on GitHub yet.
- certbot inside a container: a dry-run renewal belongs to phase 4.
- The SSE stream through the edge: its settings are copied unchanged from production, but it needs a signed-in browser to watch it live.

## 9. Open questions for the team

1. Does fleet-server already have GHCR access set up in the OGC-Ltd org, or does it need the org setting that project-manager uses?
2. Is there a quiet window for phase 2? Polling runs around the clock, so pick the lowest-traffic hour from the nginx access log.
3. Should Dereva's backend, once it is connected, join this compose file or live separately?
