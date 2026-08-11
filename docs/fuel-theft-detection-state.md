# Fuel event detection — where this stands

Written 2026-08-11 as a handover, revised the same day after the backfill ran
and again after the vocabulary changed. Read this before touching the fuel
pipeline.

---

## The vocabulary changed — read this first

Asked for directly by the operator on 2026-08-11: *"we need to have either a
refill, drain or redistribution (undulation)"*, and *"avoid strong words like
loss"*. `LOSS` and `UNVERIFIED` are gone from the enum, the code, the feed and
the dashboard.

| was | is |
| --- | --- |
| `LOSS` | `DRAIN`, confirmed |
| `UNVERIFIED` / `insufficient-telemetry`, `drop-not-observed`, `no-drop-observed` | `DRAIN`, unconfirmed |
| `UNVERIFIED` / `filling-too-soon` | `REFILL` / `filling-in-window` |
| `REDISTRIBUTION`, `SENSOR_FAULT`, `PENDING` | unchanged |

Two separate things had been mashed into one field. **`verdict` now says what
happened to the fuel; `confirmed` says whether we watched it happen.**
Confirmation is DERIVED from `verdictReason` (`isConfirmed`), never stored — a
second column that must agree with the first is a second column that can
disagree with it.

Why each went:

- `LOSS` asserted where the fuel went. Telemetry cannot see that. It observes a
  level falling and not returning, which is what `DRAIN` says and as far as this
  data honestly goes.
- `UNVERIFIED` described our EVIDENCE, not the fuel, and covered 1,938 of 2,571
  rows — so for three quarters of the ledger nobody could tell whether the fuel
  had gone.

Migration `20260811060000_fuel_event_verdict_vocabulary`, validated against prod
inside a rolled-back transaction: `DRAIN 1,919` (415 confirmed) · `REFILL 435` ·
`REDISTRIBUTION 213` · `SENSOR_FAULT 4`, no nulls.

**Nothing in the operator-facing path may say loss, theft, stolen or suspicious
again** — that includes the notification text, the dashboard chips and labels,
and the `SYSTEM_PROMPT` in `ai-insight.ts`, which is now instructed against it
explicitly. A test asserts it on the notification path.

---

## The one thing to understand first

**The tank-state gap is real. The fix proposed for it does not work, and the
measurements below close the question — do not re-open it without reading them.**

Raised by the operator against `MUFINDI: DZ 07`, whose drains read:

```
-61.7 L   -51.6 L   +51.6 L   +23.9 L   -23.7 L      20:57 -> 21:52
```

Their words: *"without the original tank state you cannot make a decision on if
this is a theft or not."* The phenomenon is real and now quantified. The
proposed instrument — fill fraction as a trust gate — fails twice:

**1. The denominator is not knowable per vehicle.** `vehicles.tankCapacityLitres`
IS populated (466 of 822 units; the earlier claim that capacity "is not stored"
was wrong). It does not agree with the probes:

| | |
| --- | --- |
| median sustained max / declared capacity | **0.64** |
| units never reading above half their declared capacity | 120 of 299 |
| units reading ABOVE declared | 16 |
| worst | `MUFINDI: DZ 16` — 7,204 L sustained on a declared 540 L tank |

Observed max is no better a substitute: max over sustained-max is 12x at p99,
28x at worst. Both routes to a fill fraction are unreliable, in both directions.

**2. On the units where the two DO corroborate, the hypothesis is backwards.**
Over the 119 units where declared and observed agree within 20%, parked
half-hour swings by fill:

```
fill      windows   swing p50  p90  p95   share >=10 L
  0- 10%       77         0    1    1        3.90%
 40- 50%      524         1   17   23       18.70%
 70- 80%      703         3   19   36       21.76%
 90-100%      922         1   15   20       16.49%
```

A fuller tank swings **more**. Physically unsurprising — more fuel free to move,
and a probe near the bottom of its range has little above it to move away. A
gate suppressing verdicts on part-full tanks would suppress the wrong ones.

Note this is fill fraction's *second* failure. `modules/fuel/fuel-adjudication.ts`
already recorded it failing as a CLASSIFIER (0.62 vs 0.63 on KASULU, inverted on
SUKARI). It now also fails as a TRUST GATE, which was the open question.

## What replaced it, and what shipped

The same question asked of the **machine** instead of the tank. Big parked
swings are not spread across the fleet:

- 97 of 139 units never swing >=25 L while parked
- 80% of all >=25 L swings come from 13 vehicles (9% of the fleet)

and unlike fill fraction it predicts the verdict. The gate is in
`applyProbeTrustGate` (`fuel-adjudication.ts`), fires only on LOSS, and only
ever moves a drain to UNVERIFIED — which stays in the loss figures, so nothing
is written off by it. Constants and the threshold grid that chose them are
documented at `SWING_ML` / `SWING_SHARE` / `MIN_SWING_WINDOWS`.

**Read `MIN_SWING_WINDOWS` before changing it.** The obvious guard — a minimum
number of PARKED windows — excluded DZ 07 itself, which has only 12 parked
half-hours because it spends its days working, 9 of them swinging. Counting the
swings rather than the opportunities is what catches the originating case.

Impact if applied to the ledger: **173 of the 415 confirmed drains (13,550 L)**
across 15 machines, led by `MUFINDI: DZ 05` (34 rows), `DZ 14` (24),
`KHMA 449U` (18), `DZ 04` (15), `MUFINDI: 008` (14), `DZ 07` (10). Note that
under the new vocabulary the gate moves **no volume at all** — a DRAIN counts
whether or not it is confirmed. All it withdraws is the confirmation and the
critical notification that went with it.

## The backfill — DONE, and it had a bug in it

`prisma/readjudicate-fuel.ts` already existed but kept its **own copy** of the
sweep's evidence query, and that copy selected no `engineOn`. Both dead-probe
rules decide on engine evidence, so from the day `SENSOR_FAULT` shipped a
re-judge could not reach that verdict for any row — silently, because a missing
`engineOn` reads as "no engine evidence", a state the rules tolerate by design.

Both callers now go through one `judgeDrain()` in `fuel-adjudication.service.ts`.
Do not reintroduce a second copy of that query.

Applied to prod 2026-08-11 over a 45-day window, 2,564 rows examined:

| verdict | before | after |
| --- | --- | --- |
| LOSS | 604 | **417** |
| UNVERIFIED | 1,719 | **1,938** |
| REDISTRIBUTION | 241 | **212** |
| SENSOR_FAULT | 0 | **4** |

269 rows changed; 2,297.7 L moved back into the loss figures, 717.6 L out.
`drop-not-observed` went 73 -> 291 — that is `OBSERVED_DROP_MIN_RATIO`, added
2026-08-08, finally reaching history.

**The guard that makes re-judging safe** is `isUncheckable`, not the `--days`
window: a verdict decided on evidence is never overwritten by one reporting the
absence of evidence. Only 1 row needed it — telemetry goes back to 2025-01
against a ledger starting 2026-07, and nothing prunes it (`lib/queues/retention`
sweeps notifications only). The guard is there for when that changes.

## `fsl_dead` — DONE

`modules/fuel/fuel-probe-health.ts` (pure rule) + `.service.ts` (sweep), wired as
a daily BullMQ job at 04:23 UTC on the `maintenance` queue, and runnable by hand
with `npx tsx prisma/probe-health.ts`. Prod, 2026-08-11: **15 DIED, 32 SILENT,
25 not fitted, 293 reporting.**

Validated against the five units the operator independently sent for a workshop
visit — `MUFINDI: FT 11`, `MUFINDI: EX 07`, `KDL 182X`, `KTCC 811D`,
`KTCC 856B` — and it flags all five, plus ten nobody had noticed.
`MUFINDI - FT 13` has been dark since 2026-07-31 with 2,992 pings of movement
since.

**It deliberately does not gate on `engineOn`**, unlike the adjudicator's rule,
which is answering a different question. `KTCC 856B` reports `engineOn` on 0 of
780 readings and `MUFINDI: EX 07` on 0 of 11,965 — an engine-gated rule misses
two of the operator's own five. Movement stands in where it exists.

Uses the durable notification path, not `VehicleAlert`: `syncFrameAlerts`
resolves every open alert whose type is not in the current frame's flags, so an
alert raised out of band is closed by the next ping.

## Measured facts worth not re-deriving

- **Probes.** 30 units pinned at exactly zero across 386k readings; 32 have never
  read above zero in 30 days. 25 more report telemetry with no fuel channel at
  all and are NOT a fault.
- **Motion gating is not worth building.** Slosh is ~1.4 L at p95, and 57-90% of
  drains are fully static.
- **Consumption must be engine-hours, not km.** 215 of 310 probed units are plant
  or tractors. Rates in `fuel-consumption-rates.md`; per-vehicle required, spread
  within a type reaches 4.1x.
- **Claim sizes.** p25 16.2 L, p50 27.0 L, p75 45.1 L, p90 82.7 L. This is what
  makes 25 L the right swing threshold — it is the median claim.
- **The dashboard's fuel gauge is wrong for most of the fleet.** `poller.ts` and
  `db-follower.ts` both compute `fuelLevelPct` as
  `fuelLevelMl / (tankCapacityLitres ?? 200) * 1000`, and the measurements above
  say that denominator is off by more than 20% on 180 of 299 probed units. Not
  addressed here; it is a separate piece of work and nobody has complained yet.

## Next, in order

1. **Deploy.** The vocabulary change, the volatility gate and the probe-health
   sweep are NOT on the box — fleet-server has no Actions secrets and deploys by
   hand. `prisma migrate deploy` must run for the enum swap; the server will not
   start against the old enum. Dash deploys itself from a push to its main.
2. **Then apply the volatility gate to history** with `readjudicate-fuel.ts`.
   Same command, same guard. Until it runs, old and new drains carry
   confirmation judged by different rules.
3. **Then** the originating detector (settle-time baselines, threshold,
   expected-consumption reconciliation) on a level series that can now be
   interpreted. Not started.
4. The fuel-gauge denominator, if anyone starts trusting the percentage.

Two older analyses — `analytics-fidelity-plan.md` and
`fuel-displacement-mirror.md` — are written in the retired LOSS/UNVERIFIED
vocabulary. They are dated findings and were left as they were rather than
rewritten; read them with the mapping table above beside you.

## Not shipped, deliberately

Five files carry uncommitted gate-arrival work (`yard-departure.ts`,
`telemetry.worker.ts`, `raifactorysuite-events.service.ts` and two tests). It is
complete and tested but was never committed, pending observation of real gate
crossings. Do not sweep it into an unrelated commit.
