-- User groups: the third axis of who may administer whom.
--
-- Organisation says who employs a person and org_memberships says which
-- tenants they may read. Neither can say that Offgrid staff and Kasulu staff,
-- both reachable from one organisation, must not administer each other.
--
-- Additive and reversible: users.group_id is nullable with no backfill here.
-- Placement is done by prisma/backfill-user-groups.ts, which is a dry run
-- until told otherwise, and nothing reads the column until
-- USER_GROUP_ENFORCE is true.

CREATE TYPE "DomainMatch" AS ENUM ('SUFFIX', 'LABEL');

CREATE TABLE "user_groups" (
  "id"          TEXT NOT NULL,
  "slug"        TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_groups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_groups_slug_key" ON "user_groups"("slug");

CREATE TABLE "group_email_domains" (
  "id"         TEXT NOT NULL,
  "group_id"   TEXT NOT NULL,
  "pattern"    TEXT NOT NULL,
  "kind"       "DomainMatch" NOT NULL DEFAULT 'SUFFIX',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "group_email_domains_pkey" PRIMARY KEY ("id")
);

-- One pattern cannot route to two groups. Patterns are stored lowercased by
-- the application; this index is what makes that a rule rather than a habit.
CREATE UNIQUE INDEX "group_email_domains_pattern_key" ON "group_email_domains"("pattern");
CREATE INDEX "group_email_domains_group_id_idx" ON "group_email_domains"("group_id");

ALTER TABLE "group_email_domains"
  ADD CONSTRAINT "group_email_domains_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "user_groups"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "users" ADD COLUMN "group_id" TEXT;

-- SET NULL rather than CASCADE: deleting a group must never delete people.
-- An orphaned account falls back to "ungrouped", which the read path treats as
-- visible to the platform administrator only — recoverable, and loud.
ALTER TABLE "users"
  ADD CONSTRAINT "users_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "user_groups"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "users_group_id_idx" ON "users"("group_id");
