SET lock_timeout = '5s';

-- The live role rows had drifted from ROLE_DEFINITIONS (roles are edited as
-- data), so 20261026090000 alone left gaps against the operator's 2026-10-26
-- list, measured on production right after it ran:
--
--   supervisor  lacked sensor:read, weighbridge:read and fuel_filling:read:
--               no Maintenance, Weighbridges or Fuel Report
--   operator    lacked driver:read and map:filter (Drivers; the Fleets types
--               and In transit only), and still held repair:read, which
--               opens the Workshop it is not to have
--
-- Only those slugs are touched; everything else the rows hold stays.

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p
    ON (r."slug" = 'supervisor' AND p."slug" IN ('sensor:read', 'weighbridge:read', 'fuel_filling:read'))
    OR (r."slug" = 'operator'   AND p."slug" IN ('driver:read', 'map:filter'))
ON CONFLICT DO NOTHING;

DELETE FROM "role_permissions" rp
 USING "roles" r, "permissions" p
 WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id"
   AND r."slug" = 'operator'
   AND p."slug" = 'repair:read';
