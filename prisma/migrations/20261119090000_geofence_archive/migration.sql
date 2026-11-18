-- Archived geofences: kept for history (feed ids, past reports) but out of use
-- everywhere else: live containment, the map, Planner matching, reports. NULL =
-- in use. Set by prisma/archive-geofences.ts; archived_note carries the batch tag
-- so a batch can be undone in one UPDATE. Nullable, no default: catalog-only.

SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "geofences" ADD COLUMN "archived_at" TIMESTAMP(3),
ADD COLUMN "archived_note" TEXT;

-- CreateIndex
CREATE INDEX "geofences_organisation_id_archived_at_idx" ON "geofences"("organisation_id", "archived_at");
