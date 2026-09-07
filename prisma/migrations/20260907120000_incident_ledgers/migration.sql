-- Incident ledgers: what HAPPENED, as opposed to what is happening.
--
-- `vehicle_alerts` answers "is this unit in trouble right now" — syncFrameAlerts
-- opens and closes its rows every poll cycle, and that is what drives the
-- markers, the live feed and SSE. It cannot answer "how many times did KTCC 853B
-- speed last month, for how long, and how fast": the row carries the speed at
-- the instant it opened and nothing else, and it is closed the moment the unit
-- slows.
--
-- Sensor faults had no record at all. The live detector is a browser memo whose
-- `detectedAt` is when the PAGE RENDERED, and connection-state is deliberately
-- an in-memory map — neither can say when a fault began or when it cleared.
--
-- So: two write-once/close-once ledgers, and a daily rollup so month-over-month
-- survives the 90-day detail retention.
--
-- All three tables are created EMPTY, so their index builds take no meaningful
-- lock. The one statement at the bottom that touches an existing table is
-- discussed there.

-- CreateTable
CREATE TABLE "speeding_incidents" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "vehicle_type" TEXT,
    "driver_id" TEXT,
    "driver_name" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3) NOT NULL,
    "duration_sec" INTEGER NOT NULL,
    "peak_kmh" DOUBLE PRECISION NOT NULL,
    "avg_kmh" DOUBLE PRECISION,
    "limit_kmh" DOUBLE PRECISION NOT NULL,
    "limit_source" TEXT NOT NULL,
    "over_by_kmh" DOUBLE PRECISION NOT NULL,
    "frames" INTEGER NOT NULL,
    "distance_m" INTEGER,
    "start_lat" DOUBLE PRECISION,
    "start_lng" DOUBLE PRECISION,
    "peak_lat" DOUBLE PRECISION,
    "peak_lng" DOUBLE PRECISION,
    "end_lat" DOUBLE PRECISION,
    "end_lng" DOUBLE PRECISION,
    "day" DATE NOT NULL,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "speeding_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sensor_fault_episodes" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "recovered_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "duration_sec" INTEGER,
    "detail" TEXT NOT NULL,
    "observations" INTEGER NOT NULL DEFAULT 1,
    "evidence" JSONB,
    "day" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sensor_fault_episodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_incident_daily_stats" (
    "id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "speeding_count" INTEGER NOT NULL DEFAULT 0,
    "speeding_peak_kmh" DOUBLE PRECISION,
    "speeding_seconds" INTEGER NOT NULL DEFAULT 0,
    "speeding_distance_m" INTEGER NOT NULL DEFAULT 0,
    "fault_count" INTEGER NOT NULL DEFAULT 0,
    "fault_seconds" INTEGER NOT NULL DEFAULT 0,
    "fault_by_kind" JSONB,

    CONSTRAINT "vehicle_incident_daily_stats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "speeding_incidents_vehicle_id_started_at_key" ON "speeding_incidents"("vehicle_id", "started_at");
CREATE INDEX "speeding_incidents_organisation_id_started_at_idx" ON "speeding_incidents"("organisation_id", "started_at");
CREATE INDEX "speeding_incidents_vehicle_id_started_at_idx" ON "speeding_incidents"("vehicle_id", "started_at");
CREATE INDEX "speeding_incidents_organisation_id_day_idx" ON "speeding_incidents"("organisation_id", "day");
CREATE INDEX "speeding_incidents_driver_id_started_at_idx" ON "speeding_incidents"("driver_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "sensor_fault_episodes_vehicle_id_kind_started_at_key" ON "sensor_fault_episodes"("vehicle_id", "kind", "started_at");
CREATE INDEX "sensor_fault_episodes_organisation_id_started_at_idx" ON "sensor_fault_episodes"("organisation_id", "started_at");
CREATE INDEX "sensor_fault_episodes_vehicle_id_started_at_idx" ON "sensor_fault_episodes"("vehicle_id", "started_at");
CREATE INDEX "sensor_fault_episodes_organisation_id_kind_recovered_at_idx" ON "sensor_fault_episodes"("organisation_id", "kind", "recovered_at");
CREATE INDEX "sensor_fault_episodes_organisation_id_day_idx" ON "sensor_fault_episodes"("organisation_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_incident_daily_stats_vehicle_id_day_key" ON "vehicle_incident_daily_stats"("vehicle_id", "day");
CREATE INDEX "vehicle_incident_daily_stats_organisation_id_day_idx" ON "vehicle_incident_daily_stats"("organisation_id", "day");

-- AT MOST ONE OPEN EPISODE per (vehicle, kind).
--
-- Prisma cannot express a partial unique index, and this one is load-bearing
-- twice over: it is the concurrency guard between the poller and the 15-minute
-- sweep, and it is what lets "open or extend" be a single upsert instead of a
-- read-then-write race. Without it a unit whose GPS dies during a sweep can
-- collect a second open row for the same fault and never close either.
CREATE UNIQUE INDEX "sensor_fault_episodes_open_uniq"
    ON "sensor_fault_episodes" ("vehicle_id", "kind")
    WHERE "recovered_at" IS NULL;

-- AddForeignKey
ALTER TABLE "speeding_incidents" ADD CONSTRAINT "speeding_incidents_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "speeding_incidents" ADD CONSTRAINT "speeding_incidents_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "speeding_incidents" ADD CONSTRAINT "speeding_incidents_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sensor_fault_episodes" ADD CONSTRAINT "sensor_fault_episodes_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sensor_fault_episodes" ADD CONSTRAINT "sensor_fault_episodes_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_incident_daily_stats" ADD CONSTRAINT "vehicle_incident_daily_stats_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The one statement here that touches a table with rows in it.
--
-- findMaintenanceHistory (telemetry.repository) and the driver-conduct query
-- both filter `organisation_id` + a `triggered_at` range, and neither has ever
-- had an index for it — the existing two lead with `resolved_at`.
--
-- Built plainly rather than CONCURRENTLY, deliberately: this pipeline wrote its
-- first row on 2026-08-31 (the table was empty platform-wide before that), so
-- vehicle_alerts is days old and small, and the ACCESS EXCLUSIVE lock is
-- measured in milliseconds. If this table is ever large when a similar index is
-- added, use CREATE INDEX CONCURRENTLY instead — which cannot run inside a
-- transaction, so it has to be applied out of band rather than through Migrate.
CREATE INDEX "vehicle_alerts_organisation_id_triggered_at_idx" ON "vehicle_alerts"("organisation_id", "triggered_at");
