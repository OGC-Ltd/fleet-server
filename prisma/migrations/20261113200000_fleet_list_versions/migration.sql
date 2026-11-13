SET lock_timeout = '5s';

-- The client's fleet list, kept for the organisation (operator, 2026-11-13):
-- uploaded once for every user, where it was kept in each browser. Every
-- upload is a row and none is changed or deleted; the newest is the one in
-- use, and a row with no entries puts the built-in list back. New table
-- only; nothing existing changes.
CREATE TABLE IF NOT EXISTS "fleet_list_versions" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "file_name" TEXT,
    "entries" JSONB,
    "unit_count" INTEGER NOT NULL DEFAULT 0,
    "sheets" JSONB,
    "conflicts" JSONB,
    "uploaded_by_id" TEXT,
    "uploaded_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fleet_list_versions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "fleet_list_versions_organisation_id_created_at_idx"
    ON "fleet_list_versions"("organisation_id", "created_at");
