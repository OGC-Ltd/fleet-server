SET lock_timeout = '5s';

-- The Gate log right (operator, 2026-11-25): sign-outs and returns at the
-- gate, for the Ops Room Operator role. One row, nothing altered. It must be
-- in the table BEFORE the role exists: the role catalogue gives a new role only
-- the rights the table already holds (modules/roles/role.catalogue).

INSERT INTO "permissions" ("id", "name", "slug", "resource", "action")
VALUES ('perm_' || replace(gen_random_uuid()::text, '-', ''), 'View the Gate log: sign-outs and returns', 'gate_log:read', 'gate_log', 'read')
ON CONFLICT ("slug") DO NOTHING;
