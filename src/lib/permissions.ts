/**
 * The permission vocabulary, and the roles built from it.
 *
 * One definition, read by three things that must not disagree: the seed that
 * writes the `permissions` and `roles` tables, the middleware that checks a
 * request, and the tests. A slug typed twice is a slug that eventually differs
 * in one place, and the failure mode is a route that silently admits everyone.
 *
 * Slugs keep the existing `resource:action` shape, so the 60 permissions
 * already seeded stay valid and this only widens the catalogue. The seeded
 * resources covered vehicles, trips, fuel, users, routes, geofences, reports,
 * ingest keys, assignments, engine sessions and cargo — none of which name the
 * things the dashboard actually gates: the map, analytics, the drivers page,
 * the weighbridge screens.
 *
 * ROLES ARE DATA. This matrix seeds them; it does not define them. A super
 * admin editing a role in the database is the supported way to change what it
 * can do, and nothing here is consulted at request time — the middleware reads
 * `role_permissions`. Treat this as the starting position, not the contract.
 */

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/** `resource:action` -> human name. The seed writes exactly these. */
export const PERMISSION_CATALOGUE = {
  // FULL ACCESS in one organisation (user, 2026-11-14): one tick in IAM that
  // stands for every right below except FULL_ACCESS_EXCLUDED. Expanded in
  // lib/authz/subject (applyPersonalGrants) before denials, so a right taken
  // away from the person still bites. Held by no role to start with.
  'access:full':           'Full access in this organisation',

  // Live tracking. `map:read` is the map itself; the three below are the
  // controls on it, because an operator may be allowed to watch the fleet
  // without being allowed to re-colour it or to see fuel incidents.
  'vehicle:read':          'View vehicles',
  'vehicle:create':        'Add vehicles',
  'vehicle:update':        'Amend vehicles',
  'vehicle:delete':        'Remove vehicles',
  'sensor:read':           'View sensor and probe health',
  'telemetry:read':        'View telemetry and positions',
  'map:read':              'View the live map',
  'map:layers':            'Toggle map layers',
  'map:fuel_alerts':       'See fuel alerts on the map',
  'map:filter':            'Filter units by type or feature',
  // The map's Geofences menu (operator, 2026-11-13): its two switches, each a
  // right of its own so IAM can take one away. They draw fences on the map
  // only; the geofence list, report and editing stay with geofence:*.
  'map:geofences':         'Show geofences on the map',
  'map:custom_geos':       'Show custom geos on the map',
  'map:playback':          'Replay a vehicle journey',
  // The map tools that used to be taken from technicians by a fixed rule
  // (operator, 2026-10-27). Rights of their own since 2026-11-14 so IAM
  // decides; every role starts with them (user: "full access").
  'map:traffic':           'Show live traffic on the map',
  'map:weather':           'Show live weather on the map',
  'map:arrivals':          'Open Arrivals: drive times to a hub',
  // A RESTRICTION, not a capability: in an organisation where a person holds
  // it, the units they see are only those with an open repair job
  // (lib/authz/subject). A unit drops out once its job is resolved. Named by
  // the operator for technicians (2026-10-27). Read straight off the grants,
  // never through holds(): the wildcard must not narrow a super admin. IAM
  // may set or clear it per person since 2026-11-14.
  'vehicle:flagged_only':  'See only units with an open repair job',

  // The fleet status counts at the top of the map, once hidden from
  // technicians by a fixed rule.
  'fleet:load_status':     'See the In transit and Empty counts',
  'fleet:status_counts':   'See the Idling, Warning and Critical counts',

  'dashboard:read':        'View the dashboard summary',
  'notification:read':     'View the live feed',
  // What the live feed carries. Each was a fixed rule on the role until
  // 2026-11-14: a technician saw repair notices only; repair tickets went to
  // the operator, supervisor and security; flags and verifications to the
  // technicians. Every role starts with all three.
  'notification:all_events':     'See every live feed event, not only repair notices',
  'notification:repair_tickets': 'See repair ticket notices in the live feed',
  'notification:repair_flags':   'See units flagged and repairs verified in the live feed',
  // Who is TOLD, by push or mail. Kept on the roles that were told before
  // (a right given to everyone would message everyone).
  'notification:push_control_room': 'Get Control Room repair notices',
  'notification:push_tickets':      'Get repair ticket numbers by push',
  'notification:push_completed':    'Get completed repairs to verify by push',
  'notification:push_stores':       'Get spare part requests',
  'notification:fuel_audit_mail':   'Get the Fuel Audit report by email',
  'trip:read':             'View trips',
  'trip:create':           'Record trips',
  'cargo:read':            'View cargo manifests',
  'cargo:update':          'Amend cargo manifests',
  'cargo:delete':          'Remove cargo manifests',
  'assignment:read':       'View driver assignments',
  'assignment:create':     'Assign a driver to a vehicle',
  'assignment:delete':     'End a driver assignment',
  'dispatch:read':         'View dispatches',
  'route:read':            'View routes',
  'route:create':          'Create routes',
  'route:update':          'Amend routes',
  'route:delete':          'Remove routes',
  'geofence:read':         'View geofences',
  'geofence:create':       'Create geofences',
  'geofence:update':       'Amend geofences',
  'geofence:delete':       'Remove geofences',

  'analytics:read':        'View analytics',
  'analytics:export':      'Export analytics',

  // `report:operations` is the restricted four-section report — units that
  // left the premises, trips completed, fuel refill per unit, sensor health.
  // It is deliberately a separate permission from `report:read`, because the
  // roles that get it are the ones denied everything else on paper.
  'report:read':           'View reports',
  'report:create':         'Create reporting periods and sessions',
  'report:export':         'Download reports',
  'report:operations':     'Download the operations report',

  'driver:read':           'View drivers',
  'driver:export':         'Download driver reports',

  'weighbridge:read':      'View weighbridge records',
  // The Gate log (operator, 2026-11-25): sign-outs and returns at the gate,
  // the Ops Room Operator's page. A read of feed events the live feed already
  // carries; held by that role and Admin (and through access:full).
  'gate_log:read':         'View the Gate log: sign-outs and returns',
  'weighbridge:create':    'Record a weighbridge entry',
  'weighbridge:update':    'Amend a weighbridge entry',
  'weighbridge:export':    'Download weighbridge records',

  'fuel_filling:read':     'View fuel refills',
  'fuel_filling:create':   'Record a fuel refill',
  'fuel_theft:read':       'View fuel loss investigations',
  'fuel_theft:create':     'Raise a fuel loss case',
  // Accept a deleted alert's follow-up and escalate or de-escalate it. NOT in
  // ORG_EVERYTHING: the operator named the case holders one by one (system
  // administrator, manager, fleet manager, director, head of security,
  // technician), and Head of Section is not among them. Granted to existing
  // roles by migration 20260925090000_fuel_theft_followups.
  'fuel_theft:triage':     'Take on and decide fuel alert follow-ups',
  'alerts:read':           'View fleet alerts',
  // Open the Fuel Audit page. NOT in ORG_EVERYTHING: the operator named its
  // readers one by one (2026-10-01) — platform administrator (wildcard),
  // director, system administrator, manager, fleet manager, fleet analyst,
  // head of security and assistant head of security. Seeing the page decides
  // nothing: every action on it keeps its own slug (triage, repair:*).
  // Granted by migration 20261001090000_fuel_audit_read.
  'fuel_audit:read':       'Open the Fuel Audit',
  // Fuel > Report's fleet-wide Performance view (every unit against its
  // standard). Split from `fuel_filling:read` (2026-10-26) because the
  // operator gets the Report's one-unit Vehicle analytics and not this.
  'fuel_review:read':      'View the fleet fuel performance review',
  // The vehicle Logbook. Split from `telemetry:read` (2026-10-26): operator
  // and technician keep telemetry for the screens they do see, and the
  // Logbook is not one of them.
  'logbook:read':          'Open the vehicle Logbook',
  // The Planner (2026-11-11): a truck's delivery sheet for a day, its
  // customers' geofences, and plan against actual. Read rides with the
  // Logbook; write uploads sheets, redraws nothing (that is geofence:*),
  // and marks each stop Full / Partly / Rejected.
  'planner:read':          'View delivery plans',
  'planner:write':         'Upload delivery plans and mark stops',

  // Repair reporting. A technician walks the yard with a list of faulty
  // probes, works through it, and files ONE report covering every unit they
  // `repair:create` raises that report; `repair:assign` hands one open item to
  // a technician; `repair:resolve` closes a single line of it later, when the
  // spare arrived or the fix held.
  //
  // `resolve` rather than `update`: closing is the only mutation an item ever
  // gets, and naming it `update` would invite a future edit-anything route to
  // shelter under a grant that was handed out to mean "tick this off".
  'repair:read':           'View repair reports',
  'repair:create':         'File a repair report',
  'repair:assign':         'Assign a repair job to a technician',
  'repair:resolve':        'Close a repair job',
  'repair:work_any':       'Work any open repair job, not only an accepted one of your own',
  // Vehicle Support and Repair Workflow (migration 20261020180000). The
  // Control Room flags and books; the supervisor of it also assesses and
  // verifies; ControlTech claims from its queue and sources parts.
  'repair:flag':           'Flag a unit for repair',
  'repair:assess':         'Assess whether a unit can reach the workshop',
  'repair:book':           'Book a unit into the workshop and record its arrival',
  'repair:claim':          'Claim a job from the ControlTech queue',
  'repair:verify':         'Verify a completed repair, or void a job',
  'repair:parts_issue':    'Issue a spare part from stores',
  'repair:parts_source':   'Source a requested spare part',
  // Being handed jobs. It was the Technician ROLE until 2026-11-14 (the
  // triage assignee, the assignee picker, the assignment mail). Holders hear
  // of their jobs in the app, not by push. Kept on technicians: given to
  // everyone, every account would appear in the assignee picker.
  'repair:take_jobs':      'Be handed repair jobs (told in the app, not by push)',
  // Opened by suspected malicious damage on a repair; never gates the repair.
  'security_case:read':    'View security investigations',
  'security_case:update':  'Update security investigations',
  // Holding an investigation, and the security notices of the repair
  // workflow. Was the Head of Security role by name until 2026-11-14.
  'security_case:hold':    'Hold security investigations and get their notices',

  // Device credentials. Minting one is a way to write telemetry for a whole
  // organisation, so it stays with administration rather than operations.
  'ingest_key:read':       'View device API keys',
  'ingest_key:create':     'Mint a device API key',
  'ingest_key:update':     'Amend a device API key',
  'ingest_key:delete':     'Revoke a device API key',

  'user:read':             'View users',
  'user:create':           'Create users',
  'user:update':           'Amend users',
  'user:delete':           'Remove users',
  'user:assign_role':      'Grant and revoke roles',
  // Until 2026-11-14 a supervisor saw only operator accounts, by role name.
  // Every role starts with this one.
  'user:read_all':         'See every account, not only operators',
  // Until 2026-11-14 an organisation's admin could not edit or remove an
  // Admin, a Director or a System Administrator, by role name. A guard over
  // other people's accounts, so only the System Administrator holds it.
  'user:manage_protected': 'Edit or remove Admins, Directors and System Administrators',

  'role:read':             'View roles',
  // Until 2026-11-14 an admin could grant only the roles below admin, by
  // role name. Platform roles (System Administrator, Director) stay with
  // the System Administrator whatever this says: they reach every tenant.
  'role:assign_senior':    'Grant the Admin and Head of Section roles',
  'role:create':           'Create roles',
  'role:update':           'Amend roles',
  'role:delete':           'Remove roles',

  'organisation:read':     'View organisations',
  'organisation:create':   'Create organisations',
  'organisation:update':   'Amend organisations',
  'organisation:delete':   'Remove organisations',

  // Markers rather than capabilities. `platform:admin` is a WILDCARD — see
  // `holds()` — so a permission added later is covered without a data change.
  // `platform:read_all` grants nothing on its own; a role's reach across
  // organisations comes from the role being a platform role (organisation_id
  // IS NULL), not from any permission it holds.
  'platform:admin':        'Administer every organisation',
  'platform:read_all':     'Read every organisation',
} as const

export type PermissionSlug = keyof typeof PERMISSION_CATALOGUE

export const ALL_PERMISSIONS = Object.keys(PERMISSION_CATALOGUE) as PermissionSlug[]

/** See `vehicle:flagged_only` in the catalogue. */
export const FLAGGED_ONLY: PermissionSlug = 'vehicle:flagged_only'

/** The wildcard. Held only by super_admin, satisfies every check. */
export const WILDCARD: PermissionSlug = 'platform:admin'

/** Split a slug into the columns `permissions` stores it under. */
export function splitSlug(slug: string): { resource: string; action: string } {
  const i = slug.indexOf(':')
  if (i < 0) throw new Error(`Malformed permission slug: ${slug}`)
  return { resource: slug.slice(0, i), action: slug.slice(i + 1) }
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

const TRACKING: PermissionSlug[] = [
  'vehicle:read', 'telemetry:read', 'map:read', 'notification:read',
]
const MAP_TOOLS: PermissionSlug[] = ['map:layers', 'map:fuel_alerts', 'map:filter', 'map:geofences', 'map:custom_geos']

/**
 * Rights that were fixed rules on a role until 2026-11-14 (a technician
 * lost the map's traffic, weather, geofence and arrivals tools, the In transit
 * and Empty counts, the Idling/Warning/Critical counts and most of the live
 * feed; a supervisor saw only operator accounts). The user asked for every
 * hidden rule to be an IAM right, and for each new right to start as FULL
 * ACCESS: every role below holds all of these, and IAM takes one away per
 * person. Migration 20261114090000_iam_hidden_rules gives them to every role
 * row already in the database.
 */
export const FULL_ACCESS_RIGHTS: PermissionSlug[] = [
  'map:traffic', 'map:weather', 'map:arrivals',
  'fleet:load_status', 'fleet:status_counts',
  'notification:all_events', 'notification:repair_tickets', 'notification:repair_flags',
  'user:read_all',
]

/** The one right that stands for every other (see PERMISSION_CATALOGUE). */
export const FULL_ACCESS = 'access:full'

/**
 * What FULL_ACCESS does NOT carry:
 * - `vehicle:flagged_only` is a restriction: it would narrow the person.
 * - `organisation:create` / `:delete` act on tenants, not inside one.
 * - The rights that TELL somebody or HAND them work: full access must not
 *   start mailing, pushing or assigning jobs to the person. IAM gives those
 *   one by one.
 * - The platform markers and the wildcard, never given to a person.
 */
export const FULL_ACCESS_EXCLUDED: ReadonlySet<string> = new Set([
  'vehicle:flagged_only',
  'organisation:create', 'organisation:delete',
  'notification:push_control_room', 'notification:push_tickets',
  'notification:push_completed', 'notification:push_stores',
  'notification:fuel_audit_mail',
  'repair:take_jobs', 'security_case:hold',
  'platform:admin', 'platform:read_all',
])

/** Every right FULL_ACCESS stands for. */
export function fullAccessRights(): string[] {
  return (Object.keys(PERMISSION_CATALOGUE) as string[]).filter((s) => !FULL_ACCESS_EXCLUDED.has(s))
}

/** Everything a role confined to one organisation can be given. */
const ORG_EVERYTHING: PermissionSlug[] = [
  ...TRACKING, ...MAP_TOOLS, 'map:playback',
  'dashboard:read', 'trip:read',
  'analytics:read', 'analytics:export',
  'report:read', 'report:create', 'report:export', 'report:operations',
  'driver:read', 'driver:export',
  'weighbridge:read', 'weighbridge:create', 'weighbridge:update', 'weighbridge:export',
  'fuel_filling:read', 'fuel_filling:create', 'fuel_review:read',
  'fuel_theft:read', 'fuel_theft:create',
  'sensor:read', 'logbook:read', 'planner:read', 'planner:write',
  // The office reads what technicians file. A repair report nobody upstream
  // can open is a report that exists only in an inbox.
  //
  // `repair:assign` IS DELIBERATELY NOT HERE, and it is the one capability
  // lifted out of "everything an org role can be given". Handing a named
  // person responsibility for a unit — and mailing them about it — is an act
  // of administration, not of operating the fleet, and the operator scoped it
  // to the two administrator roles by name. It is granted explicitly on
  // `admin` below, and reaches the platform administrator through the
  // wildcard. Heads of section, managers and fleet managers keep every other
  // repair verb: they read the board, file a report and sign one off.
  'repair:read', 'repair:create', 'repair:resolve',
  // Work ANY open job, not only one assigned to you and accepted
  // (repairs.authz requireWorkableJob). Not held by the technician.
  'repair:work_any',
  'repair:flag', 'repair:assess', 'repair:book', 'repair:verify',
  'repair:parts_issue', 'repair:parts_source',
  'vehicle:create', 'vehicle:update', 'vehicle:delete',
  'trip:create',
  'cargo:read', 'cargo:update', 'cargo:delete',
  'assignment:read', 'assignment:create', 'assignment:delete',
  'dispatch:read',
  'route:read', 'route:create', 'route:update', 'route:delete',
  'geofence:read', 'geofence:create', 'geofence:update', 'geofence:delete',
  'user:read', 'role:read',
]

export type RoleDefinition = {
  slug: string
  name: string
  description: string
  /** true = one row with organisation_id NULL, applying to every organisation. */
  platform: boolean
  /** true = the role may be narrowed to a subset of the fleet per membership. */
  vehicleScopable: boolean
  permissions: PermissionSlug[]
}

const ROLE_BASE: RoleDefinition[] = [
  // ── Platform ─────────────────────────────────────────────────────────────
  {
    /* The one role that reaches every organisation, and the only holder of
     * the wildcard. It has been "System Administrator", then "Platform
     * Administrator" while the organisation's own administrator carried the
     * first name; since 2026-11-10 that role is "Admin" and this one is the
     * System Administrator again, which is what the operators call it.
     *
     * The slug is untouched: every grant is joined on it. */
    slug: 'super_admin', name: 'System Administrator', platform: true, vehicleScopable: false,
    description: 'Every organisation. All data and all administration. The super admin.',
    // The wildcard, deliberately alone: enumerating permissions here would mean
    // a permission added later is one the super admin silently lacks.
    // The wildcard answers every check, but the Fuel Audit mail goes to the
    // holders of the slug itself (lib/authz/holders), as it went to this
    // role by name before 2026-11-14.
    permissions: ['platform:admin', 'notification:fuel_audit_mail'],
  },
  {
    slug: 'director', name: 'Director', platform: true, vehicleScopable: false,
    description: 'Every organisation. All data, no administration.',
    permissions: [
      'platform:read_all',
      ...ORG_EVERYTHING,
      'organisation:read',
      'fuel_theft:triage',
      'fuel_audit:read',
      'notification:fuel_audit_mail',
    ],
  },

  // ── Organisation administration ──────────────────────────────────────────
  /**
   * The administrator OF ONE ORGANISATION: "Admin".
   *
   * It was called "System Administrator" for a while, which is also what the
   * role that reaches EVERY organisation is called, and two roles under one
   * name could not be told apart on the roster. The operator asked for the one
   * without access across all organisations to be "Admin" (2026-11-10); the
   * name "System Administrator" now belongs to `super_admin` alone.
   *
   * The SLUG stays `admin`. Slugs are the key every grant, every seed run and
   * every permission row is joined on; changing it would orphan the grants of
   * everybody who already holds it and silently strip their access. A rename is
   * a display change and must stay one. Existing rows are renamed by migration
   * 20261110120000: ensureCatalogueRoles only creates what is missing.
   */
  {
    slug: 'admin', name: 'Admin', platform: false, vehicleScopable: false,
    description: 'Full access within this organisation, including its users.',
    permissions: [
      ...ORG_EVERYTHING,
      // Lifted out of ORG_EVERYTHING — see the note there. This role and the
      // platform administrator are the only two that hand out a triage.
      'repair:assign',
      // The Gate log (operator, 2026-11-25: admins see the page; the pop-ups
      // stay the Ops Room Operator's, who has no live feed). Named here rather
      // than in ORG_EVERYTHING so heads of section and managers do not get it.
      'gate_log:read',
      'security_case:read', 'security_case:update',
      'fuel_theft:triage',
      'fuel_audit:read',
      'user:create', 'user:update', 'user:delete', 'user:assign_role',
      // Told of spare part requests (stores has no role of its own), and
      // sent the Fuel Audit report: both were this role by name.
      'notification:push_stores', 'notification:fuel_audit_mail',
      'ingest_key:read', 'ingest_key:create', 'ingest_key:update', 'ingest_key:delete',
    ],
  },

  // ── Unrestricted within the organisation ─────────────────────────────────
  {
    slug: 'hos', name: 'Head of Section', platform: false, vehicleScopable: false,
    description: 'Everything within this organisation.',
    permissions: [...ORG_EVERYTHING],
  },
  {
    slug: 'manager', name: 'Manager', platform: false, vehicleScopable: false,
    description: 'Everything within this organisation.',
    permissions: [...ORG_EVERYTHING, 'fuel_theft:triage', 'fuel_audit:read', 'notification:fuel_audit_mail'],
  },

  // ── Fleet operations ─────────────────────────────────────────────────────
  {
    slug: 'fleet_manager', name: 'Fleet Manager', platform: false, vehicleScopable: false,
    description: 'The whole fleet: vehicles, trips, routes, dispatch and fuel. Not its people.',
    // Manager minus the people: an organisation's fleet lead runs the units and
    // the work, and has no business reading or editing the user list.
    permissions: [...ORG_EVERYTHING.filter((pm) => !pm.startsWith('user:') && !pm.startsWith('role:')), 'fuel_theft:triage', 'fuel_audit:read', 'notification:fuel_audit_mail'],
  },

  {
    slug: 'fleet_analyst', name: 'Fleet Analyst', platform: false, vehicleScopable: false,
    description: 'Reads the fleet and reports on it. Flags units for repair and books them in; changes nothing else.',
    // Read and export, and not one verb that amends a record — the point of
    // the role is to answer questions about the fleet, and an analyst who can
    // amend a trip is an analyst whose figures nobody can trust.
    //
    // THE ONE EXCEPTION: `repair:flag` and `repair:book`. The operator named
    // the analyst as one of the three Control Room roles (2026-10-20), and the
    // Control Room flags faulty units and books them into the workshop. Both
    // create a repair record; neither touches a figure the role reports on.
    // Assessing and verifying stay with the supervisor.
    //
    // NOT vehicleScopable, deliberately, and for the reason spelled out on
    // `supervisor`: the analytics endpoints compute ORG-WIDE aggregates that
    // are not vehicle-scoped, so narrowing this role to a subset of the fleet
    // would quietly hand its holder figures for every vehicle through a screen
    // that looks like it is showing them their own.
    permissions: [
      ...TRACKING, ...MAP_TOOLS, 'map:playback',
      'dashboard:read', 'trip:read', 'sensor:read',
      'analytics:read', 'analytics:export',
      'report:read', 'report:export', 'report:operations',
      'driver:read', 'driver:export',
      'fuel_filling:read', 'fuel_review:read', 'fuel_theft:read', 'fuel_audit:read',
      'logbook:read', 'planner:read',
      'weighbridge:read', 'weighbridge:export',
      'geofence:read', 'route:read', 'dispatch:read',
      'repair:read', 'repair:flag', 'repair:book',
      'notification:push_control_room', 'notification:fuel_audit_mail',
    ],
  },

  // ── Security ─────────────────────────────────────────────────────────────
  // NOT SPECIFIED by the operator beyond the two names, so seeded from what
  // the job needs to watch a fleet — tracking, replay, geofences and fuel
  // theft — and expected to be corrected in the role editor. The assistant is
  // the same watch with nothing that writes.
  {
    slug: 'head_of_security', name: 'Head of Security', platform: false, vehicleScopable: false,
    description: 'Watching the fleet: live tracking, journey replay, geofences and fuel theft.',
    permissions: [
      ...TRACKING, ...MAP_TOOLS, 'map:playback',
      'dashboard:read', 'trip:read', 'sensor:read',
      'geofence:read', 'geofence:create', 'geofence:update',
      'fuel_theft:read', 'fuel_theft:create', 'fuel_theft:triage', 'fuel_audit:read', 'fuel_filling:read',
      'fuel_review:read', 'logbook:read', 'planner:read',
      'driver:read',
      'report:read', 'report:export', 'report:operations',
      // Suspected malicious damage found in a repair (Repair Workflow 4.2).
      'security_case:read', 'security_case:update', 'security_case:hold',
      'notification:push_tickets', 'notification:push_completed', 'notification:fuel_audit_mail',
    ],
  },
  {
    slug: 'asst_head_of_security', name: 'Assistant Head of Security', platform: false, vehicleScopable: false,
    description: 'The same watch, read-only — nothing here creates or amends a record.',
    permissions: [
      ...TRACKING, ...MAP_TOOLS, 'map:playback',
      'dashboard:read', 'trip:read', 'sensor:read',
      'geofence:read', 'fuel_theft:read', 'fuel_audit:read', 'fuel_filling:read',
      'fuel_review:read', 'logbook:read', 'planner:read',
      'driver:read',
      'report:read', 'report:operations',
      'security_case:read',
      'notification:push_tickets', 'notification:push_completed', 'notification:fuel_audit_mail',
    ],
  },

  // ── Fleet-scoped operations ──────────────────────────────────────────────
  // These two see the units assigned to them, and one report: the four-section
  // operations summary. Denied analytics, drivers and maintenance on paper.
  {
    slug: 'logistics_manager', name: 'Logistics Manager', platform: false, vehicleScopable: true,
    description: 'The units assigned to them, and the operations report.',
    permissions: [
      ...TRACKING, ...MAP_TOOLS, 'map:playback',
      'dashboard:read', 'trip:read', 'fuel_filling:read', 'fuel_review:read',
      'sensor:read', 'dispatch:read', 'logbook:read', 'planner:read', 'planner:write',
      'weighbridge:read', 'report:operations',
    ],
  },
  {
    slug: 'dispatcher', name: 'Dispatch Manager', platform: false, vehicleScopable: true,
    description: 'The units assigned to them, and the operations report.',
    permissions: [
      ...TRACKING, ...MAP_TOOLS, 'map:playback',
      'dashboard:read', 'trip:read', 'fuel_filling:read', 'fuel_review:read',
      'sensor:read', 'dispatch:read', 'logbook:read', 'planner:read', 'planner:write',
      'weighbridge:read', 'report:operations',
      'notification:fuel_audit_mail',
    ],
  },

  // ── Supervision and tracking ─────────────────────────────────────────────
  // Named by the operator (2026-10-26): live map, alerts, drivers,
  // maintenance, workshop, weighbridges, the Fleets block (types, in transit,
  // units), Logbook, Fuel Audit and Fuel Report. Everything an org role gets
  // EXCEPT analytics, which is the Analytics screen; overspeeding still
  // reaches them on Alerts through `alerts:read`.
  {
    slug: 'supervisor', name: 'Supervisor', platform: false, vehicleScopable: false,
    description: 'Map, alerts, drivers, maintenance, workshop, weighbridges, logbook and fuel audit/report; no analytics, no user administration.',
    permissions: [
      ...ORG_EVERYTHING.filter((pm) => !pm.startsWith('analytics:')),
      'alerts:read', 'fuel_audit:read',
      'notification:push_control_room', 'notification:push_completed',
    ],
  },
  {
    slug: 'operator', name: 'Operator', platform: false, vehicleScopable: true,
    description: 'Map, alerts, drivers, maintenance, units, weighbridge, fuel audit and vehicle fuel analysis for assigned units.',
    /*
     * Named by the operator (2026-10-26): live map, alerts, drivers,
     * weighbridges, maintenance, the Fleets block (types, in transit, units),
     * Fuel Audit, and of Fuel Report only Vehicle analytics. No Logbook
     * (`logbook:read`), no Performance view (`fuel_review:read`), no Workshop
     * (`repair:read`), no Analytics.
     *
     * `map:read`, `driver:read`, and the report permissions open those named
     * sidebar resources. `weighbridge:read` opens the weighbridge feeds.
     *
     * TELEMETRY:READ AND VEHICLE:READ STAY, and not as leftovers. The weighbridge
     * screen reads the live snapshot (`telemetry:read`) to turn a ticket's plate
     * into a unit we track; drop it and the screen loads with every row unresolved.
     * That is the whole of what those two grant this role now: there is no map to
     * put a position on.
     *
     * No dashboard, analytics, or unrelated operational administration.
     */
    permissions: [
      ...TRACKING,
      ...MAP_TOOLS,
      'alerts:read',
      'map:playback',
      'driver:read',
      'report:read', 'report:export', 'report:operations',
      'weighbridge:read',
      'sensor:read',
      'fuel_filling:read', 'fuel_audit:read',
      'notification:push_control_room', 'notification:push_tickets', 'notification:push_completed',
    ],
  },

  {
    slug: 'ops_room_operator', name: 'Ops Room Operator', platform: false, vehicleScopable: false,
    description: 'The Gate log (sign-outs and returns) and the weighbridges, view only; no map, live feed, alerts, reports or administration.',
    /*
     * 2026-11-25, the operator: a person in the ops room sees the gate's
     * sign-outs and returns, and the weighbridges where the organisation has
     * them, and nothing else; view only.
     *
     * NO `notification:read`, on purpose: that right opens the live feed and
     * its stream (every event, unfiltered). The gate's events come through
     * their own route (modules/gate-log) on `gate_log:read`, which can only
     * answer with sign-outs and returns. No `map:read`, `alerts:read`,
     * `report:*`, `analytics:*`, `user:*` (beyond what every role carries),
     * and no right to act on anything.
     *
     * `vehicle:read` and `telemetry:read` for the weighbridge screen alone, as
     * on the Operator: it turns a ticket's plate into a unit we track.
     */
    permissions: [
      'gate_log:read',
      'weighbridge:read',
      'vehicle:read', 'telemetry:read',
    ],
  },

  {
    slug: 'technician', name: 'Technician', platform: false, vehicleScopable: false,
    description: 'Units flagged for repair: the live map, units and in transit for those units only; Maintenance probes, malfunctions and repairs; the Workshop ControlTech queue.',
    /*
     * 2026-10-27, the operator: technicians see the live map, Units and In
     * transit only, but ONLY for units with an open repair job, in every
     * organisation they belong to (`vehicle:flagged_only`, lib/authz/subject);
     * a unit drops off once its job is resolved. Maintenance is back, with
     * Probes, Malfunction and Repairs (Fuel FSL and Speed stay closed by their
     * own slugs). Workshop stays ControlTech only (2026-10-26): its Jobs and
     * Day tabs need a Control Room verb, which this role holds none of. No
     * `map:filter` (machine-type chips, halted units) and no `map:fuel_alerts`.
     * The history below is kept for why the remaining grants are here.
     *
     * The narrowest role in the system, and narrower than `operator` above.
     *
     * `sensor:read` was the whole of the read grant that matters. It opens the
     * Maint tab - the dash grades that button on exactly this slug, the same
     * way it grades Fleet on `map:read` - and it opens the two feeds behind
     * the only two tabs this role sees: /fuel/probe-health and
     * /incidents/faults*. Deliberately NOT `analytics:read`; the header on
     * incidents.routes named this role before it existed.
     *
     * WHAT IS ABSENT IS THE POINT, and each absence closes exactly one thing:
     *   analytics:read     the Speed tab AND the Analytics screen
     *   fuel_filling:read  the Fuel FSL tab (tank-state and fillings)
     *   map:read           the Fleet tab, as it does for operator
     *   driver:read        Drivers
     *   weighbridge:read   Weighbridges
     *   dashboard:read     /dashboard - there is no dashboard on this role's
     *                      one screen, so granting it would only widen an API
     *                      surface that nothing here draws
     *
     * VEHICLE:READ, TELEMETRY:READ AND NOTIFICATION:READ STAY, and not as
     * leftovers - each is load-bearing for the Probes tab specifically:
     *   vehicle:read + telemetry:read  ProbeHealthPanel merges the live
     *     snapshot in per row; without them "Fuel now" is a dash on every row
     *     and the coverage tiles above the table read zero.
     *   notification:read  guards GET /organisations/:orgId/live, the SSE
     *     stream that keeps that snapshot current. Drop it and a technician
     *     reads a probe's "current" litres from ten minutes ago while standing
     *     next to the tank. It grants the live FEED as a side effect; that is
     *     a real widening, accepted knowingly, because a stale reading on a
     *     diagnostic screen is the worse fault.
     *
     * NOT vehicleScopable. Narrowing a technician to a subset of the fleet
     * would be theatre: probe-health and faults compute ORG-WIDE and are not
     * vehicle scoped, which is the same objection `supervisor` raises against
     * analytics:read. A scoped technician would still be handed every unit's
     * probe health, quietly, through a screen that looks like it is showing
     * them theirs.
     */
    permissions: [
      // map:filter: the Fleets tree let a technician filter by a fixed rule
      // until 2026-11-14; now it is the right, as for everyone else.
      ...TRACKING, 'map:layers', 'map:filter', 'map:geofences', 'map:custom_geos', 'vehicle:flagged_only',
      'repair:take_jobs',
      'sensor:read',
      'repair:read', 'repair:create', 'repair:resolve',
      // Repair Workflow: claim from the ControlTech queue; source the parts
      // a workshop job is missing.
      'repair:claim', 'repair:parts_source',
      // Fuel alert follow-ups: named by the operator as a case holder. See
      // fuel-followup.service. The follow-up carries its own copy of the
      // incident, so this opens no fuel screen beyond the case itself.
      'fuel_theft:triage',
    ],
  },

  // ── Back office ──────────────────────────────────────────────────────────
  {
    slug: 'hr', name: 'Human Resources (HR)', platform: false, vehicleScopable: false,
    description: 'People: drivers, their records and their reports. No tracking.',
    permissions: [
      'dashboard:read',
      'driver:read', 'driver:export',
      'report:read', 'report:export',
      'user:read',
    ],
  },
  {
    slug: 'accountant', name: 'Finance Manager', platform: false, vehicleScopable: false,
    description: 'Money: fuel spend, refills and trip totals. No tracking.',
    permissions: [
      'dashboard:read', 'trip:read', 'vehicle:read',
      'analytics:read', 'analytics:export',
      'report:read', 'report:export',
      'fuel_filling:read', 'fuel_review:read', 'weighbridge:read',
    ],
  },
]

/** Every role, each holding FULL_ACCESS_RIGHTS (the wildcard already covers them). */
export const ROLE_DEFINITIONS: RoleDefinition[] = ROLE_BASE.map((r) =>
  r.permissions.includes('platform:admin')
    ? r
    : { ...r, permissions: [...new Set([...r.permissions, ...FULL_ACCESS_RIGHTS])] })

export const PLATFORM_ROLE_SLUGS: string[] =
  ROLE_DEFINITIONS.filter((r) => r.platform).map((r) => r.slug)

/**
 * The roles an organisation admin may hand out.
 *
 * The complement of PLATFORM_ROLE_SLUGS. Used to narrow the role picker, so
 * the UI never offers a choice the API will refuse — and to keep the ~40
 * legacy seeded rows out of it, which are org-scoped but are not roles anybody
 * should be assigning today.
 *
 * This is presentation, not enforcement: applyMembership refusing platform
 * roles on an org-restricted call is what actually stops the grant.
 */
export const ORG_ROLE_SLUGS: string[] =
  ROLE_DEFINITIONS.filter((r) => !r.platform).map((r) => r.slug)

/** Roles an organisation admin may grant; admin and platform roles are excluded. */
export const ASSIGNABLE_ROLE_SLUGS: string[] = [
  'hr',
  'fleet_manager',
  'fleet_analyst',
  'dispatcher',
  'manager',
  'accountant',
  'head_of_security',
  'asst_head_of_security',
  'supervisor',
  'operator',
  'technician',
  'ops_room_operator',
]

export const VEHICLE_SCOPABLE_ROLE_SLUGS: string[] =
  ROLE_DEFINITIONS.filter((r) => r.vehicleScopable).map((r) => r.slug)

/**
 * Does this permission set satisfy `needed`?
 *
 * The wildcard is the only special case, and it is why super_admin does not
 * enumerate: a permission introduced next month is covered without anyone
 * remembering to grant it.
 */
export function holds(held: ReadonlySet<string> | readonly string[], needed: string): boolean {
  const set = Array.isArray(held) ? new Set(held) : (held as ReadonlySet<string>)
  return set.has(WILDCARD) || set.has(needed)
}
