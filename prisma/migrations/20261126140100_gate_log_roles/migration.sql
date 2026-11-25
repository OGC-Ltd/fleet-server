SET lock_timeout = '5s';

-- The Gate log for every organisation's existing Admin and Ops Room Operator
-- roles (operator, 2026-11-25: admins see the page, without the Ops Room
-- Operator's pop-ups).
--
-- The role catalogue only creates missing roles at boot, and skips any right
-- not yet in the permissions table; it never adds a right to a role that
-- exists. The Ops Room Operator role is created at the first boot of this
-- release, BEFORE these migrations are run by hand, so it is created without
-- gate_log:read: this gives it, and Admin, the right afterwards. Needs the
-- gate_log:read row from 20261126140000_gate_log_permission (runs first, by
-- name); does nothing without it. Safe to run twice.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."slug" = 'gate_log:read'
 WHERE r."slug" IN ('admin', 'ops_room_operator')
ON CONFLICT DO NOTHING;
