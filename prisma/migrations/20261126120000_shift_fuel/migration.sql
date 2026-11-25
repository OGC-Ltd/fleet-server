SET lock_timeout = '5s';

-- Each kept plan line's shift fuel (planner/shift-fuel.ts): issued in the
-- shift, probe filled, consumed, probe used, the end level and the run. New
-- nullable columns on factorysuite_fuel_befores, nothing else altered. Rows
-- already kept stay at kept_version 1, so the keep job reads every past day
-- again, a few a pass, and fills these in on its own.

ALTER TABLE "factorysuite_fuel_befores"
    ADD COLUMN IF NOT EXISTS "end_l" DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "end_at" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "end_gap" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "hours" DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "km" DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "issued_l" DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "shift_fuellings" JSONB,
    ADD COLUMN IF NOT EXISTS "probe_filled_l" DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "shift_start_l" DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "shift_start_by" TEXT,
    ADD COLUMN IF NOT EXISTS "consumed_l" DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "consumed_why" TEXT,
    ADD COLUMN IF NOT EXISTS "probe_used_l" DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "kept_version" INTEGER NOT NULL DEFAULT 1;
