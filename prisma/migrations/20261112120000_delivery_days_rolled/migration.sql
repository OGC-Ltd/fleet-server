SET lock_timeout = '5s';

-- Unfinished deliveries roll over to the next day's list (operator, 12 Nov
-- 2026). Marks the day whose leftovers were carried, so it happens once.
-- Nullable, so nothing existing changes.

ALTER TABLE "delivery_days" ADD COLUMN IF NOT EXISTS "rolled_at" TIMESTAMP(3);
