SET lock_timeout = '5s';

-- The map's Geofences menu as two rights of their own (operator, 2026-11-13):
-- "Show on the map" (map:geofences) and "Custom geos" (map:custom_geos).
-- Operator, Dispatch Manager, Logistics Manager and Technician have the map
-- but not geofence:read, so the menu was empty for them. Every role that can
-- toggle map layers gets both; IAM takes either away per person.

INSERT INTO "permissions" ("id", "name", "slug", "resource", "action")
VALUES ('perm_' || replace(gen_random_uuid()::text, '-', ''),
        'Show geofences on the map', 'map:geofences', 'map', 'geofences'),
       ('perm_' || replace(gen_random_uuid()::text, '-', ''),
        'Show custom geos on the map', 'map:custom_geos', 'map', 'custom_geos')
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT rp."role_id", p."id"
  FROM "role_permissions" rp
  JOIN "permissions" layers ON layers."id" = rp."permission_id" AND layers."slug" = 'map:layers'
  JOIN "permissions" p ON p."slug" IN ('map:geofences', 'map:custom_geos')
ON CONFLICT DO NOTHING;
