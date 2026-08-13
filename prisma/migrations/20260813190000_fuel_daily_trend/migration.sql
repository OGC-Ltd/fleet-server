-- Daily fuel trend per vehicle — for TREND LOGGING, never for theft detection.
--
-- Asked for by the operator: "during motion we tend to have fluctuation in fuel
-- either drops or fills, but these for the most part are often slosh artefact
-- which we need to use the data to maintain a moving average but not for theft
-- detection but for trend logging."
--
-- A moving average has to be KEPT to be a trend. Until now turbulence was
-- recomputed on every page load and thrown away, so nothing could be compared
-- across days: a probe whose slosh is drifting upward over weeks — which is the
-- thing worth knowing about a mounting or a baffle — was invisible.
--
-- One row per vehicle per FLEET day (Kenyan, not UTC — see lib/provider-time).
-- The closing level is the same figure the FSL table shows, so a day's row and
-- the table agree, and one day's closing_ml is the next day's opening_ml.
--
-- Nothing in modules/fuel/fuel-adjudication reads this table and nothing should.
-- The drain rules have their own probe instrument, measured while PARKED
-- (getProbeProfile). Feeding a motion-slosh average into a theft verdict would
-- let a machine excuse its own drains by working rough ground.

CREATE TABLE "fuel_daily_trends" (
    "id"             TEXT NOT NULL,
    "vehicle_id"     TEXT NOT NULL,
    -- The fleet day this row describes, at 00:00 EAT.
    "day"            DATE NOT NULL,
    "opening_ml"     INTEGER,
    "closing_ml"     INTEGER,
    "consumed_ml"    INTEGER,
    -- Mean level range per 30-min window while MOVING. Slosh, not fuel moved.
    "turbulence_ml"  INTEGER,
    -- How many moving windows the average was taken over, so a figure built on
    -- one window is not read as confidently as one built on eight.
    "motion_windows" INTEGER NOT NULL DEFAULT 0,
    "computed_at"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fuel_daily_trends_pkey" PRIMARY KEY ("id")
);

-- One row per vehicle per day; the daily job upserts on it.
CREATE UNIQUE INDEX "fuel_daily_trends_vehicle_id_day_key"
    ON "fuel_daily_trends" ("vehicle_id", "day");

-- "Show me this vehicle's slosh over the last N days" — the trend query.
CREATE INDEX "fuel_daily_trends_vehicle_id_day_idx"
    ON "fuel_daily_trends" ("vehicle_id", "day" DESC);

-- "Show me the whole fleet for a day".
CREATE INDEX "fuel_daily_trends_day_idx" ON "fuel_daily_trends" ("day");

ALTER TABLE "fuel_daily_trends" ADD CONSTRAINT "fuel_daily_trends_vehicle_id_fkey"
    FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
