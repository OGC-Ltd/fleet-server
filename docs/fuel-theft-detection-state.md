# Fuel event detection — where this stands

Handover, rewritten 2026-08-11 after a full day of changes. Read this before
touching the fuel pipeline. Everything below is deployed unless it says
otherwise.

---

## 1. The vocabulary — read this first

At the operator's instruction: *"we need to have either a refill, drain or
redistribution (undulation)"*, and *"avoid strong words like loss"*. `LOSS` and
`UNVERIFIED` are gone from the enum, the feed and the dashboard.

**`verdict` says what happened to the fuel. `confirmed` says whether we watched
it happen.** They were one field doing both jobs. `confirmed` is DERIVED from
`verdictReason` via `isConfirmed()` and never stored — a second column that must
agree with the first is a second column that can disagree with it.

| verdict | meaning |
| --- | --- |
| `DRAIN` | the level went down and did not come back |
| `REDISTRIBUTION` | the level came back with no filling — undulation |
| `SENSOR_FAULT` | the probe failed; not a fuel event |
| `PENDING` | inside the 20-minute settle window |
| `REFILL` | **RESERVED — never assigned.** See below. |

**`REFILL` must never be given to a `fuel_thefts` row.** It was, for a few
hours, to drains whose recovery window a filling had closed. Two things were
wrong with that and both are instructive:

- It is an ABSENCE of evidence, not a finding. We cannot tell "the drop was
  spurious and they refuelled" from "fuel was taken and then they refuelled".
  This module removes what it can DISPROVE, never what it merely doubts.
- The filling that closes the window need not be real. On an oscillating probe
  Wialon logs up-swings as fillings and down-swings as thefts. `MUFINDI - EX 22`
  ran `-21.7, +29.1, +24.8, -27.7, +28.2 L` in four minutes; the `-21.7` was
  correctly ruled REDISTRIBUTION while the `-27.7` became a REFILL and rendered
  **green against a negative volume** on the dashboard.

Every row on that table is a reported DROP, so none can turn out to be fuel
arriving. Real refills are `fuel_fillings` rows and render green there. The dash
now enforces this independently: **the sign decides the colour first**, and no
verdict can override it (`chipKind` in `SensorPanel.jsx`).

Nothing operator-facing may say loss, theft, stolen or suspicious-as-a-verdict
again — that includes notification text, dash labels, and `SYSTEM_PROMPT` in
`ai-insight.ts`, which is now instructed against it explicitly. A test asserts
it on the notification path.

Colours, per the operator: **every drain red** (confirmed or not — that split is
about our coverage, not the fuel, and lives in the tooltip), **undulation
amber**, **refills green**.

## 2. Ledger state, 2026-08-11 (after all backfills)

| verdict | reason | rows |
| --- | --- | --- |
| DRAIN | insufficient-telemetry | 1,129 |
| **DRAIN** | **level-stayed-down** (confirmed) | **468** |
| DRAIN | filling-too-soon | 438 |
| DRAIN | probe-swings | 240 |
| REDISTRIBUTION | level-recovered | 137 |
| DRAIN | drop-not-observed | 114 |
| DRAIN | no-drop-observed | 35 |
| SENSOR_FAULT | fsl-dead | 4 |

It started the day claiming **604 confirmed losses**. It now claims **468
confirmed drains** — ones we have actually watched happen in our own telemetry
rather than asserted on the provider's word.

## 3. What shipped today

| commit | what |
| --- | --- |
| `2c32dc5` | `fsl_dead` probe-health sweep + daily 04:23 UTC job |
| `0f51493` | vocabulary migration, probe trust gate, one shared evidence path |
| `6165ddf` | stop inventing a 200 L tank for the live fuel percentage |
| `b155bac` | a reported drop is never a REFILL |
| `8b6fd79` | find the trough AFTER the drain, not only inside the claim |
| `a4c0539` | let probe-health exit when it is done |
| dash `62f1ddf`, `b3a94a7` | colours, Tank column, sign-over-verdict guard |

Migration `20260811060000_fuel_event_verdict_vocabulary` is **applied** on prod.
A backup of all 2,571 rows in the old vocabulary, plus a ready-to-run restore,
is at `/home/ubuntu/fuel_thefts_verdicts_2026-08-11T03-51-53.*` on the box.

### The two bugs worth understanding

**One evidence path.** `readjudicate-fuel.ts` kept its own copy of the sweep's
telemetry query and the copy omitted `engineOn` — so from the day `SENSOR_FAULT`
shipped, a re-judge could not reach that verdict for any row, silently, because
absent engine data is a state those rules tolerate by design. Both callers now
go through `judgeDrain()`. **Do not reintroduce a second copy of that query.**

**The trough window.** The trough was taken from the provider's own event
window, so a fall that starts *after* the provider closes the event was
invisible and the drain was thrown out as "we never saw it fall".
`MUFINDI - EX 09`: Wialon claimed 220→199 L between 14:37 and 14:50; our
readings show 220.5 at 14:37, still 219.4 at 14:49, then 212.7 → 203.7 → 199.1
by 15:09, holding for half an hour, parked with the engine off. Measured inside
the claim window that is a 1 L drop.

This runs the OPPOSITE way to every other fix: it **under**-called real drains.
`drop-not-observed` collapsed from 292 rows to 114.

The recovery test had to move with it: "did it come back" means came back UP
FROM THE LOW POINT, so `peakAfter` is measured from the trough onward.
Otherwise a level sitting at 200 L that falls to 150 L late gives peak 200,
trough 150, ratio 1.0 — a perfect "it recovered" read off a fall that never
recovered. That was a real failure, not hypothetical: `KTCC 111G` fell
40.3 → 23.7 L and stayed at ~25 L for three hours, and was stored as
REDISTRIBUTION with "16.6 L recovered" — which was the fall itself, measured
from the wrong side. Both cases have regression tests.

## 4. The probe trust gate

Fill fraction was the proposed instrument and it **fails twice**; do not
re-propose it, it has now failed as a classifier AND as a trust gate.

- The denominator disagrees with the probes on 180 of 299 units.
- On the 119 where the two sources corroborate, parked swings **rise** with
  fill (3.9% of windows ≥10 L at 0-10% fill vs 21.8% at 70-80%) — the opposite
  of the hypothesis.

What works is the MACHINE, not the tank: 97 of 139 units never swing ≥25 L
parked, and 80% of big swings come from 13 vehicles. `applyProbeTrustGate` fires
only on a confirmed DRAIN, withdraws only the confirmation, and **moves no
volume** — a drain counts either way. Constants at `SWING_ML` / `SWING_SHARE` /
`MIN_SWING_WINDOWS`.

**Read `MIN_SWING_WINDOWS` before changing it.** The obvious guard — a minimum
number of PARKED windows — excluded `MUFINDI: DZ 07`, the case that started all
of this, because a dozer spends its days working and has few parked windows. It
counts the swings, not the opportunities.

⚠️ **The thresholds are now stale.** 25 L / 5% was chosen against verdicts the
trough fix has since changed; the 1.47x separation no longer describes the
current ledger. The gate currently touches 240 rows. Re-measure before trusting
that number.

## 5. `fsl_dead`

`fuel-probe-health.ts` (pure rule) + `.service.ts`, daily at 04:23 UTC on the
`maintenance` queue, runnable by hand with `npx tsx prisma/probe-health.ts`
(`--notify` to publish). Prod: **13 died, 32 silent, 25 not fitted, 295
reporting.**

Validated against the five units the operator independently sent for a workshop
visit — it flags all five plus ten nobody had noticed. **It deliberately does
not gate on `engineOn`**, unlike the adjudicator's dead-probe rule: `KTCC 856B`
reports it on 0 of 780 readings and `MUFINDI: EX 07` on 0 of 11,965, so an
engine-gated rule misses two of the operator's own five.

Uses the durable notification path, not `VehicleAlert`: `syncFrameAlerts`
resolves every open alert whose type is absent from the current frame's flags,
so an alert raised out of band is closed by the next ping.

---

# OPEN — in priority order

## A. FSL columns: initial/current fuel, and working turbulence

Asked for at the end of the session, **not started**. As I understood it:

1. `Tank` stops showing `current / capacity` and becomes the **initial** fuel
   level in litres — the level at the *previous* stop.
2. A **new column** holds the **current** level in litres.
3. At each stop, roll the pair: `initial ← old current`, `current ← new
   reading`; the difference is fuel consumed since the last stop.
4. A **moving-average turbulence** figure measured while the unit was *working*
   — engine on, whether moving or stationary.

**Three decisions the operator must make before this can be built:**

- **What is a "stop"?** Engine off? Speed 0 held for N minutes? Arrival in a
  geofence? This defines the whole column — a dozer that idles all day never
  stops under one definition and stops constantly under another. Most important
  of the three.
- **Does capacity disappear?** They asked for `current / capacity` earlier that
  same day and that is what shipped (`318 / 335 L`). If `Tank` becomes initial,
  is capacity dropped or kept elsewhere?
- **Turbulence over what window?** Last N stops, last 24h, or since the last
  refill.

**Most of the machinery already exists.** `getProbeProfile` in
`fuel-adjudication.service.ts` measures level swing per 30-minute window but
only while PARKED (to judge probe trustworthiness). The request is the same
measure while WORKING — nearly the same query. The two together are genuinely
informative: swing while parked means the probe is unreliable, swing while
working describes terrain and load.

The consumption half is the more valuable one and connects to
`fuel-consumption-rates.md`: consumption must be per-vehicle ENGINE-HOURS, not
km, because 215 of 310 probed units are plant or tractors. A stop-to-stop delta
is a far better input than anything computed today.

## B. ~~The fillings ledger is not adjudicated at all~~ — DONE 2026-08-11

`fuel-filling-adjudication.ts` (pure) + `.service.ts` + `prisma/adjudicate-fillings.ts`,
migration `20260811090000_fuel_filling_verdict`. Applied to all 5,794 rows:

| verdict | rows | claimed | observed |
| --- | --- | --- | --- |
| REFILL · insufficient-telemetry | 3,928 | 265,133 L | — |
| REFILL · level-rose (confirmed) | 1,557 | 130,797 L | **133,791 L** |
| REDISTRIBUTION · no-rise-observed | **307** | 13,075 L | **−3,689 L** |

The confirmed set validates the rule: 133,791 L observed against 130,797 L
claimed is 102%, near-exact. The 307 claim fuel arriving while the tanks went
DOWN 3,689 L — `MUFINDI: DZ 04` claims +480 L against an observed −20 L.

Uses MEDIANS either side, not the extrema the drain rules use: a drain asks how
far down it ever went (an extreme), a filling asks what the level was before and
what it is now (two steady states). On a probe that swings 25 L parked, a
max/min pair would invent or erase a delivery on noise alone.

`filledMl` is never edited; `observedRiseMl` holds what we saw, so the claim and
the measurement stay side by side. Dash draws a REDISTRIBUTION filling amber
(`dash 2bec463`).

**Still open here:** the sweep is a CLI only — it is NOT wired into a schedule,
so new fillings sit at PENDING until someone runs it. It should join the daily
maintenance queue beside the probe-health job.

### Original note, kept for the reasoning

Drains are checked against our own telemetry. **Fillings are stored exactly as
Wialon reports them, with no check.** Two cases found today:

- `MUFINDI: LMV 03` — three "fillings" stamped the same minute totalling
  **288.7 L into a 180 L tank**. Our readings show `26.5 → 81.0 L` and it stayed
  up: ONE real refuel of ~54 L, triple-counted and inflated 5.3x.
- `MUFINDI - EX 22` — three fillings in two minutes on an oscillating probe.

Fleet-wide: **17 fillings exceed the tank they went into**, 56 rows sit within
5 minutes of another on the same vehicle, 5 clusters total more than the tank
(1,229 L).

This is not cosmetic. A phantom filling **corrupts drain adjudication** by
truncating the recovery window — that is the `filling-too-soon` path, now the
third-largest category at 438 rows. Mirror `judgeDrain`: a real filling shows a
sustained RISE, noise shows a spike that falls back. There is a spawned task
carrying the full brief.

## C. Remove MUFINDI units that "never appear on Controltech"

Asked for; **cannot be done without a rule.** The obvious test — a vehicle in
our DB with no matching unit in the provider's device list — **finds nothing**.
`sync-wialon.ts` already implements exactly that (deactivates
`externalId notIn seen`, hard-scoped to the KASULU account, so SUKARI is safe).
Run on 2026-08-11: Wialon returned 218 units, all 218 active KASULU vehicles
matched, **0 deactivated**. `MUFINDI: 009` IS in the account
(`wialon:30287336`) and reports telemetry.

So the units the operator wants gone are junk on Controltech's side, not
phantom rows on ours. Candidate rules to put to them:

- **The `XN` prefix.** That sync hit 4 duplicate-plate failures, one being
  `XNMUFINDI: BUS 02` against a live `MUFINDI: BUS 02`; `XNMUFINDI: CTR 03` also
  appeared in the dead-probe sweep. If `XN` marks a retired unit, each pair is
  one vehicle listed twice and colliding on the plate. **Most promising.**
- A named list from the operator.
- Never-reported: `MUFINDI: 012/013/014/015` plus 5 units named as bare IMEIs.

None of these catches `009`, so if `009` is the archetype the rule is something
visible in Controltech that is not in our data.

**"Remove" should mean `isActive = false`, not deletion** — the schema comment
says exactly that, and trips/alerts/drains and 5.5M telemetry rows FK these.

## D. Online/offline state classification

Spec supplied, **not started**. The only OFFLINE state is
`connection off + engine off + stationary`; everything else is online in some
form. Two rows need confirming before implementing, as they may be typos:

- `connection off · engine off · MOVING → online in transit` — if the
  connection is off, what reports the movement? Possibly meant as
  last-known-moving, which is how `signal-lost` is drawn today.
- `connection off · engine on · stationary → online idling` — makes a unit with
  the connection off count as online.

## E. Smaller, flagged

- **Express `trust proxy`** is false behind nginx, so express-rate-limit may key
  the whole fleet to nginx's IP — one shared 100 req/60s bucket. Spawned task
  carries the detail.
- **`telemetry.worker.ts` still divides by a 200 L fallback** for the SSE fuel
  percentage. `db-follower` and the snapshot were fixed; this one was left
  because that file carries uncommitted gate-arrival work.

---

# Gotchas that cost time today

- **`pgrep -f readjudicate` matches its own command line.** Every status check
  written that way reports "still running" forever, and an
  `until ! pgrep …; do sleep …; done` watcher never exits. Use `[r]eadjudicate`.
  This produced hours of false "still running" reports.
- **Timestamps read back shifted.** `captured_at` is a naive timestamp; node-pg
  builds a Date in the process's local zone, so ad-hoc scripts display times
  offset by the local UTC offset. Use `to_char(captured_at, …)` in SQL when
  reading values you intend to reason about. Dashboard chip times are
  browser-local and differ again.
- **Run the CLIs ON THE BOX directly**, never through the npm wrappers — those
  set `DOTENV_CONFIG_PATH=.env.example`, whose `DATABASE_URL` is the dev SSH
  tunnel.
- **Five files carry uncommitted gate-arrival work** (`yard-departure.ts`,
  `telemetry.worker.ts`, `raifactorysuite-events.service.ts` and two tests).
  Complete and tested, never committed, pending observation of real gate
  crossings. **Do not sweep them into an unrelated commit.**
- Two older docs — `analytics-fidelity-plan.md` and `fuel-displacement-mirror.md`
  — are written in the retired LOSS/UNVERIFIED vocabulary. Left as dated
  findings; read them against the table in §1.
