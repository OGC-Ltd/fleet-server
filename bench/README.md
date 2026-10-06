# Benchmarks

A dependency-free load harness for fleet-server, plus the first set of numbers.

**Read this first: these numbers are a ceiling, not a prediction.** The local
harness runs the real server against a *stubbed* database (`stub-prisma.mjs`),
so every query returns in microseconds. What it measures is the framework —
socket accept, routing, middleware, auth, rate limiting, zod validation,
serialisation. That is the wall the app can never get past no matter how fast
Postgres becomes, and it is the right number for answering "is Express or the
database in my way". It is *not* what a real request costs, because real
handlers spend most of their wall time in Postgres and the stub deletes all
of it.

## Why the database is stubbed and not local

There is no local Postgres on this machine: no Docker, no `psql`, and
`test:db:setup` needs both. Worse, `.env.example` points `DATABASE_URL` at
`localhost:15432`, which is the **SSH tunnel to the production RDS** rather
than a local database. Booting the server "locally" with the tunnel up would
have put full benchmark load on the production database. The stub is what
closes that back door — it is seeded into `globalThis.prisma` before the app
is imported, so no pg pool is ever constructed and no socket is ever opened.

## Running it

```bash
# terminal 1 — the server (loopback only, auth bypassed, limits raised)
npx tsx bench/server.mts

# terminal 2 — the load
node bench/load.mjs --path /health --stages 25:8,50:8,100:8,200:8
```

On Git Bash, prefix with `MSYS_NO_PATHCONV=1` or it rewrites `/health` into a
Windows path and the generator fails with `ERR_INVALID_PROTOCOL`.

`node bench/load.mjs --help` lists every flag.

### The two flags that change what you are measuring

- `bench/server.mts --keep-limits` leaves the rate limiters at their shipped
  values. **Without it they are raised to a million.** The global limiter
  ships at 100 requests per second, so any load worth calling load otherwise
  measures express-rate-limit and reports a flat 100 rps behind a wall of
  429s — a fact about the limiter, not about the server. Pass the flag when
  the limiter is what you want to test.
- `--mode sse` holds connections open instead of cycling requests. Throughput
  is meaningless there; what matters is how many establish and how many the
  server drops while holding them.

## Results — 2026-09-16, local, stubbed DB

Windows, Node v24.19.0, single process, Redis absent.

### Throughput

| Route | conn | rps | p50 | p99 |
|---|---|---|---|---|
| `/health` | 25 | **4506** | 5.2 ms | 13.9 ms |
| `/health` | 100 | 4414 | 21.3 ms | 35.2 ms |
| `/health` | 400 | 3860 | 99.2 ms | 136.2 ms |
| `vehicles/snapshot` | 25 | **2892** | 8.2 ms | 15.9 ms |
| `vehicles/snapshot` | 200 | 2496 | 78.4 ms | 109.3 ms |
| `POST ingest/telemetry` | 25 | **3537** | 6.4 ms | 15.1 ms |
| `POST ingest/telemetry` | 200 | 2489 | 80.6 ms | 120.3 ms |

Zero errors at every level.

**The shape is the finding.** Throughput is flat from 25 connections upward
while latency rises in direct proportion — 25→400 connections is 16x the load
for 16x the p50 and *no* extra throughput. That is a saturated single-threaded
event loop: the server is already at capacity at 25 concurrent requests, and
everything above that is queueing, not working. Adding concurrency cannot help;
only more processes or less work per request can.

**Auth and org middleware cost about a third.** `/health` does nothing and
manages 4506 rps; the same box authenticating and resolving an organisation
manages 2892. That ~1600 rps gap is the per-request cost of `authenticate` +
`requireOrgAccess` + `requirePermission`, and it is paid on every API call.

### SSE — concurrent live-map viewers

| held open | established | failed | dropped | first byte p50 | p99 |
|---|---|---|---|---|---|
| 100 | 100 | 0 | 0 | 56 ms | 89 ms |
| 500 | 500 | 0 | 0 | 268 ms | 380 ms |
| 1000 | **1000** | 0 | 0 | 524 ms | 775 ms |

A thousand simultaneous streams, none refused and none dropped. First-byte
latency scales linearly with the size of the *burst*, not with the number held
— this opens all N at once, which no real fleet does. Steady-state cost of a
held connection is near zero; the cost is in establishing them.

This matters because **SSE viewers are invisible in nginx's access log**, so
this harness is the only way to count them at all.

## Results — 2026-10-06, 3000 concurrent real-time users

The 1000-stream run above held idle streams. Real viewers receive the fleet:

```bash
npx tsx bench/server.mts --fleet 600 --tick 30     # 600 vehicles report every 30 s
node bench/realtime.mjs --users 3000 --ramp 100 --hold 65 --rps 250
```

`--fleet` pushes positions through the real `emitDashboardPosition`, so the
fan-out, replay-on-connect and heartbeat are the production paths; the server
prints event-loop delay, CPU and RSS every 5 s. `realtime.mjs` holds N `/live`
streams, measures how late live positions arrive, and offers API calls at a
fixed rate (open loop: ~250/s is the web app's polling at 3000 users).

| | streams | API calls | positions arrive | worst stall | RSS |
|---|---|---|---|---|---|
| 1000 users, before | 1000 | 3072 refused, 352 timed out | — | **14 s** | 600 MB |
| 3000 users, heartbeat fixed only | 2694 (306 refused) | 496 refused | 3–7 s late | 6.9 s every tick | ~1 GB |
| 3000 users, heartbeat fixed + batched | **3000** | **0 errors**, p50 2 ms | 0.7–1.4 s late | 0.67 s | ~410 MB |

The two fixes, both in `src/lib/sse.ts`:

- **Heartbeat was O(N²).** Each client's 25 s timer broadcast to every client
  in the org. Now each timer writes to its own socket (`writeHeartbeat`).
- **One write per event per client.** A 600-vehicle tick to 3000 viewers was
  1.8 M writes. Events are now queued per org and flushed every 150 ms as one
  shared Buffer per org — one write per client. Same bytes on the wire.

### Deltas — changed vehicles and fields only

`/live?delta=1` (dash and new-ui both open it) gets each batch's positions as
one `position_delta` event: `[{ vehicleId, ...changed fields, $del? }]`,
unchanged vehicles left out. Full frames still go to a client that did not ask,
and as the replay on connect. `realtime.mjs --delta` measures it; the
synthetic fleet moves two in three vehicles every tick (position, heading,
speed, fuel, odometer) so the deltas are not flattered.

| 3000 users, 600 vehicles | per tick on the wire | per viewer | worst stall | positions arrive |
|---|---|---|---|---|
| full frames (batched) | ~950 MB | ~316 KB | 0.85 s | 0.85–1.7 s late |
| `?delta=1` | **~325 MB** | **~108 KB** | **0.26 s** | **~0.5 s late** |

0 failed streams, 0 of 15,152 API calls failed. What is left per tick is
data that genuinely changed. Real payloads carry more static fields than the
synthetic one, so production should save more, not less — unmeasured. The
replay on connect is still full (~320 KB each). Next lever: more instances
(Redis pub/sub).

## What is NOT measured here, and why

- **Database query cost.** Needs a real Postgres with representative data. The
  heavy analytics and probe-health aggregations are the likely dominators and
  none of them are exercised. This is the biggest gap.
- **True ingest write capacity.** The 3537 rps above is the cost of *accepting*
  a telemetry POST, not of durably writing it. With a real database this will
  be far lower and will be bound by the pg pool (`max: 14`) long before it is
  bound by the event loop.
- **Redis-backed rate limiting.** Redis is absent locally, so the limiter fell
  back to in-memory counting — which is *faster* than production. Production
  pays a Redis round trip per request here.
- **nginx, TLS, and the network.** Everything above is loopback to a bare node
  process. Production traffic arrives through nginx over TLS from Kenya and
  Tanzania.

Each of these makes the local numbers *optimistic*. Treat 2892 rps as the
best the app could ever do on this hardware, and expect production to be well
under it.

## Files

| | |
|---|---|
| `load.mjs` | the generator — closed-loop, keep-alive, percentile reporting, SSE mode |
| `server.mts` | the real `createApp()`, no background workers, stubbed DB |
| `stub-prisma.mjs` | a Prisma client that answers in shapes Postgres could produce |

`load.mjs` has no dependencies on purpose: pointing it at a real host one day
should not mean installing a tool on that host.
