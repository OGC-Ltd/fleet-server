# Telling theft from burn, slosh and settling — implementation plan

Branch: `fuel`. Nothing here is built yet. Written 2026-08-16 against the code as
it stands on that branch.

Read `docs/fuel-theft-detection-state.md` first — it describes what is already
deployed, and about half of the outline below is already in the codebase under
different names.

---

## 1. What already exists, so we do not rebuild it

| Outline calls for | Already in the code | File |
| --- | --- | --- |
| Median filter to kill slosh spikes | `smoothLevels()` — rolling median, 3 samples, backtested over 833 drains / 481k readings | `fuel-adjudication.ts:530` |
| Settle window before judging | `SETTLE_MINUTES = 20`, measured to catch 92–93% of recoveries | `fuel-adjudication.ts:84` |
| "Return to baseline" / did it come back | `RECOVERY_THRESHOLD = 0.6` recovery-ratio test → `REDISTRIBUTION` | `fuel-adjudication.ts:757` |
| Expected L/hr per machine | `vehicle_fuel_rates` table — per-vehicle `lPerHour`, type-median fallback, refreshed weekly | `fuel-rate.ts`, `fuel-rate.service.ts` |
| Distrust probes that move on their own | `probeSwings()` / `applyProbeTrustGate()` — 25 L parked-swing profile | `fuel-adjudication.ts:406` |
| Dead-probe suppression | `SENSOR_FAULT` — `fsl-dead`, `fsl-dropout` | `fuel-adjudication.ts:584,663` |
| Confidence score instead of red/green | `verdictConfidence` 0–1, already stored | `schema.prisma:937` |
| Only alert on a surviving verdict | Notification fires on the verdict, not the raw Wialon event | `fuel-adjudication.service.ts:280` |

**So the gap is not filtering. The gap is that everything not disproved becomes
`DRAIN`, and every `DRAIN` is announced.** The module was deliberately built to
"remove what we can DISPROVE, not what we merely doubt" — which is the correct
rule for a *ledger* and the wrong rule for an *alert*. That is precisely the
complaint: all drains are flagged.

The change is therefore **not** a rewrite of adjudication. It is a second
classifier layered on top of it, plus an inversion of the notification default.

---

## 2. What the outline assumes vs. what this fleet actually sends

This is the part that most changes the plan, so it is up front.

| Signal the outline uses | Do we have it? | Detail |
| --- | --- | --- |
| `fuel_level` | **Yes** | `vehicle_telemetries.fuel_level_ml`, calibrated, ~28–30 s cadence |
| `engine.ignition` / `engine.operation` | **Yes** | `engine_on`, real ignition (`io_239`) on 222/224 units; falls back to `speed>0` where absent |
| Speed | **Yes** | `speed_kmh` |
| `engine_hours` (motohours) | **Partly — not usable as an X-axis yet** | Lives only in `vehicle_telemetry_raws.payload->>'engine_hours'` as unindexed JSON, and it is Wialon's `cneh` counter carried forward between *reconcile* sweeps — it does not change per ping. It has day resolution, not minute resolution. |
| `accel_total` / g-sensor | **No** | Not ingested anywhere. Needs a sensor census against the Wialon account before we know if it is even fitted. |
| RPM | **No** | Same. |
| Ambient temperature (thermal contraction) | **No** | No weather source integrated. |
| Fuel card / ERP transactions | **No** | Not integrated. |
| Tank capacity (for "1% of tank" thresholds) | **Yes but wrong** | `vehicles.tankCapacityLitres` disagrees with the probe on 180 of 299 units; median unit sustains 0.64× its declared capacity, 16 units read *above* it. Any threshold expressed as "% of tank" is built on sand. |

Two consequences:

**(a) The X-axis for a single event must be engine-on *seconds*, not motohours.**
We integrate `engine_on` across the ping stream inside the event window. That
gives sub-minute resolution, needs no new ingestion, and is the same quantity
motohours measures. The `cneh` counter stays where it is — as the daily basis
`fuel-tank-state` already uses it for.

**(b) Phase 3's vibration gate collapses onto ignition + speed.** We have no
accelerometer. `engine_on = false AND speed = 0` is the "machine is settled"
condition, and it is available on ~all units. Worth a one-off script to
enumerate every distinct sensor `t` (type) across the account — if a g-sensor or
RPM channel turns out to be fitted, Phase 3 gets stronger, but the design must
not depend on it.

---

## 3. Proposed design

### 3.1 Two questions, two fields

Keep `verdict` answering the question it already answers, and add a second field
for the new one:

- **`verdict`** (existing, untouched): *did fuel leave the tank?* →
  `REDISTRIBUTION` / `SENSOR_FAULT` / `DRAIN` / `PENDING`.
- **`drainCause`** (new): *if it left, why?* Only computed for rows that survive
  as `DRAIN`.

Leaving `verdict` alone is deliberate — the analytics, reports, AI insight,
dashboard chips, backfill script and 2,500+ historical rows all read it, and a
change of meaning there would silently rewrite a month of reporting.

```
enum FuelDrainCause {
  ENGINE_BURN     // consistent with this machine's own L/h — not an incident
  HIGH_BURN       // real consumption, but above the expected band (leak, hard work)
  SLOSH           // physically impossible rate — tilt/agitation, not a departure
  SETTLING        // parked, but the drop decays like a liquid finding its level
  SIPHON          // engine off, linear, sustained, above the noise floor
  INDETERMINATE   // not enough evidence to say — the default
}
```

New columns on `fuel_thefts`: `drain_cause`, `cause_confidence`, `cause_reason`
(mirroring the existing `verdict` / `verdictConfidence` / `verdictReason`
triple, including the rule that `cause_reason` is the auditable slug and
confidence never talks the category into changing).

**Only `SIPHON` notifies.** That is requirement 1.

**Operator-facing, a `SIPHON` reads "POSSIBLE THEFT"** — decided 2026-08-16:
*"when we have determined that truly it was a theft then we need to use the word
possible theft"*. So the earlier ban on that vocabulary is not lifted wholesale.
It still holds everywhere it holds today; the single exception is a drain that
has passed every gate in §3.2, and even there the word is qualified. Nothing
that reaches `INDETERMINATE`, `ENGINE_BURN`, `HIGH_BURN`, `SLOSH` or `SETTLING`
may use it. The existing notification-path test therefore stays, narrowed: it
asserts the vocabulary is absent unless `drainCause = SIPHON`.

### 3.2 The classifier — `src/modules/fuel/fuel-theft-classifier.ts`

Pure, no clock, no database, same shape as `fuel-adjudication.ts`. Called from
`judgeDrain()` after the recovery test and the probe trust gate have run.

Input per drain: the already-smoothed level series, the drop segment
(`beganAt`→trough, which adjudication already computes), the vehicle's expected
burn band, and its `ProbeProfile`.

**The expected band resolves operator-first** (decided 2026-08-16): a band
supplied per machine type by the operator is primary, and `vehicle_fuel_rates`
is the fallback where no band covers the machine. That ordering matters because
689 of 815 vehicles currently borrow a *type median* rather than having a rate of
their own, and a median built from three contributors is a weak thing to gate a
theft accusation on. Resolution order per vehicle:

1. operator band for its `vehicleType`
2. its own derived `lPerHour` (needs `MIN_RUNS`)
3. its type median from `vehicle_fuel_rates`
4. none → the burn gates cannot run, and the drain can only reach
   `INDETERMINATE` or the parked branch

Step 4 is not a failure case to be engineered around. A machine we cannot say
anything about the consumption of is a machine whose drop we cannot attribute to
consumption, and `INDETERMINATE` says exactly that.

Engine time inside the window is **engine-on seconds integrated from the ping
stream**, not the `cneh` counter (decided 2026-08-16) — see §2(a).

Gate order — first match wins:

1. **Probe trust.** `probeSwings(profile)` → `INDETERMINATE`. An instrument that
   moves 25 L on a parked machine cannot support a theft accusation. (Existing
   function, reused.)

2. **Impossible physics.** `impliedLPerHour = dropLitres / engineOnHours` in the
   window. Above `IMPOSSIBLE_MULTIPLE ×` the vehicle's expected `lPerHour` →
   `SLOSH`. This is the outline's 150 L/h excavator example, expressed against
   the machine's own measured rate rather than a fleet constant. Where engine-on
   time in the window is ~0 the ratio is undefined and this gate is skipped —
   an engine-off drop falls through to the parked branch below, which is where
   it belongs.

3. **Engine running.** If the window is predominantly engine-on:
   - implied rate within the expected band → `ENGINE_BURN` (suppress)
   - above the band but below impossible → `HIGH_BURN` (suppress as *theft*;
     see open question 4 on whether it gets its own alert)
   - Theft is never raised on a running machine. Per the outline, and it also
     matches this fleet: siphoning a working excavator is not a real scenario.

4. **Engine off / parked — the only branch that can reach `SIPHON`.** Three
   tests, all required:
   - **Magnitude floor.** The drop must exceed the thermal-contraction /
     noise floor. *Not* expressed as % of declared tank — see §2. Proposed
     instead: a flat millilitre floor, cross-checked against this vehicle's own
     observed parked swing distribution.
   - **Rate floor.** Drop rate > `SIPHON_MIN_L_PER_HOUR` (outline says 2 L/h)
     sustained over `SIPHON_MIN_MINUTES` (outline says 10).
   - **Shape.** Fit the drop segment to both a straight line and an exponential
     decay `A·e^(−kt)+C`; compare normalised residuals. Curve wins →
     `SETTLING` (suppress). Line wins → `SIPHON`.

   The shape test is the genuinely new physics in this plan and the one piece
   with no existing analogue in the codebase. It is also the one most worth
   backtesting before it gates anything — see §6.

5. Anything else → `INDETERMINATE`.

Every threshold above is a named exported constant with its derivation in the
docstring, matching the house style of `fuel-adjudication.ts`. **None of the
numbers should ship as the outline's round figures without being measured
against the ledger first** — that is what §6 is for.

### 3.3 Requirement 1 — suppress everything until theft is proved

Single change in `fuel-adjudication.service.ts:280`:

```ts
if (!opts.notify || verdict.verdict !== 'DRAIN') continue        // today
if (!opts.notify || cause.drainCause !== 'SIPHON') continue      // proposed
```

Notification text and severity change with it: a `SIPHON` is a single critical
item naming the vehicle, the volume, the place, the duration and the confidence.
Everything else lands in the ledger and the dashboard tables silently, exactly as
it does now.

Expected effect on volume: on the ledger as it stands, 417 of 2,571 rows are a
*confirmed* drain and 1,129 are `insufficient-telemetry`. Under this design the
1,129 stop notifying immediately (they become `INDETERMINATE`), and the 417 are
further split by cause. I would expect the notification rate to fall by well over
90%. That number is a prediction, not a measurement — §6 measures it.

### 3.4 Requirement 2 — the vehicle turns red on the dashboard

**The existing red path is already built and currently dead.** `dash`'s
`deriveStatus()` returns `'theft'` when `flags.fuelInconsistency` is set, which
drives the red marker, the pulse/ripple animation and the `critical` count
(`vehicleMap.js:152`, `FleetMap.css:203`). But the Wialon adapter hardcodes
`fuelInconsistency: false` (`wialon.adapter.ts:334`), so on live data it never
fires. Nothing on the dash needs rewriting — it needs feeding.

Server side, two additions to the fleet snapshot (`telemetry.repository.ts`
`findFleetSnapshot`):

- `flags.fuelInconsistency = true` when the vehicle has an open `SIPHON`
  incident inside a recency window. This alone turns the marker red everywhere,
  with **zero dash changes**.
- A `fuelIncident` object carrying the detail the operator needs without a
  second request: volume, began/detected time, duration, location, engine state,
  level before/after, confidence, cause reason, and the `fuel_thefts` row id.

Dash side: render `fuelIncident` in the vehicle card and the map popup. This is
new UI work, but it is *additive* — the red state itself comes for free.

**The vehicle stays red for a fixed window after the incident** and clears
itself (decided 2026-08-16) — no acknowledgement table, no endpoint, no button.
The window length is still needed; 12 h and 24 h are both defensible and 24 h
means an overnight siphon is still red when the day shift arrives.

Consequence worth stating: nothing records that a human looked. A red state that
expires on a timer can be missed entirely by a shift that was not watching. That
is the accepted trade for not building acknowledgement tonight, and it is the
obvious next increment if the operator starts asking "did anyone see this one".

---

## 4. Files touched

| File | Change |
| --- | --- |
| `prisma/schema.prisma` | `FuelDrainCause` enum; `drainCause`, `causeConfidence`, `causeReason` on `FuelTheft`; index for the snapshot lookup |
| `prisma/migrations/…` | additive migration, no backfill of existing rows in the same step |
| `src/modules/fuel/fuel-theft-classifier.ts` | **new** — pure classifier |
| `src/modules/fuel/fuel-adjudication.service.ts` | call the classifier in `judgeDrain`; persist the three columns; gate the notification on `SIPHON`; new message wording |
| `src/modules/fuel/fuel-rate.service.ts` | expose a per-vehicle rate lookup for the classifier (cached like `getProbeProfile`) |
| `src/modules/telemetry/telemetry.repository.ts` | `flags.fuelInconsistency` + `fuelIncident` on the fleet snapshot |
| `src/modules/fuel/fuel.controller.ts` / `.schema.ts` | expose cause fields on `/thefts` |
| `prisma/readjudicate-fuel.ts` | must go through `judgeDrain()` so backfilled rows get a cause too |
| `tests/unit/fuel-theft-classifier.test.ts` | **new** |
| `dash: src/lib/vehicleMap.js`, vehicle card, map popup | render `fuelIncident` |
| `docs/fuel-theft-detection-state.md` | update — it is the handover doc |

---

## 5. Sequencing

Each step is independently shippable and reversible.

1. **Sensor census** (30 min, read-only). One script against the Wialon account
   listing every distinct sensor type per unit. Settles whether RPM/g-sensor
   exist. Result changes Phase 3, so it goes first.
2. **Measurement harness** (read-only). Replay every adjudicated `DRAIN` on the
   ledger through a draft classifier and print the cause distribution, plus the
   linear-vs-decay residuals for parked drops. This is how the thresholds get
   chosen instead of guessed.
3. **Schema + migration.** Additive only.
4. **Classifier + unit tests.** Pure, no wiring.
5. **Wire into `judgeDrain`, persist, but do NOT change the notification gate
   yet.** Run for a day writing causes while still notifying as today. Compare.
6. **Flip the notification gate to `SIPHON`.**
7. **Snapshot flag + `fuelIncident`.**
8. **Dash rendering.**

Steps 1–2 answer most of the open questions below with data rather than opinion,
which is why they are cheap and first.

---

## 6. Why the thresholds must be measured, not adopted

The outline's numbers (10–25 L/hr band, 2 L/hr siphon floor, 1% of tank, 5-min
median window) are reasonable priors and none of them should ship as-is:

- **The 5-minute median window is wrong for this fleet and it is already known
  to be.** Drains here have a median duration of 2.3 min (SUKARI) and 11 min
  (KASULU). A 5-minute median is wider than the median SUKARI drain and would
  smooth away the event being measured. The deployed 3-sample median (~90 s) was
  chosen for exactly this reason and is documented at `fuel-adjudication.ts:463`.
- **"10–25 L/hr" is a fleet constant we do not need.** We already store a
  per-vehicle `lPerHour`. Using the machine's own rate is strictly better than a
  band — but note 689 of 815 vehicles borrow a *type median* rather than having
  their own rate, so the band is only as good as the group. This is question 3.
- **"1% of tank volume"** rests on `tankCapacityLitres`, which disagrees with
  the probe on 180 of 299 units. Needs a different denominator.
- **"2 L/hr while parked"** is plausible and untested here. The measurement
  harness gives us the parked-drop-rate distribution to place it against.

Precedent for this: `RECOVERY_THRESHOLD`, `SWING_ML`, `MIN_SWING_WINDOWS` and
`OBSERVED_DROP_MIN_RATIO` were each chosen by measuring alternatives against the
ledger, and the docstrings record the grids. Same standard here.

---

## 7. Decisions taken, 2026-08-16

| # | Decision | Consequence |
| --- | --- | --- |
| 1 | **"Possible theft" only once proved.** A `SIPHON` may say it; nothing else may. | The vocabulary ban stands everywhere else. The notification-path test is narrowed, not deleted. |
| 2 | **Notifications only.** Ledger and loss figures unchanged. | Analytics, reports, AI insight and the PDF are untouched by this work. Reversible. |
| 3 | **Operator bands primary, derived rates fallback.** | Needs the band table from the operator — see §8. |
| 4 | **`HIGH_BURN` silent in the first cut.** | Stored and visible in the fuel tables; no notification. Promote later if it fires rarely enough to be useful. |
| 5 | **Thresholds derived from the ledger and brought back for approval.** | Step 2 produces the grids the way `RECOVERY_THRESHOLD` and `SWING_ML` were produced. |
| 6 | **Engine-on seconds from the ping stream.** | No migration, no poller change. `cneh` stays where it is. |
| 7 | **Fixed window on the red state.** | No acknowledgement table. Window length still needed — see §8. |
| 8 | **Steps 1–8 tonight, dashboard included.** | See the sequencing note below. |

### Note on 5 + 8 together

These two pull against each other and it is worth being explicit rather than
discovering it at 2 a.m. Decision 5 puts a **human approval checkpoint** in the
middle of the run — I measure, bring the numbers, you approve, and only then do
they gate anything. Decision 8 wants all eight steps in one night.

Both are achievable, but it means the checkpoint is **in-flight rather than
overnight**: I stop after step 2 with the distributions, you look at them there
and then, and we continue. If you are not at the keyboard when step 2 lands, the
run stops there — I will not pick thresholds for a live theft accusation on my
own authority just to keep moving.

The honest risk in reaching step 8 tonight is that the notification gate and the
red dashboard state go live on thresholds validated against historical replay
only, with no day of shadow running behind them. The mitigation is that step 5
(write causes, keep notifying as today) still happens first and its output is
inspectable in seconds, and that flipping the gate back is a one-line revert.

---

## 8. Step 1 result — the sensor census, run 2026-08-16

`prisma/wialon-sensor-census.ts`, read-only, two `core/search_items` sweeps.
Scoped to our two fleets rather than the whole token, which sees eight
customers and 1,504 units.

**CONFIGURED is not ARRIVING, and the gap is the entire finding.** Nearly every
signal in the outline is configured on nearly every unit. Far fewer actually
transmit.

| signal | KASULU (218) cfg → arriving | SUKARI (336) cfg → arriving |
| --- | --- | --- |
| fuel level | 99.1% → **79.4%** | 100% → **86.0%** |
| ignition / engine operation | 99.1% → **78.9%** | 100% → **64.3%** |
| engine RPM | 99.1% → **55.5%** | 100% → **25.6%** |
| engine hours (sensor) | 91.3% → 39.9% | **0% configured** |
| accelerometer / g-sensor | 99.1% → **3.2%** | 100% → **16.4%** |
| hydraulic pressure | 0% | 0% |
| engine load | 0% | 0% |

Engine-hours *counter* (`cneh`, a unit property not a sensor): KASULU 89.9%,
SUKARI 94.9%.

### What this settles

**The accelerometer gate is dead — drop it from Phase 3.** The 99% "configured"
figure is misleading: those sensors are `Harsh Acceleration` / `Harsh
Acceleration Alert (2.7m/s/s)` on `io_253`/`io_254`, which are *event
thresholds*, not a continuous g-sensor. They arrive on 3.2% of KASULU units and
0–2.6% of ignition-readable units anywhere. There is no vibration channel to
gate on. The plan's fallback — `engine_on = false AND speed = 0` — is not a
compromise, it is the only option, and §2(b) stands as written.

**RPM is real but partial, so it is a bonus signal and never a requirement.**
It arrives on 121 of 218 KASULU units and 86 of 336 SUKARI. Enough to sharpen a
verdict where present; nowhere near enough for the classifier to depend on. If
we ingest it, it must be strictly additive — a machine without RPM has to reach
the same verdicts by the same route it would today.

**Engine hours as an X-axis is now doubly ruled out.** The sensor is not
configured on a single SUKARI unit, and it arrives on 39.9% of KASULU. Only the
coarse `cneh` counter has real coverage, and §2(a) already explains why that
cannot resolve a six-minute event. Decision 6 (engine-on seconds) is confirmed
by measurement rather than merely reasoned.

**Nothing about hydraulic pressure or engine load is available at all**, so the
outline's "hydraulic pressure" work-state input is unavailable.

### Checked, so it is not assumed later

RPM arrival is *not* explained by machines being switched off. Split by the
unit's own ignition reading on KASULU: RPM arrives on 44.4% of running units and
49.0% of stopped ones — near-identical, so the devices that send RPM send it
regardless of engine state, and the ones that do not, never do. (The equivalent
SUKARI split is unusable: `readIgnition` returns null for the 118 units on the
`flg:1` ignition parameter, which are exactly the units carrying the `timp` RPM
channel, so the readable subset excludes the units of interest.)

---

## 9. Step 2 findings so far — two corrections to the design

The distributions themselves are still running. Two things the harness settled
on the way there, both of which change the classifier rather than merely
informing it.

### 9.1 `engine_on` cannot answer "was the engine off"

`vehicle_telemetries.engine_on` is `NOT NULL DEFAULT false`, and the Wialon
adapter fills it as `ignitionOn ?? (speed > 0)` (`wialon.adapter.ts:305`). On
any unit that does not report ignition, the column is therefore a restatement of
whether the vehicle was MOVING.

This breaks the gate the siphon branch depends on. "Engine off and stationary"
is true of every parked vehicle on such a unit **by construction**, whether or
not the engine was turning. The first harness run read engine evidence at 100%
on every drain, which is not a coverage figure — it is the absence of one.

`ignition_known`, which the adapter writes into the raw payload for exactly this
purpose, is the only honest source. Coverage over 24 h of fuel-carrying pings:

| org | pings | ignition known | engine on, of those |
| --- | --- | --- | --- |
| KASULU | 148,716 | 70.2% | 82.5% |
| SUKARI | 151,673 | 87.9% | 81.3% |

**The classifier must read `ignition_known`, not `engine_on` alone**, and treat
its absence as UNKNOWN — never as off. A vehicle we cannot prove was stopped
cannot yield a theft verdict.

### 9.2 There are three fall shapes, and the two obvious discriminators are blind to the third

The outline contrasts linear (theft) with exponential decay (settling). The data
has a third that is neither: a **step**, where most of the drop falls between two
consecutive readings — which is the operator's own description of theft, *"hard
and sharp drops through siphoning"*.

Measured on synthetic falls whose true shape is not in question
(`tests/unit/fuel-drop-shape.test.ts`):

| shape | kT | decay residual | half-slope |
| --- | --- | --- | --- |
| step at 5% of window | 8.000 | 5,785 | 0.000 |
| step at 25% | 4.066 | 8,280 | 0.000 |
| step at 50% | 0.050 | 9,992 | 0.000 |
| straight line | 0.050 | 5 | 1.000 |
| decay, τ = 300 s | 4.066 | 214 | 0.141 |
| decay, τ = 1200 s | 0.965 | 11 | 0.614 |

**Half-slope reads 0.000 for every step — identical to a settle**, because the
flat stretches either side have no slope. A rule of "half-slope well below 1
means settling" would suppress every hard siphon on the fleet as noise. That is
this project's own failure mode, reached from the opposite direction.

**kT is no better: the same event moved within the window swings it across the
entire scan range**, 8.0 to 0.05. Nothing about the fuel changes — only when we
started watching.

What does work is the model-free measure, **step fraction** (largest single
interval ÷ total drop), corroborated by the **normalised residual**: a real line
and a real decay both fit to under 1% of their drop, and a step cannot be fitted
by either and leaves more than 10%.

So the shape branch is:

1. `stepFraction` high → sharp fall. Neither burn nor settling.
2. else low residual on the decay AND `kT` ≳ 1 AND half-slope ≪ 1 → SETTLING.
3. else low residual on the line AND half-slope ≈ 1 → steady fall.

`RECOVERY` has already decided whether the fuel came back before any of this
runs, so a step that was a probe glitch is REDISTRIBUTION and never reaches here.

### 9.3 A harness bug worth recording

The first run defined the fall from the pre-drain baseline READING, which
includes up to 30 minutes of flat plateau before the level moves. That divided
every drop rate by as much as eight and reported parked falls with a median
duration of 33 minutes. The fall now starts at the last reading still at the top.
Any figure quoted from a run before 2026-08-16 22:00 carries that error.

---

## 10. Still needed from you before step 3

Two inputs, both small, neither blocking steps 1–2:

1. **The per-type L/h bands.** A table of machine type → expected litres per
   engine-hour, as a range. Whatever granularity you actually have — excavator /
   dozer / tractor / truck is enough to start, and anything not covered falls
   back to the derived rate. This is the primary input to the burn gates, so its
   quality sets theirs.

2. **The red-state window.** 12 h or 24 h, or another figure.
