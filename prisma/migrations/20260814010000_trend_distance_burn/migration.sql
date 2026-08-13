-- Ground covered, and the fuel the engine is expected to have burned over it.
--
-- Asked for by the operator: mileage in km, and "for every 2KM we expect 1L
-- usage" (KM_PER_LITRE = 2).
--
-- Distance is summed from the position fixes — there is no odometer on
-- vehicle_telemetries — dropping hops over MAX_HOP_KM, which at a 30-second
-- ping would be over 600 km/h and are GPS jumps rather than travel.
--
-- expected_burn_ml is an EXPECTATION, not a measurement, and 2 km/L cannot be
-- right for every unit here: fuel-consumption-rates.md records 215 of 310
-- probed units as plant or tractors, KASULU PLANT at 1.5 km/h and 7.361 L/km,
-- and a 4.1x spread within a single vehicle type. A dozer clearing a face burns
-- fuel while covering no ground, so its expected burn reads near zero against a
-- real consumption. That gap is the useful part — it sits beside consumed_ml,
-- which is what the tank actually did — and nothing judges on it.
--
-- Metres, not kilometres: an integer of metres is exact, and a float of
-- kilometres accumulates error across a day of hops.

ALTER TABLE "fuel_daily_trends"
  ADD COLUMN "distance_m"       INTEGER,
  ADD COLUMN "expected_burn_ml" INTEGER;
