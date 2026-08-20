-- One row per vehicle per fleet day, carrying the probe figures the report
-- used to derive by scanning thirty days of vehicle_telemetries.
--
-- Cheap to create: a new empty table, no lock on anything hot, no index build
-- over 9.2M rows. The backfill (prisma/probe-stats.ts --days 30) fills it
-- afterwards, one day at a time, and can be interrupted and resumed.
CREATE TABLE "probe_daily_stats" (
    "id"            TEXT         NOT NULL,
    "vehicle_id"    TEXT         NOT NULL,
    "day"           DATE         NOT NULL,
    "pings"         INTEGER      NOT NULL,
    "level_pings"   INTEGER      NOT NULL,
    "peak_ml"       INTEGER,
    "last_alive_at" TIMESTAMP(3),
    "last_level_at" TIMESTAMP(3),
    "computed_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "probe_daily_stats_pkey" PRIMARY KEY ("id")
);

-- The job replaces a whole day at a time and the report reads a date RANGE
-- across every vehicle, so day leads here.
CREATE INDEX "probe_daily_stats_day_idx" ON "probe_daily_stats"("day");

-- One row per unit per day. The day-replace relies on this to keep a re-run
-- from doubling a day.
CREATE UNIQUE INDEX "probe_daily_stats_vehicle_id_day_key"
    ON "probe_daily_stats"("vehicle_id", "day");

ALTER TABLE "probe_daily_stats"
    ADD CONSTRAINT "probe_daily_stats_vehicle_id_fkey"
    FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
