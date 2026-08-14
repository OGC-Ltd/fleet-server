-- The unit's cumulative engine-hour METER at the close of the day.
--
-- Asked for by the operator: "engine hour should be the final engine hours for
-- that day on a unit" — the counter reading, the way Current is the day's final
-- fuel level, NOT the hours the engine ran that day. Those are different
-- quantities and both are now carried: engine_seconds is the duration and
-- prices the expected burn, engine_hours_meter is the reading.
--
-- Source is Wialon's `cneh`, which arrives in vehicle_telemetry_raws.payload
-- rather than as a column, exactly like the odometer. Coverage measured
-- 2026-08-14: 159 of 214 active KASULU units, 270 of 284 SUKARI.
--
-- Float, not an integer of seconds: this is a counter reported in fractional
-- hours (e.g. 692.4) and rounding it would make consecutive days disagree with
-- the machine's own dashboard.
--
-- The READING is stored rather than the day-over-day delta on purpose. The
-- delta is the more tempting figure and it corroborates engine_seconds well
-- (EX 30: 22.17 h by meter against 22.3 h integrated), but the adapter carries
-- the last known meter value forward into every frame, so a boundary reading
-- can be one taken hours earlier and a delta built from two of them
-- misattributes hours across days — 3 of 158 KASULU units showed more than 24
-- hours in a single day, which no engine does.

ALTER TABLE "fuel_daily_trends"
  ADD COLUMN "engine_hours_meter" DOUBLE PRECISION;
