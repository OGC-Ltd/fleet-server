SET lock_timeout = '5s';

-- `fuel_audit:read`: open the Fuel Audit page (operator, 2026-10-01).
-- Only the roles the operator named. The platform administrator holds it
-- through its wildcard. Granted here rather than by seed:rbac for the reason
-- 20260925090000_fuel_theft_followups gives.
INSERT INTO "permissions" ("id", "name", "slug", "resource", "action")
VALUES ('perm_' || replace(gen_random_uuid()::text, '-', ''),
        'Open the Fuel Audit', 'fuel_audit:read', 'fuel_audit', 'read')
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."slug" = 'fuel_audit:read'
 WHERE r."slug" IN ('director', 'admin', 'manager', 'fleet_manager', 'fleet_analyst',
                    'head_of_security', 'asst_head_of_security')
ON CONFLICT DO NOTHING;
