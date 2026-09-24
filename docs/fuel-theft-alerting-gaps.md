# Why no fuel theft has ever been alerted — eight cases, six constants

Written 2026-09-24. Every measurement in it is from the live af-south-1 database
and the Wialon account, and every script named at the end can be re-run.

`fuel-theft-discrimination-plan.md` designed the classifier. This document is
about what happened when it met real data: **the ledger is largely correct and
the alert never fires.** Eight drains on 2026-09-23, on seven separate Mufindi
machines, every one of them between 17.0 and 23.0 L, totalling 161 L. Not one
reached an operator.

The operator's report is what started this — *"a drain happens, fuel leaves the
tank, that's fuel siphoning which should have been alerted"* — and it is correct.

---

## 1. The eight events

All 2026-09-23, KASULU (Mufindi Paper Mills). Times EAT.

| unit | detected | claimed | verdict | reason | conf | cause | cause reason |
|---|---|---|---|---|---|---|---|
| MTR 09 | 12:13 | 20.6 L | `REDISTRIBUTION` | level-recovered | 0.950 | — | — |
| CTR 19 | 12:06 | 17.0 L | `DRAIN` | level-stayed-down | 0.591 | INDETERMINATE | engine-state-unknown |
| FT 13 | 12:49 | 19.4 L | `DRAIN` | level-stayed-down | 0.942 | INDETERMINATE | engine-state-unknown |
| CTR 14 | 13:46 | 23.0 L | `REDISTRIBUTION` | level-recovered | 0.829 | — | — |
| CTR 12 | 16:59 | 19.8 L | `DRAIN` | level-stayed-down | 0.942 | **SLOSH** | rate-not-physical |
| CTR 19 | 16:53 | 21.4 L | `DRAIN` | level-stayed-down | 0.947 | INDETERMINATE | below-parked-floor |
| MTR 04 | 17:12 | 19.1 L | `DRAIN` | level-stayed-down | 0.950 | INDETERMINATE | below-parked-floor |
| MTR 20 | 17:33 | 20.6 L | `DRAIN` | level-stayed-down | 0.947 | INDETERMINATE | below-parked-floor |

Mean 20.1 L, range 17.0–23.0. **That is a jerrycan**, and it is the single most
important observation here: the population is not a spread of plausible
operational losses, it is one container used repeatedly.

Measured fall shape, for the six where it was computed:

| unit | fall s | measured drop | step fraction | engine evidence |
|---|---|---|---|---|
| CTR 12 | 181 | 19.8 L | **0.977** | 1.0 |
| MTR 04 | 302 | 19.5 L | **0.745** | 1.0 |
| CTR 19 16:53 | 419 | 21.5 L | **0.699** | 1.0 |
| MTR 20 | 429 | 21.0 L | **0.626** | 1.0 |
| FT 13 | 911 | 23.9 L | **0.750** | 0.0 |
| CTR 19 12:06 | 4944 | 28.7 L | **0.626** | 1.0 |

---

## 2. Two traces worth reading in full

### 2.1 CTR 19, 16:50 — the cleanest siphon signature on the fleet

```
16:44–16:52   309.2 L   flat 8 min, engine MEASURED off, 0 km/h
16:53:30      307.3 L   −1.90
16:55:28      292.3 L   −14.95
16:57:27      288.9 L   −3.43
16:59:26      287.8 L   −1.11
17:00–17:10   287.8 L   flat 10 min
```

21.5 L over six minutes. Engine provably off, stationary throughout, level holds
for ten minutes afterwards, and **no filling anywhere in the window** to confuse
the evidence. The verdict is right and confident. Nothing in the adjudicator
needed fixing; the event needed only permission to speak.

CTR 19 carries **16 drains in 30 days, ~470 L**, almost all `level-stayed-down`,
with zero alerts.

### 2.2 MTR 20, 17:31 — both ledgers correct, still silent

```
17:31 → 17:33   drain  20.6 L   DRAIN / level-stayed-down    conf 0.947   correct
17:54           fill   23.6 L   REFILL / level-rose   observed +19.9 L    correct
```

This is the proof that adjudication is not the problem. The drain is right, the
filling is right — the filling was even correctly corroborated at +19.9 L, so
the baseline defect in §4.2 did not bite. And nobody was told, solely because
the fall lasted 429 seconds against a 600-second floor.

Note also that 23.6 L was returned against 20.6 L taken — three litres *more*
went back than left.

---

## 3. The gate that silences all eight

`SIPHON_MAX_STEP_FRACTION = 0.6` (`fuel-theft-classifier.ts`).

Every measured step fraction above exceeds it: 0.626, 0.626, 0.699, 0.745,
0.750, 0.977. **All eight land on `step-shaped` → INDETERMINATE**, and would
continue to do so even if every other change in this document shipped.

The constant's stated reasoning is that *"a siphon is a person with a hose, and
that takes minutes; it does not empty a tank between two consecutive pings."*
That holds only if pings are dense. Measured over two days of KASULU telemetry:

```
median gap between readings        30 s
median non-zero level move       0.16 L
p99 level move between readings   2.9 L
```

These probes report **on change**, at 30–60 s intervals. A 20 L draw spread over
five minutes therefore lands 60–98% of its total in one reported interval *by
construction*. CTR 19's 14.95 L step spans two minutes — **7.5 L/min, 450 L/h** —
which is an ordinary transfer pump, not an instrument fault.

The metric measures the sensor's reporting granularity and reports it as
evidence about the thief.

---

## 4. The other five blockers

### 4.1 `SIPHON_MIN_SECONDS = 600`

Three of the eight (MTR 04 302 s, CTR 19 419 s, MTR 20 429 s) die here with
`below-parked-floor`. Measured across 30 days:

| fall duration | drains | on steady probe | also fail step > 0.6 |
|---|---|---|---|
| under 60 s | 93 | 1 | 93 |
| 60–120 s | 3 | 0 | 3 |
| 120–300 s | 150 | 0 | 105 |
| 300–600 s | 179 | 2 | 108 |
| 600 s + | 2,055 | 22 | 873 |

Lowering to **120 s** admits 329 rows, only 2 of them on steady probes. The risk
is small and the gain is direct.

### 4.2 `FILL_LOOKBEHIND_MINUTES = 20` — the baseline spans the drop

`adjudicateFilling` takes its pre-fill baseline as a median over the 20 minutes
before the filling. When a drain has just happened, that window contains the
pre-drop level, so a refill which merely restores what was taken measures as
zero or negative rise and is ruled `REDISTRIBUTION`.

Observed on four of the five events that had a filling:

| unit | filling | claimed | `observed_rise_ml` | verdict |
|---|---|---|---|---|
| MTR 09 | 12:22 | 19.9 L | **−0.8 L** | REDISTRIBUTION |
| FT 13 | 13:01 | 20.0 L | **−1.0 L** | REDISTRIBUTION |
| MTR 04 | 17:20 | 16.8 L | **−2.3 L** | REDISTRIBUTION |
| CTR 14 | 13:59 | 25.6 L | +9.1 L (under ratio) | REDISTRIBUTION |
| MTR 20 | 17:54 | 23.6 L | +19.9 L | REFILL |

Every one of those first four is a real delivery. MTR 09's raw series shows
39.4 → 59.3 L; FT 13's 71.6 → 90.6 L; MTR 04's 40.7 → 57.8 L. The fuel arrived
and the ledger says it did not.

**Fix:** take the baseline from the last stable level immediately before the
rise begins, not a fixed-window median. Predicted on the same rows: +19.9,
+15.9, +17.1 — all `REFILL`.

### 4.3 `MAX_PLAUSIBLE_REMOVAL_LPH = 300`

CTR 12's 16:53 drain — 19.8 L in 181 s, engine off, steady probe (p90 0.8 L) —
was ruled **`SLOSH` / `rate-not-physical`**, and `SLOSH` is in
`CAUSE_NO_FUEL_LEFT`, so it left the loss figures entirely.

300 L/h is **5 litres a minute**: a gravity hose. A small 12 V diesel transfer
pump moves 40–60 L/min — **2,400–3,600 L/h**, eight to twelve times the ceiling.
The constant asserts "no pump could draw this fast" at a rate slower than every
pump on the market.

### 4.4 `parked` is ejected by a single speed sample

`parked = engineEvidence >= MIN_ENGINE_EVIDENCE && !moved`, and `moved` is
`fall.some(s => (s.speedKmh ?? 0) > 0)`. CTR 19's 12:06 fall carries isolated
6–31 km/h readings on a machine whose ignition was measured **off** for the
entire 82 minutes. One sample takes it out of the only branch that can reach
SIPHON, and it lands on `engine-state-unknown`.

A tolerance — a share of samples, or a distance floor — would keep it.

### 4.5 Ignition, for the vehicles that have none

`engineEvidence >= 0.5` is a precondition of the parked branch. FT 13 reports
`ignition_known = false` on all 7,193 of its stored readings, so its
`engineEvidence` is 0 on every drain and **SIPHON is structurally impossible on
that unit**, whatever happens to its tank. Its Wialon `1.IGN` sensor is bound to
`io_9`; `io_239` arrives in every message with a valid value.

**Corrected figure.** An earlier count of "110 of 211 unreadable, 73
recoverable" was produced by running `readIgnition()` against each unit's last
message. That is the wrong measure — CTR 19's sensor is bound to `pwr_ext`,
`readIgnition()` returns null for it, and yet all 3,674 of its stored readings
carry `ignition_known = true`. Measured from stored telemetry instead, over two
days and vehicles with at least 50 readings:

```
147 vehicles reporting
 93 with usable ignition
 54 that NEVER report it true  <- cannot ever reach SIPHON
```

37%, not 52%. The blind set includes CTR 14 and all three of the heavy
oscillators (DZ 04, DZ 07, DZ 14).

### 4.6 `SIPHON_MIN_DROP_ML = 15_000` — real, but not currently binding

Measured across 30 days:

| band | drains | on steady probe | litres |
|---|---|---|---|
| under 5 L | **0** | — | — |
| 5–10 L | **0** | — | — |
| 10–15 L | 176 | 8 | 2,112 L |
| 15 L + | 3,263 | 38 | 133,776 L |

**Wialon never reports a drain below 10 L**, so lowering our constant to 5 L
admits nothing today. It becomes meaningful only once drops are detected from
our own telemetry (§6). At that point 5 L is workable but tight — p99 single-step
noise is 2.9 L — and should be per-probe rather than a fleet constant:
`max(5 L, k × that vehicle's p90 parked swing)`. For MTR 09 (p90 **0.1 L**) that
is 5 L and 50× its noise floor; for DZ 14 (p90 **74 L**) no fixed figure is
meaningful at all.

---

## 5. Refill and redistribution are different physical events

Stated by the operator, 2026-09-23, and it is the right primitive:

> A refill is fuel from the pump into the tank. A redistribution is fuel within
> the tank levelling.

The code currently infers both from the same observation — the level went up —
which is why they are confusable. The physical definitions separate them:

- **Refill** — fuel crosses the tank boundary inward. **Content increases.** The
  level rises and stays.
- **Redistribution** — fuel moves inside the tank. **Content is unchanged.** The
  level moves and returns.

The consequence the code does not encode: **redistribution requires a
disturbance.** Fuel does not reposition itself in a tank that is sitting still.
Something must tilt, move, or stop the machine.

> **Proposed rule.** A level excursion on a machine that has been stationary,
> engine-off and undisturbed throughout **cannot be `REDISTRIBUTION`.** There is
> no mechanism for it.

MTR 09 sat flat at 60.1 L for **23 minutes** — engine off, 0 km/h, unchanged —
then dropped 20.7 L. Any settling from the previous stop had long finished. It
was classified as undulation on a probe whose **worst parked excursion in 30
days is 1.7 L** (31 windows, 0 swinging, p90 0.1 L). A 20.7 L excursion is not
that instrument wandering, and it is 25% of an 84 L tank — a tilt that large on
a stationary machine is not available.

### The counter-example that proves the rule

CTR 12 at 08:50 the same morning, ruled `REDISTRIBUTION`, **and that is probably
correct**:

```
08:45:06  275.2 L   engine ON, 0 km/h
08:46:09  265.6 L   −9.55    engine ON, 4 km/h
08:48:16  290.1 L  +24.47
08:50:08  255.7 L  −34.34
08:52:08  260.0 L   +4.26
08:54:08  270.2 L  +10.23
```

Range 255.7–290.1 L inside eleven minutes, **engine running throughout**. A
running machine is a disturbed tank; redistribution is physically available, and
this is what it looks like. The contrast with MTR 09 is exactly the discriminator
the rule encodes.

---

## 6. The ordering defect, and why the obvious fix is wrong

`adjudicateDrain` cuts a drain's recovery window at any filling not already
ruled `REDISTRIBUTION`. A drain ripens at `SETTLE_MINUTES` (20); a filling at
`FILL_SETTLE_MINUTES + FILL_HOLD_MINUTES` (60). `adjudicatePendingDrains`
selects only `verdict: 'PENDING'`, so a drain is written once and never revisited
by the live pass.

The outcome therefore depends on **which was judged first**:

| | filling judged | truncated? | drain verdict | ~20 L |
|---|---|---|---|---|
| FT 13 | 60 min **after** | yes | DRAIN | counted, silent |
| MTR 04 | 60 min **after** | yes | DRAIN | counted |
| MTR 09 | 390 min **before** | **no** | **REDISTRIBUTION** | **erased** |
| CTR 14 | 45 min **after** | yes | **REDISTRIBUTION** | **erased** |

**An earlier proposal in this investigation — "make the drain wait for the
filling's verdict before allowing truncation" — is withdrawn.** Judging the
filling first yields `REDISTRIBUTION` (because of §4.2), which then does *not*
truncate, which is precisely the path that erased MTR 09. It would convert
"counted but unannounced" into "erased entirely".

**Fix the dependency instead of its ordering:**

> A drain asks one question: **did the level stay down until the next external
> event?** — where an external event is a recorded filling *or* a vehicle state
> change. What verdict that filling later receives is irrelevant.

MTR 09 stayed down 12:20 → 12:23:50; FT 13 12:52 → 13:02; MTR 04 17:18 → 17:22.
All three `DRAIN`, none dependent on ordering, and the window can never be
cancelled because no verdict feeds back into it.

---

## 7. Speed

The operator's second requirement: *"we need judgement quick, not hours."*

Current path, MTR 09: level fell **12:14–12:20**, verdict written **20:02** —
nearly eight hours, and wrong. The delay is not `SETTLE_MINUTES`; it is waiting
for Wialon's *fuel report* to mature, plus the quarter-hourly sync.

We already hold the level ourselves at the device's own cadence.

```
12:14:09   fall begins        60.1 L
12:20:42   trough reached     39.4 L
12:21:42   confirmed          39.4 L   <- alertable here
12:23:50   refill starts      54.5 L
```

**An alert at 12:21:42** — one minute after the trough, two minutes before the
refill began.

The floor is principled, not arbitrary: a drop must be confirmed by at least 2–3
consecutive readings or a single bad sample raises a theft alert. At ~60 s
cadence that is **1–3 minutes**. That is the limit, not ten.

### Two stages, so speed and precision do not trade against each other

- **Live (~1–3 min)** — the telemetry worker watches each vehicle's level and
  sets `flags.fuelInconsistency`; the map marker turns red immediately.
  Provisional and retractable, no notification. The dashboard path for this is
  **already built and currently dead** — `deriveStatus()` keys on that flag and
  `wialon.adapter.ts:334` hardcodes it `false`.
- **Settle (10–20 min)** — the existing adjudication confirms or clears. Only a
  confirmed siphon reaches the feed as a critical item.

### The six gates a fast alert must clear

1. drop ≥ per-probe threshold (§4.6)
2. sustained ≥3 consecutive readings at the low level
3. stationary and engine **measured** off
4. no disturbance in the preceding window (§5)
5. the vehicle's own p90 parked swing below a bound — `probeSwings` used as an
   *enabler*, not only a suppressor. MTR 09 at p90 0.1 L qualifies instantly;
   DZ 14 at p90 74.2 L never fast-alerts and stays on the slow path
6. no filling recorded in the window

MTR 09 passes all six at 12:21:42.

---

## 8. Recommended order

| # | change | unblocks | status |
|---|---|---|---|
| 1 | retire `SIPHON_MAX_STEP_FRACTION` as a hose/instrument test | **all eight** | **shipped** `0defb99` |
| 2 | `SIPHON_MIN_SECONDS` 600 → 120 | MTR 04, CTR 19 16:53, MTR 20 | **shipped** `914613f` |
| 3 | filling baseline from the pre-fill level, on trusted probes | MTR 09, CTR 14, FT 13, MTR 04 | **shipped** `8e17018` |
| 4 | `MAX_PLAUSIBLE_REMOVAL_LPH` 300 → 3,000, **with** a per-interval burst test | CTR 12 | **shipped** |
| 5 | `parked` tolerant of stray speed samples | CTR 19 12:06 | open |
| 6 | ignition fallback for the 54 blind vehicles | FT 13, CTR 14 | **shipped** `ec85742` |
| 7 | the disturbance rule (§5) | stops the erasures recurring | open |
| 8 | live two-stage detector (§7) | latency: hours → minutes | **shipped** `lib/fuel-drop-watch` |

### What change 4 turned out to require

Raising the ceiling alone was not safe, and the replacement it needed was not
the obvious one. The retirement note on `SIPHON_MAX_STEP_FRACTION` proposed a
per-interval rate test; measured over 711 drains, that test **does not work as
stated**. With no minimum interval the confirmed and distrusted populations are
indistinguishable — p90 11,710 against 11,840 — because both are dominated by
one- and two-second gaps from probes that report on change. Dividing a real
15 L fall by a one-second gap yields 55,000 L/h, which measures the reporting
cadence and nothing else.

It works only with a denominator floor. At a 30 s minimum the populations
separate ~2.5x and hold through the tail; at 60 s the separation survives but
only 210 of 711 drains have any qualifying interval, so the test goes inert on
70% of the ledger. Thirty seconds is the fleet's median reporting gap, and it is
both the smallest usable denominator and the largest that keeps coverage.

`MAX_PLAUSIBLE_BURST_LPH = 5,000` costs 3.4% of confirmed drains (5 of 147) and
still refuses a quarter of the distrusted population. Below it the cost climbs
fast — 3,000 takes 10% of confirmed drains — and above it the guard stops
catching much.

One consequence lands outside the parked branch and is worth stating: at
300 L/h, four times a generator's band (380 L/h) already exceeded the ceiling,
so the burn-multiple rule was **dead for that class** and only the operator-set
`CLASS_CEILING_LPH` kept it reachable. At 3,000 the comparison happens, and a
generator burning several hundred litres an hour becomes a finding rather than
a discarded reading.

---

## 8a. Validation — replayed against 30 days of ledger

`prisma/measure-alerting-gates.ts` replays every drain in the window through the
same gates under each change, cumulatively. Read-only. **It corrects a claim
this document made before it was run** (see the end of this section).

Two things cannot be replayed and both make every count below an **upper
bound**: the SETTLING branch (`kT` / `decayResidual` are computed and discarded,
so a parked fall that decays is counted here and would not be in life), and
gates 4–5, which need `resolveBand`. 2,482 of 3,443 drains carry a persisted
fall shape; the rest predate 2026-08-28 or never reached a DRAIN verdict, so no
cause was computed for them.

### Alert volume

| scenario | alerts / 30 d | per day | on trusted probes | volume |
|---|---|---|---|---|
| **S0 current** | **1** | 0.0 | 1 | 46 L |
| S1 + step test retired | 5 | 0.2 | 5 | 146 L |
| S2 + 120 s fall floor | 8 | 0.3 | 8 | 207 L |
| S3 + removal ceiling 3,000 | 17 | 0.6 | 17 | 661 L |
| S4 + stray-speed tolerance | 27 | 0.9 | 27 | 994 L |
| **S5 + 5 L drop floor** | **31** | **1.0** | 31 | 1,272 L |

The replayed S0 gives 1 where the ledger holds 3 stored SIPHON rows; the
difference is the unreplayable settling branch plus a profile window that does
not exactly match the live `getProbeProfile`. Close enough to trust the deltas.

**Operator burden is one alert a day.** Not a flood, and that is the number the
proposal has to survive.

**Every one of the 31 lands on a probe the trust gate already trusts. Zero on a
distrusted one.** That is the safety result: `probeSwings` suppresses 2,199 of
the 2,482 replayable rows — 89% — before any of these gates is reached, and
raising the gates does not disturb that. The heavy oscillators (DZ 04, DZ 07,
DZ 14) stay silent throughout.

The corollary is a known and accepted blind spot: a genuine theft on a
distrusted probe remains silent under every scenario here.

### Which change is load-bearing

The cumulative table is order-dependent — a change applied fourth is credited
only with what the first three left. Removing each change from the *full*
proposal measures what it is actually worth:

| remove this change | alerts | cost |
|---|---|---|
| **step retirement** | 10 | **−21** |
| removal ceiling | 13 | −18 |
| 120 s fall floor | 15 | −16 |
| stray-speed tolerance | 17 | −14 |
| 5 L drop floor | 27 | −4 |

They sum to 73 against a total gain of 30, so the gates overlap heavily — most
rows are blocked by several at once, which is why no single change unlocks much
on its own and why the cumulative view understates the first one applied.
Retiring the step test is confirmed as the largest single contributor, as §3
argued from the eight cases.

### Where the rows go

| outcome | current | proposed |
|---|---|---|
| SIPHON | 1 | **31** |
| probe-swings | 2,199 | 2,199 |
| slosh | 33 | 3 |
| not-parked | 60 | 66 |
| below-floor | 5 | 3 |
| step-shaped | 4 | 0 |
| other-branch | 180 | 180 |

### The correction

This document previously asserted *"with 1 and 2 alone, six of the eight alert;
with 1–4, all eight."* **The replay does not support it.** Of the six hand-read
cases that carry a replayable fall shape:

| case | current | full proposal |
|---|---|---|
| MTR 04 17:12 | below-floor | **SIPHON** |
| CTR 12 16:59 | slosh | **SIPHON** |
| CTR 19 16:53 | below-floor | **SIPHON** |
| MTR 20 17:33 | below-floor | **SIPHON** |
| FT 13 12:49 | not-parked | not-parked |
| CTR 19 12:06 | not-parked | not-parked |

**Four of six, not six of eight**, and changes 1+2 alone reach only three of
them (CTR 12 needs the removal ceiling). The two that stay silent are silent for
reasons no gate constant can fix:

- **FT 13** has `engine_evidence = 0` — it is one of the 54 ignition-blind
  vehicles (§4.5), so `parked` can never be true. It needs change 6.
- **CTR 19 12:06** has an 82-minute fall that genuinely spans movement. Calling
  that a parked siphon would be wrong, and the classifier is right to refuse.

**MTR 09 and CTR 14 do not appear at all** — both were settled
`REDISTRIBUTION`, so `classifyDrain` never ran and no fall shape was persisted.
They need change 3 (the filling baseline) before there is anything to classify.

So the ordering in §8 stands, but its expected yield does not: **changes 1–5
raise fleet alerts from 1 to 31 per 30 days and recover four of the eight known
cases. The other four need changes 3 and 6, which are accounting and ingestion
fixes rather than gate changes.**

---

## 8b. Pre-merge verification

Three things were outstanding when the constants were all shipped. All three are
now settled, and one of them changed a number this document had asserted.

### Alert volume, measured fleet-wide with the real code

`prisma/backtest-units.ts` re-judges through the same `judgeDrain` and
`judgeFilling` the live sweep calls — not the replay's reconstruction from
stored columns — so every change is in scope at once. Over **224 KASULU
vehicles, 3 days, 299 drains and 279 fillings**:

```
WHAT REACHES AN OPERATOR — 21 items, 7.0/day
  burn-above-class-ceiling    11
  burn-far-above-band          7
  parked-sustained-fall        3   (may be worded as theft)
```

**§8a's "one alert a day" was wrong**, and the error is instructive.
`measure-alerting-gates.ts` models the PARKED branch only, and counted `SIPHON`
alone. But `announces()` is `ANNOUNCED.has(cause) || ANNOUNCED_REASONS.has(reason)`,
and both `burn-far-above-band` and `burn-above-class-ceiling` announce. Raising
`MAX_PLAUSIBLE_REMOVAL_LPH` moved rows out of `SLOSH` and into the burn branch,
which the replay never modelled.

The honest framing is the delta, not the total. Of the 21, **14 were already
announcing under the old code**; 7 are new:

| new alert | from | to |
|---|---|---|
| MTR 18, CTR 19, MTR 20 | INDETERMINATE | `parked-sustained-fall` (theft) |
| CTR 23 ×2, EX 17, EX 02 | SLOSH | burn findings |

So the change takes the feed from **4.7/day to 7.0/day — plus 2.3, a 49%
increase**, of which one a day is a siphon. That is a real increase and the
operator should see the number before it ships, but it is not a flood.

### Integration suite

138 passed, 18 skipped, **2 failed — both pre-existing**, verified by running
the same file on a clean tree: `users.test.ts` DELETE endpoints, unrelated to
fuel. `tests/unit/user.service.test.ts` also flakes intermittently in the full
unit run on a 5 s timeout, a different test each time, likewise pre-existing.

### The live detector, shipped 2026-09-24

`lib/fuel-drop-watch` raises a PROVISIONAL warning within a few minutes of a
tank dropping, from our own poller rather than the provider's report. It never
uses the word theft, never writes to the ledger, and the adjudicator still
decides. Three of its six gates are simply unavailable in a poll loop — the
probe's 30-day profile, whether a filling explains the fall, whether the level
comes back — so this says "a tank dropped and nobody was near it" and the slow
half says what it was.

What makes a fast signal safe is the operator's own rule: fuel does not
reposition itself inside a tank that is sitting still. The whole window must be
stationary with the engine MEASURED off, and it abandons the moment anything
moves or runs. That also keeps it silent on the 54 of 147 units whose ignition
cannot be read — "we do not know if the engine was off" is not "the engine was
off".

Its floor is **10 L**, below the adjudicator's 15 L, because 176 drains over 30
days sit in the 10-15 L band the adjudicator excludes entirely — including
MUFINDI - EX 16's 11 L on 2026-09-24, which prompted it.

### The verdict pass got its own clock, 2026-09-24

The adjudication pass ran at the tail of `runFuelSync`, so it inherited
`FUEL_SYNC_CRON` — quarter-hourly, a cadence chosen because executing Wialon
reports for 460 vehicles is expensive. This pass asks Wialon nothing; the
comment it sat under said so. Sharing that clock put **up to fifteen minutes of
dead wait** between a drain ripening and anything looking at it, on top of
`SETTLE_MINUTES`.

A drain detected 14:48 ripened 15:08 and was judged 15:15.

It now has its own queue, worker and cadence (`FUEL_ADJUDICATION_CRON`, every
minute). A separate QUEUE rather than just a schedule: the sync worker runs at
concurrency 1 so two cycles cannot open two Wialon sessions, and a one-minute
job on that queue would wait behind every slow sweep.

Worst case for a ripe drain: **35 minutes → 21**. The remaining twenty are
`SETTLE_MINUTES`, which the live watcher does not wait for at all because it is
not deciding — it is reporting that a tank dropped.

### The filling/drain ordering

`tests/unit/fuel-ledger-ordering.test.ts` pins it. `adjudicateDrain` exempts a
REDISTRIBUTION filling from truncating, which makes the drain's verdict depend
on the filling's — and therefore on which ran first. The tests assert both
directions on identical evidence: with the filling corroborated the drain stands
as `DRAIN`/`level-stayed-down`; with it stale the refill's own rise reads as
recovery and the drain is erased. That is MTR 09's real history, where the
filling was judged 390 minutes before the drain.

`lib/queues/fuel-events` already runs fillings first and its comment says why.
Nothing tested it until now.

**Note for anyone replaying history:** a dry-run backtest cannot settle this,
because `judgeDrain` reads the filling's STORED verdict and a dry run does not
write one. Rows with a filling in window will show as cancelled when they would
stand in production. Up to 14 of the 7-day sample were affected.

---

## 9. Scope, and what this document does not claim

A fleet-wide sweep found **1,960 of 3,435 drains** in 30 days were settled as
`DRAIN` while judged against a filling later ruled `REDISTRIBUTION` — 57% of the
ledger, 82,152 L. That count is four database facts and it holds.

**What does not hold**, and was withdrawn during this investigation:

- An attempt to split those 1,960 into "probe artefact" and "real movement" by
  net level change across the episode. The net-change window assumes one drain
  and one filling per episode, and **78% of flagged rows arrive within an hour of
  the same vehicle's previous one**, so the window routinely spans neighbouring
  events. The classifier also misplaced FT 13 — a case verified by hand — into
  `UNCLEAR`. Do not use those bucket totals.
- Net ≈ 0 as evidence of a probe artefact at all. FT 13 shows net ≈ 0 is equally
  consistent with "took 19 L, put 19 L back".

**Concentration.** The 1,960 rows fall on **29 vehicles**, and three dozers —
DZ 14 (535), DZ 07 (460), DZ 04 (455) — account for **1,450, or 74%**. The top
15 account for 99%. Those units are oscillating probes writing paired phantom
events; the truncation defect is a symptom there, not the disease, and fixing it
would change their verdicts without making their data trustworthy. The ~28 rows
on the remaining quiet vehicles are where a good probe met the defect once, and
those are the operationally important ones.

**Open.** CTR 14's parked-swing profile (p90 9.1 L, 4 of 58 windows swinging,
6.9%) exceeds the distrust threshold, so `probeSwings` discredits it — but the
profile is computed over a window containing the very events being judged, so
the events make the probe look swingy which then discredits the events. That
circularity is a defect in `probeSwings` and is not addressed here.

---

## 10. Reproducing all of it

```bash
npm run accel:report                 # sensor presence for a named list
npx tsx prisma/drain-audit.ts        --plate="CTR 19" --days=30 --tunnel
npx tsx prisma/probe-behaviour.ts    --plate="MTR 09" --days=30 --tunnel
npx tsx prisma/inspect-window.ts     --plate="FT 13" --from=… --to=… # UTC bounds
npx tsx prisma/truncation-sweep.ts   --org=KASULU --days=30 --tunnel
npx tsx prisma/truncation-concentration.ts --org=KASULU --days=30 --tunnel
npx tsx prisma/threshold-probe.ts    --org=KASULU --days=30 --tunnel
npx tsx prisma/ignition-coverage.ts  --org=KASULU --days=2  --tunnel
npx tsx prisma/adjudication-pulse.ts --tunnel
npx tsx prisma/measure-alerting-gates.ts --org=KASULU --days=30 --tunnel
```

`--tunnel` rewrites the host in `DIRECT_URL` to `localhost:15432` for a dev
machine reaching the private RDS through the SSH tunnel; see `guide.md`.

**One trap worth knowing.** Prisma `DateTime` maps to `timestamp` *without* time
zone and stores UTC, and node-pg parses it in the process's local zone. On a
Nairobi machine (UTC+3) a reading formatted back into Nairobi returns the raw UTC
wall-clock digits and looks like a plausible local time. Format in SQL instead —
`to_char(captured_at + interval '3 hours', 'HH24:MI:SS')` — which is what these
scripts do.

---

## 11. Still needed from the business

1. **The per-type L/h bands**, still outstanding from
   `fuel-theft-discrimination-plan.md` §10. Machine type → expected litres per
   engine-hour, as a range. It is the primary input to the burn gates.
2. **The red-state window** — 12 h or 24 h (same document).
3. **Confirmation of the 20 L pattern.** Eight events in one day, all 17–23 L, is
   a container, and the yard will know which one. That is worth more than any
   threshold in this document.
