SET lock_timeout = '5s';

-- IAM: access rights given to, or taken from, one person on top of their role.
-- organisation_id NULL = every organisation the person can reach. Additive.
CREATE TABLE "user_permission_grants" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organisation_id" TEXT,
    "permission_id" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "granted_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_permission_grants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_permission_grants_effect_check" CHECK ("effect" IN ('allow', 'deny'))
);

CREATE INDEX "user_permission_grants_user_id_idx" ON "user_permission_grants"("user_id");
CREATE INDEX "user_permission_grants_organisation_id_idx" ON "user_permission_grants"("organisation_id");

-- One row per person, organisation and permission. Two partial indexes because
-- NULL organisations are distinct under a plain unique index.
CREATE UNIQUE INDEX "user_permission_grants_org_key"
    ON "user_permission_grants"("user_id", "organisation_id", "permission_id")
    WHERE "organisation_id" IS NOT NULL;
CREATE UNIQUE INDEX "user_permission_grants_all_orgs_key"
    ON "user_permission_grants"("user_id", "permission_id")
    WHERE "organisation_id" IS NULL;

ALTER TABLE "user_permission_grants" ADD CONSTRAINT "user_permission_grants_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_permission_grants" ADD CONSTRAINT "user_permission_grants_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_permission_grants" ADD CONSTRAINT "user_permission_grants_permission_id_fkey"
    FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_permission_grants" ADD CONSTRAINT "user_permission_grants_granted_by_fkey"
    FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Role names. The organisation's own administrator is "Admin"; the one role
-- that reaches every organisation is "System Administrator". Display names
-- only: slugs, grants and permissions are untouched. `system_admin` is the
-- legacy organisation-scoped slug that carried the same name.
UPDATE "roles" SET "name" = 'Admin'
 WHERE "organisation_id" IS NOT NULL AND "slug" IN ('admin', 'system_admin');
UPDATE "roles" SET "name" = 'System Administrator'
 WHERE "organisation_id" IS NULL AND "slug" = 'super_admin';
