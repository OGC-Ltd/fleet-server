# Partitioning vehicle_telemetries by month

Migration `20261125120000_partition_vehicle_telemetries`. This page is the runbook for applying it to production, and the record of the rehearsal.

## What changes

`vehicle_telemetries` becomes a table partitioned by `RANGE (captured_at)`, with one partition per UTC month:

| Partition | Holds |
|---|---|
| `vehicle_telemetries_legacy` | the existing 46 GB table, renamed, everything before the cut-over instant |
| `vehicle_telemetries_pYYYYMM` | one month (the first one starts at the cut-over instant, not on the 1st) |
| `vehicle_telemetries_default` | fixes outside every month; should stay empty |

Nothing is copied. The old table is attached as it is, so the cut-over takes about a second whatever its size. Nothing is ever dropped either: there is no retention.

The app reads and writes the parent as before. Prisma does not model partitions, and the partitions are not drift: `prisma migrate diff` against the rehearsal database showed nothing for this table. The only key change is that the primary key is now `(id, captured_at)`, because a partitioned table's key must include the partition column. `id` stays unique on its own, since it comes from one sequence.

The nightly maintenance queue runs `telemetry:partitions` at 02:05 UTC (`lib/telemetry-partitions.ts`). It calls the database function `vehicle_telemetries_ensure_partitions(3)`, which:

- keeps three months of partitions ahead;
- moves any stray rows out of the default partition into the month it creates for them.

It logs an **error** whenever the default partition holds rows. That means a tracker clock is wrong, or the job has stopped running. Before the migration is applied, the job does nothing.

## Why

On 24 Nov 2026, new fixes were landing in holes that rewrites had left in old pages. An hour of fixes sat on 41,965 pages instead of about 1,900, and every "today" query read 25× the pages it needed. #149 stopped the rewrites. Partitioning makes the fix structural: new rows can only land in the current partition, which nothing rewrites or deletes from.

## Why monthly, not daily

About ten queries ask for a vehicle's newest fix with no lower bound on `captured_at`:

- the fleet snapshot and its "last moved" lookup;
- work plans;
- movement events;
- odometer-at;
- the probe report.

Postgres answers each of these with a Merge Append that probes every partition. With 12 partitions a year that is cheap. With 365 it would not be.

## Runbook (production)

**Order:** merge the code first. The job and the Prisma change are harmless on the plain table.

**Timing:** run everything in one sitting, starting in the quiet hour (about 02:00 UTC).

**The cut-over instant (`B`):** use the start of the next fleet day, 21:00 UTC on the same date. Fleet days start at 21:00 UTC, so "today" queries will then read only the new partition from the first full fleet day.

**Connection:** use the tunnel and `DIRECT_URL`, not the pooler. On this PC, the `pg18-partman` Docker image provides `psql` (host `host.docker.internal:15432`).

### Step 1: index `(id, captured_at)`, concurrently

```sql
SET maintenance_work_mem = '1GB';
CREATE UNIQUE INDEX CONCURRENTLY vehicle_telemetries_id_captured_at_key
  ON vehicle_telemetries (id, captured_at);
```

- **What it costs:** two passes over the 20 GB heap and about 3 GB of new index. Expect 10–20 minutes. Inserts are never blocked by a lock, but they compete with it for disk: in the rehearsal they waited on WAL flushes (`WalSync`), not on locks.
- **What to watch:** ingest lag on Grafana. The app's 55 s `statement_timeout` is far above anything seen.
- **If it fails:** it leaves an INVALID index behind. Drop it (`DROP INDEX CONCURRENTLY vehicle_telemetries_id_captured_at_key`) and run the step again.

### Step 2: mark the legacy range, then validate it

```sql
ALTER TABLE vehicle_telemetries ADD CONSTRAINT vehicle_telemetries_legacy_range
  CHECK (captured_at < 'YYYY-MM-DD 21:00') NOT VALID;          -- B
ALTER TABLE vehicle_telemetries VALIDATE CONSTRAINT vehicle_telemetries_legacy_range;
```

- **Locking:** VALIDATE reads the table once, under a lock that lets inserts through.
- **Step 3 must follow before `B`.** From `B` on, this check refuses every new fix until the cut-over.
- **If you stop here:** run `ALTER TABLE vehicle_telemetries DROP CONSTRAINT vehicle_telemetries_legacy_range`.

### Step 3: the cut-over (about 1 s)

```sh
psql "$DIRECT_URL" -1 -v ON_ERROR_STOP=1 \
  -f prisma/migrations/20261125120000_partition_vehicle_telemetries/migration.sql
npx prisma migrate resolve --applied 20261125120000_partition_vehicle_telemetries
```

- **Locking:** the migration sets `lock_timeout = 5s`. If it can't get the table, it fails cleanly without changing anything; run it again.
- **Refusals:** it won't run without steps 1 and 2. It also refuses when the check is not yet validated.

### Step 4: statistics and a look

```sql
ANALYZE vehicle_telemetries;                      -- the parent's own statistics
SELECT c.relname, pg_get_expr(c.relpartbound, c.oid)
  FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
 WHERE i.inhparent = 'vehicle_telemetries'::regclass ORDER BY 1;
-- after B: new fixes are in the first monthly partition
SELECT tableoid::regclass, count(*) FROM vehicle_telemetries
 WHERE captured_at > now() AT TIME ZONE 'UTC' - interval '10 minutes' GROUP BY 1;
```

### Rollback

Rehearsed; it took 0.5 s with a handful of rows after `B`. Every fix stored since the cut-over is copied back into the old table **while the lock is held**, so the rollback is cheap only in the first hours. After a few days it means minutes of blocked ingest.

```sql
SET lock_timeout = '5s';
BEGIN;
LOCK TABLE vehicle_telemetries IN ACCESS EXCLUSIVE MODE;
ALTER TABLE vehicle_telemetries DETACH PARTITION vehicle_telemetries_legacy;
INSERT INTO vehicle_telemetries_legacy SELECT * FROM vehicle_telemetries;
ALTER SEQUENCE vehicle_telemetry_id_seq OWNED BY vehicle_telemetries_legacy.id;
DROP TABLE vehicle_telemetries;
ALTER TABLE vehicle_telemetries_legacy RENAME TO vehicle_telemetries;
ALTER TABLE vehicle_telemetries RENAME CONSTRAINT vehicle_telemetries_legacy_pkey TO vehicle_telemetries_pkey;
ALTER INDEX vehicle_telemetries_legacy_device_id_captured_at_key  RENAME TO vehicle_telemetries_device_id_captured_at_key;
ALTER INDEX vehicle_telemetries_legacy_vehicle_id_captured_at_idx RENAME TO vehicle_telemetries_vehicle_id_captured_at_idx;
ALTER INDEX vehicle_telemetries_legacy_captured_at_idx            RENAME TO vehicle_telemetries_captured_at_idx;
ALTER INDEX vehicle_telemetries_legacy_moving_idx                 RENAME TO vehicle_telemetries_moving_idx;
COMMIT;
```

The primary key stays `(id, captured_at)`, which still matches the Prisma schema, so the code doesn't need reverting.

## Rehearsal, 2026-11-25

The rehearsal ran on PostgreSQL 18.7 in Docker. The schema was production's own, copied with `pg_dump --schema-only`. The data was 7.15 M synthetic fixes (300 units, Aug–Nov, 1.8 GB), with pgbench inserting 20 fixes/s throughout.

- **Unprepared run:** the migration refused, and the table was untouched. The same happened with an unvalidated check.
- **Timings:** step 1 took 22–26 s, step 2 1.1 s, and the cut-over 0.66–0.82 s.
- **Ingest during the cut-over:** no insert over 100 ms. During step 1, inserts queued behind WAL flushes, which are slow on Docker's disk.
- **Adopted, not rebuilt:** all five old indexes and the foreign key were attached to the parent's. The sequence moved to the parent.
- **Routing:**
  - 20:59:59 goes to legacy, and 21:00:00 to the first new partition.
  - A duplicate `(device_id, captured_at)` is ignored, both with `ON CONFLICT` and with Prisma's `upsert`.
  - A 2031 fix goes to the default partition, and the job reports it as an error.
  - A March 2027 stray was moved into its month when that partition was created.
  - An unknown vehicle is still refused by the foreign key.
- **Plans:**

  | Query | Time |
  |---|---|
  | Snapshot newest fix + last moved, 300 units | 21 ms |
  | "Today" for 300 units | 12 ms (only partitions that can hold today are read) |
  | Dispatch last fix with a join-dependent `since` | 1.2 ms |

- **Prisma:** `migrate diff` showed nothing for `vehicle_telemetries`. The upsert and the job worked through the app's own client.
- **Rollback:** 0.5 s, back to a plain table.
