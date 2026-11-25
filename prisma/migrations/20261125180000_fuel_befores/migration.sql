SET lock_timeout = '5s';

-- Each FactorySuite plan line's Fuel before, kept once its shift has settled
-- (planner/fuel-befores.ts). One new table, nothing altered. The server fills
-- it on its own after this is applied: each reconcile pass keeps a few past
-- days, back to the first kept plan day, then yesterday's once a day.

-- CreateTable
CREATE TABLE IF NOT EXISTS "factorysuite_fuel_befores" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "factory_code" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "machine" TEXT NOT NULL,
    "line_id" TEXT NOT NULL,
    "vehicle_id" TEXT,
    "window_start" TIMESTAMP(3),
    "window_end" TIMESTAMP(3),
    "before_l" DOUBLE PRECISION,
    "before_at" TIMESTAMP(3),
    "before_by" TEXT,
    "before_read_at" TIMESTAMP(3),
    "kept_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "factorysuite_fuel_befores_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "factorysuite_fuel_befores_organisation_id_fkey" FOREIGN KEY ("organisation_id")
        REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "factorysuite_fuel_befores_organisation_id_day_idx" ON "factorysuite_fuel_befores"("organisation_id", "day");
CREATE INDEX IF NOT EXISTS "factorysuite_fuel_befores_factory_code_day_idx" ON "factorysuite_fuel_befores"("factory_code", "day");
