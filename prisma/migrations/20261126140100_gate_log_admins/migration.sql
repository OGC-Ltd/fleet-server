SET lock_timeout = '5s';

-- The Gate log for every organisation's existing Admin role (operator,
-- 2026-11-25: admins see the page, without the Ops Room Operator's pop-ups).
-- The role catalogue only creates missing roles at boot, it never adds a right
-- to one that exists, so existing Admin roles get it here. Needs the
-- gate_log:read row from 20261126140000_gate_log_permission; does nothing
-- without it. Safe to run twice.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."slug" = 'gate_log:read'
 WHERE r."slug" = 'admin'
ON CONFLICT DO NOTHING;
