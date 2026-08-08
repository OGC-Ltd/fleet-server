# Displacement recorded twice — the drain and the phantom refill

**Date:** 2026-08-05 · **Status:** DISCOVERY COMPLETE, nothing implemented
**Scope:** Wialon/Controltech fuel ledger — `fuel_thefts` and `fuel_fillings`
**Orgs:** KASULU (`cms0oo1n40000fwv7r1u4pg36`), SUKARI (`cmr6da1bp0000vzizby6z0dzw`)

Read-only throughout. No rule was changed, no row was written.

This answers an open question left by
[`analytics-fidelity-plan.md`](./analytics-fidelity-plan.md):

> *"Does Wialon report the recovery as a **filling**? If so both totals are
> inflated today, and the fix has to cancel a pair, not just suppress one row."*

---

## Verdict

**Yes.** When fuel displaces away from the probe and settles back, Wialon
records the drop as a **drain** and the return as a **filling**. Both rows enter
the ledger. The drain inflates reported loss; the filling inflates reported
consumption.

Worse, the phantom filling **blocks the existing adjudicator**. The recovery
test in `fuel-adjudication.ts` disqualifies a drain that has a filling in its
window (`filling-too-soon`), so the very event that proves the fuel came back is
what prevents it being ruled `REDISTRIBUTION`. Those drains fall through to
`UNVERIFIED` — and `/analytics/fuel-cost` counts everything except
`REDISTRIBUTION` as lost.

---

## Why this matters to the Analytics page

`analytics.repository.ts` (`fuelConsumption`) sums
`verdict: { not: 'REDISTRIBUTION' }`. So the endpoint's "fuel lost" is
`LOSS + UNVERIFIED + PENDING` — **91% of the raw provider claim on KASULU and
96% on SUKARI** over 30 days. Adjudication removes only the small
`REDISTRIBUTION` slice.

Any chart plotting that field is plotting the provider's unfiltered claim under
a trustworthy-looking label. **Do not build a "fuel lost" number on it.**

---

## Finding 1 — the mirror signature

A displacement pair has an unmistakable shape: a drain **A→B**, then within
minutes a filling **B→~A** of comparable volume, ending at the level the tank
started from. Real examples, 30-day window:

```
MUFINDI - DG 11   DRAIN 30 Jul 17:38   884.0L → 225.0L  = -659.0L  speed 0
                  FILL  30 Jul 17:44   225.0L → 884.0L  = +659.0L  (+6 min)
                  net 0.0L vs start                     [UNVERIFIED -> counted as lost]

MUFINDI: EX 04    DRAIN 07 Jul 21:54   336.4L → 212.1L  = -124.3L  speed 0
                  FILL  07 Jul 22:01   212.1L → 336.3L  = +124.2L  (+6 min)
                  net -0.1L vs start                    [UNVERIFIED -> counted as lost]

MUFINDI: EX 04    DRAIN 13 Jul 17:28   380.0L → 283.1L  = -96.9L   speed 0
                  FILL  13 Jul 18:06   283.1L → 380.0L  = +96.9L   (+38 min)
                  net 0.0L vs start                     [UNVERIFIED -> counted as lost]
```

659 litres "siphoned and refuelled" in six minutes, ending at exactly the
starting level, is not a fuel event.

## Finding 2 — SUKARI has a different fault with the same shape

SUKARI's largest pairs are not slosh. The probe **reads zero and recovers**:

```
SINO ZZ4257V344JB1R  DRAIN 15 Jul 13:48   98.7L → 0.0L   = -98.7L
                     FILL  15 Jul 14:19    0.0L → 99.3L  = +99.3L  (+31 min)

Faw Prime Mover      DRAIN 04 Aug 12:29   74.3L → 0.0L   = -74.3L
                     FILL  04 Aug 12:45    0.0L → 74.1L  = +74.1L  (+14 min)

SINO ZZ4257V344JB1R  60.0L → 0.0L → 60.0L → 0.0L → 60.4L   (twice, 8 min apart)
```

A dropout to zero, not a displacement. Same treatment (the fuel never moved),
but a different root cause: this is **sensor failure**, and it explains why
`analytics-fidelity-plan.md` found 52% of SUKARI's pending drains had zero
fuel-level readings around the event.

**This is a hardware problem and should be raised with the installer.**

## Finding 3 — it concentrates in a few units

Both orgs are dominated by a handful of vehicles. `MUFINDI: EX 04` alone is 5 of
KASULU's 8 largest pairs over 30 days, and 7 pairs in August.

A per-vehicle probe-health view would likely catch more than any threshold, and
these specific trackers are worth listing for the installer regardless.

---

## Impact — measured

### Trailing 30 days (as of 2026-08-05)

| | UNVERIFIED | LOSS | REDISTRIBUTION | reported lost |
|---|---|---|---|---|
| KASULU | 68.6% · 40,962 L | 22.3% · 13,296 L | 9.2% · 5,474 L | 54,273 L |
| SUKARI | 88.5% · 20,229 L | 7.7% · 1,766 L | 3.8% · 876 L | 21,995 L |

Provably-returned fuel sitting inside the reported loss figure:
**2,448 L (KASULU)** and **2,051 L (SUKARI)**.

### August 2026 only (01–04 Aug, 4 days)

| | UNVERIFIED | LOSS | REDISTRIBUTION | reported lost |
|---|---|---|---|---|
| KASULU | 44.8% · 7,832 L | 35.2% · 6,161 L | **20.0%** · 3,508 L | 13,993 L |
| SUKARI | 39.1% · 826 L | 38.6% · 815 L | **22.3%** · 472 L | 1,641 L |

**The live adjudication pass is working far better than the backfill — this
confirms a prediction `analytics-fidelity-plan.md` left open.** That document
recorded 76% `UNVERIFIED` after the backfill and said:

> *"The live pass should do better than this... That is a prediction, not a
> result — worth checking against the ledger in a week."*

Checked. On events judged live in August, `REDISTRIBUTION` rises from 9.2%/3.8%
to **20.0%/22.3%**, and `UNVERIFIED` falls from 68.6%/88.5% to **44.8%/39.1%**.
SUKARI improves most, which is the opposite of what the 30-day figures suggest.

Mirror pairs in August: **20 (KASULU, 500 L, 3.6% of reported loss)** and
**10 (SUKARI, 165 L, 10.1%)**. The share is lower than over 30 days precisely
because the live recovery test is already catching more of them.

---

## Proposed rule — NOT implemented

**Decide on return-to-start, not on volume equality.**

The first attempt required the refill volume to match the drain volume within
20%. The sample showed that is the weak test — several pairs return to *exactly*
the starting level while the volumes differ, because the level drifted further
down between the drain and the refill:

```
EX 04  -74.1L then +108.8L   return err 0.0%  net 0.0L   <- excluded by volume test
EX 04  -73.3L then  +89.8L   return err 0.0%  net 0.0L   <- excluded by volume test
```

Accepted pairs also show a small net deficit — displacement *plus* a few litres
genuinely burned while the machine idled — so a modest deficit must be forgiven
rather than disqualifying.

### The rule

For a drain `D` and a filling `F` on the same vehicle, where
`F.filledAt` is within **120 minutes** after `D.detectedAt`:

```
net  = F.finalFuelLevelMl - D.initialFuelLevelMl
tol  = max(3 L, D.initialFuelLevelMl * RET)
match if:  net <= tol  AND  net >= -(tol + D.stolenMl * BURN)
```

`RET = 0.03` (3%), `BURN = 0.25` (25%). **These are choices, not measurements**
— the same caveat `analytics-fidelity-plan.md` makes about `RECOVERY_THRESHOLD`.

### Sweep, 30-day window

| | ret / burn | pairs | loss reclaimed | consumption corrected |
|---|---|---|---|---|
| KASULU | 2% / 0% | 54 | 2,477 L (4.6%) | 2,964 L (1.4%) |
| | **3% / 25%** | **83** | **3,620 L (6.7%)** | **4,064 L (1.9%)** |
| | 8% / 40% | 93 | 4,190 L (7.7%) | 4,496 L (2.1%) |
| SUKARI | 2% / 0% | 87 | 1,736 L (7.9%) | 1,992 L (2.0%) |
| | **3% / 25%** | **123** | **2,895 L (13.2%)** | **2,951 L (3.0%)** |
| | 8% / 40% | 158 | 4,010 L (18.2%) | 3,710 L (3.7%) |

No cliff: the loosest setting is under twice the tightest. 3%/25% sits in the
knee.

At KES 179.36/L, 3%/25% removes roughly **KES 1.17M per month** across both orgs
from reported loss.

### Safety — why it cannot swallow a genuine refuel

1. **Structural.** A real refuel *overshoots* the pre-drain level. Return-to-
   start rejects it by construction.
2. **Control group.** 1,285 (KASULU) and 2,918 (SUKARI) fillings have no drain
   before them and are untouchable by the rule. **Every one raises the tank
   level**, as a refuel should. Median genuine refuel: 119.9 L / 22.9 L.
3. **No drift under loosening.** Counting caught fillings above 60% of tank
   capacity — the depot-refuel signature — gives **1 (KASULU) / 3 (SUKARI)** and
   that count is **flat across every tolerance setting**. A rule sliding into
   real refuels would show that number climbing.

### Design, if adopted

Following `analytics-fidelity-plan.md`'s "adjudicate, do not delete":

1. Drain → `REDISTRIBUTION`, with a distinct `verdictReason` (e.g.
   `mirrored-filling`) so it is separable from recovery-test verdicts.
2. Filling flagged so `fuelConsumption` excludes it. **Needs a new column** —
   `fuel_fillings` has no status field today.
3. Both rows kept, so the rule stays auditable against Wialon.
4. Dry run over history before applying.

---

## Not addressed here

- **Stationary engine-on plant burn.** 79–83% of even the adjudicated `LOSS`
  litres begin at speed 0, and 250 of KASULU's 275 `LOSS` rows are `PLANT`
  (excavators, dozers). This is Signal 2 of `analytics-fidelity-plan.md`, which
  was proposed and never implemented — `fuel-adjudication.ts` contains **no
  speed logic at all**. It is a larger effect than the mirror problem and needs
  its own decision: is engine-on stationary burn a loss, or consumption?
- **`UNVERIFIED` treated as lost by the endpoint.** Independent of both rules.
- **Six KASULU units the token cannot report on** (`Access denied (7)`) — their
  fuel is absent from every figure. See `fuel-ledger-fidelity.md`.
- `/analytics/fuel-cost` **is now deployed**, contrary to Finding 5 of
  `fuel-ledger-fidelity.md`, which is stale on that point.

---

## Reproducing this — runbook

The box has no GitHub credentials and runs `dist/`, not `src/`. All of the below
is read-only.

### 1. Connect

```bash
ssh -i keys/logistics.pem ubuntu@ec2-18-232-178-169.compute-1.amazonaws.com
```

The public DNS rerolls on stop/start — check the current host if this fails.

### 2. Make node visible

`bash -lc` does **not** load nvm over ssh; `node`, `npm` and `pm2` all report
"command not found". Prefix every command:

```bash
export PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH
cd /home/ubuntu/prod/fleet-server
```

### 3. Do NOT use the `npm run` wrappers

Every `prisma/*` script in `package.json` is
`cross-env DOTENV_CONFIG_PATH=.env.example tsx …`, and `.env.example`'s
`DATABASE_URL` points at `localhost:15432` — the dev SSH tunnel, which does not
exist on the box. Run node directly so dotenv falls back to the real `.env`:

```bash
node --env-file=.env <script>.mjs
```

Import from `dist/`, never from `generated/prisma` (TypeScript sources, not a
loadable client).

### 4. Verdict split for a window

```bash
node --env-file=.env --input-type=module -e '
import { prisma } from "./dist/src/lib/prisma.js";
const FROM = new Date("2026-07-31T21:00:00Z");   // 01 Aug 00:00 EAT
for (const [n,org] of [["KASULU","cms0oo1n40000fwv7r1u4pg36"],["SUKARI","cmr6da1bp0000vzizby6z0dzw"]]) {
  const rows = await prisma.fuelTheft.groupBy({
    by:["verdict"], where:{ vehicle:{organisationId:org}, beganAt:{gte:FROM} },
    _count:{_all:true}, _sum:{stolenMl:true} });
  console.log("===", n, "===");
  for (const r of rows) console.log(" ", r.verdict.padEnd(15),
    String(r._count._all).padStart(5), "drains",
    String(Math.round((r._sum.stolenMl||0)/1000)).padStart(7), "L");
}
process.exit(0)'
```

### 5. Full mirror analysis

Copy `scripts/fuel-mirror.mjs` (below) to the box and run it. It takes an
optional window:

```bash
node --env-file=.env /tmp/fuel-mirror.mjs                              # current month
node --env-file=.env /tmp/fuel-mirror.mjs 2026-07-05T21:00:00Z         # from a date
```

Getting a local file onto the box without scp:

```bash
B64=$(base64 -w0 fuel-mirror.mjs)
ssh -i keys/logistics.pem ubuntu@<host> "echo $B64 | base64 -d > /tmp/fuel-mirror.mjs"
```

The script is reproduced in full in the appendix so it can be recreated from
this document alone.

### 6. Reading the output

- **`REDISTRIBUTION` share rising** over recent windows = the live adjudication
  pass is healthy.
- **`UNVERIFIED` above ~60%** = telemetry coverage is the limiting factor, not
  the rule. Check the fuel channel before tuning anything.
- **`worst offenders`** = candidate probe faults. A unit appearing repeatedly is
  a hardware conversation, not a threshold conversation.

---

## Appendix — `scripts/fuel-mirror.mjs`

```js
import { prisma } from '/home/ubuntu/prod/fleet-server/dist/src/lib/prisma.js'

const FROM = new Date(process.argv[2] ?? '2026-07-31T21:00:00.000Z')  // 01 Aug 00:00 EAT
const TO   = new Date(process.argv[3] ?? Date.now())
const WIN  = 120     // minutes after a drain to look for the mirror
const RET  = 0.03    // tank must return within 3% of its pre-drain level
const BURN = 0.25    // forgive this fraction of the drain as genuine burn

const L = ml => (ml / 1000).toFixed(1)
const ORGS = [['KASULU', 'cms0oo1n40000fwv7r1u4pg36'], ['SUKARI', 'cmr6da1bp0000vzizby6z0dzw']]

for (const [name, org] of ORGS) {
  const drains = await prisma.fuelTheft.findMany({
    where: { vehicle: { organisationId: org }, beganAt: { gte: FROM, lte: TO } },
    select: { vehicleId: true, detectedAt: true, stolenMl: true, verdict: true,
              initialSpeedKmh: true, initialFuelLevelMl: true, finalFuelLevelMl: true,
              vehicle: { select: { name: true, vehicleType: true, tankCapacityLitres: true } } },
  })
  const fills = await prisma.fuelFilling.findMany({
    where: { vehicle: { organisationId: org }, filledAt: { gte: FROM, lte: TO } },
    select: { vehicleId: true, filledAt: true, filledMl: true,
              initialFuelLevelMl: true, finalFuelLevelMl: true },
  })
  const byVeh = new Map()
  for (const f of fills) { if (!byVeh.has(f.vehicleId)) byVeh.set(f.vehicleId, []); byVeh.get(f.vehicleId).push(f) }
  for (const a of byVeh.values()) a.sort((x, y) => x.filledAt - y.filledAt)

  const totalFill = fills.reduce((s, f) => s + f.filledMl, 0)
  const lost = drains.filter(d => d.verdict !== 'REDISTRIBUTION').reduce((s, d) => s + d.stolenMl, 0)

  const used = new Set(), hits = []
  for (const d of drains) {
    if (d.initialFuelLevelMl == null) continue
    const cands = (byVeh.get(d.vehicleId) ?? []).filter(f =>
      !used.has(f) && f.filledAt >= d.detectedAt && f.filledAt - d.detectedAt <= WIN * 60000)
    const hit = cands.find(f => {
      if (f.finalFuelLevelMl == null) return false
      const net = f.finalFuelLevelMl - d.initialFuelLevelMl
      const tol = Math.max(3000, d.initialFuelLevelMl * RET)
      return net <= tol && net >= -(tol + d.stolenMl * BURN)
    })
    if (hit) { used.add(hit); hits.push({ d, f: hit }) }
  }

  const reclaimed = hits.filter(h => h.d.verdict !== 'REDISTRIBUTION').reduce((s, h) => s + h.d.stolenMl, 0)
  const excluded  = hits.reduce((s, h) => s + h.f.filledMl, 0)
  console.log(`${name}: ${drains.length} drains, reported lost ${L(lost)} L, filled ${L(totalFill)} L`)
  console.log(`  ${hits.length} mirrored pairs · reclaim ${L(reclaimed)} L of loss · exclude ${L(excluded)} L of fillings`)

  const worst = {}
  for (const h of hits) {
    const k = h.d.vehicle.name ?? '?'
    worst[k] = worst[k] ?? { n: 0, ml: 0 }
    worst[k].n++; worst[k].ml += h.d.stolenMl
  }
  for (const [v, o] of Object.entries(worst).sort((a, b) => b[1].ml - a[1].ml).slice(0, 6)) {
    console.log(`    ${v.slice(0, 28).padEnd(28)} ${String(o.n).padStart(3)} pairs · ${L(o.ml)} L`)
  }
}
process.exit(0)
```

---

## Next

1. **Decide the stationary-plant-burn question** — it is the larger effect and
   blocks an honest fuel page on its own.
2. Implement the mirror rule at 3%/25% behind a dry run, if adopted.
3. Raise with the provider/installer: SUKARI's zero-dropout probes, and the
   named units in `worst offenders`.
4. Only then build the Analytics fuel page — consumption first, and never a
   single "fuel lost" number that hides `UNVERIFIED`.
