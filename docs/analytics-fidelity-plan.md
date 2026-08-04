# Analytics fidelity — plan

**Status:** DRAFT, awaiting sign-off. Nothing in here has been executed.
**Date:** 2026-08-04 · **Author:** working session
**Scope:** three workstreams — false fuel-loss flags, late "left the yard"
notifications, and the analytics page's fuel/distance/derived metrics.

Everything under "Measured" below was checked against the live systems while
writing this. Everything under "Proposed" is a decision to be validated before
any of it is built.

---

## Ground rule

Unchanged from `LIVE_INTEGRATION.md`: a field the provider does not supply stays
absent. Nothing here adds a fabricated number. Two of the three workstreams are
about the opposite failure — figures we DO record that describe something that
did not happen (fuel that was never lost, a gate that was never crossed).

A false flag is worse than a missing one. An operator who is told nine times
that a truck was drained, and finds nine times that it was parked on a slope,
stops reading the tenth.

---

## Workstream 1 — false fuel-loss flags

### Symptom (reported)

Drain notifications fire for vehicles parked on a hill. With a partly filled
tank, fuel shifts away from the probe on a slope, the level reads low, and the
level returns when the vehicle levels out. The dip is recorded as fuel lost.

### Measured

- We do **not** detect drains ourselves. Every `fuel_thefts` row is Wialon's
  own answer, read from the `unit_thefts` table of the per-vehicle Advanced Fuel
  Analysis report (`wialon.reports.ts` → `mapThefts`). The decision that a dip
  is a theft is made by the provider's template, upstream of this codebase.
- Each row already carries what an adjudication needs:
  `initialFuelLevelMl`, `finalFuelLevelMl`, `stolenMl`, `beganAt`,
  `detectedAt`, `initialSpeedKmh`, `initialLocation`.
- `fuel-ledger-fidelity.md` already recorded a related population of false
  positives from a different cause: **352 of 427** KASULU drain rows begin at
  speed 0, on excavators and dozers, where engine-on stationary burn is very
  likely being reported as theft by the template itself. That finding was
  flagged and left alone. It is the same class of defect as the hill case and
  should be handled by the same mechanism.
- A settle pass already exists (`FUEL_SETTLE_ENABLED`, `--settle-age`), which
  re-reads events once they are old enough for Wialon to have stopped moving
  their edges. There is already a place for "decide later, with more evidence".

### Proposed

Add an **adjudication layer** between the provider's claim and the ledger the
analytics read. The provider keeps reporting what it reports; we decide what
counts as a loss, and we record why.

Four signals, all computable from data we already hold:

1. **Recovery.** A drop followed by a comparable rise within a short window,
   with no filling event to explain it, is redistribution, not loss. This is the
   hill case directly: the fuel comes back. Needs the level series around the
   event, which the telemetry table has.
2. **Stationary + engine on.** A drop with `initialSpeedKmh = 0` that persists
   is consumption on heavy plant, not theft. Covers the 352 KASULU rows.
3. **Fill fraction.** A probe in a partly filled tank is what makes the slope
   sensitive at all — a full tank cannot slosh away from the sensor. Low
   `finalFuelLevelMl / tankCapacityLitres` raises suspicion rather than
   deciding on its own.
4. **Persistence.** Nothing is settled as a loss until the level has stayed
   down for a defined period AND the vehicle has moved since. This is the
   general form of (1) and reuses the existing settle pass.

**Recording, not deleting.** A rejected event stays in the ledger with a status
and a reason, rather than being dropped. Two reasons: we need to be able to
audit the rule against the provider, and an operator who saw the notification
must be able to find out what happened to it.

**Notification changes with it.** A drain notification is only raised once the
event survives adjudication. That trades immediacy for correctness — worth
stating explicitly, because it is a real cost and it is the point.

### Open questions for discovery

- What does the level series actually look like around a hill event? Need real
  examples: pull the telemetry fuel channel around known-suspect drains and see
  whether the recovery is visible at our 2-minute sampling.
- Does Wialon report the recovery as a **filling**? If so both totals are
  inflated today, and the fix has to cancel a pair, not just suppress one row.
- Is `tankCapacityLitres` trustworthy? `fuel-ledger-fidelity.md` found it
  disagrees with probe calibration on 22 of 496 KASULU fillings. If it is not
  reliable, signal (3) is out.
- Can the slope be established at all, or only inferred from the recovery?
  There is no pitch sensor and no elevation in the telemetry. Probably inferred
  only — worth confirming, since it changes how confidently we can label.
- Is the template itself configurable? If the operator can tighten the drain
  rule upstream in Wialon, some of this belongs there rather than here.

### How we would validate

Same method as `fuel-ledger-fidelity.md`: take a fixed, fully settled window,
run the adjudication over it, and compare event-by-event against the provider's
raw rows plus a hand-checked sample. The rule ships only if it clears the known
false positives without suppressing a drain anyone believes was real.

---

## Workstream 2 — "left the yard" fires ~800 m late

### Symptom (reported)

The notification says a unit left the premises when it is already ~800 m out.
It should fire as the unit clears the gate.

### Measured — this one is fully explained

- `YARD_RADIUS_M = 800` (`src/lib/dispatch-trip.ts:79`). `yard-departure.ts`
  publishes on the first fix further than that from a single point.
- That point is the org's `hubLat/hubLng`. For SUKARI:
  `-0.8217694, 34.3819971`.
- **The `geofences` table holds 0 rows for SUKARI.** There is no boundary in
  our database to test against, which is why a radius is being used at all.
- **Wialon does hold the real boundary.** Resource `27625222` (RAI GROUP),
  zone 29, `Sukari industries`, a **polygon** with a bounding box of roughly
  **1561 m × 1386 m**. The same resource carries polygons for the weighbridges
  the trips name as destinations — Oyani, Mariwa, Opapo, Amuka, Selia, Butali,
  Butere, Khalaba, Nyaundo — each ~250–460 m across.
- So the 800 m circle is not merely coarse, it is the wrong shape. The site is
  ~1.5 km across; a truck at the far side of the compound is already beyond
  800 m from the hub point without having gone anywhere. The comment on the
  constant anticipates exactly this and accepts it to stop the flicker a tight
  radius would cause.

### Proposed

1. **Sync the Wialon zones into `geofences`.** A `sync:geofences` script and
   the `Geofence` model already exist, and `geofence.ts` already implements
   polygon, circle and corridor containment. The gap is that nothing has been
   run for these resources.
2. **Departure = crossing the premises polygon**, not leaving a radius. The
   polygon boundary follows the perimeter, so the crossing is the gate.
3. **Hysteresis instead of a big radius.** The flicker the 800 m circle was
   protecting against gets handled where it belongs: require N consecutive
   fixes outside, or a small buffer band around the boundary, so a unit parked
   on the fence line does not narrate a convoy. Keyed on the dispatch as it is
   today, so a re-entry updates one row.
4. **Fall back to the radius** when an org has no polygon, so nothing regresses
   for an org whose zones were never drawn.

Sampling is the limit on precision: at a 2-minute cadence a truck at 20 km/h
covers ~660 m between fixes, so "at the gate" means "the first fix after the
gate". Worth stating in the plan rather than discovering it in review — if the
operator needs tighter, that is a polling-rate conversation, not a geometry one.

### DISCOVERY RESULT — the premise above is wrong

Signed off: RAI GROUP is the source of truth, SUKARI first. Discovery then ran
the replay before any code was written, and **it does not support swapping the
circle for the polygon as a way to fire earlier.**

The polygon, fetched from RAI GROUP zone 29: 10 vertices, 142 ha, perimeter
4,897 m, bbox 1461 m N–S × 1286 m E–W. The hub point sits inside it. 3 of its
10 vertices lie beyond the current 800 m radius.

Replayed over 40 recent SUKARI dispatches, measuring **metres beyond the fence
at the moment each rule fires** (negative = still inside):

| rule | median | min | max | n |
|---|---|---|---|---|
| 800 m hub radius | **+31 m** | −50 m | +1002 m | 15 |
| premises polygon | **+70 m** | +7 m | +1002 m | 15 |

Three things follow, none of them what the plan assumed:

1. **The radius is not firing 800 m late.** Its median is 31 m past the fence.
   The 800 m is measured from the hub, and on the routes vehicles actually use
   the fence happens to sit near that distance. The reported symptom is the
   TAIL, not the typical case.
2. **The polygon fires slightly LATER, not earlier** (70 m vs 31 m median), and
   the two agree on the same fix in almost every case — median lag 0 min, both
   raw and filtered.
3. **The radius's real defect is the opposite of the complaint: it fires
   EARLY.** In 6 of 15 departures it fired while the vehicle was still inside
   the fence (−8 m to −50 m). The polygon never does, by construction. That —
   not earliness — is what the polygon buys.

**What actually causes the tail.** Two measured defects in the fix stream:

- **Implausible positions.** 0.91% of consecutive-fix pairs org-wide over 24 h
  imply a speed above 120 km/h; 1,282 imply over 300 km/h; p99.9 is 2,141 km/h.
  In departure windows the rate is **5.15%** — five times higher, consistent
  with multipath around sheds and the weighbridge. Decisively: **zero** fixes
  carry a REPORTED speed above 120 km/h. The device never claims to be moving
  that fast, so the position is wrong, not the speed. `yard-departure.ts` has
  no plausibility guard; `trip-builder.ts` has one for distance only.
- **Gaps.** Fix-to-fix gap is median 30 s and p90 37 s — good — but p99 is
  1,175 s and the worst is 45,548 s (12.6 h). Every large outlier above
  (+1002 m, +728 m, +576 m) sits behind a gap or a discarded teleport. When the
  stream goes quiet across the gate, the first fix we see is already far out,
  and no boundary geometry can recover that.

### Revised proposal

1. **Still sync RAI GROUP's zones for SUKARI** — the boundary and the
   weighbridge polygons are worth having regardless, and arrival detection
   needs them. `sync-geofences.ts` is currently hardcoded to KASULU
   (`ORG_CODE`, `KASULU_WIALON_ACCOUNT_ID`) and needs parameterising.
2. **Adopt the polygon for the containment test** — justified by removing the
   6-in-15 false-early notifications, NOT by earliness. Say so plainly, so
   nobody later reads the change as a latency fix.
3. **Add a plausibility filter to the departure path**, expressed as an implied
   speed so it scales with the gap rather than as a fixed distance. This is the
   single highest-value change measured: it is what removes teleport-triggered
   departures.
4. **Be honest about gaps rather than papering over them.** When the fix
   preceding a crossing is more than a few minutes stale, the notification
   should say the departure is bounded, not exact. Interpolating a crossing
   time across a 20-minute silence would be inventing a measurement.
5. **Hysteresis** as originally planned, to stop boundary-line flicker.

### DISCOVERY, part 2 — the gates, located

Confirmed: the polygon is the premises boundary and does **not** enclose cane
fields, so the distance table above stands. Decision taken: trigger on the
**gate**, not the perimeter as a whole.

A gate is a choke point, so it can be measured rather than guessed. Over 120
dispatches across 21 days, taking each plausibility-filtered track's
last-inside/first-outside midpoint and clustering at 200 m:

| gate | position | departures | share | spread (mean / max) |
|---|---|---|---|---|
| **North-west** | `-0.813411, 34.378680` | 19 | 54% | 42 m / 199 m |
| **South-east** | `-0.825918, 34.388060` | 12 | 34% | **14 m / 37 m** |
| West (KTCC only) | `-0.823931, 34.377780` | 3 | 9% | 53 m / 79 m |
| (single track) | `-0.815231, 34.378472` | 1 | 3% | — |

The south-east cluster is 14 m mean, 37 m max across 12 departures — that is a
gate, not a statistical artefact. The north-west one is looser and may be a
wide entrance or two adjacent exits worth splitting.

**The crossings also hand us a false-flag test.** 35 of 46 usable crossings fall
in a gate cluster. The other 11 do not — and every one of them is a gap or a
teleport:

```
KDL 714E   2025 m over  314 s      KTCC 119G  4563 m over 5291 s
KDL 708E   1627 m over 1409 s      KTCC 953G  1195 m over 2547 s
KDL 712E   1080 m over  338 s      KDL 715E    459 m over  324 s
```

A truck cannot leave except through a gate. So a perimeter crossing that does
not happen at one is not a departure we observed — it is a departure we missed
and are now inferring from the far side of a data gap.

Note the recurring ~320 s gap (314, 320, 322, 324, 338…). That regularity looks
like a pipeline artefact rather than coincidence and is worth chasing on its own.

### DISCOVERY, part 3 — gates without any geofence

Correction from the operator: the SUKARI zone set covers neither the whole site
nor the wider operating area. **Geofences are therefore out as a basis for
either departure or arrival detection**, and the part-2 gate positions — which
were derived by crossing that polygon — cannot be trusted: a "crossing" of an
incomplete boundary may be a truck moving between two parts of the site.

Re-derived from telemetry alone, no zones involved.

**Convergence failed to isolate a gate.** Scoring 30 m cells by how far apart
the same departures were 250 m earlier lights up the entire outbound road —
vehicles merge onto it from scattered parking and stay merged, so convergence
stays high for hundreds of metres. It maps the route, not the gate.

**Halts do isolate it.** A truck leaving a sugar estate stops at the gate — the
barrier, the security check, the weigh-out — and nowhere else on the way out.
Clustering every outbound halt of 30 s or more, across 68 usable departures:

| position | departures | halts | median halt | spread | from hub |
|---|---|---|---|---|---|
| `-0.822721, 34.383258` | **47 (69%)** | 92 | **116 s** | 20 m | **176 m** |
| `-0.821828, 34.382022` | 44 (65%) | 58 | 157 s | 13 m | 7 m |
| `-0.822875, 34.385120` | 18 (26%) | 26 | 254 s | 24 m | 368 m |
| `-0.822392, 34.382411` | 16 (24%) | 17 | 392 s | 29 m | 83 m |
| `-0.815148, 34.377087` | 4 (6%) | 7 | 71 s | 16 m | 917 m |

The 7 m cluster is the hub itself — parking and loading, not a gate. The
standout is **176 m from the hub: 69% of all departures halt there, within a
20 m spread, for a median of just under two minutes.** That is the signature of
a barrier or a weigh-out, and it is the strongest gate candidate in the data.

The 368 m and 83 m clusters may be a second checkpoint and a queue position on
the same way out. The 917 m cluster sits on the north-west route and is thin
(4 departures) but has a short 71 s halt — the profile of a second gate rather
than a checkpoint.

**Coverage caveat, unchanged and material:** only 68 of 150 dispatches produced
a usable outbound track at all. Whatever rule is built, it can only fire for
departures the telemetry actually witnessed.

### DISCOVERY, part 4 — the gate, supplied and verified

The operator gave the gate directly: **`-0.821842, 34.381860`**. It sits **17 m
from the hub point** the 800 m radius is centred on, and it matches the halt
cluster in part 3 that 65% of departures stop at for a median of 157 s — the
cluster dismissed there as "parking". It was the weigh-out.

**This closes the original question.** The radius is centred on the gate, so the
rule fires one radius past the gate *by construction*. Replayed over 54
departures across 21 days:

| | median | p90 | max |
|---|---|---|---|
| metres past the gate, **current** rule | **867 m** | 4,210 m | 20,087 m |
| metres past the gate, **gate** rule | **118 m** | 554 m | 2,017 m |
| warning gained | **264 s** | 1,113 s | 14,633 s |

The reported "800 m or so" is 867 m measured. 45 of 54 departures reach the
gate; 9 are never seen there — the coverage ceiling again, unchanged.

The gate rule's own tail (p90 554 m) is entirely the gap cases. It cannot be
closed by geometry, only by better telemetry or by declining to state a time we
did not observe.

### Design — gate-triggered departure

No geofences: the gate is a coordinate and a radius held as configuration, and
it can be re-derived from halt clustering whenever the site changes.

1. **Gate per organisation** — `-0.821842, 34.381860` for SUKARI, radius 60 m
   (the value the table above was measured at; the halt spread is 13–20 m, so
   60 m clears it comfortably without reaching the next cluster at 83 m).
2. **Departure = a dispatched vehicle seen inside the gate radius, then outside
   it and staying outside.** That is what "as soon as it leaves the gate" means
   in terms the fixes support.
3. **Hysteresis** — a nose-out that returns within 10 minutes is shunting at the
   barrier, not a departure. Keyed on the dispatch as today, so one row.
4. **Plausibility filter first** — drop any fix implying over 120 km/h from the
   last accepted one. 5.15% of fixes in departure windows fail this, and no fix
   in the fleet ever REPORTS above 120 km/h, so the position is what is wrong.
5. **Never seen at the gate → bounded, not fabricated.** For the 9 in 54, say
   the vehicle has left without claiming a time we did not measure.
6. **Keep the 800 m radius as the fallback** for an org with no gate configured,
   so nothing regresses elsewhere.

### Verification — SHIPPED and verified 2026-08-04

Deployed as `fd8f0b4`; migrations `20260804200000_add_organisation_gate` and
`20260804200100_set_sukari_gate` applied to prod RDS; pm2 restarted clean, 165
poll cycles with `errors: 0`.

Replay re-run over the same 54 dispatches, importing the **deployed**
`isPlausibleFix` and `haversineM` from `dist/` and reading the gate from the
database, so it exercises shipped code rather than a re-implementation:

| | median | p90 | max |
|---|---|---|---|
| metres past gate — old rule | 865 m | 1,112 m | 4,557 m |
| metres past gate — **new rule** | **136 m** | 1,240 m | 4,557 m |
| warning gained | **242 s** | 1,019 s | 14,623 s |

Outcome per dispatch: **44 precise** (watched it clear the gate), **3 bounded**
(never seen at the gate), 7 announced nothing.

| criterion | result |
|---|---|
| median distance well under the old 867 m | PASS — 136 m |
| no departure fired from a rejected fix | PASS — 0 |
| no dispatch announced more than once | PASS — 0 |
| gate-less departures reported as bounded | PASS — 3 |

**The p90 got worse, and that is correct.** 1,240 m against the old 1,112 m,
because the bounded cases fire wherever the stream reappears — sometimes
kilometres out. The old rule reported those with the same false confidence as
the rest. The tail is not a regression in detection; it is the coverage gap
finally being visible instead of hidden behind a plausible-looking number.

Unit tests cover the notification path itself (12 cases), including the
hysteresis band, the plausibility rejection, the bounded wording, and the
fallback for an org with no gate. Full suite 287 passed / 7 skipped.

### The ~320 s gap — investigated, 2026-08-04

**It is a device power-save heartbeat that engages when the engine is off, and
the gate is exactly where trucks switch off.**

Over 635,221 fixes / 194 vehicles / 3 days, the gap distribution is **bimodal,
not a tail**:

```
   0- 19s  31.14%  ############################################################
  20- 39s  59.43%  ############################################################
  40- 59s   1.75%
  60-139s   1.17%
 140-279s   ~0        <- nothing here
 280-299s   0.12%
 300-319s   0.82%
 320-339s   1.21%     <- a discrete second mode
   >600s    3.39%
```

A near-empty 140–280 s band with a clean spike at 300–340 s is a configured
interval, not random loss.

Of gaps in the 240–420 s band: **90% are preceded by speed 0** and **88% by
engine OFF**; only 7% have the vehicle moving at both ends.

**Not our pipeline.** Ingest lag (`receivedAt − capturedAt`) is a median of 2 s
for frames ending a 320 s gap and 2 s for frames ending a 30 s gap. The frames
arrive promptly; the device sent nothing in between.

**Normal reporting is much denser than assumed.** Across 156 vehicles with
enough data, the median gap is **12 s while moving** and **30 s while parked** —
so the earlier "30 s median" was the parked figure, and moving resolution is
better still.

**Two distinct populations:**

| | vehicles | median gap moving | median gap parked |
|---|---|---|---|
| normal | 153 | 12 s | 30 s |
| **permanently sparse** | **3** | **301 s** | 320 s |

The three are `KTCB 297U`, `KCX 796S`, `KCX 802S` — reporting every ~5 minutes
*even at speed*. That is a tracker configuration defect, not power-save, and it
is worth raising with the installer. They happen to explain none of the missed
departures (none were dispatched in the sample), so it is a separate, smaller
problem than it first looked.

**What actually causes the departure misses.** All 6 of the 54 departures with
no fix at the gate were on NORMAL reporters. The mechanism: a truck halts at
the barrier for the weigh-out — median 157 s, engine off — the tracker drops to
its ~320 s heartbeat, and the next fix lands hundreds of metres down the road.
The power-save engages precisely at the one place we most need resolution.

This is upstream of the codebase. Two ways to close it, both provider-side:
shorten the parked heartbeat, or have the device report on ignition-on so the
restart itself is an event. Until then, bounded notification is the honest
answer and is what ships.

### Next

- Raise the 3 permanently-sparse trackers, and the parked-heartbeat question,
  with the provider.
- Workstream 1 (false fuel-loss flags) is unstarted and re-enters discovery on
  its own terms.

### Still open

- Is the **west cluster** (3 departures, KTCC only) a real third gate — a cane
  or haulmaster exit — or three vehicles cutting across? Operator knows.
- Should the **north-west** cluster be one 200 m gate or two tighter ones?
- Only **46 of 120** dispatches produced a usable crossing at all; the rest had
  too few fixes, never crossed, or began outside. That coverage gap caps what
  any departure rule can achieve and needs its own look.
- Are the telemetry gaps ours or the provider's — and what is the ~320 s
  periodicity?
- Weighbridge arrival detection — in scope for this workstream, or separate?

### How we would validate

Re-run this same replay after the change and compare the two tables. The
success criterion is now explicit: **no departure fires while the vehicle is
inside the fence, and no departure fires on a discarded fix** — with the median
distance staying in the tens of metres rather than improving, because it is
already there.

---

## Workstream 3 — the analytics page's own metrics

### Measured

Checked against Wialon's own trip segmentation (SUKARI resource `28843152`,
template 4 "Movement Report Per Vehicle" → `unit_trips`) over 10 recent trips,
same vehicle, same window:

| | ours | Wialon | note |
|---|---|---|---|
| Distance | within 15% on 7 of 10 | — | we err LOW; two outliers at ~50% and ~29% under |
| Average speed | +20–25% on **every** row | — | systematic, not noise |
| Interrupted flag | 9 of 10 | 5 of 10 by driving time | we over-flag |

- The speed bias has a known cause: Wialon's driving time includes the brief
  in-trip stops its `unit_stops` table records (many are 30 s); our average
  drops every sample under 1 km/h. Our expected transit time therefore comes
  out ~20% short and the 2× interrupted test trips more easily.
- The underlying signal is real, though: driving time was 1.2–3.7 h against
  dispatch windows of 3.3–14.3 h. These trucks genuinely spend two to four
  times their driving time stationary inside a dispatch. On the provider's
  untouched numbers half the sample still exceeds twice its driving time.
- Production currently reports **401 of 430** trips interrupted over 30 days.
  A reliability KPI that flags 93% is about as actionable as one that flags
  none — which is what it did until this week.

### Proposed

1. **Take expected transit from the provider.** `unit_trips` gives driving time
   directly. Using it removes the bias and the definitional argument in one
   move, and it is the same "read the provider's answer, don't invent one"
   principle the fuel module already follows.
2. **Rename what the metric measures.** Elapsed-vs-driving is *waiting*, not
   *interruption*. Loading at a weighbridge is not a breakdown. Whatever the
   threshold ends up being, the label should say what it detects.
3. **Investigate the distance shortfall.** The jitter floor (20 m) and teleport
   ceiling (5 km) are documented as deliberately conservative, but a trip at
   half the provider's distance is past conservative. Two candidates: coverage
   gaps being dropped wholesale, or the dispatch window not covering the whole
   run.
4. **Fuel and distance cards** follow from workstreams 1 and 2 — once losses
   are adjudicated and the ledger is trustworthy, the fuel card is reporting a
   number that survives scrutiny. No page change is proposed independently of
   the data behind it.

### Open questions for discovery

- Is per-trip `unit_trips` affordable? It is one report execution per trip; the
  fuel sync already does one per vehicle per night, so the pattern exists, but
  the volume is different. Cache in the trip row at build time?
- What should the threshold be, once it is measured against driving time
  rather than a derived average?
- Do we keep our own measured distance, or take Wialon's? Ours is auditable
  from fixes we hold; theirs is calibrated. They disagree by up to 50%.

---

## Sequence

Workstreams 1 and 2 are independent and can run in either order. 3 depends on
neither, but its fuel section reads better after 1 lands.

Proposed order, on the process agreed for this work — **discover → plan →
validate → document → execute → verify**:

1. **Workstream 2 first.** It is the best understood, the cause is proven, the
   data exists, and it is the one an operator feels every day.
2. **Workstream 1 second.** Largest correctness win, largest discovery cost —
   the level-series question has to be answered before the rule can be written.
3. **Workstream 3 last**, once the fuel ledger it reports on is settled.

Nothing starts until this document is signed off, and each workstream re-enters
discovery on its own before anything is built.
