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
  'map:playback':          'Replay a vehicle journey',

  'dashboard:read':        'View the dashboard summary',
  'notification:read':     'View the live feed',
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
  // Open the Fuel Audit page. NOT in ORG_EVERYTHING: the operator named its
  // readers one by one (2026-10-01) — platform administrator (wildcard),
  // director, system administrator, manager, fleet manager, fleet analyst,
  // head of security and assistant head of security. Seeing the page decides
  // nothing: every action on it keeps its own slug (triage, repair:*).
  // Granted by migration 20261001090000_fuel_audit_read.
  'fuel_audit:read':       'Open the Fuel Audit',

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
  // Opened by suspected malicious damage on a repair; never gates the repair.
  'security_case:read':    'View security investigations',
  'security_case:update':  'Update security investigations',

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

  'role:read':             'View roles',
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
const MAP_TOOLS: PermissionSlug[] = ['map:layers', 'map:fuel_alerts', 'map:filter']

/** Everything a role confined to one organisation can be given. */
const ORG_EVERYTHING: PermissionSlug[] = [
  ...TRACKING, ...MAP_TOOLS, 'map:playback',
  'dashboard:read', 'trip:read',
  'analytics:read', 'analytics:export',
  'report:read', 'report:create', 'report:export', 'report:operations',
  'driver:read', 'driver:export',
  'weighbridge:read', 'weighbridge:create', 'weighbridge:update', 'weighbridge:export',
  'fuel_filling:read', 'fuel_filling:create',
  'fuel_theft:read', 'fuel_theft:create',
  'sensor:read',
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

export const ROLE_DEFINITIONS: RoleDefinition[] = [
  // ── Platform ─────────────────────────────────────────────────────────────
  {
    /* Renamed from "System Administrator", which is now the name of the
     * ORG-SCOPED role above. Two roles cannot both be called that: the account
     * page prints this one as "System Administrator · applies in every
     * organisation" directly above a list of organisations each showing their
     * own, and no reading of that tells you which one you actually hold or
     * which one somebody should be given.
     *
     * The slug is untouched for the reason the rename above gives — every
     * grant is joined on it. */
    slug: 'super_admin', name: 'Platform Administrator', platform: true, vehicleScopable: false,
    description: 'Every organisation. All data and all administration. The super admin.',
    // The wildcard, deliberately alone: enumerating permissions here would mean
    // a permission added later is one the super admin silently lacks.
    permissions: ['platform:admin'],
  },
  {
    slug: 'director', name: 'Director', platform: true, vehicleScopable: false,
    description: 'Every organisation. All data, no administration.',
    permissions: [
      'platform:read_all',
      ...ORG_EVERYTHING.filter((p) => !p.startsWith('user:') && !p.startsWith('role:')),
      'organisation:read',
      'fuel_theft:triage',
      'fuel_audit:read',
    ],
  },

  // ── Organisation administration ──────────────────────────────────────────
  /**
   * The system administrator OF ONE ORGANISATION.
   *
   * Renamed from "Admin". The name was the whole problem: the roster offered
   * both this and the PLATFORM role, whose name is also System Administrator,
   * and an operator reading a picker containing "Admin" and "System
   * Administrator · all orgs" reasonably concluded that their organisation did
   * not have a system administrator role — only a lesser "Admin" — and that the
   * real one was the cross-tenant grant. It was the other way round: this is
   * the role that administers an organisation, and it is seeded into every one
   * of them.
   *
   * The SLUG stays `admin`. Slugs are the key every grant, every seed run and
   * every permission row is joined on; changing it would orphan the grants of
   * everybody who already holds it and silently strip their access. A rename is
   * a display change and must stay one.
   */
  {
    slug: 'admin', name: 'System Administrator', platform: false, vehicleScopable: false,
    description: 'Full access within this organisation, including its users.',
    permissions: [
      ...ORG_EVERYTHING,
      // Lifted out of ORG_EVERYTHING — see the note there. This role and the
      // platform administrator are the only two that hand out a triage.
      'repair:assign',
      'security_case:read', 'security_case:update',
      'fuel_theft:triage',
      'fuel_audit:read',
      'user:create', 'user:update', 'user:delete', 'user:assign_role',
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
    permissions: [...ORG_EVERYTHING, 'fuel_theft:triage', 'fuel_audit:read'],
  },

  // ── Fleet operations ─────────────────────────────────────────────────────
  {
    slug: 'fleet_manager', name: 'Fleet Manager', platform: false, vehicleScopable: false,
    description: 'The whole fleet: vehicles, trips, routes, dispatch and fuel. Not its people.',
    // Manager minus the people: an organisation's fleet lead runs the units and
    // the work, and has no business reading or editing the user list.
    permissions: [...ORG_EVERYTHING.filter((pm) => !pm.startsWith('user:') && !pm.startsWith('role:')), 'fuel_theft:triage', 'fuel_audit:read'],
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
      'fuel_filling:read', 'fuel_theft:read', 'fuel_audit:read',
      'weighbridge:read', 'weighbridge:export',
      'geofence:read', 'route:read', 'dispatch:read',
      'repair:read', 'repair:flag', 'repair:book',
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
      'driver:read',
      'report:read', 'report:export', 'report:operations',
      // Suspected malicious damage found in a repair (Repair Workflow 4.2).
      'security_case:read', 'security_case:update',
    ],
  },
  {
    slug: 'asst_head_of_security', name: 'Assistant Head of Security', platform: false, vehicleScopable: false,
    description: 'The same watch, read-only — nothing here creates or amends a record.',
    permissions: [
      ...TRACKING, ...MAP_TOOLS, 'map:playback',
      'dashboard:read', 'trip:read', 'sensor:read',
      'geofence:read', 'fuel_theft:read', 'fuel_audit:read', 'fuel_filling:read',
      'driver:read',
      'report:read', 'report:operations',
      'security_case:read',
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
      'dashboard:read', 'trip:read', 'fuel_filling:read',
      'sensor:read', 'dispatch:read',
      'weighbridge:read', 'report:operations',
    ],
  },
  {
    slug: 'dispatcher', name: 'Dispatch Manager', platform: false, vehicleScopable: true,
    description: 'The units assigned to them, and the operations report.',
    permissions: [
      ...TRACKING, ...MAP_TOOLS, 'map:playback',
      'dashboard:read', 'trip:read', 'fuel_filling:read',
      'sensor:read', 'dispatch:read',
      'weighbridge:read', 'report:operations',
    ],
  },

  // ── Supervision and tracking ─────────────────────────────────────────────
  // NOT SPECIFIED by the operator: seeded as operator plus the map tools and
  // analytics, and expected to be corrected in the role editor.
  {
    slug: 'supervisor', name: 'Supervisor', platform: false, vehicleScopable: true,
    description: 'Tracking and map tools for the units assigned to them.',
    // NO analytics. Not a judgement about the role - a consequence of the
    // analytics endpoints computing ORG-WIDE aggregates that are not vehicle
    // scoped. Granting `analytics:read` to a role whose whole point is being
    // narrowed to a subset of the fleet would hand that subset's holder figures
    // for every vehicle in the organisation, quietly, through a screen that
    // looks like it is showing them their own units.
    //
    // Restore it when analytics learns the scope; the invariant is pinned in
    // tests/unit/permissions-matrix.
    //
    // The Control Room (Repair Workflow, operator 2026-10-20): flag and book
    // like the analyst and the operator, and the two accountable calls,
    // assessing whether a unit can reach the workshop and verifying a repair.
    permissions: [
      ...TRACKING, ...MAP_TOOLS, 'dashboard:read', 'trip:read',
      'repair:read', 'repair:flag', 'repair:book', 'repair:assess', 'repair:verify',
    ],
  },
  {
    slug: 'operator', name: 'Operator', platform: false, vehicleScopable: true,
    description: 'The weighbridge, and the units assigned to them. No map, no reports.',
    /*
     * Changed 2026-09-14: the fleet off, the weighbridge on.
     *
     * `map:read` is gone, which is what closes the Fleet tab — the dash grades
     * that button and the screen behind it on exactly this slug. `weighbridge:read`
     * is in, which opens the Weighbridges tab and the /weighments feeds behind it.
     *
     * TELEMETRY:READ AND VEHICLE:READ STAY, and not as leftovers. The weighbridge
     * screen reads the live snapshot (`telemetry:read`) to turn a ticket's plate
     * into a unit we track; drop it and the screen loads with every row unresolved.
     * That is the whole of what those two grant this role now: there is no map to
     * put a position on.
     *
     * Still the narrowest role in the system otherwise — no dashboard, no
     * analytics, no report of any kind, no map tools.
     */
    permissions: [
      ...TRACKING.filter((pm) => pm !== 'map:read'),
      'weighbridge:read',
      // Control Room (Repair Workflow): flag a faulty unit and book it in.
      'repair:read', 'repair:flag', 'repair:book',
    ],
  },

  {
    slug: 'technician', name: 'Technician', platform: false, vehicleScopable: false,
    description: 'Probe and sensor faults for their organisation, and the repairs they file against them. Nothing else.',
    /*
     * The narrowest role in the system, and narrower than `operator` above.
     *
     * `sensor:read` is the whole of the read grant that matters. It opens the
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
      ...TRACKING.filter((pm) => pm !== 'map:read'),
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
      'user:read', 'user:create', 'user:update', 'user:delete',
    ],
  },
  {
    slug: 'accountant', name: 'Finance Manager', platform: false, vehicleScopable: false,
    description: 'Money: fuel spend, refills and trip totals. No tracking.',
    permissions: [
      'dashboard:read', 'trip:read', 'vehicle:read',
      'analytics:read', 'analytics:export',
      'report:read', 'report:export',
      'fuel_filling:read', 'weighbridge:read',
    ],
  },
]

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

/**
 * The roles an administrator is offered, in the order they are offered.
 *
 * Named explicitly by the operator, so this is a list rather than a filter,
 * and the order is theirs rather than alphabetical.
 *
 * It is deliberately NARROWER than ROLE_DEFINITIONS: `hos` and
 * `logistics_manager` are still seeded and still work for the people who hold
 * them, but they are not on the operator's list and are not offered for new
 * grants. Nothing is deleted — revoking a role people hold is a decision for
 * the role editor, not a side effect of renaming a picker.
 *
 * Presentation only. What actually stops a grant is applyMembership refusing
 * platform roles on an organisation-scoped call.
 */
export const ASSIGNABLE_ROLE_SLUGS: string[] = [
  'hr',
  'admin',
  /* `super_admin` was here, and being here is what put "System Administrator ·
   * all orgs" in EVERY organisation's picker: the platform arm of
   * listAssignableRoles queries `organisationId: null` filtered by this same
   * list. Removing it from the list removes the option from every organisation
   * at once, which is exactly the scope of the change asked for.
   *
   * The role DEFINITION stays, and so does every grant of it. That is
   * deliberate and it is not a half-measure — platform-only surface exists and
   * needs somebody: `requirePermission` on a route with no :orgId is satisfied
   * ONLY by `subject.isPlatform`, so with nobody holding a platform role the
   * organisation list itself becomes unadministrable. What changes here is that
   * a cross-tenant grant can no longer be made from inside one tenant's user
   * page, which is where it never belonged.
   *
   * `director` is still offered and carries the same "all orgs" badge for the
   * same reason. It was not part of the request, so it is left alone rather
   * than swept up — say the word and it goes the same way. */
  'fleet_manager',
  'fleet_analyst',
  'dispatcher',
  'manager',
  'director',
  'accountant',
  'head_of_security',
  'asst_head_of_security',
  'supervisor',
  'operator',
  'technician',
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
