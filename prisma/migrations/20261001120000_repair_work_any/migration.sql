SET lock_timeout = '5s';

-- `repair:work_any`: work any open repair job (operator, 2026-10-01). Without
-- it a job can be worked only by the technician it is assigned to, once they
-- have accepted it (repairs.authz requireWorkableJob); everyone else reads.
-- Granted to every role that holds repair:resolve today EXCEPT the
-- technician, so nobody but technicians loses anything. The platform
-- administrator holds it through its wildcard.
INSERT INTO "permissions" ("id", "name", "slug", "resource", "action")
VALUES ('perm_' || replace(gen_random_uuid()::text, '-', ''),
        'Work any open repair job, not only an accepted one of your own', 'repair:work_any', 'repair', 'work_any')
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT DISTINCT rp."role_id", w."id"
  FROM "role_permissions" rp
  JOIN "permissions" p ON p."id" = rp."permission_id" AND p."slug" = 'repair:resolve'
  JOIN "roles" r ON r."id" = rp."role_id" AND r."slug" <> 'technician'
  JOIN "permissions" w ON w."slug" = 'repair:work_any'
ON CONFLICT DO NOTHING;
