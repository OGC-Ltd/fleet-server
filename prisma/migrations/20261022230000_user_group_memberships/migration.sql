-- Replace the single user group with many-to-many memberships. Preserve every
-- existing assignment before removing the legacy column.
CREATE TABLE "user_group_memberships" (
  "user_id"    TEXT NOT NULL,
  "group_id"   TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_group_memberships_pkey" PRIMARY KEY ("user_id", "group_id")
);

INSERT INTO "user_group_memberships" ("user_id", "group_id")
SELECT "id", "group_id"
FROM "users"
WHERE "group_id" IS NOT NULL;

CREATE INDEX "user_group_memberships_group_id_user_id_idx"
  ON "user_group_memberships"("group_id", "user_id");

ALTER TABLE "user_group_memberships"
  ADD CONSTRAINT "user_group_memberships_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_group_memberships"
  ADD CONSTRAINT "user_group_memberships_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "user_groups"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX "users_group_id_idx";
ALTER TABLE "users" DROP CONSTRAINT "users_group_id_fkey";
ALTER TABLE "users" DROP COLUMN "group_id";
