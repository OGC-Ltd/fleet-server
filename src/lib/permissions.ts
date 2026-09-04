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
    slug: 'super_admin', name: 'Super Administrator', platform: true, vehicleScopable: false,
    description: 'Every organisation. All data and all administration.',
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
    ],
  },

  // ── Organisation administration ──────────────────────────────────────────
  {
    slug: 'admin', name: 'Organisation Administrator', platform: false, vehicleScopable: false,
    description: 'Full access within this organisation, including its users.',
    permissions: [
      ...ORG_EVERYTHING,
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
    permissions: [...ORG_EVERYTHING],
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
    slug: 'dispatcher', name: 'Dispatcher', platform: false, vehicleScopable: true,
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
    permissions: [...TRACKING, ...MAP_TOOLS, 'dashboard:read', 'trip:read'],
  },
  {
    slug: 'operator', name: 'Operator', platform: false, vehicleScopable: true,
    description: 'Tracking only, for the units assigned to them. No reports.',
    // The narrowest role in the system. No dashboard, no analytics, no report
    // of any kind, and no map tools — activity, and nothing else.
    permissions: [...TRACKING],
  },

  // ── Back office ──────────────────────────────────────────────────────────
  {
    slug: 'hr', name: 'Human Resources', platform: false, vehicleScopable: false,
    description: 'People: drivers, their records and their reports. No tracking.',
    permissions: [
      'dashboard:read',
      'driver:read', 'driver:export',
      'report:read', 'report:export',
      'user:read', 'user:create', 'user:update', 'user:delete',
    ],
  },
  {
    slug: 'accountant', name: 'Accountant', platform: false, vehicleScopable: false,
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
