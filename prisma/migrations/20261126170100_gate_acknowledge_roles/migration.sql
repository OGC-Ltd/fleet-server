SET lock_timeout = '5s';

-- gate_log:acknowledge for every organisation's existing Admin and Ops Room
-- Operator roles, the two that hold gate_log:read. The role catalogue never
-- adds a right to a role that exists (see 20261126140100_gate_log_roles).
-- Needs the permission row from 20261126170000_gate_acknowledgements (runs
-- first, by name); does nothing without it. Safe to run twice.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."slug" = 'gate_log:acknowledge'
 WHERE r."slug" IN ('admin', 'ops_room_operator')
ON CONFLICT DO NOTHING;
