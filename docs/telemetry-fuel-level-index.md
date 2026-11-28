# Tank-reading index on vehicle_telemetries

Migration `20261128120000_telemetry_fuel_level_partial_index` adds:

```sql
vehicle_telemetries_fuel_level_idx ON vehicle_telemetries (vehicle_id, captured_at)
  WHERE fuel_level_ml >= 1000
```

This page explains why the index is needed and how to build it on production without holding up ingest.

## Why

Some queries need a unit's first or last fixes that carry a tank reading over a range. They are:

- `edgeLevels` in `reports/range-reports.service.ts`, used by the Fuel Consumption Rate report and the Monthly report;
- the fuel before and after a shift in `planner/work-plans.service.ts`.

The `(vehicle_id, captured_at)` index cannot check the tank reading. So for a unit with no reading of at least 1 L in the range, Postgres reads every fix the unit has in the range, from each end. That happens when the unit has no probe, a dead probe, or a probe reading 0. A month of fixes is about 30,000 rows per unit.

On 28 Nov 2026, Aquamist's Fuel Consumption Rate hit the 55 s `statement_timeout` inside `edgeLevels` and came back as a 500. That happened for October (77 units, about a third with no readings) and for 20–27 Nov. The server log showed `canceling statement due to statement timeout` (code 57014) each time.

With the index:

- a unit with readings is answered from the first entries of its range;
- a unit without readings finds an empty range and stops at once.

**Measured on production (28 Nov, read-only).** KAU 374Y (Aquamist) has no readings. Over October, one direction of `edgeLevels` read and dropped 6,862 rows on 6,457 pages, almost one page per row. That took 1.8 s, nearly all of it disk reads. With two directions and about 26 such units, the October report needs roughly 95 s, against a 55 s limit.

**PGlite rehearsal.** On a partitioned copy of the table, the same lookup went from 20,070 rows read and dropped to none, and from 231 buffers to 6.

## Why not `prisma migrate deploy`

`vehicle_telemetries` is partitioned by month (see [telemetry-partitioning.md](telemetry-partitioning.md)). Postgres has two ways to index a partitioned table, and neither is safe here:

- A plain `CREATE INDEX` on the parent builds every partition's index under a lock that holds up ingest. On the 46 GB legacy partition that is many minutes.
- `CREATE INDEX CONCURRENTLY` is refused on a partitioned table.

So the runbook builds it in three parts:

1. The parent's index is made `ON ONLY`. This is instant, and the index starts out invalid.
2. Each partition's index is built `CONCURRENTLY`, and inserts carry on throughout.
3. Each partition's index is attached to the parent. Postgres marks the parent's index valid when the last one is attached.

The migration is then marked applied. Its `IF NOT EXISTS` makes it a no-op on production. On a new or small database it builds everything inline.

## Runbook (production)

**Order:** the PR contains no app code, so it can be merged before or after the build.

**When:** any time, but the quiet hour (about 02:00 UTC) is kindest to ingest.

**Connection:** use the tunnel and `DIRECT_URL`, not the pooler. On this PC, the `pg18-partman` Docker image provides `psql` (host `host.docker.internal:15432`).

**Before:** check free storage on the RDS instance (`FreeStorageSpace` in CloudWatch). Plan for about **8 GB** of new index, plus room for the build's sort files:

- About 75% of fixes carry a reading of at least 1 L (pg_stats, 28 Nov: 16% have no reading, the rest read under 1 L).
- The existing `(vehicle_id, captured_at)` index on the legacy partition is 11 GB, so this one will be about 75% of that.
- Each month adds about 0.4 GB.

```sh
psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f docs/telemetry-fuel-level-index.sql
npx prisma migrate resolve --applied 20261128120000_telemetry_fuel_level_partial_index
```

Run psql in autocommit mode: not `-1`, and not inside `BEGIN`. `CONCURRENTLY` cannot run in a transaction.

The script:

1. **Creates the parent's index `ON ONLY`.** This is instant and leaves the index invalid.
2. **Builds each partition's index `CONCURRENTLY`.** `\gexec` runs one statement per partition.
   - **Legacy partition:** this is the long one, with two passes over its 20 GB heap. Expect 10–20 minutes, like step 1 of the partitioning runbook.
   - **Monthly and default partitions:** seconds.
3. **Attaches each partition's index to the parent's.**
4. **Prints the check.** The parent should be `valid = t`, with one valid index per partition.

**What to watch:** ingest lag on Grafana. Inserts are never blocked by a lock, but they share the disk with the build.

**If it fails part-way:** a failed `CONCURRENTLY` build leaves an INVALID index behind.

1. Drop it: `DROP INDEX CONCURRENTLY vehicle_telemetries_legacy_fuel_level_idx`, or whichever one failed.
2. Run the script again. Every step skips what already exists.

**Partitions added later:** the nightly `telemetry:partitions` job attaches new months. Each new partition gets its own copy of the index when it is attached, as with every other index on the parent. This was rehearsed.

## Rollback

```sql
DROP INDEX vehicle_telemetries_fuel_level_idx;   -- drops the partitions' copies with it
```

Then delete the migration's row from `_prisma_migrations`, or leave it in place: the next deploy will not try to run it again.
