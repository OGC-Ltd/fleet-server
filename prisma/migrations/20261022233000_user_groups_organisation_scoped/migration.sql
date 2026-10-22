-- Groups are custom per-organisation resources. Split each legacy group into
-- one group per organisation its users can reach, retaining each assignment.
DROP TABLE "group_email_domains";
DROP TYPE "DomainMatch";

ALTER TABLE "user_groups" ADD COLUMN "organisation_id" TEXT;
DROP INDEX "user_groups_slug_key";

CREATE TEMP TABLE "_user_group_orgs" AS
SELECT DISTINCT ug."group_id", u."organisation_id"
FROM "user_group_memberships" ug
JOIN "users" u ON u."id" = ug."user_id"
UNION
SELECT DISTINCT ug."group_id", om."organisation_id"
FROM "user_group_memberships" ug
JOIN "org_memberships" om ON om."user_id" = ug."user_id"
WHERE om."revoked_at" IS NULL;

CREATE TEMP TABLE "_user_group_org_map" AS
SELECT
  group_orgs."group_id" AS "old_group_id",
  group_orgs."organisation_id",
  CASE
    WHEN ROW_NUMBER() OVER (
      PARTITION BY group_orgs."group_id"
      ORDER BY group_orgs."organisation_id"
    ) = 1 THEN group_orgs."group_id"
    ELSE 'c' || SUBSTRING(MD5(group_orgs."group_id" || ':' || group_orgs."organisation_id"), 1, 24)
  END AS "new_group_id"
FROM "_user_group_orgs" group_orgs;

CREATE TEMP TABLE "_old_user_group_memberships" AS
SELECT "user_id", "group_id", "created_at"
FROM "user_group_memberships";

UPDATE "user_groups" groups
SET "organisation_id" = mapping."organisation_id"
FROM "_user_group_org_map" mapping
WHERE groups."id" = mapping."new_group_id"
  AND mapping."new_group_id" = mapping."old_group_id";

INSERT INTO "user_groups" (
  "id", "organisation_id", "slug", "name", "description", "created_at", "updated_at"
)
SELECT
  mapping."new_group_id",
  mapping."organisation_id",
  groups."slug",
  groups."name",
  groups."description",
  groups."created_at",
  groups."updated_at"
FROM "_user_group_org_map" mapping
JOIN "user_groups" groups ON groups."id" = mapping."old_group_id"
WHERE mapping."new_group_id" <> mapping."old_group_id";

DELETE FROM "user_group_memberships";

INSERT INTO "user_group_memberships" ("user_id", "group_id", "created_at")
SELECT old_memberships."user_id", mapping."new_group_id", old_memberships."created_at"
FROM "_old_user_group_memberships" old_memberships
JOIN "users" u ON u."id" = old_memberships."user_id"
JOIN (
  SELECT "id" AS "user_id", "organisation_id" FROM "users"
  UNION
  SELECT "user_id", "organisation_id"
  FROM "org_memberships"
  WHERE "revoked_at" IS NULL
) user_orgs ON user_orgs."user_id" = old_memberships."user_id"
JOIN "_user_group_org_map" mapping
  ON mapping."old_group_id" = old_memberships."group_id"
 AND mapping."organisation_id" = user_orgs."organisation_id";

DELETE FROM "user_groups" groups
WHERE groups."organisation_id" IS NULL;

ALTER TABLE "user_groups" ALTER COLUMN "organisation_id" SET NOT NULL;
ALTER TABLE "user_groups"
  ADD CONSTRAINT "user_groups_organisation_id_fkey"
  FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "user_groups_organisation_id_slug_key"
  ON "user_groups"("organisation_id", "slug");
CREATE INDEX "user_groups_organisation_id_idx"
  ON "user_groups"("organisation_id");
