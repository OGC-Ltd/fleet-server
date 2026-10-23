-- Groups may be shared by several organisations. Keep the existing
-- organisation_id as the group creator/owner and seed the association table
-- with the current one-organisation scope for every existing group.
CREATE TABLE "user_group_organisations" (
  "group_id"        TEXT NOT NULL,
  "organisation_id" TEXT NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_group_organisations_pkey"
    PRIMARY KEY ("group_id", "organisation_id")
);

INSERT INTO "user_group_organisations" ("group_id", "organisation_id")
SELECT "id", "organisation_id"
FROM "user_groups";

CREATE INDEX "user_group_organisations_organisation_id_group_id_idx"
  ON "user_group_organisations"("organisation_id", "group_id");

ALTER TABLE "user_group_organisations"
  ADD CONSTRAINT "user_group_organisations_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "user_groups"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_group_organisations"
  ADD CONSTRAINT "user_group_organisations_organisation_id_fkey"
  FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
