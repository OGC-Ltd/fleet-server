# Fuel tracking — how it is implemented

**Scope:** fillings and drains, per vehicle and per organisation, on the Live Feed.
**Figures measured:** 2026-08-02, against the live provider and the shared RDS.
**Orgs:** KASULU (Wialon account `Mufindi Paper Mills`) · SUKARI (units under `RAI GROUP`)

| | Status |
|---|---|
| Fuel ledger (`fuel_fillings` / `fuel_thefts`) | **live** — 1,598 rows |
| Live Feed items | **live** — in-process job, every 15 min |
| Provider fuel notifications | blocked on ControlTech ACL |
| Org attribution fix for Wialon notifications | written, **not yet landed** (§7) |

---

## 1. What was wrong

Fuel was a static gauge. The level reached the dashboard, but nothing ever became an event:
`wialon.adapter.ts` deliberately hardcodes every alert flag to `false` — raising them on guesses
would fabricate alerts — so the fuel-drop line in `feed-events.ts` was dead code.

`fuel_fillings`, `fuel_thefts`, their REST module and the analytics that read them had all survived
the simulator's retirement on 2026-07-25 with **nothing writing to them**. Both tables: 0 rows.

## 2. The fault that was hiding behind it

`docs/sukari-polled-fleet.md` recorded *"no Sukari vehicle reports fuel, from either provider."*
That was a fact about our pipeline, not about the fleet.

| Sukari | Before | After |
|---|---|---|
| Wialon units carrying a fuel-level probe | 336 of 336 | 336 |
| …with a calibration table (readable by `readFuel`) | 262 | 262 |
| Vehicles with `tank_capacity_litres` | **0** of 598 | **257** |
| Vehicles whose newest ping carries `fuel_level_ml` | 177 | 176 |
| Vehicles with a *usable* reading (litres **and** a percentage) | **0** | **176** |

Calibrated litres had been landing all along. What was missing was the **divisor**.

Wialon has no tank-capacity field — the operator encodes it in the fuel sensor's *name*
(`2.Main Tank Fuel Level Qty (520L)`), which `tankCapacityOf` parses. `sync:wialon` has always read
it for Kasulu; `sync:sukari-gps` bound `deviceId` and never did. With no capacity the snapshot
computes no percentage, and neither the API nor the dashboard will invent one against an assumed
tank — so the gauge rendered `—`, and the count came out as zero.

`sync:sukari-gps` now writes the capacity for every matched vehicle, **including the already-bound
ones** — which is where it mattered, since all 280 bound vehicles were affected.

> The lesson kept in `sukari-polled-fleet.md`: that table measures **what our pipeline stored**, not
> what the hardware reports. A zero there is a question, not an answer.

## 3. Approach — read the provider's answer, don't invent one

Wialon already computes fillings and drains, applying each probe's own filtering and ignoring the
sloshing and settling a raw level shows. Deriving them from our 2-minute samples would mean
inventing thresholds against probes that are demonstrably noisy — some units report volumes far
above their stated tank (one reads 7,184 L against a 540 L tank).

So **every volume, time and place on the feed is the provider's own figure.** We decide *who to ask
about*; Wialon decides *what happened*.

Three strands, in dependency order:

1. **Unlock the data already arriving** — tank capacity, §2. Everything downstream needs a divisor.
2. **Populate the ledger** from Wialon's per-vehicle *Advanced Fuel Analysis* report, §4.
3. **Surface recent events** on the Live Feed from an in-process job, §5.

## 4. Reading the reports

`wialon.reports.ts` executes the report and maps `unit_fillings` / `unit_thefts` into the existing
schema. Two properties were **measured, not assumed**, and the mapping depends on both:

- **Table order shifts per vehicle.** An empty table is omitted entirely, so `unit_fillings` came
  back at index 1 for one unit and index 0 for another. → tables are located by `name`.
- **Column names differ per template.** The standalone theft report says `Beginning` / `Drained`
  where Advanced Fuel Analysis says `Start Time` / `Stolen`, and only the latter carries an initial
  speed. → cells are located by **header label**.

Templates resolve **by name**, never by id: the ids are per-resource (both orgs have a template `2`
meaning different things) and an operator reordering their reports would silently repoint us.

| Org | Resource | Template |
|---|---|---|
| KASULU | `30394506` Mufindi Paper Mills | `MUFINDI- Advanced Fuel Analysis Report (Per Vehicle)` |
| SUKARI | `28843152` SUKARI INDURSTRIES LIMITED | `SUKARI -Advanced Fuel Analysis Report (Per Vehicle)` |

Backfill over 7 days: **1,119 fillings, 479 drains** (`npm run sync:fuel -- --apply`, ~50 min).

## 5. The live path, and why it runs in-process

```
Wialon probe (raw ADC)
   └─ poller, every 2 min → calibrated litres → vehicle_telemetries.fuel_level_ml
        └─ did this tank move?  min/max over 45 min ≥ 15 L
             ├─ no  → no provider call
             └─ yes → Wialon report over a 3 h window
                        ├─ fuel_fillings / fuel_thefts        (ledger)
                        └─ publishNotification → SSE + Redis + Postgres  (feed)
```

**Why in-process.** The CLI writes identical rows and its feed items were *invisible in production*.
`notification.reader` serves the first page from the Redis cache whenever the cache holds enough
items and never falls through to Postgres — and a CLI has no Redis, so `cacheNotification` is a
no-op. Measured against the live box, the same request returned:

| Request | Fuel items |
|---|---|
| `?limit=40` (Redis cache) | **0** |
| `?limit=40&before=…` (forces Postgres) | **21** |

Inside the server, `publishNotification` writes the live stream, the cached page and the history in
one call, so they cannot disagree.

**Why it never sweeps.** One report execution takes seconds and Wialon serialises them per session,
so sweeping ~460 instrumented vehicles takes tens of minutes — a nightly batch, not a quarter-hourly
one. Since the poller already stores a level every couple of minutes, a tank that has not moved
cannot have been filled or drained. `findFuelCandidates` answers that in one indexed query (~250 ms).

The candidate threshold is a **trigger, never a measurement**. It only decides who to ask about, so a
crude threshold cannot put a wrong number on the feed — at worst it asks about a vehicle with no
event, or a slow drain waits for the next cycle.

**Why two different windows.** The trigger window (45 min) and the report window (3 h) answer
different questions: "whose tank moved recently" wants a short one, "what exactly happened" wants a
long one so Wialon has settled readings either side of the event. Sharing a single 3-hour window
returns 47 candidates and re-executes each report ~12 times for the same event; split, it is 8.

**Feed publication is decided by an event's AGE**, never by whether the ledger row was new. Tying
them together let the nightly backfill swallow an event before any cycle could surface it. The stable
`feedId` upsert makes republishing harmless.

Config — inert without `REDIS_URL`, exactly like the retention sweep:

| Variable | Default |
|---|---|
| `FUEL_SYNC_ENABLED` | `true` (set `false` on additional instances) |
| `FUEL_SYNC_CRON` | `*/15 * * * *` |

## 6. Verification

Ledger sanity, run before anything was published:

| Check | Result |
|---|---|
| Filling arithmetic — `initial + filled = final` | 168 / 168 exact |
| Volumes exceeding tank capacity | 0 |
| Drains ending before they start | 0 |
| Rows outside their reporting period | 0 |

First production cycle, and the cached page the dashboard actually reads:

```
{"queue":"fuel","cron":"*/15 * * * *","msg":"Fuel event sync scheduled"}
{"candidates":12,"fillings":4,"thefts":2,"published":10,"failed":0,
 "msg":"Fuel sync cycle complete"}

SUKARI  cached first page: 40 items, 9 fuel
   10:41  KTCC 110D refuelled 22.3 L at Ndhiwa-Uriri Rd., Kanyikela Ward
   10:30  KTCC 505D refuelled 17.8 L at Ndhiwa-Uriri Rd., Kanyikela Ward
```

Drains render critical, fillings informational, interleaved chronologically with dispatch activity.
The wording states what Wialon measured and stops there — no claim that anyone has been alerted,
because no escalation path exists. 169 tests pass; typecheck clean.

## 7. Open items

**Org attribution — written, not landed.** Every Wialon notification was filed under KASULU whatever
vehicle it named; both orgs have units under one token, so Sukari's alerts would appear in another
company's feed. The fix (attribute to the matched vehicle's org, refuse to link an ambiguous plate)
plus fuel keywords in the severity map are **in the working tree but not committed** — the file now
imports `resolveEstatePlaces` from an in-flight `zone-presence` change that is not on `main`, so
committing it would not build. It ships with that work. Inert today only because no Wialon
notifications arrive at all.

**Provider fuel notifications — needs ControlTech.** Wialon's own fuel rules would alert in near
real time rather than as events mature. Our receiver handles them today, including the optional
`volumeL` / `fuelLevelL` fields (see `LIVE_INTEGRATION.md` §5.5.1), but the service account has view
rights only and cannot create rules. A configuration request; the report path deliberately routes
around it.

**Kasulu feed visibility.** Kasulu emits ~13 zone events per minute, so the 40-item feed covers
roughly three minutes of history and a fuel event computed later never appears there. The data is in
the ledger and the API. Needs filtering by event type or a dedicated fuel view — scoped, not built.

**Drains worth an operator's eye.** Some are large — 485 L on `MUFINDI - CTR 03`, 351 L on
`MUFINDI: DZ 04`. These are Wialon's own figures recorded faithfully, and are either serious losses
or probe artefacts. That distinction is an operational judgement, not one the platform should make.

**Driver attribution.** `analytics.repository` scores drains by `driverId`, and the backfill writes
`null` — who was assigned during a drain days ago is not something the current roster can answer. So
the ledger and the driver ratings will not agree.

---

See also: [LIVE_INTEGRATION.md](LIVE_INTEGRATION.md) §5.5.2 ·
[sukari-polled-fleet.md](sukari-polled-fleet.md) §4 ·
[wialon-integration-report.md](../../docs/wialon-integration-report.md)
