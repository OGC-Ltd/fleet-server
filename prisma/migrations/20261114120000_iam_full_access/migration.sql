SET lock_timeout = '5s';

-- One right that stands for every other in an organisation (user,
-- 2026-11-14: "add a full-access right"). lib/authz/subject expands it to
-- every right but FULL_ACCESS_EXCLUDED (lib/permissions). No role holds it:
-- IAM gives it per person per organisation.

INSERT INTO "permissions" ("id", "name", "slug", "resource", "action")
VALUES ('perm_' || replace(gen_random_uuid()::text, '-', ''), 'Full access in this organisation', 'access:full', 'access', 'full')
ON CONFLICT ("slug") DO NOTHING;
