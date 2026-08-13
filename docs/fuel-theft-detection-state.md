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

**Re-measured 2026-08-11 against the settled ledger** — after the trough fix and
the filling adjudication — and the constants hold. Separation of REDISTRIBUTION
from confirmed DRAIN across the grid:

| swing | min swings | share | units | separation |
| --- | --- | --- | --- | --- |
| **25 L** | **3** | **5%** | **18** | **2.64x** |
| 15 L | 3 | 10% | 21 | 2.25x |
| 25 L | 3 | 10% | 13 | 2.24x |
| 25 L | 5 | 5% | 15 | 1.97x |
| 40 L | 3 | 10% | 7 | 1.17x |

Still the best cell, and better than the 1.47x measured mid-session: the trough
fix and the filling work sharpened it rather than eroding it. 27% of decidable
drains came back on the 18 machines the gate fires on, against 10% elsewhere.
The neighbours degrade gently, so it is not perched on a spike.

⚠️ **When you re-measure this, do NOT exclude `probe-swings` rows to "avoid
scoring the gate on its own output".** That deletes the DRAIN side for exactly
the vehicles the gate fires on, so every swingy machine reads 100% recovered and
the grid reports a spurious 9.84x. Reconstruct the pre-gate ledger instead: a
`probe-swings` row is one the level-series rules confirmed as a drain and the
gate then withdrew, so count it AS a confirmed drain.

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

## A. ~~FSL columns~~ — DONE 2026-08-13, extended 2026-08-14

`Initial` / `Current` / `Turbulence` on the FSL table, and the table is scoped
to one fleet DAY with a date picker (default today).

**Initial is the previous day's closing level; Current is this day's** (the
latest reading, for today). Not a shift — a shift cannot be lined up with a
date filter or added across dates. One day's Current IS the next day's Initial,
verified on live data: 129 agree, 0 differ.

### ⚠️ Every PAST day was empty until 2026-08-14 — a one-millisecond bug

Reported by the operator: switching the picker to a previous day lost the
mileage, the engine burn and the closing fuel level. It was not the new columns
— it was the date picker, and it had been wrong since the picker shipped. Today
was always fine, which is why it survived review.

`asOfFromQuery` returned **midnight at the END of the requested day**. That
instant belongs to the FOLLOWING fleet day, and `getFleetTankState` re-derives
its own window from `fleetDayStart(asOf)` — so the window became `[asOf, asOf]`,
zero milliseconds wide. Asking for the 13th:

```
asOf handed to service   2026-08-13T21:00:00.000Z   (= midnight EAT on the 14th)
service dayStart         2026-08-13T21:00:00.000Z   (fleetDayStart of it = itself)
window width             0 ms
```

Everything derived from the day's readings came back null: closing level,
mileage, engine seconds, both expected burns, turbulence, stops.

**It hid behind a plausible-looking symptom.** The previous-day lookup reaches
back 24 hours from that same boundary, which spans exactly the day that was
requested — so the table rendered the requested day's real closing level in the
**Initial** column with Current blank. That reads as a telemetry gap, not an
off-by-one, and it is the reason this went unnoticed.

Fixed by ending the day at `dayStart + 86_400_000 - 1`, so `asOf` falls inside
the day it names. `recordFuelTrends` had always bounded its day that way, which
is why the persisted `fuel_daily_trends` rows were right the whole time while
the live table was wrong — if you are ever comparing the two and they disagree,
suspect the API's window before the data.

Six regression tests in `tests/unit/fuel-tank-state-day.test.ts` pin the
boundary, including that adjacent days do not overlap by even a millisecond —
one day's Current is the next day's Initial, and a shared instant would
double-count a reading into both.

The closing level is a MEDIAN of the final 15 minutes, not the last reading. A
one-sample error at the close would land in the day's consumption AND in
tomorrow's opening balance. `PREV_CLOSE_SAMPLES` must exceed the densest
15 minutes any vehicle produces — measured p50 2, p99 77, **densest 376**, so
it is 600. It was 60 first, which was above p99 and still silently wrong for
the busiest units.

`consumed = initial − current` is what the TANK did, not what the machine
burned: a refuelled day reads negative, and the fillings ledger is the other
half. Folding them together would bury a measurement in a derivation.

### The day's work: mileage, engine hours, and two expected burns

Added 2026-08-14. Four more figures per vehicle per fleet day, and the split
between them is the whole point:

| field | kind | how |
| --- | --- | --- |
| `distanceM` | measurement | great-circle hops between fixes, dropping any over `MAX_HOP_KM` |
| `engineSeconds` | measurement | gap between fixes charged to the earlier fix's engine state, capped at `MAX_ENGINE_GAP_SECONDS` |
| `expectedBurnMl` | expectation | distance ÷ `KM_PER_LITRE` (2) |
| `engineBurnMl` | expectation | engine hours × the vehicle's measured L/h |

Both measurements come from ONE SQL pass over the day, and both need every fix
— including the ones with no fuel reading that the levels query filters out.
They are taken over different row sets on purpose: the hop chain uses only
position-bearing fixes, so a fix with no lat/lng breaks no hop, while engine
time uses every fix, because a unit reporting ignition without a position is
still running its engine.

**Engine hours is the primary basis, not distance.** `fuel-consumption-rates.md`
is the measurement and it is emphatic: 215 of 310 probed units are plant or
tractors, KASULU PLANT runs its engine on 58.3% of samples but moves in 19.3%
and averages 1.5 km/h, and **position freezes at speed 0 on this telemetry**. A
working excavator therefore reports ≈0 km while burning ~11 L/h — a distance
model predicts nothing for it and the entire real burn presents as an
unexplained drop. PLANT's measured 7.361 L/km is not a rate anyone can use; it
is the arithmetic saying the denominator is wrong. Distance stays as the
secondary check on road vehicles, where the two agree.

Both expectations sit beside `consumedMl` and neither is derived from the
other. The gap between them is the question worth asking.

⚠️ **`MAX_ENGINE_GAP_SECONDS` (900) must stay equal to the 900 s that cuts a run
in the rate derivation.** `engineBurnMl` is a rate calibrated under one
time-integration convention multiplied by hours counted under another; if they
diverge the product carries a silent bias. The cap errs SHORT on a sparse
reporter, which is the safe direction — it understates the expectation rather
than inventing burn to explain a drop with.

### The rates, and why the fallback is a median

`vehicle_fuel_rates`, one row per vehicle, written by
`prisma/fuel-rates.ts` (`--apply`) and by `fuel:consumption-rates` **weekly**,
02:40 UTC Sunday. Weekly because the derivation sorts the full fuel-carrying
telemetry window against a 1 GB RDS, and a consumption rate does not move
between Tuesday and Wednesday.

The derivation is `fuel-consumption-rates.md` §6 unchanged: rates come from
engine-on RUNS with no filling and no drain inside them, never from per-ping
deltas, which accumulate probe noise into fictional consumption. A drain must
never calibrate the expectation it will later be compared against.

A vehicle under `MIN_RUNS` (3) falls back to the **median of its org+type's
per-vehicle rates** — never the fleet aggregate. That aggregate is
volume-weighted and a few heavy machines dominate it: Kasulu TRACTOR reads
**12.47 L/h** aggregated against a per-vehicle median of **3.51**, and against
Sukari's 4.71 the apparent 4x gap between the orgs reverses. Vehicles under
`MIN_RUNS` contribute to nothing, not even the median — a rate too thin to
trust for one machine is too thin to be evidence about twenty.

No rate for a machine or its type gives `engineBurnMl = null`, **never 0**. A
zero reads as "burned nothing" where the truth is "nobody has ever measured
this one". The API echoes `engineRateLPerHour` and `engineRateBasis`
(`vehicle` | `type`) so a borrowed rate is visible rather than implied.

⚠️ **`RATE_WINDOW_DAYS` is 3 because 3 is what the box survives**, not because
3 is right — 30 days is what per-vehicle rates should stand on, and coverage at
3 days is 21 of 27 KASULU PLANT and 48 of 76 SUKARI tractors. `--days` widens
it deliberately, with someone watching the instance.

### Deployed and verified on live data, 2026-08-14

Migration `20260814020000_fuel_engine_burn` **applied** (2.7 s — nullable
`ADD COLUMN` is metadata-only, so no rewrite on the 1 GB instance). Rates
derived and stored on prod: **124 vehicles produced a rate, 77 cleared
`MIN_RUNS`**, the rest on their org+type median. The derivation ran in ~10 s at
3 days with `/health` steady at 2.5 ms throughout — so the window is not as
frightening as §5 of `fuel-consumption-rates.md` implies, though widening it
still wants someone watching.

KASULU for 2026-08-13, all 133 vehicles carrying a closing level, mileage,
engine hours and engine burn. The case the basis exists for, in the data:

| vehicle | km | engine h | engine burn | distance would have said |
| --- | --- | --- | --- | --- |
| `MUFINDI - EX 30` | 9.7 | 22.3 | **212.1 L** | 4.9 L |
| `MUFINDI - EX 23` | 7.4 | 21.3 | **220.0 L** | 3.7 L |
| `MUFINDI - BUS 03` | 561.7 | 17.7 | 84.5 L | 280.9 L |

An excavator working a face for 22 hours covers 9.7 km. The distance model
prices that shift at under 5 L.

### ⚠️ A dead ignition signal currently reads as "burned nothing"

Found while verifying, NOT yet fixed. **21 of 133 KASULU vehicles reported zero
engine seconds** for 2026-08-13, and 20 of those still reported distance —
696 km, 9.6% of the fleet's day. They are not all parked:

- Fleet-wide there are **19,640 readings with `engine_on = false` and
  `speed_kmh >= 1`** over two days, against 234,121 stationary ones. The fleet
  does report movement with the ignition flag down.
- `MUFINDI: EX 07` is one of them, and §5 above already records it reporting
  `engineOn` on **0 of 11,965 readings**. Its zero is a dead signal, not a
  quiet day.

So `engineSeconds = 0` conflates *"the machine rested"* with *"we cannot see
its ignition"*, and `engineBurnMl` then renders **0.0 L** — the exact failure
mode this module rejects everywhere else, where a rate we do not have gives
`null` and never a zero. A zero here claims a measurement.

The fix is the same shape as the probe-health sweep: a unit that never reports
`engineOn` across a window has an ABSENT signal, and absent must give `null`
burn rather than `0`. It cannot be decided from one day's rows alone — a
genuinely parked machine looks identical inside the day — so it needs the
history check, which is why it is written down here rather than guessed at.

Until then, read a 0.0 L engine burn as "unconfirmed", and note it also drags
any fleet total down by however much those units actually burned.

**None of this judges anything.** No verdict reads a rate or a burn.
`fuel-consumption-rates.md` §5 lists why they could not carry one yet: three
days of history, load not modelled, idle not separated from work, and rates
derived from the very probe a detector would be watching — so a mis-calibrated
probe yields a self-consistent wrong rate that cross-checks against nothing.

### Turbulence — the formula

Slosh while MOVING, kept for trend logging in `fuel_daily_trends`.

```
A RUN is the motion between two stops. A STOP is STOP_MINUTES (15) of
continuous engine-off. Within a run, readings group into 30-minute windows;
a window counts only with >= TURBULENCE_MIN_SAMPLES readings at
speedKmh >= MOTION_MIN_KMH (0.1).

  window range    R(w) = max(level in w) - min(level in w)
  run turbulence  T(r) = mean of R(w) over qualifying windows in run r
  moving average  TURB = mean of T(r) over the last TURBULENCE_STOPS (8) runs,
                         WHEREVER THEY FELL - the window crosses midnight
```

Three choices, each of which was wrong once before it was right:

- **Per window inside a run**, not the run's whole range: a two-hour haul's
  max−min measures the burn plus the slosh, and mostly the burn.
- **Per run**, not per clock interval: the unit is the journey. Four windows of
  20 L and one of 60 L average to 40 L per-run, 28 L per-window. A test pins it.
- **Across days**, not resetting at midnight: vehicles average **1.3-2.0 runs a
  day**, so an eight-run average that restarted nightly spanned one or two runs.
  Each day stores its individual run values (`runSloshMl`) because a day's mean
  cannot be un-meaned back into its runs.

⚠️ **Backfill oldest-first.** `prisma/fuel-trends.ts` walks forwards for this
reason: a day computed before its predecessors finds nothing behind it and
reports a one-run average — the exact defect the carried window fixes.

⚠️ **This feeds NOTHING that judges.** `fuel-adjudication` does not read
`fuel_daily_trends` and must not. The drain rules have their own probe
instrument (`getProbeProfile`, measured while PARKED). A motion-slosh average
reaching a theft verdict would let a machine excuse its own drains by working
rough ground. Stated at the type, the model and the migration.

Written daily at 21:20 UTC (00:20 EAT — into the NEXT day, so the day recorded
has finished). Idempotent on (vehicleId, day).

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

Scheduled daily at 04:05 UTC on the `maintenance` queue, **before** the
probe-health job at 04:23. That order is load-bearing: `adjudicateDrain` cuts
its recovery window at the first filling in the window, so judging fillings
first is what stops a phantom one truncating a drain's evidence.

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

## E. Smaller — both rectified 2026-08-11

- ~~**Express `trust proxy`**~~ — **false alarm, no action needed.**
  `src/app.ts:43` already sets `app.set("trust proxy", 1)` and it is present in
  the deployed `dist/src/app.js`. The ValidationError lines that prompted this
  sat at line 41 of a 287-line error log and predate the fix; nothing recent
  contains one. Read `pm2 logs` with that in mind — the file persists across
  restarts, so old stack traces resurface in any `--lines N` window.
- ~~**The 200 L fallback on the live path**~~ — **fixed** (`5655eee`).
  `db-follower` and the snapshot were corrected earlier; the poller was still
  handing `telemetry.worker` a 200 L guess for the 355 of 815 active vehicles
  with no stated capacity, so a vehicle's gauge changed meaning depending on
  which update it arrived on. Fixed in `poller.ts` rather than the worker,
  because that file carries the uncommitted gate-arrival work: passing 0 makes
  the worker's truthiness guard yield null, matching the other two paths. The
  worker is its only consumer.

## F. Redis eviction policy — NOT addressed, and it matters more now

The box's Redis runs `volatile-lru`; BullMQ warns on every boot that it should
be `noeviction`. Under memory pressure Redis may evict keys, and BullMQ's keys
ARE the job state — so a scheduled job can silently vanish rather than fail
loudly.

This was survivable when the queue held one nightly prune. It now carries
**five** jobs on a t3.micro that is already swapping:

| job | when |
| --- | --- |
| `notifications:prune` | 03:17 UTC daily |
| `fuel:adjudicate-fillings` | 04:05 UTC daily |
| `fuel:probe-health` | 04:23 UTC daily |
| `fuel:daily-trend` | 21:20 UTC daily |
| `fuel:consumption-rates` | 02:40 UTC **Sunday** |

A silently dropped filling sweep leaves new fillings at PENDING, which then lets
phantom fillings truncate drain evidence again — the exact failure §B exists to
stop. The rate job is the one that hides longest if it vanishes: it is weekly,
so nothing looks wrong for seven days, and stale rates degrade quietly into
expectations nobody re-checks. `derivedAt` on each row is how you tell.

It is a Redis config change, not a code change, so it is out of scope for a
commit here and wants an ops decision.

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
