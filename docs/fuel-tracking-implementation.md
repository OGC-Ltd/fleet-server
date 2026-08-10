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
| Feed duplication + ordering under fuel events | fixed 2026-08-02 (§8) — **not deployed** |
| Ledger figures vs feed figures | fixed 2026-08-02 (§8); historical rows still need a re-sync |

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
them together let the nightly backfill swallow an event before any cycle could surface it.

That means one event is re-offered on every cycle inside the 2-hour notify window — up to eight
times. Republishing is now genuinely harmless, which it was not when this was written: see §8.

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

**Drains worth an operator's eye.** Some are large — 485 L on `MUFINDI - CTR 03`, 351 L on
`MUFINDI: DZ 04`. These are Wialon's own figures recorded faithfully, and are either serious losses
or probe artefacts. That distinction is an operational judgement, not one the platform should make.

**Driver attribution.** `analytics.repository` scores drains by `driverId`, and the backfill writes
`null` — who was assigned during a drain days ago is not something the current roster can answer. So
the ledger and the driver ratings will not agree.

## 8. What fuel events broke in the feed, and the fix

*Added 2026-08-02, after the first cycles ran against live dashboards.*

Fuel is the first emitter whose events do **not** arrive at the moment they happen. Wialon only
recognises a filling once settled readings follow it, so an item is published with an `at` up to two
hours old. Three components assumed arrival order was event order.

**The panel froze until a reload.** `useFleetLive` merged each SSE item with `[item, ...prev]` — a
blind prepend with no identity. Both panels render `key={item.id}`, so a republished item put two
siblings with the same React key in the list; React keeps the first and stops updating the rest.
Three things republish: the reconnect replay (EventSource reconnects internally, so the effect never
re-runs and never clears the feed, yet the server replays 40 items on every connect), the fuel sync's
age-based re-offer, and any reconcile pass. It is now a Map keyed by `id`, sorted on `ts` — which
also puts a past-dated fuel item in its correct slot instead of at the top.

**One event could be cached twice.** The Redis ZSET member was `JSON.stringify(item)`, so identity
was the exact serialised body rather than the `feedId`. Wialon refines a filling's volume, final
level and location as the report matures, so a republished event differing by one character became a
second member at the same score — one event shown twice, while Postgres held a single clean row. The
ZSET now holds ids with payloads in a companion hash, kept in step by one Lua script.

**Every republish reached the dashboard.** `publishNotification` is the single choke point, and it
had no memory. It now fingerprints `severity|text|plate|vehicleId|at` per `feedId`: an identical
re-offer reaches nothing — no SSE frame, no row, no cache write — while a **corrected** one still
goes out, because a refined volume is an update and not noise. In-process and synchronous, since the
callers are poll-cycle handlers; `SET NX EX` is the upgrade path if a second instance ever publishes.
`publishNotificationDurable` returns `{ item, published }` so a cycle can log `published: 0,
deduped: 6` rather than claim six publications.

**Kasulu's fuel events were unreachable** (this replaces the old §7 open item, which read as
cosmetic — it was not). At ~13 zone crossings a minute, `NOTIFICATION_CACHE_MAX` of 200 is about
fifteen minutes of history, so a 90-minute-old fuel event was added to the ZSET and removed by the
rank trim *in the same transaction* — and `notification.reader` serves the cache whenever it holds a
full page, so Postgres was never consulted. The item flashed on a live tab and was gone on refresh.
Correct ordering does not fix this: one chronological feed cannot serve both event rates. So the API
grew `?alertType=` and `?severity=` filters, which bypass the cache and read Postgres. The dashboard
still defaults to the mixed feed — **which view it should default to is not decided.**

**The ledger and the feed disagreed about the same event.** Found while confirming the above against
the live box, and the more serious of the two. Wialon does not merely refine an event's *wording* —
it refines its **figures**: one KCR 714F filling was reported as 55.1 L, then 53.9 L, then 52.8 L
across three cycles, at one unchanging timestamp. The notification was upserted every time, so the
feed tracked the latest answer; the ledger checked existence by `filledAt` and skipped, so it kept
the first glimpse forever. Measured on `fuel_fillings` versus `notifications`, 2026-08-02:

| Event | Ledger held | Feed said |
|---|---|---|
| KCR 714F 18:06 | 55.1 L | 53.9 L |
| KTCB 294U 17:52 | 57.2 L | 57.3 L |
| KTCB 466U 17:52 | **27.9 L** | **47.0 L** |

Analytics, reporting periods and driver scoring read the **ledger** — the stale side. A cycle now
rewrites the row when the provider's figures have moved, guarded on an actual change so settled
events are not written every cycle, and counts it as `corrected`. This is the module's own principle
applied consistently: the provider computes the event, we record its current answer.

**A refresh discarded everything that was not fuel.** The panel took the server's newest-40 replay
and threw away what it had accumulated — and on a lopsided fleet those 40 are all one kind of event.
Measured: SUKARI's newest 40 are 37 fuel items; KASULU's are 40 zone crossings. So a
`TRACTOR_OVERDUE` or a keep-out breach survived only as long as the tab stayed open. The dashboard
now persists the feed per company in localStorage (12-hour horizon) and merges the replay onto it
rather than replacing it.

Persistence alone was not enough, and the arithmetic is why: at thirteen crossings a minute a
200-item list is fifteen minutes of history, so an hour-old fuel drop is evicted by volume and a
bigger cap only moves the cliff. Trimming therefore reserves space — no single `alertType` takes
more than 60% of the list, and the majority gets the remainder back when nothing else is waiting, so
a single-type feed still fills the panel. The cost is that the list can show a chronological gap.
The `?alertType=` filter is the alternative if strict chronology matters more.

Also: `deriveFeedEvents` built its id from a process-global counter, so re-processing one frame
minted new ids and the duplicate was invisible to every dedupe including Postgres'. It now uses the
item's index within the frame — same uniqueness, but it repeats.

Cycle cost, while in here: ledger existence was a `findFirst` per event over a window that is almost
entirely already stored; it is now one range scan per table per vehicle, with reporting periods
memoised per month. A cycle that outruns its interval logs a warning, and a tick arriving while one
is still running is **skipped** rather than queued — concurrency 1 stopped overlap but not a pile-up.

**Not done.** Cross-source duplicates: when the ControlTech ACL lands, Wialon's own fuel rules will
push an alert for the same drain the report path publishes, under a different `feedId`, and nothing
will collide them. Deriving both from `fuel-<kind>-<vehicleId>-<minute>` would, but it needs the
webhook receiver to agree — decide before enabling the rules, not after.

## 9. Running the backfill against a live server

*Added 2026-08-02, after the first repair pass came back half-done.*

**Wialon executes ONE report at a time per account.** The CLI opens its own session, and the
in-process cycle (§5) is executing reports on the same account every fifteen minutes. Run them
together and the loser gets `Only one request at a time is allowed (1003)` per unit. Measured:

| Run | KASULU failures | SUKARI failures |
|---|---|---|
| Alongside the in-process cycle | 6 / 205 | **108 / 257** |
| With the cycle paused | 0 / 205 | — |

SUKARI took the damage because it runs second, by which point the cycle had fired twice. A pass that
reports "3 fillings written" after skipping 42% of the fleet looks like a quiet day, not a failure —
so **check the failed count, not just the written count.**

Pause it for the duration rather than editing `.env` (which is root-owned on the box):

```
FUEL_SYNC_ENABLED=false pm2 restart server --update-env    # log: "fuel event sync NOT started"
npx tsx prisma/sync-fuel-events.ts --days 7 --apply              # NOT npm run — see below
FUEL_SYNC_ENABLED=true  pm2 restart server --update-env
```

`--update-env` is what makes pm2 pick the variable up, and it is also what makes the restore
necessary: pm2 remembers the injected environment until told otherwise.

Nothing is lost to the pause. The cycle's report window is three hours and its notify horizon two,
so whatever matured while it was stopped is picked up on the next tick.

**Do not use `npm run sync:fuel` on the box.** It sets `DOTENV_CONFIG_PATH=.env.example`, and that
file points at `localhost:15432` — the developer's SSH tunnel, which does not exist on the server.
It fails to connect rather than writing anywhere wrong (`env.ts` also refuses a localhost URL under
`NODE_ENV=production`), but it will not do the job. Invoking `tsx` directly loads `.env`.

**Historical rows are still wrong.** The correction only fires when a cycle sees the event again,
i.e. inside the 3-hour window. Every `fuel_fillings` / `fuel_thefts` row older than that keeps
whichever figure was first observed. Re-running `npm run sync:fuel -- --apply` over a date range now
repairs them rather than skipping — worth doing over the backfilled week before anyone reads the
analytics.

---

See also: [LIVE_INTEGRATION.md](LIVE_INTEGRATION.md) §5.5.2 ·
[sukari-polled-fleet.md](sukari-polled-fleet.md) §4 ·
[wialon-integration-report.md](../../docs/wialon-integration-report.md)
