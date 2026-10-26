SET lock_timeout = '5s';

-- Screen access per role, as the operator named it on 2026-10-26.
--
--   supervisor  live map, alerts, drivers, maintenance, workshop, weighbridges,
--               the Fleets block, logbook, fuel audit and fuel report;
--               no Analytics
--   operator    live map, alerts, drivers, weighbridges, maintenance, the
--               Fleets block, fuel audit, and of Fuel Report only Vehicle
--               analytics; no Logbook, no Workshop
--   technician  the Workshop's ControlTech tab and nothing else
--
-- Two new permissions split screens off grants the operator and technician
-- keep for other reasons: `logbook:read` (was `telemetry:read`) and
-- `fuel_review:read`, the Fuel Report's fleet Performance view (was
-- `fuel_filling:read`). Every role that could open those screens before keeps
-- them, so nobody else loses anything.

INSERT INTO "permissions" ("id", "name", "slug", "resource", "action")
VALUES ('perm_' || replace(gen_random_uuid()::text, '-', ''),
        'Open the vehicle Logbook', 'logbook:read', 'logbook', 'read'),
       ('perm_' || replace(gen_random_uuid()::text, '-', ''),
        'View the fleet fuel performance review', 'fuel_review:read', 'fuel_review', 'read')
ON CONFLICT ("slug") DO NOTHING;

-- The Logbook: every role holding telemetry:read today, except operator and
-- technician.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."slug" = 'logbook:read'
 WHERE r."slug" IN ('director', 'admin', 'hos', 'manager', 'fleet_manager',
                    'fleet_analyst', 'head_of_security', 'asst_head_of_security',
                    'logistics_manager', 'dispatcher', 'supervisor')
ON CONFLICT DO NOTHING;

-- The fleet Performance view: every role holding fuel_filling:read today
-- (the operator gains fuel_filling:read below, but not this).
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."slug" = 'fuel_review:read'
 WHERE r."slug" IN ('director', 'admin', 'hos', 'manager', 'fleet_manager',
                    'fleet_analyst', 'head_of_security', 'asst_head_of_security',
                    'logistics_manager', 'dispatcher', 'supervisor', 'accountant')
ON CONFLICT DO NOTHING;

-- Operator: Maintenance, Fuel Audit, and the Fuel Report (Vehicle analytics).
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."slug" IN ('sensor:read', 'fuel_filling:read', 'fuel_audit:read')
 WHERE r."slug" = 'operator'
ON CONFLICT DO NOTHING;

-- Supervisor: no Analytics screen.
DELETE FROM "role_permissions" rp
 USING "roles" r, "permissions" p
 WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id"
   AND r."slug" = 'supervisor'
   AND p."slug" IN ('analytics:read', 'analytics:export');

-- Technician: no Maintenance.
DELETE FROM "role_permissions" rp
 USING "roles" r, "permissions" p
 WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id"
   AND r."slug" = 'technician'
   AND p."slug" = 'sensor:read';
