SET lock_timeout = '5s';

-- Geofences drawn in the app say what they are for and how they look.
-- Both NULL for every existing fence: the name still decides, as before.
ALTER TABLE "geofences" ADD COLUMN "purpose" TEXT;
ALTER TABLE "geofences" ADD COLUMN "color" TEXT;
