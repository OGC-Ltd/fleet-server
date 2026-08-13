-- Engine hours, and the fuel those hours are expected to have burned.
--
-- The day already carried distance and a distance-based expectation. For most
-- of this fleet that is not a model of anything: fuel-consumption-rates.md
-- records 215 of 310 probed units as plant or tractors, KASULU PLANT with its
-- engine on for 58.3% of samples but moving in only 19.3%, averaging 1.5 km/h.
-- Position FREEZES at speed 0 on this telemetry, so a working excavator reports
-- ~0 km while burning ~11 L/h — a distance model predicts no consumption for it
-- and the whole real burn presents as an unexplained drop.
--
-- So engine hours is the primary basis for every type; distance stays as the
-- secondary check on road vehicles, where the two agree. Both are expectations
-- and sit beside consumed_ml, which is what the tank actually did.
--
-- engine_seconds is a MEASUREMENT: the gap between consecutive fixes charged to
-- the earlier fix's engine state, capped at MAX_ENGINE_GAP_SECONDS (900) so a
-- unit that reports engine-on and goes silent for three hours cannot bank three
-- hours of running. That cap is the same 900 s that cuts a run in the rate
-- derivation, and the two must agree — integrating time one way and calibrating
-- it another puts a silent bias into the product.
--
-- engine_burn_ml is NULL, never 0, when neither the vehicle nor its type has a
-- measured rate. Zero would read as "burned nothing".

ALTER TABLE "fuel_daily_trends"
  ADD COLUMN "engine_seconds"  INTEGER,
  ADD COLUMN "engine_burn_ml"  INTEGER;

-- Per-vehicle consumption rates, refreshed weekly by fuel-rate.service.
--
-- Derived from engine-on RUNS containing no filling and no drain — never from
-- per-ping deltas, which accumulate probe noise into fictional consumption. A
-- drain must not calibrate the expectation it will later be compared against.
--
-- Kept in a table rather than computed per request because the derivation sorts
-- the full fuel-carrying telemetry window, and this instance has ~1 GB of RAM
-- for a 5.9 GB database. A consumption rate moves over weeks in any case.
--
-- window_days travels with the row: the published measurement used 3 days
-- because that is what the box survives, where 30 is what these should
-- eventually stand on, and a rate should say which it is.

CREATE TABLE "vehicle_fuel_rates" (
  "id"           TEXT NOT NULL,
  "vehicle_id"   TEXT NOT NULL,
  "l_per_hour"   DOUBLE PRECISION NOT NULL,
  "l_per_km"     DOUBLE PRECISION,
  "runs"         INTEGER NOT NULL,
  "window_days"  INTEGER NOT NULL,
  "derived_at"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "vehicle_fuel_rates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vehicle_fuel_rates_vehicle_id_key" ON "vehicle_fuel_rates"("vehicle_id");

ALTER TABLE "vehicle_fuel_rates"
  ADD CONSTRAINT "vehicle_fuel_rates_vehicle_id_fkey"
  FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
