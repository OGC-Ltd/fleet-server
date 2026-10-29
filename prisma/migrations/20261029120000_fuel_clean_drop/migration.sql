SET lock_timeout = '5s';

-- What left the tank on a drain: the measured fall less the engine's burn
-- (judgeDrain's lossMl). measured_drop_ml stays the judged fall.
-- Nullable and unindexed: a metadata-only ADD COLUMN, no rewrite.
ALTER TABLE "fuel_thefts" ADD COLUMN "clean_drop_ml" INTEGER;
