# Fuel theft detection — where this stands

Written 2026-08-11 as a handover. Read this before touching the fuel pipeline.

---

## The one thing to understand first

**Everything currently deployed reasons in DELTAS. Nothing knows the absolute
tank state, and that is the biggest gap in the design.**

Raised by the operator against `MUFINDI: DZ 07`, whose drains read:

```
-61.7 L   -51.6 L   +51.6 L   +23.9 L   -23.7 L      20:57 -> 21:52
```

Fuel that comes back was never gone. A dozer on undulating ground with a
part-full tank moves fuel off and onto the probe exactly like that. Their words:
*"without the original tank state you cannot make a decision on if this is a
theft or not."* That is correct and it is upstream of every rule below — the
recovery ratio, `OBSERVED_DROP_MIN_RATIO` and the median filter all measure
change against change. A 60 L swing on a near-empty tank is what a probe does on
a slope; the same swing on a full tank is not, and none of the code can tell.

Note the distinction from earlier work: §"Why the level series and nothing else"
in `modules/fuel/fuel-adjudication.ts` records that **fill fraction failed as a
CLASSIFIER** (0.62 vs 0.63 on KASULU, inverted on SUKARI). That is a different
claim. Fill fraction is being proposed here as a **trust gate** — a precondition
for the reading meaning anything — which was never tested.

Blocker: tank capacity is not held per vehicle. It is derivable — the observed
max `fuel_level_ml` per vehicle over a long window is a sound proxy — and that
turns every absolute reading into a fill fraction.

## Deployed and live

| commit | what |
| --- | --- |
| `e89cdcf` | `SENSOR_FAULT` verdict; dead-probe gate; 3-sample median filter |
| `d87859d` | drains described as "suspicious", never "lost" |
| `c1c365e` (dash) | "Confirmed" -> "Suspicious" across the drains UI |

Migration `20260811020000_add_sensor_fault_verdict` is **applied** on prod; the
enum reads `PENDING, LOSS, REDISTRIBUTION, UNVERIFIED, SENSOR_FAULT`.

## Why the dashboard did not change — READ THIS BEFORE DEBUGGING

`fuel-adjudication.service.ts` selects `where: { verdict: 'PENDING' }`. Every
drain is judged exactly once and never revisited:

```
UNVERIFIED 1719   LOSS 599   REDISTRIBUTION 237   PENDING 1
```

So 2,554 of 2,555 rows can never be re-judged, and none of the new rules reach
them. DZ 07 is one of these: it was already reclassified
`LOSS -> REDISTRIBUTION` in the median-filter backtest, so the deployed code
agrees with the operator about that unit — it simply has no way to revisit the
row.

**A backfill is the missing piece**, and it is the fastest way to make any of
this visible. Bound it to a window where telemetry still exists; re-judging
older drains would degrade them to `UNVERIFIED` when the level series has aged
out, which is worse than leaving them.

## Measured facts worth not re-deriving

- **Probes.** 37 of 298 (12.4%) sit at exactly zero. 27 of those have never
  produced a theft or filling row despite 154 fillings against them — a silent
  blind spot, not a noisy one. Five fell to zero inside one day, from as high as
  256 L. `KDL 182X` reached the ledger as a 55 L "theft", 55 L -> 0 L.
- **Motion gating is not worth building.** Slosh is real but ~1.4 L at p95,
  under any sane threshold, and only 4-5% of drain-window samples show motion.
  57-90% of drains are fully static. Tested both against verdicts and against
  raw noise; see the git history of this session.
- **Consumption must be engine-hours, not km.** 215 of 310 probed units are
  plant or tractors. KASULU PLANT averages 1.5 km/h and 7.361 L/km. Rates are in
  `fuel-consumption-rates.md`; per-vehicle is required, spread within a type
  reaches 4.1x.
- **Impact of what shipped is small and honestly so.** Median filter moves 15 of
  833 verdicts (1.8%, net 51 L). Dead-probe gate clears 4 drains, 149 L.

## Next, in order

1. **Backfill** the existing drains (see above). Nothing else becomes visible
   until this exists.
2. **Tank state.** Derive capacity per vehicle from observed max; carry fill
   fraction at drain time into the verdict as a TRUST GATE. A part-full tank on
   a machine working slopes should not yield a confident verdict either way.
3. **`fsl_dead` alert.** The 27 silent probes still read as monitored units with
   clean records. A verdict cannot fix this — they never generate a drain. It
   needs an alert so they get repaired.
4. **Then** the originating detector (settle-time baselines, threshold,
   expected-consumption reconciliation) on a level series that can be
   interpreted.

## Not shipped, deliberately

Five files carry uncommitted gate-arrival work (`yard-departure.ts`,
`telemetry.worker.ts`, `raifactorysuite-events.service.ts` and two tests). It is
complete and tested but was never committed, pending observation of real gate
crossings. Do not sweep it into an unrelated commit.
