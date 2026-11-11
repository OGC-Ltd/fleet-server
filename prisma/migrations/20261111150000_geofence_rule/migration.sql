SET lock_timeout = '5s';

-- A geofence's rule: who may not use it and the alert it raises
-- (lib/fence-rules). NULL for every existing fence: no rule, nothing changes.
-- IF NOT EXISTS: safe to run again, or after the column went in by hand.
ALTER TABLE "geofences" ADD COLUMN IF NOT EXISTS "rule" JSONB;
