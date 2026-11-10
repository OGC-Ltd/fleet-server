SET lock_timeout = '5s';

-- Geofences drawn in the app say what they are for and how they look.
-- Both NULL for every existing fence: the name still decides, as before.
-- IF NOT EXISTS: the columns went in ahead of the code that reads them.
ALTER TABLE "geofences" ADD COLUMN IF NOT EXISTS "purpose" TEXT;
ALTER TABLE "geofences" ADD COLUMN IF NOT EXISTS "color" TEXT;
