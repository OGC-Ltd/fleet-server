SET lock_timeout = '5s';

-- Planner reads Wialon Logistics itineraries too (operator, 11 Nov 2026):
-- the plan keeps its source, route name, planned run, km and home; each stop
-- its planned arrival, window, service time and leg. Nullable or defaulted,
-- so existing plans are untouched.

ALTER TABLE "delivery_plans"
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'sheet',
  ADD COLUMN IF NOT EXISTS "route_name" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "planned_start" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "planned_end" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "planned_km" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "home_name" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "home_lat" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "home_lng" DOUBLE PRECISION;

ALTER TABLE "delivery_plan_stops"
  ADD COLUMN IF NOT EXISTS "planned_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "window_from" TEXT,
  ADD COLUMN IF NOT EXISTS "window_to" TEXT,
  ADD COLUMN IF NOT EXISTS "service_min" INTEGER,
  ADD COLUMN IF NOT EXISTS "leg_km" DOUBLE PRECISION;
