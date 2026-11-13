SET lock_timeout = '5s';

-- Every hidden rule becomes an IAM right (user, 2026-11-14: "include all
-- hidden rules into our IAM, and on every rule we add full access").
-- Until now these were role NAMES in the code: a technician lost the map's
-- traffic, weather, geofence and arrivals tools, two sets of status counts
-- and most of the live feed; only technicians could be handed repair jobs;
-- notices went to role lists; a supervisor saw operator accounts only; an
-- admin could not grant senior roles or touch protected accounts.

INSERT INTO "permissions" ("id", "name", "slug", "resource", "action")
SELECT 'perm_' || replace(gen_random_uuid()::text, '-', ''), v.name, v.slug,
       split_part(v.slug, ':', 1), split_part(v.slug, ':', 2)
  FROM (VALUES
    ('map:traffic',                     'Show live traffic on the map'),
    ('map:weather',                     'Show live weather on the map'),
    ('map:arrivals',                    'Open Arrivals: drive times to a hub'),
    ('fleet:load_status',               'See the In transit and Empty counts'),
    ('fleet:status_counts',             'See the Idling, Warning and Critical counts'),
    ('notification:all_events',         'See every live feed event, not only repair notices'),
    ('notification:repair_tickets',     'See repair ticket notices in the live feed'),
    ('notification:repair_flags',       'See units flagged and repairs verified in the live feed'),
    ('notification:push_control_room',  'Get Control Room repair notices'),
    ('notification:push_tickets',       'Get repair ticket numbers by push'),
    ('notification:push_completed',     'Get completed repairs to verify by push'),
    ('notification:push_stores',        'Get spare part requests'),
    ('notification:fuel_audit_mail',    'Get the Fuel Audit report by email'),
    ('repair:take_jobs',                'Be handed repair jobs (told in the app, not by push)'),
    ('security_case:hold',              'Hold security investigations and get their notices'),
    ('user:read_all',                   'See every account, not only operators'),
    ('user:manage_protected',           'Edit or remove Admins, Directors and System Administrators'),
    ('role:assign_senior',              'Grant the Admin and Head of Section roles')
  ) AS v(slug, name)
ON CONFLICT ("slug") DO NOTHING;

-- FULL ACCESS: the rights that widen what somebody may see or use go to every
-- role there is. IAM takes them away per person.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."slug" IN (
    'map:traffic', 'map:weather', 'map:arrivals',
    'fleet:load_status', 'fleet:status_counts',
    'notification:all_events', 'notification:repair_tickets', 'notification:repair_flags',
    'user:read_all')
ON CONFLICT DO NOTHING;

-- Who is TOLD or HANDED something stays with the roles that were, so nobody
-- is suddenly messaged or listed as an assignee. IAM adds anyone else.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM (VALUES
    ('notification:push_control_room', 'supervisor'),
    ('notification:push_control_room', 'fleet_analyst'),
    ('notification:push_control_room', 'operator'),
    ('notification:push_tickets',      'operator'),
    ('notification:push_tickets',      'head_of_security'),
    ('notification:push_tickets',      'asst_head_of_security'),
    ('notification:push_completed',    'operator'),
    ('notification:push_completed',    'supervisor'),
    ('notification:push_completed',    'head_of_security'),
    ('notification:push_completed',    'asst_head_of_security'),
    ('notification:push_stores',       'admin'),
    ('notification:fuel_audit_mail',   'head_of_security'),
    ('notification:fuel_audit_mail',   'asst_head_of_security'),
    ('notification:fuel_audit_mail',   'fleet_manager'),
    ('notification:fuel_audit_mail',   'dispatcher'),
    ('notification:fuel_audit_mail',   'fleet_analyst'),
    ('notification:fuel_audit_mail',   'manager'),
    ('notification:fuel_audit_mail',   'admin'),
    ('notification:fuel_audit_mail',   'director'),
    ('notification:fuel_audit_mail',   'super_admin'),
    ('repair:take_jobs',               'technician'),
    ('security_case:hold',             'head_of_security')
  ) AS g(perm, role)
  JOIN "roles" r       ON r."slug" = g.role
  JOIN "permissions" p ON p."slug" = g.perm
ON CONFLICT DO NOTHING;

-- The Fleets tree let a role restricted to flagged units filter whatever it
-- held; now map:filter decides, so those roles keep it.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT rp."role_id", p."id"
  FROM "role_permissions" rp
  JOIN "permissions" f ON f."id" = rp."permission_id" AND f."slug" = 'vehicle:flagged_only'
  JOIN "permissions" p ON p."slug" = 'map:filter'
ON CONFLICT DO NOTHING;
