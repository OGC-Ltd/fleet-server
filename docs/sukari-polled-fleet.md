# Sukari — what is polled, and what is not

**Organisation:** Sukari Industries Limited · code `SUKARI` · id `cmr6da1bp0000vzizby6z0dzw`
**Figures measured:** 2026-07-30, against the live provider and the shared RDS.

Sukari's fleet is assembled from **two providers that know nothing about each
other**. Neither is complete on its own, and the join between them is a
registration plate. Almost everything surprising about this org follows from
that, so it is worth stating plainly before any of the numbers:

| | Registry, drivers, dispatches, alerts | Position, odometer, ignition |
|---|---|---|
| Source | RaiFactorySuite (`factorysuite.org`) | Wialon Hosting (`hst-api.wialon.com`) |
| Covers | **598** vehicles | **278** of them |
| Arrives by | webhook + 5-min reconcile | 2-second delta poll |
| Knows the other's ids? | no | no |

RaiFactorySuite is the system of record for *what the fleet is*. It exposes **no
coordinates at all**. Wialon is the only source of real GPS on the platform, and
it sees a little over half the fleet.

---

## 1. The registry — 598 vehicles

Synced from RaiFactorySuite with `npm run sync:vehicles`, upserted on
`externalId` (the provider's UUID). 597 of the 598 are `isActive`.

| Type | Vehicles | With a live tracker |
|---|---|---|
| `TRACTOR` | 482 | 184 |
| `TRUCK` | 67 | 62 |
| `COMPANY_VEHICLE` | 49 | 32 |
| **Total** | **598** | **278** |

The fleet is overwhelmingly tractors, and the tractors are the least tracked:
**38%** of them report position, against **93%** of trucks. Any fleet-wide
average taken over the polled subset is therefore a statement about trucks.

Also present: **550 driver users**, and **0 geofences** — every one of the 107
imported zones belongs to Kasulu, so no geofence rule evaluates for any Sukari
vehicle and the containment row never renders on a Sukari card.

## 2. The polled subset — 278 vehicles

Wialon exposes **336 units named `SUKARI*`** under the
`developer@offgridconsultingltd.com` account. Their names carry the plate:

```
SUKARI-AMBULANCE-KBN 201N
SUKARI-HARVESTING BUS-KBV 715U-2km/l
SUKARI-PRIME MOVER-FAW-KBU 715P-2km/l
```

`npm run sync:sukari-gps` parses the plate out of the unit name and points the
matching vehicle's `deviceId` at `wialon:<unitId>`. That single column is the
entire binding — positions are keyed on `deviceId` all the way through the
poller, so a bound vehicle starts receiving telemetry with no code change. The
script is idempotent and dry-run unless given `--apply`.

Of the 336 units:

- **324** carry a readable plate; **12** do not (asset names like `BELL16`,
  `TRAILER 60m` — nothing to match on).
- **278** are bound to a registry vehicle. ✅
- **46** have a good plate but **no registry row at all** — Wialon can see them,
  RaiFactorySuite has never heard of them. Mostly `SUKARI-HAULMASTER-*` and
  `SUKARI-KTCC *`. These are invisible in the dashboard: no vehicle, no marker,
  no alerts. **This is the one actionable gap in the data.**

And of the 598 vehicles, **320 have no Wialon unit**. They are not broken and
not "offline" in any fault sense — there is no hardware on them to report. They
will read OFFLINE forever until a tracker is fitted, and no amount of poller
work will change it.

## 3. How the polling actually runs

Two independent loops on the EC2 box (`lib/poll-loop.ts`), each with its own
guard, watchdog and cadence. A stall in one is visible in the logs as that
loop, and cannot skip the other's tick.

| Loop | Cadence | Carries |
|---|---|---|
| Wialon telemetry | `POLL_INTERVAL_MS=2000` | position, heading, speed, ignition, odometer, engine hours |
| RaiFactorySuite reconciler | `RAIFACTORYSUITE_POLL_MS=300000` | the safety net for webhook deliveries their sender gave up on |

Both are enabled on the box (`POLL_ENABLED=true`,
`RAIFACTORYSUITE_POLL_ENABLED=true`). The 2-second figure is not a full fleet
sweep — it drives Wialon's `avl_evts` **delta** stream, which returns only units
that changed. The `POLL_INTERVAL_MS` default in `config/env.ts` is 30 s; the box
overrides it.

Alerts and dispatches are **pushed**, not polled: RaiFactorySuite POSTs to
`/webhook/rai`, and the 5-minute reconciler only backfills what the push channel
dropped.

> ⚠️ **Known stale comment.** `src/index.ts` still reads "Live positions for
> KASULU come from Wialon. Sukari's provider exposes no coordinates". The second
> half is true; the first is now wrong — Wialon serves both orgs since the
> binding landed. Left in place rather than committing a comment-only change
> that would put the repo ahead of the deployed box.

## 4. What the polled vehicles actually report

Measured off the live snapshot (597 rows) on 2026-07-30:

| Channel | Vehicles reporting |
|---|---|
| Position | 278 |
| Odometer | 278 |
| Reported in the last hour | 172 |
| Reported in the last 24 h | 190 |
| Provider says connected | 103 |
| Engine on | 85 |
| **Fuel level** | **0** — see the correction below |
| **Cargo weight** | **0** |

> **CORRECTED 2026-08-02 — the fuel row was a reporting artefact, not a fact
> about the fleet.**
>
> Re-measured against the live provider and the database:
>
> | | Measured |
> |---|---|
> | Sukari Wialon units carrying a fuel-level probe | **336 of 336** |
> | …with a calibration table (readable by `readFuel`) | **262** |
> | Sukari vehicles whose newest ping carries `fuel_level_ml` (24 h) | **176** |
>
> Calibrated litres had been landing in `vehicle_telemetries.fuel_level_ml` all
> along. What was missing was `vehicles.tank_capacity_litres` — NULL on all 598
> rows, because `sync:sukari-gps` bound `deviceId` and never wrote the capacity,
> unlike `sync:wialon`, which has always read it from the probe's sensor name
> for Kasulu. With no divisor the snapshot computes no percentage, and both it
> and the dashboard refuse to invent one against an assumed tank — so the gauge
> rendered "—" and the count above came out as zero.
>
> `sync:sukari-gps` now writes the capacity too; 257 vehicles were populated on
> 2026-08-02 and the same query returns **176**, not 0.
>
> The lesson worth keeping: this table measures **what our pipeline stored**,
> not what the hardware reports. A zero here is a question, not an answer.

**Cargo weight is genuinely 0** — neither provider exposes a load channel. The
payload bar has no data behind it for this org, and the IN TRANSIT topbar KPI
was made plain for exactly this reason: its sub line was a permanent "(cargo
not reported)".

Note also that only **172 of 278** bound vehicles reported within the hour. A
tracker that is bound is not necessarily a tracker that is transmitting.

## 5. How new this is

Sukari GPS is **two days old**. Telemetry by day for this org:

```
2026-07-25    4        ← DB wipe / cutover; strays only
2026-07-26    1
2026-07-27    5
2026-07-28    3
2026-07-29    3,407    ← binding applied, real ingestion begins
2026-07-30   21,201
```

24,391 rows in total. A handful of rows carry timestamps back to 2025 — these
are **one row per scattered day**, from trackers reporting a bad clock, not
history. Do not read the telemetry table's `MIN(captured_at)` as a retention
window; there is no Sukari history before 2026-07-29.

This matters for anything that averages or takes a median over "the last N
days": for this org there is no N. It is also why dispatch distances are so
often zero — a dispatch raised before the 29th has no fixes to sum.

## 6. Dispatches — 1,048 rows

A third stream, from RaiFactorySuite only, backfilled with
`npm run sync:dispatches`. The provider caps `/dispatches` at 1000 rows and
**ignores offset**, so it is a sliding window: every day the sync is not re-run,
the oldest completed trips fall off and their durations are gone for good.

Destinations are free text — 152 distinct cane-zone names, no coordinates, not
in any usable gazetteer. Nothing derived from them can be a distance or a route.
There is currently **no UI consuming this data**; the hover-card section built on
it was removed on 2026-07-30.

---

## Summary for anyone reading a Sukari dashboard

1. **598 vehicles, 278 tracked.** The other 320 have no hardware.
2. **Tractors are the blind spot** — 482 of them, only 184 tracked.
3. **Fuel WORKS (corrected 2026-08-02); load does not.** 176 vehicles report a
   calibrated fuel level. The earlier "no fuel" finding was a missing tank
   capacity in our own registry, not absent hardware — see §4. Cargo weight is
   genuinely unavailable from either provider.
4. **No history before 2026-07-29.** Trends and medians have nothing to stand on.
5. **46 tracked units have no registry row** and are invisible in the app.

See also: [LIVE_INTEGRATION.md](LIVE_INTEGRATION.md),
[live-telemetry-design.md](live-telemetry-design.md).
