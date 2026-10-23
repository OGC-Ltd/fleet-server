SET lock_timeout = '5s';

-- The Alerts page is a separate resource from fuel investigations and
-- analytics. This lets operators see alerts without granting those broader
-- resource permissions.
INSERT INTO "permissions" ("id", "name", "slug", "resource", "action")
VALUES ('perm_' || replace(gen_random_uuid()::text, '-', ''),
        'View fleet alerts', 'alerts:read', 'alerts', 'read')
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."slug" = 'alerts:read'
 WHERE r."slug" IN ('supervisor', 'operator')
ON CONFLICT DO NOTHING;

-- Ensure the requested sidebar resources are available to existing roles too,
-- not only to roles created or reconciled from the current RBAC seed.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p
    ON (r."slug" = 'supervisor' AND p."slug" IN (
          'report:read', 'driver:read', 'repair:read', 'fuel_audit:read'
       ))
    OR (r."slug" = 'operator' AND p."slug" IN (
          'map:read', 'telemetry:read', 'notification:read', 'vehicle:read'
       ))
ON CONFLICT DO NOTHING;
