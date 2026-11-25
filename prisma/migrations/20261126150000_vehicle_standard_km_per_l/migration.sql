SET lock_timeout = '5s';

-- A unit's standard consumption, km/L (operator, 2026-11-25: Menengai's
-- "proposed consumption figure" per unit, for the TAT report). Nullable with
-- no default: adding it rewrites nothing and is instant. Filled afterwards per
-- unit, separately, with the operator's go.
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "standard_km_per_l" DOUBLE PRECISION;
