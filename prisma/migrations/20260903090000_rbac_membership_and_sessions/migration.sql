-- Enforced authorisation: platform roles, cross-tenant membership with a
-- vehicle scope, and stored refresh-token families.
--
-- The RBAC tables (roles, permissions, role_permissions, user_roles) already
-- existed and were seeded; nothing ever read them for a decision. This adds the
-- three things the model could not express, and closes two constraint gaps.

-- ---------------------------------------------------------------------------
-- 1. PLATFORM ROLES
-- ---------------------------------------------------------------------------
-- Roles are keyed to one organisation, so "every tenant" was inexpressible.
-- A NULL organisation_id now means the role's permissions apply everywhere --
-- super_admin and director. Nothing else should use it.
ALTER TABLE "roles" ALTER COLUMN "organisation_id" DROP NOT NULL;

-- roles_organisation_id_slug_key does NOT constrain these: Postgres treats
-- NULLs as distinct, so any number of platform roles could share a slug.
CREATE UNIQUE INDEX "roles_platform_slug_key"
    ON "roles"("slug") WHERE "organisation_id" IS NULL;

-- ---------------------------------------------------------------------------
-- 2. ONE LIVE GRANT PER (USER, ROLE)
-- ---------------------------------------------------------------------------
-- user.service.ts catches Prisma P2002 on role assignment and raises
-- ConflictError, but no such constraint existed -- duplicate grants were
-- created silently instead.
--
-- PARTIAL, not a plain unique: grants are soft-revoked via revoked_at, and a
-- plain unique on (user_id, role_id) would make a revoked role ungrantable for
-- the rest of that user's life.
--
-- Collapse existing duplicate LIVE grants first, keeping the earliest -- it
-- carries the true assigned_at, and its assigned_by is the person who actually
-- made the decision.
DELETE FROM "user_roles" a
      USING "user_roles" b
      WHERE a."revoked_at" IS NULL
        AND b."revoked_at" IS NULL
        AND a."user_id" = b."user_id"
        AND a."role_id" = b."role_id"
        AND (a."assigned_at", a."id") > (b."assigned_at", b."id");

CREATE UNIQUE INDEX "user_roles_user_id_role_id_live_key"
    ON "user_roles"("user_id", "role_id") WHERE "revoked_at" IS NULL;

-- ---------------------------------------------------------------------------
-- 3. MEMBERSHIP -- which organisations a person may reach
-- ---------------------------------------------------------------------------
CREATE TABLE "org_memberships" (
    "id"              TEXT NOT NULL,
    "user_id"         TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "all_vehicles"    BOOLEAN NOT NULL DEFAULT true,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at"      TIMESTAMP(3),
    "created_by"      TEXT,

    CONSTRAINT "org_memberships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "org_memberships_user_id_organisation_id_key"
    ON "org_memberships"("user_id", "organisation_id");
CREATE INDEX "org_memberships_user_id_revoked_at_idx"
    ON "org_memberships"("user_id", "revoked_at");
CREATE INDEX "org_memberships_organisation_id_idx"
    ON "org_memberships"("organisation_id");

ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. VEHICLE SCOPE -- how much of a fleet a restricted membership sees
-- ---------------------------------------------------------------------------
CREATE TABLE "membership_vehicle_scopes" (
    "id"               TEXT NOT NULL,
    "membership_id"    TEXT NOT NULL,
    "vehicle_id"       TEXT,
    "vehicle_group_id" TEXT,

    CONSTRAINT "membership_vehicle_scopes_pkey" PRIMARY KEY ("id")
);

-- Exactly one of the two, which Prisma cannot express. A row naming both would
-- silently widen the scope; a row naming neither would silently narrow it.
ALTER TABLE "membership_vehicle_scopes"
    ADD CONSTRAINT "membership_vehicle_scopes_one_target"
    CHECK (num_nonnulls("vehicle_id", "vehicle_group_id") = 1);

CREATE UNIQUE INDEX "membership_vehicle_scopes_membership_id_vehicle_id_key"
    ON "membership_vehicle_scopes"("membership_id", "vehicle_id");
CREATE UNIQUE INDEX "membership_vehicle_scopes_membership_id_vehicle_group_id_key"
    ON "membership_vehicle_scopes"("membership_id", "vehicle_group_id");
CREATE INDEX "membership_vehicle_scopes_membership_id_idx"
    ON "membership_vehicle_scopes"("membership_id");

ALTER TABLE "membership_vehicle_scopes" ADD CONSTRAINT "membership_vehicle_scopes_membership_id_fkey"
    FOREIGN KEY ("membership_id") REFERENCES "org_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "membership_vehicle_scopes" ADD CONSTRAINT "membership_vehicle_scopes_vehicle_id_fkey"
    FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "membership_vehicle_scopes" ADD CONSTRAINT "membership_vehicle_scopes_vehicle_group_id_fkey"
    FOREIGN KEY ("vehicle_group_id") REFERENCES "vehicle_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. REFRESH-TOKEN FAMILIES
-- ---------------------------------------------------------------------------
CREATE TABLE "auth_sessions" (
    "id"             TEXT NOT NULL,
    "user_id"        TEXT NOT NULL,
    "family_id"      TEXT NOT NULL,
    "token_hash"     TEXT NOT NULL,
    "issued_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"     TIMESTAMP(3) NOT NULL,
    "rotated_at"     TIMESTAMP(3),
    "revoked_at"     TIMESTAMP(3),
    "revoked_reason" TEXT,
    "user_agent"     TEXT,
    "ip"             TEXT,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auth_sessions_token_hash_key" ON "auth_sessions"("token_hash");
CREATE INDEX "auth_sessions_user_id_revoked_at_idx" ON "auth_sessions"("user_id", "revoked_at");
CREATE INDEX "auth_sessions_family_id_idx" ON "auth_sessions"("family_id");
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions"("expires_at");

ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 6. BACKFILL -- every existing user is a member of the org that employs them
-- ---------------------------------------------------------------------------
-- users.organisation_id stays as the EMPLOYING org and is unchanged. This gives
-- each existing account the membership that reproduces its current reach, so
-- the migration alters nobody's access: all_vehicles = true is exactly what
-- they have today.
--
-- Soft-deleted accounts get a REVOKED membership rather than none, so the
-- invariant "the home org is always a membership row" holds for every user.
INSERT INTO "org_memberships" ("id", "user_id", "organisation_id", "all_vehicles", "created_at", "revoked_at")
SELECT 'mem_' || replace(gen_random_uuid()::text, '-', ''),
       u."id",
       u."organisation_id",
       true,
       u."created_at",
       u."deleted_at"
  FROM "users" u
ON CONFLICT ("user_id", "organisation_id") DO NOTHING;
