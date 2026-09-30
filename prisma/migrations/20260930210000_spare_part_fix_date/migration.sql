-- The planned fix date, given when a spare part is collected. See
-- RepairSparePart.fixPlannedAt and repairs.overhaul. One nullable column.

-- Never queue behind a long read on a hot table; fail fast instead.
SET lock_timeout = '5s';

ALTER TABLE "repair_spare_parts" ADD COLUMN "fix_planned_at" DATE;
