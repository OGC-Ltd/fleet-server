SET lock_timeout = '5s';

-- Technicians (operator, 2026-10-27): the live map, Units and In transit only,
-- restricted to units with an open repair job in every organisation they
-- belong to; Maintenance with Probes, Malfunction and Repairs.
--
-- `vehicle:flagged_only` is a restriction read by lib/authz/subject: a role
-- holding it sees only units with an open repair_report_items row
-- (resolved_at IS NULL). `sensor:read` comes back (it was taken away on
-- 2026-10-26); `map:read` and `map:layers` are new for this role.

INSERT INTO "permissions" ("id", "name", "slug", "resource", "action")
VALUES ('perm_' || replace(gen_random_uuid()::text, '-', ''),
        'See only units with an open repair job', 'vehicle:flagged_only', 'vehicle', 'flagged_only')
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."slug" IN ('vehicle:flagged_only', 'map:read', 'map:layers', 'sensor:read')
 WHERE r."slug" = 'technician'
ON CONFLICT DO NOTHING;
