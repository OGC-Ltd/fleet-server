# Fuel consumption rates — derivation and measured values

Prerequisite for expected-consumption reconciliation ("this vehicle should have
burned X since its last trusted baseline"). Measured 2026-08-11.

Nothing in the codebase modelled consumption before this. There is still no
table and no service — this records the **method and the numbers**, so the
detector that consumes them is built on something audited rather than assumed.

---

## Status, 2026-08-27 — read this before §1

This is a **dated measurement record**, not a description of current behaviour.
The numbers below were correctly measured on 2026-08-11 and are preserved as
they were taken. Four of its conclusions have since been superseded, and one of
them was reversed outright:

| § | what it says | now |
| --- | --- | --- |
| 1 | "engine hours is the primary basis for **every type**" | **reversed.** Road vehicles are judged per kilometre — see below |
| 5 | 3 days of history, forced by RAM | 7 days. The ceiling was a 60 s client timeout, not memory |
| 6 | the derivation SQL | no longer what ships — it has no plausibility cap at all |
| 7 | what step 4 needs | items 1 and 2 are built |

The sentence at the end of §1 is the one to be careful with, because a doc
outranks code in apparent authority and this one is wrong in a way that reads
as settled. **Its evidence is entirely about plant** — 215 of 310 units, 58.3%
engine-on, 1.5 km/h, 7.361 L/km — and it was generalised onto the 95 road units
it never measured, where distance is the natural denominator and a stationary
truck's whole burn presents as unexplained.

The rule now lives in `resolveBasis` (`modules/fuel/fuel-theft-classifier`) and
is recorded per machine on `vehicle_fuel_rates.primary_basis`:

- **hours** — excavators, dozers, loaders, graders, generators, and tractors.
  A tractor works the field at 0 km/h, so §1's argument holds for it exactly.
- **distance** — trucks, lorries, buses, saloons, company vehicles. `applicableBasis`
  sends one back to hours for a fall during which it did not travel, because an
  idling truck is burning rather than driving.

Do not restore hours-for-everything from §1 without re-reading that measurement's
scope.

---

## 1. Why engine hours and not distance

The obvious model, `expected = baseline − km × L_per_km`, fails on most of this
fleet. Fuel-probed units, both orgs:

| | units with a fuel probe |
| --- | --- |
| Plant (excavator, dozer, loader, roller) | 53 |
| Tractors | 162 |
| Road (truck, lorry, saloon, bus, company) | 95 |

**215 of 310 probed units — 69% — burn fuel while stationary or crawling.** Over
two days of fuel-carrying telemetry, Kasulu PLANT has its **engine on for 58.3%
of samples but is moving in only 19.3%**, and averages **1.5 km/h** across
measured working runs.

It is worse than imprecise. Position freezes at speed 0 on this telemetry, so a
working excavator reports ≈0 km while burning ~11 L/h: a distance model predicts
no consumption, the entire real burn presents as an unexplained drop, and every
plant unit raises a theft alert every shift.

The measured L/km for PLANT is **7.361 L/km**. That number is not a rate anyone
can use — it is the arithmetic telling you the denominator is wrong.

**So engine hours is the primary basis for every type.** Distance is kept only
as a secondary check on road vehicles, where the two agree.

> **Superseded 2026-08-27 — see Status above.** Everything preceding this line
> is sound and still governs plant, generators and tractors. The concluding
> sentence is not: every figure supporting it was measured on machines that burn
> while stationary, and the 95 road units in the table above were swept in
> without being measured. They are now judged per kilometre.

## 2. Method

Rates come from **engine-on runs**, not per-ping deltas. Summing positive
level deltas accumulates probe noise into fictional consumption; taking the
level at the two ends of a long run does not.

A run is a maximal stretch of consecutive telemetry with `engine_on` unchanged
and no gap over 15 minutes. A run is used when it:

- has the engine **on**, ≥10 readings, and lasts ≥20 minutes
- ends lower than it started, by between 0.3 L and 200 L
- contains **no `fuel_fillings` row** (a refuel invalidates the endpoints)
- contains **no `fuel_thefts` row** (a drain is the thing we are calibrating
  against, so it must not calibrate itself)

Then per vehicle: `L_per_hour = Σ litres / Σ hours`, and the same over Σ km.
Distance is integrated from speed × dt, capped at 900 s per interval.

The derivation SQL is in §5 and is repeatable as-is.

## 3. Measured — fleet aggregate (Σ litres / Σ hours, 3 days)

| org | type | runs | veh | L/hour | L/km | avg km/h |
| --- | --- | --- | --- | --- | --- | --- |
| Kasulu | PLANT | 113 | 29 | **11.28** | *7.361* | 1.5 |
| Kasulu | TRACTOR | 80 | 19 | 12.47 | 1.866 | 6.7 |
| Kasulu | TRUCK | 106 | 14 | 6.98 | **0.444** | 15.7 |
| Kasulu | LORRY | 70 | 12 | 6.45 | **0.505** | 12.8 |
| Kasulu | SALOON | 59 | 9 | 3.04 | **0.100** | 30.5 |
| Kasulu | BUS | 18 | 1 | 5.63 | 0.171 | 32.9 |
| Sukari | TRACTOR | 324 | 79 | 3.13 | 0.591 | 5.3 |
| Sukari | TRUCK | 72 | 14 | 9.58 | 0.703 | 13.6 |

Sanity: saloon 10 L/100 km, truck 44, lorry 50, bus 17, excavator ~11 L/h. All
land where they should, which is the main evidence the method is sound.

## 4. Measured — per vehicle, and why type-level rates are not enough

| org | type | vehicles | ≥3 runs | p25 | **p50** | p75 | p75/p25 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Kasulu | PLANT | 27 | 21 | 7.00 | **9.79** | 12.80 | 1.8× |
| Kasulu | TRACTOR | 17 | 13 | 2.38 | **3.51** | 9.86 | **4.1×** |
| Kasulu | TRUCK | 13 | 11 | 6.20 | **6.78** | 7.96 | 1.3× |
| Kasulu | LORRY | 11 | 10 | 4.58 | **7.25** | 9.98 | 2.2× |
| Kasulu | SALOON | 9 | 8 | 2.53 | **3.69** | 4.16 | 1.6× |
| Sukari | TRACTOR | 76 | 48 | 2.21 | **4.71** | 7.05 | **3.2×** |
| Sukari | TRUCK | 14 | 10 | 6.10 | **12.64** | 15.14 | 2.5× |

**Per-vehicle rates are required, not a refinement.** Trucks are tight enough
(1.3×) that a type rate would serve, but tractors spread **4.1×** between the
first and third quartile. A single tractor rate would over-predict burn on the
light half — inventing theft — and under-predict on the heavy half, hiding it.
Whatever tolerance band step 4 uses would have to be wider than the signal.

PLANT's 1.8× is partly an artefact of the label: `vehicle_type = PLANT` lumps
excavators, dozers, loaders and rollers together. Splitting on the equipment
code (`EX`, `DZ`, `WL`, `BH`, `COMP`) should tighten it.

> **Do not read the org difference off §3.** The aggregate is volume-weighted, so
> a few heavy tractors dominate it: Kasulu TRACTOR reads 12.47 L/h there against
> a per-vehicle median of 3.51. Against Sukari's 4.71, the per-vehicle medians
> are *similar* and the apparent 4× fleet gap in §3 reverses. Use §4 for
> per-vehicle expectations and §3 only for fleet totals.

## 5. Caveats before this is used to accuse anyone

- **3 days of history.** Coverage is 21/27 PLANT and 48/76 Sukari tractors at
  ≥3 runs. A 30-day window is what per-vehicle rates should actually be built
  on; this window was kept short because the instance has ~1 GB of RAM and the
  window functions here sort the full fuel-carrying telemetry set.

  > **Corrected 2026-08-27.** Now 7 days, and the reason given here was wrong.
  > Timed against production: 3 days 21.5 s, 7 days 31.0 s, 14 days 53.5 s,
  > 21 days 57.1 s, 30 days times out. Nothing swapped and nothing failed on
  > memory — what 30 days hits is `query_timeout: 60_000` in `lib/prisma`, a
  > client-side guard shared with the API and SSE paths. Seven leaves the
  > largest safe margin under it while taking most of the gain: vehicles
  > clearing MIN_RUNS went 154 → 198. 14 and 21 both run, with 11% and 5%
  > headroom, and `--days` is there for deliberate wider passes.
- **Load is not modelled.** A loaded haul and an empty return are one rate here.
  That is a real part of the 2–4× within-type spread and it is not noise.
- **Idle is not separated from work.** `engine_on` covers both, and an excavator
  idling burns far less than one digging.
- Rates are derived from the same probe the detector will watch, so a
  mis-calibrated probe produces a self-consistent, wrong rate. It cross-checks
  against nothing.

## 6. Derivation SQL

> **This is the 2026-08-11 query, kept so the numbers above can be reproduced.
> It is no longer what ships.** `deriveFuelRates` in
> `modules/fuel/fuel-rate.service` has since gained a plausibility cap on the
> implied rate — this version bounds a run's DROP but not its RATE, so a
> 20-minute run falling 100 L implies 300 L/h and passes every filter here.
> That cap is per machine class as of 2026-08-27. The window is also 7 days
> rather than 3, and the query records which denominator each rate is in.

```sql
with s as (
  select x.vehicle_id, x.captured_at, x.fuel_level_ml, x.engine_on,
         coalesce(x.speed_kmh,0) spd,
         lag(x.captured_at) over w prev_at, lag(x.engine_on) over w prev_on
  from vehicle_telemetries x
  where x.captured_at >= now() - interval '3 days' and x.fuel_level_ml is not null
  window w as (partition by x.vehicle_id order by x.captured_at)
), b as (
  select *, extract(epoch from (captured_at - prev_at)) dt,
         sum(case when prev_on is distinct from engine_on or prev_at is null
                    or extract(epoch from (captured_at - prev_at)) > 900
                  then 1 else 0 end) over (partition by vehicle_id order by captured_at) grp
  from s
), runs as (
  select vehicle_id, grp, bool_and(engine_on) eng,
         min(captured_at) t0, max(captured_at) t1, count(*) n,
         extract(epoch from (max(captured_at)-min(captured_at)))/3600.0 hours,
         sum(case when dt between 1 and 900 then spd*dt/3600.0 else 0 end) km,
         (array_agg(fuel_level_ml order by captured_at))[1]      l0,
         (array_agg(fuel_level_ml order by captured_at desc))[1] l1
  from b group by 1,2
), clean as (
  select r.*, (r.l0 - r.l1)/1000.0 litres from runs r
  where r.eng and r.n >= 10 and r.hours >= 0.33
    and r.l0 > r.l1 and (r.l0 - r.l1) between 300 and 200000
    and not exists (select 1 from fuel_fillings f
                    where f.vehicle_id=r.vehicle_id and f.filled_at between r.t0 and r.t1)
    and not exists (select 1 from fuel_thefts t
                    where t.vehicle_id=r.vehicle_id and t.began_at between r.t0 and r.t1)
)
select c.vehicle_id, count(*) runs,
       round((sum(c.litres)/nullif(sum(c.hours),0))::numeric,2) l_per_hour,
       round((sum(c.litres)/nullif(sum(c.km),0))::numeric,3)    l_per_km
from clean c group by 1 having count(*) >= 3 order by 2 desc;
```

## 7. What step 4 needs from this

1. ~~Persist per-vehicle rates~~ — **built.** `vehicle_fuel_rates`, refreshed
   weekly by `RATE_JOB`. It carries `primaryBasis` as well, so a row says which
   of its two figures is the machine's real one.
2. ~~Fall back per org and vehicle_type~~ — **built.** `resolveRates`, with
   `MIN_GROUP_CONTRIBUTORS` on top: a group of one or two machines wearing a
   type's name is dropped rather than served weakly.
3. Size the tolerance off the per-vehicle spread in §4, not off a single global
   percentage. A tractor whose own rate is known to ±30% cannot support a
   ±10% theft threshold.

   **Still open, and now the binding constraint.** `ANNOUNCE_MULTIPLE` remains
   an alert-volume choice rather than an accuracy one, because there is no
   labelled event set to tune against — median excess measures flat at 29–31 L
   from 1.5× to 50×, so no value on that axis buys better targeting. The same
   gap blocks two later decisions: whether the measured tank balance should
   outrank the derived rate in `resolveBand` (it agrees with a machine's own
   rate only 52% of the time within 1.5×), and whether the 16 SUKARI
   announcements retired by the consumption-basis change were true or false.
   Ground truth is the prerequisite for all three.
