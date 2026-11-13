SET lock_timeout = '5s';

-- Idle alerts kept (operator, 2026-11-13): one row per idle stop the idle
-- watch raised, open while the unit stands, ended when it moves. The Alerts
-- page lists past ones from here. New table only; nothing existing changes.
CREATE TABLE IF NOT EXISTS "idle_episodes" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "plate" TEXT NOT NULL,
    "size" TEXT NOT NULL DEFAULT '',
    "designation" TEXT NOT NULL DEFAULT '',
    "since" TIMESTAMP(3) NOT NULL,
    "since_exact" BOOLEAN NOT NULL DEFAULT true,
    "alerted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "idle_minutes" INTEGER NOT NULL DEFAULT 0,
    "standing_minutes" INTEGER NOT NULL DEFAULT 0,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "place" TEXT,
    "place_metres" INTEGER,
    "engine_on" BOOLEAN,
    CONSTRAINT "idle_episodes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "idle_episodes_key_key" ON "idle_episodes"("key");
CREATE INDEX IF NOT EXISTS "idle_episodes_organisation_id_since_idx" ON "idle_episodes"("organisation_id", "since");
CREATE INDEX IF NOT EXISTS "idle_episodes_organisation_id_ended_at_idx" ON "idle_episodes"("organisation_id", "ended_at");
