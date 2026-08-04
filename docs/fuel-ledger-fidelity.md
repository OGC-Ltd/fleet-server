# Fuel analytics vs. the Wialon/Controltech API — audit and repair

**Date:** 2026-08-04 · **Account:** `developer@offgridconsultingltd.com` (hst-api.wialon.com)
**Orgs:** KASULU (resource 30394506, template 26 "MUFINDI- Advanced Fuel Analysis Report (Per Vehicle)"),
SUKARI (resource 28843152, template 11 "SUKARI -Advanced Fuel Analysis Report (Per Vehicle)")

Method: execute the same per-unit fuel report the sync uses, over a **fixed, fully
settled window**, and compare the provider's rows to the `fuel_fillings` /
`fuel_thefts` rows the Analytics page reads. Read-only throughout.

---

## Verdict

The pipeline invents nothing. Every figure on the fuel card traces to a real
Wialon report row — `wialon.reports.ts` reads the provider's own tables, the
analytics repository sums stored rows, and `fuel-pricing.ts` only multiplies
litres by a rate it echoes back. The mock generators still sitting in
`dash/src/api/analytics.js` (`getWeeklyKPIs`, `getFuelTheftCases`,
`getFuelConsumptionByType`) are dead code — no screen imports them.

**But the ledger did not equal the provider.** Fillings were close. Drains were
overstated by 1.3–1.4× typically and up to 6× on the worst vehicles, because the
sync treated an event's start timestamp as its identity and Wialon moves that
timestamp while an event is still in progress.

---

## Finding 1 — one drain, many rows *(fixed)*

`MUFINDI: 008`, 2026-08-03 00:00Z → 2026-08-04 06:00Z:

| | events | volume |
|---|---|---|
| Wialon (settled) | 2 drains | **371.1 L** |
| Ledger | 10 rows | **1,553.3 L** |

The ten `began_at` values run 20:08:03, 20:15:27, 20:30:29, 20:45:04, 21:00:07,
21:15:08, 21:30:10, 21:45:12, 22:00:44 — **fifteen minutes apart, which is
`FUEL_SYNC_CRON`**. The sync cadence had been stamped into the data.

`syncVehicleFuelEvents` keyed dedupe on exact equality of `beganAt`. Wialon
re-clamps the beginning of an in-progress drain on every report execution, so
each cycle saw a start it had never stored and inserted a new row. The
`corrected` update path could never fire, because it only matched rows whose
timestamp was already identical.

Same pattern elsewhere: `MUFINDI: EX 17` 697.1 L stored vs 181.6 L real (3.8×),
`MUFINDI: DZ 04` 2,498.4 L vs 418.3 L (6.0×).

Fillings duplicated the same way, less severely — `MUFINDI: CTR 23` stored
`20:46:31 +21.1 L (1191.5→1212.6)` and `20:47:01 +11.8 L (1200.7→1212.6)`, one
fill counted twice thirty seconds apart.

### Fix

New module `src/modules/fuel/fuel-event-match.ts`. Identity comes from physics,
not from a clock:

- **Drains** — a tank can only be draining once, so two reports whose
  `[beganAt, detectedAt]` intervals overlap are the same drain however far the
  edges have moved. Boundaries are inclusive, which also makes Wialon's
  instantaneous drains (`began == detected`) match themselves.
- **Fillings** — near-instantaneous, so there is no interval. Repeated reports
  of one fill instead agree on the **tank state**: overlapping
  `[initial, final]` fuel levels within 15 minutes. Two real fills far enough
  apart to be distinct are separated by consumption, so their level ranges do
  not overlap.

`syncVehicleFuelEvents` now matches against the ledger with these rules,
**updates the matched row in place** (including its timestamps, which are part
of the provider's answer), and claims each row at most once per pass so two
genuine events cannot both rewrite one stale row.

---

## Finding 2 — retracted events accumulated forever *(fixed)*

Matching stops duplicates being *created*. It cannot remove what the provider
has since **withdrawn** — a candidate event that a wider, settled read no longer
counts at all. Eight of `MUFINDI: DZ 04`'s 29 stored drains for 2026-08-03 had
no counterpart in Wialon's settled answer; they overlap nothing, so no matching
rule reaches them, and an insert-and-update sync would carry them forever.

### Fix

`SyncOptions.reconcile` — treat the provider's answer for a window as
**complete** and delete ledger rows inside it that the report no longer
contains. Deliberately gated: it is only safe on a window that has finished
maturing, or the live job would delete an event Wialon has not yet recognised
and re-create it minutes later. Counted even in a dry run, because this is the
one branch that destroys data.

---

## Finding 3 — volumes froze at the provider's first guess *(fixed)*

Where both sides agreed an event happened, the stored volume was often the
un-settled one. `MUFINDI: CTR 23`, fill at 20:00:37 — ledger `+24.8 L
(1200.0→1224.8)`, Wialon now `+19.6 L (1205.2→1224.8)`: 27 % high. The revision
logic worked, but only while the event stayed inside the rolling 3-hour window.
Once it slid past, whatever had been recorded was permanent.

### Fix

The **settle pass** in `lib/queues/fuel-events.ts`. Each cycle re-reads a
rotating slice of vehicles over a window ending 6 hours in the past, with
`reconcile` on and notifications off. Rotation position is derived from the
clock, so it survives restarts and stores no cursor. At the default
`FUEL_SETTLE_BATCH=20` and ~460 instrumented vehicles, every vehicle comes round
in under six hours for roughly a minute of extra Wialon time per cycle.

It runs inside the existing job rather than on a queue of its own: both passes
drive one Wialon session and Wialon rejects concurrent calls on a session
(error 1003), so sequential is the only safe arrangement.

---

## Finding 4 — vehicles the sync could never see *(fixed)*

Sampling 15 KASULU vehicles with tanks, telemetry, and **zero** ledger rows for
2026-08-02: two had real Wialon drains, one of **957.9 L**.

Two causes, both in `findFuelCandidates`:

- `tank_capacity_litres IS NOT NULL` was standing in for "has a fuel probe", but
  it is filled in by hand and blank on **19 KASULU and 23 SUKARI** instrumented
  vehicles — excluded from fuel sync entirely. The lateral join already
  establishes the same thing far better: a vehicle with no fuel readings has a
  NULL spread and drops out regardless. **Filter removed** (also from the
  backfill CLI's vehicle query).
- A vehicle reporting sparsely has a spread of zero across one sample and can
  never become a candidate. `MUFINDI: 009` sent a single fuel reading that day.
  The settle pass fixes this structurally — rotation reaches every instrumented
  vehicle whatever its telemetry did.

---

## Finding 5 — the endpoint is not deployed *(NOT fixed — needs a deploy)*

```
GET /api/v1/organisations/<kasulu>/analytics/fuel-cost?days=30
→ 404 {"statusCode":404,"status":"error","message":"Route not found"}
```

while `/analytics/deliveries` and `/analytics/overview` on the same box return
200. Confirmed at the source: `git log -S"fuel-cost" -- analytics.routes.ts`
returns nothing, and `fuel-cost.cache.ts` / `fuel-pricing.ts` are **untracked**.
The whole ledger-backed fuel feature is uncommitted local work.

`apiFetch` throws on 404, so `fuel` is null, `hasFuel` is false — and since
deliveries reports `trips: 0`, **the Analytics tab on production currently
renders the "No delivery or fuel history yet" empty state.** Nothing to fix in
code; it needs committing and deploying.

---

## Smaller items

- **`mileageAtFillKm` is not an odometer.** Wialon's "Mileage" column is
  distance since the **report window started**: 10.17 / 30.25 / 51.28 km across
  one 30-hour window, where 3-hour windows stored 0.25 / 0.09 / 0.01. Nothing
  reads the column, so it is latent — but the seeds populate it with
  odometer-scale values, so the intent clearly differs from what is stored.
  Left alone; flagged.
- **`tank_capacity_litres` disagrees with probe calibration** on 22 of 496
  KASULU fillings, whose *final* level exceeds the stated tank. `MUFINDI: 008`
  is listed at 254 L and reads 1,432 L. Data entry, not code.
- **Analytics screen said 1.5×** for the interrupted-delivery threshold where
  the server uses `INTERRUPTED_RATIO = 2.0`. Corrected to 2×.
- **Thousands separators** were checked and are absent on this account
  (`1432.70 l` parses correctly). `cellNumber` would misread a comma-grouped
  value as a decimal, but no such value exists here. Not changed.

---

## Domain caveat — worth raising with the operator

**352 of 427** KASULU drain rows start at speed 0, on excavators and dozers.
Engine-on stationary consumption on heavy plant is very likely being reported as
theft by the Wialon template itself. That is upstream of this codebase — but the
dashboard labels it "Fuel lost to drains" and prices it as loss, so the template
configuration deserves review before anyone acts on those numbers.

---

## Impact

Trailing 30 days, priced at the configured KES 179.36/L. "Corrected" is an
overlap-merge estimate from the ledger alone; the true figure is somewhat lower
still, because it cannot see retractions.

| | as shown | corrected |
|---|---|---|
| KASULU fuel lost | 24,414 L · KES 4,378,829 | ~19,442 L · KES ~3,487,153 |
| KASULU fuel filled | 71,206 L · KES 12,771,524 | ~68,561 L · KES ~12,297,144 |
| SUKARI fuel lost | 7,053 L · KES 1,264,962 | ~6,965 L · KES ~1,249,321 |
| SUKARI fuel filled | 25,208 L · KES 4,521,226 | ~24,983 L · KES ~4,480,876 |

Ground-truth ratios from a random 36-vehicle sample against the live API:
fillings 1.00× (SUKARI) / 1.07× (KASULU); drains **1.40× / 1.29×**.

---

## Changed

| File | Change |
|---|---|
| `src/modules/fuel/fuel-event-match.ts` | **new** — event identity rules |
| `src/modules/fuel/fuel-sync.service.ts` | match-and-update instead of timestamp-keyed insert; `reconcile`; row-keyed feed ids; candidate-query fix; `listVehicleSlice` |
| `src/lib/queues/fuel-events.ts` | settle pass; `settled` / `removed` counters |
| `src/config/env.ts` | `FUEL_SETTLE_ENABLED`, `FUEL_SETTLE_BATCH` |
| `prisma/sync-fuel-events.ts` | `--reconcile` / `--settle-age`; vehicle-query fix |
| `tests/unit/fuel-event-match.test.ts` | **new** — 15 cases, all built from live rows |
| `tests/unit/fuel-sync.service.test.ts` | fixtures updated; drift, reconcile, feed-id cases added |
| `dash/…/AnalyticsScreen.jsx` | 1.5× → 2× |

`tsc --noEmit` clean; 261 passed / 7 skipped.

### Feed side effect, one time only

Feed ids now key on the ledger row rather than the event timestamp, so an
in-progress event stops raising a fresh "FUEL DROP" line every cycle. Events
already in flight at deploy time get one new id, i.e. at most a couple of hours
of feed entries may appear twice, once.

---

## Repairing the existing rows

Run over both orgs, 30 days, through the developer SSH tunnel:

```bash
ssh -i keys/logistics.pem -N \
  -L 15432:fleet-store.c8ty8uocsdjp.us-east-1.rds.amazonaws.com:5432 \
  ubuntu@ec2-18-232-178-169.compute-1.amazonaws.com
```

```bash
npm run sync:fuel -- --days 30 --reconcile           # dry run, writes nothing
npm run sync:fuel -- --days 30 --reconcile --apply
```

The window automatically ends 6 hours back, which is also why this does **not**
need the live job paused: the fast pass works on the last 3 hours, the repair on
everything older, and the two cannot meet.

A 10-vehicle dry run over 2 days found 16 stale rows to delete, 3 events to
re-point onto existing rows, and 2 drains the old sync had missed outright.

### Outcome — run 2026-08-04, 30 days, both orgs

```
KASULU   926 fillings,  673 drains written · 30 corrected · 113 removed · 6 units failed
SUKARI  2327 fillings,  655 drains written · 13 corrected ·  18 removed
total   3253 fillings, 1328 drains written · 43 corrected · 131 removed
```

Verified afterwards against Wialon over 2026-08-03 00:00–20:00Z, a window wholly
inside the repaired range:

| vehicle | Wialon fills | ledger fills | Wialon drains | ledger drains |
|---|---|---|---|---|
| MUFINDI: 008 | 1 / 661.8 L | 1 / 661.8 L | 1 / 95.4 L | 1 / 95.4 L |
| MUFINDI: DZ 04 | 3 / 524.9 L | 3 / 524.9 L | 5 / 388.4 L | 5 / 391.5 L |
| MUFINDI: EX 17 | 1 / 474.6 L | 1 / 474.6 L | 2 / 55.0 L | 2 / 55.0 L |
| MUFINDI: CTR 23 | 2 / 26.1 L | 2 / 26.1 L | 5 / 116.7 L | 5 / 116.7 L |

Counts match exactly; volumes match to the litre except DZ 04's drains, 0.8%
apart because the provider has revised them since the run — which the settle
pass converges. For contrast, DZ 04 over the same day before the repair held
**29 drain rows totalling 2,498 L against Wialon's 6 and 418 L**.

**The totals went UP, not down.** Removing 131 phantom rows is dwarfed by
recovering 4,581 events that were never fetched at all (Finding 4): the old
candidate query needed both a 15 L spread and a tank capacity on file, so
roughly two-thirds of SUKARI's instrumented fleet was invisible to it. The
pre-fix figure was wrong in both directions at once.

30-day totals now served by `/analytics/fuel-cost`:

| | filled | lost | loss share |
|---|---|---|---|
| KASULU | 205,481 L · KES 36,855,101 | 56,048 L · KES 10,052,698 | 27.3% |
| SUKARI | 96,324 L · KES 17,276,705 | 21,995 L · KES 3,944,978 | 22.8% |

A 22–27% "loss" share is not credible as theft and should not be read as such —
see the domain caveat above. It is the Wialon template's drain detection firing
on engine-on stationary consumption, and it is now measured honestly rather than
measured wrongly.

### Six KASULU units the token cannot report on

```
MUFINDI: OPTIM - COMP 02 / DZ 08 / FT 02 / LMV 03 / LMV 10 · MUFINDI: WL 05
  → Wialon report/exec_report failed: Access denied (7)
```

These are visible to the token for telemetry but not for report execution, so
they contribute no fuel events and never will until the account's report
permissions are widened. Their fuel is silently absent from every figure above.

### ⚠ The repair is a point in time, not a cure

The production box runs the code in `git HEAD`. Everything in this document is
**uncommitted local work** — including `/analytics/fuel-cost` itself (Finding 5).
So until it is committed and deployed:

- the box keeps executing the old timestamp-keyed sync every 15 minutes;
- it keeps writing a fresh duplicate row per cycle for every in-progress drain;
- the repaired figures start drifting again immediately.

Observed live during this session: `MUFINDI: 008`'s evening of 2026-08-03 held
**10** drain rows at 04:10 and **14** by 05:20 — four more duplicates in seventy
minutes, on one vehicle, while the audit was being written.

Deploy first if you can. Repairing before deploying buys clean history and a
clean *today*; it does not stop tomorrow.
