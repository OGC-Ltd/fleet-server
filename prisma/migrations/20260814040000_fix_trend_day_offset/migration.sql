-- Every fuel_daily_trends row was filed under the day BEFORE the one it
-- describes. This shifts all 4,650 of them forward by one day.
--
-- The cause is in recordFuelTrends, fixed in the same commit. It derived the
-- DATE key from `fleetDayStart(asOf)`, which returns the INSTANT EAT-midnight
-- falls on — and that instant, expressed in UTC, is 21:00 the PREVIOUS evening.
-- Reading its UTC calendar components therefore yields the previous date:
--
--   fleet day 2026-08-12T21:00Z .. 2026-08-13T21:00Z   (EAT calendar: the 13th)
--   stored as day = 2026-08-12                          (wrong, off by one)
--
-- It hid because the error was UNIFORM. Every row was shifted the same way, so
-- no two rows disagreed and nothing downstream noticed; it only surfaced when
-- stored rows were lined up against a freshly recomputed day. A systematic
-- error is invisible until something outside the system is compared with it.
--
-- Second-order effect, also fixed by this: getFleetTankState gathers PRIOR run
-- slosh with `day < dayStart`. Under the old labels the current fleet day's own
-- row compared as 00:00Z against a 21:00Z bound and so was pulled into its own
-- "prior" window. With correct labels it sorts after the bound and is excluded.
--
-- Shifted in TWO statements via a far offset. A single `day + 1` would collide
-- with the (vehicle_id, day) unique index as it walked — row (v, 12) becoming
-- (v, 13) while (v, 13) still exists — because the constraint is not deferrable.
-- Moving everything a thousand days away first makes both passes collision-free.

UPDATE "fuel_daily_trends" SET "day" = "day" + 1000;
UPDATE "fuel_daily_trends" SET "day" = "day" - 999;
