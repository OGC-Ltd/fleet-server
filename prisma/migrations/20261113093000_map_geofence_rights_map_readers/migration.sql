SET lock_timeout = '5s';

-- The map's two geofence rights for every role that has the map at all
-- (map:read), not only the ones that can toggle layers: the live Operator role
-- holds map:read and map:filter but not map:layers, and the operator wants its
-- holders to see geofences too (2026-11-13). See 20261113090000.

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT rp."role_id", p."id"
  FROM "role_permissions" rp
  JOIN "permissions" m ON m."id" = rp."permission_id" AND m."slug" = 'map:read'
  JOIN "permissions" p ON p."slug" IN ('map:geofences', 'map:custom_geos')
ON CONFLICT DO NOTHING;
