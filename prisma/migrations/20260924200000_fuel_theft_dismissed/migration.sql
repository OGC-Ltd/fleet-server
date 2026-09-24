-- "Delete" on the dashboard's fuel incident window, shared by everyone in the
-- organisation. The row is never deleted: the ledger, the reports and the
-- 30-day repeat count all keep it. Only the live announcement stops.
--
-- NULL on every existing row, so nothing changes until someone dismisses one.
ALTER TABLE "fuel_thefts" ADD COLUMN "dismissed_at" TIMESTAMP(3),
                          ADD COLUMN "dismissed_by_id" TEXT;

ALTER TABLE "fuel_thefts" ADD CONSTRAINT "fuel_thefts_dismissed_by_id_fkey"
  FOREIGN KEY ("dismissed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
