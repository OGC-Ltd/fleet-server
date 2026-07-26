# Live Integration Runbook

How the platform gets real fleet data now that the simulator is retired: which
providers feed which organisation, what is already wired, how to bring up the
remaining piece (GPS positions from Wialon), and how tracking → persistence →
analytics fit together.

Everything below is verified against the live systems as of **2026-07-26**.

> **Ground rule carried over from the cutover:** there is no on-prem GPS
> hardware and no IMEIs of our own. Providers are the source of truth. If a
> provider does not supply a field, it stays `NULL` — we never fabricate a
> value to make a tile look populated. The simulator's habit of inventing
> sensor readings is exactly what we removed.

---

## 1. The shape of the system

Two organisations, two independent providers:

| Org | Country | Provider | What it gives us | Transport |
|---|---|---|---|---|
| **SUKARI** | Kenya (Ndhiwa) | **Controltech / factorysuite** | vehicles, drivers, dispatches, alerts, gate movements | REST pull + **webhook push** |
| **KASULU** | Tanzania | **Wialon Hosting** | **GPS positions**, sensors, trips, reports | REST session + polling |

They do not overlap. Controltech knows *who was dispatched where*; it does not
know *where the vehicle is*. Wialon knows position; it does not know your
dispatch paperwork. Both are needed for a complete picture.

```
                    ┌──────────────────────────┐
  factorysuite ───► │  POST /webhook/rai       │──┐
  (push, Sukari)    │  alert/dispatch/movement │  │
                    └──────────────────────────┘  │
                    ┌──────────────────────────┐  ├──►  fleet-server
  factorysuite ───► │  npm run sync:*          │──┤     (Express + Prisma)
  (REST, backfill)  │  vehicles/drivers/alerts │  │            │
                    └──────────────────────────┘  │            ▼
                    ┌──────────────────────────┐  │      PostgreSQL (RDS)
  Wialon      ────► │  poller → TelemetryProv. │──┘            │
  (session poll)    │  avl_evts loop           │               ▼
                    └──────────────────────────┘         SSE → dashboard
```

The client **never** talks to a provider. The backend owns every credential and
session, normalises, persists, then streams to the dashboard over SSE. This is
deliberate: it keeps provider keys off the browser, keeps us inside provider
rate limits, and means we can swap or drop a provider without touching the UI.

---

## 2. Credentials

All live in `fleet-server/.env` (and `.env.example` for local dev). **Never
commit them** — `.env` is untracked; `.env.example` is tracked and already
contains secrets that should be rotated and moved out.

```bash
# Controltech / factorysuite (Sukari)
CONTROLTECH_API_URL=https://factorysuite.org/api/external/v1
FACTORY_SUITE_API_KEY=rai_live_…      # header: X-API-Key
FACTORY_SUITE_HOOK=WBk-K-…            # inbound webhook signing secret

# Wialon (Kasulu)
access_token=71b943ce…                # Wialon API token
```

---

## 3. Controltech / factorysuite — already live

### 3.1 REST endpoints (verified)

Base `https://factorysuite.org/api/external/v1`, header `X-API-Key`.
All return a **bare JSON array** — no envelope, no pagination metadata.

| Endpoint | Rows | Notes |
|---|---|---|
| `GET /vehicles?limit=2000` | 598 | `{id, factoryCode, type, numberPlate, make, model, status, active}` |
| `GET /drivers?limit=2000` | 550 | `{id, factoryCode, driverType, name, staffId, licenseNumber, phoneNumber, status, active, …}` |
| `GET /dispatches?limit=2000` | **capped at 1000** | ignores `offset`/`page`/`skip` — only ~4 days visible |
| `GET /alerts?limit=500` | 257 | `{id, factoryCode, type, message, relatedId, acknowledged, createdAt}` |

`factoryCode` is `NDHIWA` for everything → maps to org `SUKARI`.

### 3.2 Sync commands

```bash
npm run sync:vehicles   # 598 vehicles, upsert by externalId
npm run sync:drivers    # 550 drivers + assignments derived from /dispatches
npm run sync:alerts     # 257 alerts (add -- --emit to push new ones to the feed)
npm run seed:admins     # one admin per org — REQUIRED or AUTH_BYPASS 401s
```

All are **idempotent** — keyed on the provider's own UUID, so re-running never
duplicates. Run them in that order on a fresh database.

### 3.3 The webhook

**`POST http://32.198.44.105/webhook/rai`** — registered with Controltech.
nginx proxies `/webhook/` → `127.0.0.1:3000`; the route is mounted at the root
(not under `/api/v1`).

Authentication accepts either scheme, constant-time compared:

* `X-Signature: sha256=<hmac-sha256 of raw body>` (hex **or** base64), also
  accepted under `x-hub-signature-256`, `x-webhook-signature`,
  `x-factory-signature`, `x-rai-signature`, `x-signature-256`
* the secret verbatim under `x-webhook-secret`, `x-factory-suite-hook`,
  `x-api-key`, `x-webhook-token`, or `Authorization: Bearer <secret>`

**Unset secret ⇒ every delivery rejected** (fail closed). HMAC needs the raw
body, captured by `express.json({ verify })` in `app.ts`.

Three event types arrive:

| Event | Payload | Handling |
|---|---|---|
| `alert.created` | `{id, factoryCode, type, message, relatedId, acknowledged, createdAt}` | persisted to `provider_alerts` + Live Feed |
| `dispatch.created` | same shape as REST `/dispatches` | writes a `vehicle_assignments` row + Live Feed |
| `movement.created` | `{id, factoryCode, vehicleNumberPlate, driverName, direction, destination, timestamp}` | Live Feed only |

**Two traps already hit — don't reintroduce them:**

1. **`alert.created` arrives with `createdAt: null`.** Only the REST backfill
   populates it. A schema requiring it silently drops every live alert. The
   receive time stands in.
2. **A 4xx makes their sender retry a few times and then DROP the event.**
   The receiver therefore validates only that the body is JSON and sorts event
   types out in the controller; an unrecognised shape is acknowledged with 200
   and logged, never refused.

`dispatch.created` and `sync:drivers` both tag assignment rows
`controltech:dispatch:<id>`, so push and backfill converge on the same row
instead of duplicating.

---

## 4. Timestamps — read this before touching any provider date

Controltech sends **offsetless local wall-clock times with nanosecond
precision**:

```
"2026-07-26T06:35:12.100337484"
```

`new Date()` on that resolves against the **host** timezone. It parsed
correctly on a dev machine in EAT and **three hours late on the production box
(UTC)** — which put the Live Feed three hours into the future.

Both fleets are East Africa Time (Kenya and Tanzania are UTC+3 year-round, no
DST), so an offsetless payload timestamp is unambiguously EAT.

**Always** parse provider times through `src/lib/provider-time.ts`:

```ts
import { parseProviderTime, parseProviderTimeOr } from '../lib/provider-time.js'

const when = parseProviderTimeOr(d.dispatchTime)      // falls back to now
const ret  = parseProviderTime(d.actualReturnTime)    // null when absent
```

It stamps `+03:00` when no offset is present, trims sub-millisecond digits, and
trusts anything that already carries `Z` or an offset. Wialon is different — it
returns **Unix epoch seconds** (`pos.t`), which is unambiguous; multiply by
1000. Call `render/set_locale` after login so Wialon *reports* render in EAT.

---

## 5. Wialon — the GPS piece (to build)

### 5.1 What the account actually is (verified)

| Fact | Value |
|---|---|
| Product | **Wialon Hosting** — `https://hst-api.wialon.com` |
| Login | `developer@offgridconsultingltd.com` (user id 30409745) |
| API access | **enabled** — `token/login` succeeds |
| Units visible | **224** (account usage 342) |
| Units with a last position | **205**; 136 reported in the last 24 h; 20 moving |
| Resource | `Mufindi Paper Mills` (id 30394506) — holds report templates, geofences, notifications |
| Plan | `Tracking+GoogleMaps+Fuel+AllApps+365Days` → **365 days** message retention |
| Position freshness | median 0 d, **p75 9.3 d**, 33 units >30 d, oldest 449 d |

Unit names carry IMEIs (`MUFINDI - 353691840300361`). Roughly a third of the
fleet is dormant — build a "last seen" concept rather than assuming all units
are live.

Two things worth fixing with the reseller: it is a **human login**, not a
service account (a password change kills ingestion at 2am), and the token
cannot manage tokens (`token/list` → `error 7`).

### 5.2 The session model

```
token/login            → returns eid  ── use as `sid` on every later call
core/update_data_flags → subscribe the session to units + properties
avl_evts (loop ~2s)    → everything that changed since the last call
```

Two behaviours that catch everyone:

* **An idle session expires in ~5 minutes.** The `avl_evts` loop *is* the
  keepalive — keep calling it.
* **`avl_evts` returns only what your data flags asked for.** If the payload
  looks empty, the flags are wrong, not the API.

Run this as **one long-lived worker process**, never per-user.

### 5.3 Where it plugs in

The seam already exists — `src/providers/telemetry-provider.ts`:

```ts
export interface TelemetryProvider {
  name: string
  init(): Promise<void>
  fetchAll(): Promise<VehicleTelemetryFrame[]>
}
```

To add Wialon:

1. Create `src/providers/wialon/wialon.adapter.ts` implementing
   `TelemetryProvider` — own the session, run the `avl_evts` loop, normalise
   each message into a `VehicleTelemetryFrame`.
2. Swap it into `startPoller()` in `src/lib/poller.ts`.
3. Set `POLL_ENABLED=true` on **exactly one** deployment.

Nothing downstream changes — persistence, SSE, alerts, geofences and the
dashboards are all provider-agnostic.

**Frame mapping** (`pos` from `avl_evts` / `core/search_items`):

| Frame field | Wialon | Notes |
|---|---|---|
| `deviceId` | unit `id` (or IMEI from `uid`) | must match `vehicles.device_id` |
| `capturedAt` | `pos.t × 1000` | epoch seconds → ms |
| `lat` / `lng` | `pos.y` / `pos.x` | **y is latitude, x is longitude** |
| `speedKmh` | `pos.s` | |
| `headingDeg` | `pos.c` | course |
| `altitudeM` | `pos.z` | |
| `satelliteCount` | `pos.sc` | |
| `engineOn`, `fuelLevelMl`, sensors | unit sensor channels | **calibration required — see §8** |

Leave anything the account does not actually expose as `NULL`.

### 5.4 Identity mapping — the real work

Our registry is keyed on the **factorysuite UUID** (`vehicles.external_id`,
mirrored into `device_id`). Wialon has its own unit ids and IMEIs. Neither
provider knows about the other.

Kasulu's vehicles are **not** in factorysuite at all, so for KASULU the Wialon
unit *is* the registry entry: sync units into `vehicles` with
`external_id = "wialon:<unitId>"` and `device_id = <IMEI or unitId>`, org
KASULU. Write a `sync:wialon-units` script mirroring `sync:vehicles`.

Do **not** try to fuzzy-match plates across providers. If a vehicle ever needs
to exist in both, add an explicit mapping column rather than guessing.

### 5.5 Notifications as a second webhook (optional, later)

Wialon notifications with the *Send a request* action POST to a URL with
`%TAGS%` substituted. Point them at the **existing** `/webhook/rai` — it is
already authenticated, idempotent and feeds the Live Feed. Add a payload branch
in `webhooks.controller.ts`. This is hours of work, not a project, and gives
speeding / geofence / ignition events without inferring them.

### 5.6 Retranslator — do this before scaling past a pilot

Ask Controltech to configure a retranslator forwarding raw device data to a
server you control, or have devices (Teltonika/Queclink/Concox commonly support
two destinations) stream to a second endpoint. You then hold your own raw copy:
no lock-in, and history is rebuildable if the reseller relationship ends.

---

## 6. Persistence model

| Table | Holds | Key |
|---|---|---|
| `vehicles` | registry | `external_id` unique; `device_id` unique; `status`, `is_active` |
| `users` | drivers | `external_id` unique; `duty_status`, `driver_type`; **`email` nullable** |
| `vehicle_assignments` | driver↔vehicle over time | `notes = controltech:dispatch:<id>` makes it idempotent |
| `provider_alerts` | provider-raised alerts | `external_id` unique → webhook redelivery is safe |
| `vehicle_telemetries` (+ `_raws`) | every position ping | raw payload retained alongside the normalised row |
| `trips` | completed journeys | **currently empty — see §7** |
| `vehicle_alerts` | alerts derived from *our* telemetry flags | requires a vehicle |

`provider_alerts` is separate from `vehicle_alerts` on purpose: the former is
pre-composed by the provider and may concern a *person* (blocked driver), the
latter is derived from our own telemetry and always has a vehicle.

The live fleet is simply **`organisationId + isActive`**. The retired
`SIM_FLEET_COMPOSITION` scoping and the `payload->'_sim'->'leg' IS NOT NULL`
ping guards are gone — those guards excluded 100 % of real pings.

---

## 7. Tracking → analytics (replacing what the sim gave us)

The simulator emitted `_sim.events.tripCompleted`, and a worker turned that into
`Trip` rows. Everything downstream — Analytics, driver scores, reports,
maintenance intervals — reads `trips`. **Real devices emit no such event**, so
until trips are generated those pages stay honestly empty.

**Trip segmentation is the single biggest remaining piece.** Build it as a
worker over `vehicle_telemetries`:

1. **Start** — engine on *and* movement begins (speed > 0 sustained, or exit
   from a depot geofence).
2. **End** — engine off, or stationary beyond a threshold, or entry into a
   destination geofence.
3. Aggregate over the window: distance (sum of haversine between consecutive
   fixes), duration, avg/max speed, fuel consumed (first − last level), start
   and end place via `reverseGeocode`.
4. Write `Trip` + `CargoManifest`, attributing the driver from the assignment
   active at `beganAt`.

Two properties it **must** have, because devices buffer through coverage gaps
and then dump a backlog:

* **idempotent** — re-processing the same messages must not create a second
  trip. Key on `(vehicleId, beganAt)`.
* **order-independent** — sort by `capturedAt`, never by arrival order.

Once `trips` populate, Analytics, the Drivers leaderboard, maintenance
intervals and PDF reports light up with no further changes: they already read
real rows and currently render zeroes.

For reports, Wialon's own engine (`report/exec_report` → fetch rows →
`report/cleanup_result`, against templates on the resource) is the fastest path
to calibrated trip/fuel/engine-hour figures. Use it for operational reports
users must trust; build fleet-wide dashboards from our own tables.

---

## 8. Pilot checklist before trusting any of it

Take five vehicles, run two weeks, verify:

- [ ] Positions match reality — drive a known route and compare
- [ ] Ignition detection is correct (engine on/off vs. reality)
- [ ] Odometer and engine hours agree with the vehicle dashboard
- [ ] Fuel sensors calibrated with a real fill-and-drain test
- [ ] Geofences trigger at the right boundary
- [ ] Driver assignment resolves (dispatch → correct person)
- [ ] **Coverage-gap behaviour**: drive through a dead zone, confirm the
      buffered backlog lands without duplicate trips or out-of-order distance
- [ ] Timestamps render in EAT everywhere (§4)

---

## 9. Operations

### Deploying

The box has **no GitHub credentials** — `git pull` there always fails. Push
straight into its working tree:

```bash
git push origin main
GIT_SSH_COMMAND='ssh -i "C:\Users\supervisor\Documents\keys\logistics.pem"' \
  git push ubuntu@32.198.44.105:/home/ubuntu/prod/fleet-server main
```

Then on the box (the **build step is mandatory** — pm2 runs `dist/`, not `src/`):

```bash
source ~/.nvm/nvm.sh
npx prisma generate --config prisma.config.ts
npm run build
pm2 restart fleet-server --update-env
```

If the push is rejected for a dirty tree, `git checkout -- .` first — the
geocode/road-route caches are tracked and rewritten at runtime.

The dashboard (`dash`) is a **separate repo** served as a static build from
`/home/ubuntu/prod/dash/build`: `npx vite build`, tar, scp, unpack, reload nginx.

### Health checks

```bash
# is the provider's push getting through?
sudo grep "/webhook/rai" /var/log/nginx/access.log | tail -20

# what arrived, and how?
select source, count(*) from provider_alerts group by source;   -- webhook vs backfill

# is anything unmapped?
pm2 logs fleet-server --lines 200 --nostream | grep "do not map yet"
```

### Gotchas that have already cost time

* **nginx's real server block is `/etc/nginx/nginx.conf`**, not
  `conf.d/default.conf` (that one is a `server_name localhost` decoy that never
  matches IP traffic — editing it silently does nothing and POSTs return 405).
* **`AUTH_BYPASS` needs ≥1 ACTIVE user** or every endpoint 401s. Run
  `npm run seed:admins` after any wipe.
* **Never run two pollers on the shared database.** `POLL_ENABLED=true` on
  exactly one deployment; everything else is API-only.
* The live-feed buffer is in-memory; it is re-seeded from `provider_alerts` at
  boot so a restart doesn't blank the panel.

---

## 10. Order of work

1. ~~Registry sync (vehicles, drivers, assignments)~~ — done
2. ~~Alert + dispatch + movement webhook~~ — done
3. ~~EAT timestamp handling~~ — done
4. **Wialon adapter + `sync:wialon-units`** → live positions on the map for Kasulu
5. **Trip segmentation worker** → unlocks Analytics, Drivers, reports, maintenance
6. Wialon notifications → richer event feed
7. Retranslator → own the raw stream before scaling

Steps 1–3 are in production. Step 4 is what makes the map live; step 5 is what
makes the analytics real.
