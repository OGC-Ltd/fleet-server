/**
 * Seed script — Sukari Industries Limited (single organisation)
 * ~200 records per transactional entity; clears all tables first.
 *
 * Run: npm run seed
 */

import 'dotenv/config'
import { Prisma } from '../generated/prisma/client.js'
import crypto from 'crypto'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma  = new PrismaClient({ adapter })

// ─── tiny helpers ──────────────────────────────────────────────────────────

const pick   = <T>(arr: T[], i: number): T => arr[Math.abs(i) % arr.length]
const addH   = (d: Date, h: number): Date  => new Date(d.getTime() + h * 3_600_000)
const addD   = (d: Date, n: number): Date  => new Date(d.getTime() + n * 86_400_000)
const sha256 = (s: string): string         => crypto.createHash('sha256').update(s).digest('hex')

// ─── reference data ────────────────────────────────────────────────────────

const KE_PLACES = [
  'Nairobi CBD', 'Mombasa Port', 'Kisumu City', 'Nakuru Town', 'Eldoret CBD',
  'Thika Road Mall', 'Machakos Town', 'Garissa Depot', 'Nyeri Town', 'Meru CBD',
  'Kitale Market', 'Malindi Town', 'Kakamega Town', 'Kericho CBD', 'Naivasha Depot',
  'Namanga Border', 'Moyale Checkpoint', 'Lodwar Town', 'Wajir Depot', 'Embu CBD',
  "Murang'a Depot", 'Bungoma CBD', 'Homa Bay Town', 'Bomet CBD', 'Isiolo Depot',
]

const KE_COORDS: [number, number][] = [
  [-1.2921, 36.8219], [-4.0435, 39.6682], [-0.0917, 34.7679], [-0.3031, 36.0800],
  [ 0.5143, 35.2698], [-1.0332, 37.0693], [-1.5177, 37.2634], [-0.4532, 39.6460],
  [-0.4167, 36.9511], [ 0.0467, 37.6490], [ 1.0154, 35.0062], [-3.2175, 40.1169],
  [ 0.2827, 34.7519], [-0.3686, 35.2863], [-0.7167, 36.4313], [-2.5462, 36.7960],
  [ 3.5236, 39.0542], [ 3.1189, 35.5986], [ 1.7471, 40.0573], [-0.5300, 37.4568],
  [-0.7228, 37.1566], [ 0.5635, 34.5606], [-0.5271, 34.4571], [-0.7939, 35.3406],
  [ 0.3527, 37.5820],
]

const FIRST_NAMES = [
  'James','Mary','John','Patricia','Robert','Jennifer','Michael','Linda',
  'William','Barbara','David','Susan','Richard','Jessica','Joseph','Sarah',
  'Thomas','Karen','Charles','Lisa','Christopher','Nancy','Daniel','Betty',
  'Matthew','Margaret','Anthony','Sandra','Mark','Ashley','Donald','Dorothy',
  'Steven','Kimberly','Paul','Emily','Andrew','Donna','Joshua','Michelle',
]

const LAST_NAMES = [
  'Kamau','Wanjiku','Odhiambo','Njoroge','Mwangi','Auma','Otieno','Njeri',
  'Kimani','Adhiambo','Maina','Anyango','Karimi','Onyango','Gitonga','Awino',
  'Kinyua','Juma','Mutua','Achieng','Gachanja','Owino','Wairimu','Okello',
  'Ndegwa','Nekesa','Gathua','Simiyu','Njenga','Chebet','Mugambi','Koech',
  'Njeru','Kirui','Kariuki','Sang','Kiema','Rotich','Muthoni','Mutai',
]

const VEHICLE_TYPES  = ['BUS','TRUCK','AMBULANCE','TRACTOR','TANKER','PICKUP','VAN','LORRY','MINIBUS','TIPPER']
const PLATE_PREFIXES = ['KBV','KDL','KDD','KCY','KBQ','KCA','KDB','KBA','KCX','KBZ','KCZ','KDE','KDF','KDG','KDH']
const PLATE_SUFFIXES = ['A','B','C','D','E','F','G','H','J','K','L','M','N','P','Q','R','S','T','U','V']
const GPS_VENDORS    = ['Queclink','Teltonika','CalAmp','Meitrack','Controltech']
const CARGO_DESCS    = [
  'Maize flour 50 kg bags','Sugar cane bales','Cement bags 50 kg',
  'Steel reinforcement rods','Fast-moving consumer goods','Medical supplies & PPE',
  'Livestock feed pellets','Fertilizer 25 kg bags','Bottled water pallets',
  'Pharmaceutical products','Petroleum products','Heavy machinery parts',
]
const RESOURCES = ['vehicle','trip','fuel_theft','fuel_filling','user','route',
                   'geofence','report','ingest_key','assignment','engine_session','cargo']
const ACTIONS   = ['read','create','update','delete','export']

// ─── clear ─────────────────────────────────────────────────────────────────

async function clearAll() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE
      vehicle_telemetry_raws, vehicle_telemetries,
      cargo_manifests, vehicle_period_summaries,
      geofence_violations, fuel_thefts, fuel_fillings,
      engine_hour_sessions, trips,
      vehicle_geofences, vehicle_assignments,
      route_waypoints, routes, geofences,
      ingest_api_keys, user_roles, users,
      role_permissions, roles,
      vehicles, vehicle_groups, reporting_periods,
      permissions, organisations
    CASCADE
  `)
  console.log('  ✓ All tables cleared')
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🌱  Seeding — Sukari Industries Limited\n')

  console.log('→ Clearing existing data')
  await clearAll()

  // ── 1. Organisation (1) ───────────────────────────────────────────────────
  console.log('→ Organisation')
  const org = await prisma.organisation.create({
    data: { name: 'Sukari Industries Limited', code: 'SUKARI' },
  })
  console.log(`  ✓ ${org.name}  (${org.id})`)

  // ── 2. Permissions (60) ───────────────────────────────────────────────────
  console.log('→ Permissions')
  const permRows: { name: string; slug: string; resource: string; action: string }[] = []
  for (const resource of RESOURCES) {
    for (const action of ACTIONS) {
      permRows.push({
        name:     `${action[0]!.toUpperCase() + action.slice(1)} ${resource.replace(/_/g, ' ')}`,
        slug:     `${resource}:${action}`,
        resource,
        action,
      })
    }
  }
  await prisma.permission.createMany({ data: permRows })
  const permissions = await prisma.permission.findMany()
  console.log(`  ✓ ${permissions.length} permissions`)

  // ── 3. Roles (20) ─────────────────────────────────────────────────────────
  console.log('→ Roles')
  const roleDefs = [
    { name: 'Fleet Manager',             slug: 'fleet_manager',          description: 'Full fleet oversight and reporting access'        },
    { name: 'Senior Driver',             slug: 'senior_driver',          description: 'Experienced driver — long-haul routes'            },
    { name: 'Driver',                    slug: 'driver',                 description: 'Assigned vehicle operator'                        },
    { name: 'Junior Driver',             slug: 'junior_driver',          description: 'Driver under probation period'                    },
    { name: 'Lead Mechanic',             slug: 'lead_mechanic',          description: 'Heads the workshop maintenance team'              },
    { name: 'Mechanic',                  slug: 'mechanic',               description: 'Vehicle maintenance and repair technician'        },
    { name: 'Field Supervisor',          slug: 'field_supervisor',       description: 'Field operations supervisor'                      },
    { name: 'Dispatcher',                slug: 'dispatcher',             description: 'Trip planning and vehicle dispatch'               },
    { name: 'Senior Dispatcher',         slug: 'senior_dispatcher',      description: 'Oversees dispatch team and scheduling'            },
    { name: 'System Administrator',      slug: 'system_admin',           description: 'Platform-level administration'                    },
    { name: 'Accountant',                slug: 'accountant',             description: 'Fuel cost tracking and financial reporting'       },
    { name: 'Fuel Coordinator',          slug: 'fuel_coordinator',       description: 'Manages fuelling schedules and FLS calibration'   },
    { name: 'Operations Coordinator',    slug: 'ops_coordinator',        description: 'Cross-functional operations coordination'         },
    { name: 'Security Officer',          slug: 'security_officer',       description: 'Fuel theft investigation and geofence alerts'     },
    { name: 'Compliance Officer',        slug: 'compliance_officer',     description: 'Ensures regulatory and safety compliance'         },
    { name: 'Fleet Analyst',             slug: 'fleet_analyst',          description: 'Telemetry analysis and KPI reporting'             },
    { name: 'Workshop Manager',          slug: 'workshop_manager',       description: 'Manages workshop scheduling and spare parts'      },
    { name: 'HR Manager',                slug: 'hr_manager',             description: 'Driver onboarding, licences, and HR records'      },
    { name: 'IT Support',                slug: 'it_support',             description: 'Device provisioning and system integrations'      },
    { name: 'Maintenance Lead',          slug: 'maintenance_lead',       description: 'Preventive maintenance planning'                  },
  ]

  const allRoles: { id: string }[] = []
  for (const rd of roleDefs) {
    const role = await prisma.role.create({ data: { organisationId: org.id, ...rd } })
    allRoles.push({ id: role.id })
  }
  console.log(`  ✓ ${allRoles.length} roles`)

  // ── 4. RolePermissions (~200) ─────────────────────────────────────────────
  console.log('→ Role permissions')
  const rpRows: { roleId: string; permissionId: string }[] = []
  const rpSet  = new Set<string>()

  // fleet_manager (index 0) gets all 60 permissions
  for (const perm of permissions) {
    const key = `${allRoles[0]!.id}:${perm.id}`
    if (!rpSet.has(key)) { rpSet.add(key); rpRows.push({ roleId: allRoles[0]!.id, permissionId: perm.id }) }
  }
  // every other role gets 8 relevant permissions
  for (let ri = 1; ri < allRoles.length; ri++) {
    const role   = allRoles[ri]!
    const start  = (ri * 7) % permissions.length
    const subset = [...permissions.slice(start), ...permissions.slice(0, start)].slice(0, 8)
    for (const perm of subset) {
      const key = `${role.id}:${perm.id}`
      if (!rpSet.has(key)) { rpSet.add(key); rpRows.push({ roleId: role.id, permissionId: perm.id }) }
    }
  }
  await prisma.rolePermission.createMany({ data: rpRows })
  console.log(`  ✓ ${rpRows.length} role permissions`)

  // ── 5. Users (200) ────────────────────────────────────────────────────────
  console.log('→ Users')
  const userRows: {
    organisationId: string; fullName: string; email: string; phone: string;
    licenceNumber: string | null; employeeId: string; status: 'ACTIVE'|'SUSPENDED'|'TERMINATED'
  }[] = []

  for (let i = 0; i < 200; i++) {
    const fn = pick(FIRST_NAMES, i)
    // Both name pools have 40 entries; indexing both by the same `i` made
    // the (first, last) combination repeat every 40 users — with 200 users
    // that's 5 exact-duplicate full names, and since vehicle assignments
    // are spread across all 200 distinct user rows, those duplicate-named
    // users would land on different vehicles and look like the same
    // driver assigned twice. Offsetting the last-name index by how many
    // full 40-cycles of first names have elapsed keeps every (fn, ln) pair
    // unique across all 200 users (5 cycles × 40 last names is well within
    // the 40-name pool's range before it would wrap and repeat a pair).
    const ln = pick(LAST_NAMES, i + Math.floor(i / FIRST_NAMES.length))
    userRows.push({
      organisationId: org.id,
      fullName:       `${fn} ${ln}`,
      email:          `${fn.toLowerCase()}.${ln.toLowerCase()}${i}@sukari.co.ke`,
      phone:          `+2547${String(10_000_000 + i).slice(1)}`,
      licenceNumber:  i < 120 ? `DLSUKARI${String(1000 + i).padStart(4, '0')}` : null,
      employeeId:     `SUKARI-EMP-${String(1000 + i).padStart(4, '0')}`,
      status:         pick(['ACTIVE','ACTIVE','ACTIVE','ACTIVE','SUSPENDED'] as const, i),
    })
  }
  await prisma.user.createMany({ data: userRows })
  const users = await prisma.user.findMany({ select: { id: true } })
  console.log(`  ✓ ${users.length} users`)

  // ── 6. UserRoles (200) ────────────────────────────────────────────────────
  console.log('→ User roles')
  const urRows: { userId: string; roleId: string }[] = []
  const urSet  = new Set<string>()

  for (let ui = 0; ui < users.length; ui++) {
    const role = pick(allRoles, ui)
    const key  = `${users[ui]!.id}:${role.id}`
    if (!urSet.has(key)) { urSet.add(key); urRows.push({ userId: users[ui]!.id, roleId: role.id }) }
  }
  // every 5th user gets a second role
  for (let ui = 0; ui < users.length && urRows.length < 200; ui += 5) {
    const role = pick(allRoles, ui + 4)
    const key  = `${users[ui]!.id}:${role.id}`
    if (!urSet.has(key)) { urSet.add(key); urRows.push({ userId: users[ui]!.id, roleId: role.id }) }
  }
  await prisma.userRole.createMany({ data: urRows })
  console.log(`  ✓ ${urRows.length} user roles`)

  // ── 7. IngestApiKeys (200) ────────────────────────────────────────────────
  console.log('→ Ingest API keys')
  const akRows: {
    organisationId: string; label: string; keyHash: string;
    isActive: boolean; expiresAt: Date | null
  }[] = []

  for (let i = 0; i < 200; i++) {
    const rawKey = `flt_sukari_${String(i).padStart(3, '0')}_secret_${i}`
    akRows.push({
      organisationId: org.id,
      label:          `${pick(GPS_VENDORS, i)} Device #${i + 1}`,
      keyHash:        sha256(rawKey),
      isActive:       i < 180,
      expiresAt:      i % 8 === 0 ? addD(new Date('2026-06-30'), 365) : null,
    })
  }
  await prisma.ingestApiKey.createMany({ data: akRows })
  console.log(`  ✓ ${akRows.length} ingest API keys`)

  // ── 8. VehicleGroups (20) ─────────────────────────────────────────────────
  console.log('→ Vehicle groups')
  const vgDefs = [
    'HARVESTING','PRIME MOVER','BUS','AMBULANCE','MAINTENANCE',
    'TANKER','PICKUP','MINIBUS','TIPPER','CRANE',
    'TRACTOR','WATER BOWSER','FLATBED','REFRIGERATED','SCHOOL BUS',
    'CARGO VAN','FIRE TRUCK','SECURITY','WASTE MANAGEMENT','FUEL TANKER',
  ]
  const allVehicleGroups: { id: string }[] = []
  for (const gName of vgDefs) {
    const code = `SUKARI_${gName.replace(/\s+/g, '_')}`
    const vg   = await prisma.vehicleGroup.create({
      data: { organisationId: org.id, name: gName, code },
    })
    allVehicleGroups.push({ id: vg.id })
  }
  console.log(`  ✓ ${allVehicleGroups.length} vehicle groups`)

  // ── 9. Vehicles (100) ─────────────────────────────────────────────────────
  console.log('→ Vehicles')
  const vehicleRows: {
    organisationId: string; vehicleGroupId: string; name: string;
    registrationPlate: string; deviceId: string; vehicleType: string;
    fuelEfficiencyKmpl: number; tankCapacityLitres: number
  }[] = []

  let plateSeq = 100
  for (let i = 0; i < 100; i++) {
    const vg     = pick(allVehicleGroups, i)
    const prefix = pick(PLATE_PREFIXES, i)
    const suffix = pick(PLATE_SUFFIXES, i)
    const plate  = `${prefix} ${plateSeq++}${suffix}`
    vehicleRows.push({
      organisationId:     org.id,
      vehicleGroupId:     vg.id,
      name:               `${pick(vgDefs, i)} ${plate}`,
      registrationPlate:  plate,
      deviceId:           `DEV_${plate.replace(/\s+/g, '_')}`,
      vehicleType:        pick(VEHICLE_TYPES, i),
      fuelEfficiencyKmpl: pick([2.5, 3.0, 4.0, 5.0, 1.8, 2.0, 6.0, 3.5, 4.5, 2.2], i),
      tankCapacityLitres: pick([80, 120, 200, 300, 400, 60, 100, 150, 250, 350], i),
    })
  }
  await prisma.vehicle.createMany({ data: vehicleRows })
  const vehicles = await prisma.vehicle.findMany()
  console.log(`  ✓ ${vehicles.length} vehicles`)

  // ── 10. ReportingPeriods (20) ─────────────────────────────────────────────
  console.log('→ Reporting periods')
  const periodDefs: { label: string; start: string; end: string; type: 'WEEKLY'|'MONTHLY'|'CUSTOM'|'DAILY' }[] = [
    { label: 'Week 15 — Apr 2026',  start: '2026-04-07', end: '2026-04-13', type: 'WEEKLY'  },
    { label: 'Week 16 — Apr 2026',  start: '2026-04-14', end: '2026-04-20', type: 'WEEKLY'  },
    { label: 'Week 17 — Apr 2026',  start: '2026-04-21', end: '2026-04-27', type: 'WEEKLY'  },
    { label: 'Week 18 — Apr 2026',  start: '2026-04-28', end: '2026-05-04', type: 'WEEKLY'  },
    { label: 'Week 19 — May 2026',  start: '2026-05-05', end: '2026-05-10', type: 'WEEKLY'  },
    { label: 'Week 20 — May 2026',  start: '2026-05-11', end: '2026-05-17', type: 'WEEKLY'  },
    { label: 'Week 21 — May 2026',  start: '2026-05-18', end: '2026-05-24', type: 'WEEKLY'  },
    { label: 'Week 22 — May 2026',  start: '2026-05-25', end: '2026-05-31', type: 'WEEKLY'  },
    { label: 'Week 23 — Jun 2026',  start: '2026-06-01', end: '2026-06-07', type: 'WEEKLY'  },
    { label: 'Week 24 — Jun 2026',  start: '2026-06-08', end: '2026-06-14', type: 'WEEKLY'  },
    { label: 'Week 25 — Jun 2026',  start: '2026-06-15', end: '2026-06-21', type: 'WEEKLY'  },
    { label: 'Week 26 — Jun 2026',  start: '2026-06-22', end: '2026-06-28', type: 'WEEKLY'  },
    { label: 'April 2026',          start: '2026-04-01', end: '2026-04-30', type: 'MONTHLY' },
    { label: 'May 2026',            start: '2026-05-01', end: '2026-05-31', type: 'MONTHLY' },
    { label: 'June 2026',           start: '2026-06-01', end: '2026-06-30', type: 'MONTHLY' },
    { label: 'Q1 2026',             start: '2026-01-01', end: '2026-03-31', type: 'CUSTOM'  },
    { label: 'Q2 2026',             start: '2026-04-01', end: '2026-06-30', type: 'CUSTOM'  },
    { label: 'H1 2026',             start: '2026-01-01', end: '2026-06-30', type: 'CUSTOM'  },
    { label: 'Jan 2026',            start: '2026-01-01', end: '2026-01-31', type: 'MONTHLY' },
    { label: 'Feb 2026',            start: '2026-02-01', end: '2026-02-28', type: 'MONTHLY' },
  ]
  const periodIds: string[] = []
  for (const pd of periodDefs) {
    const rp = await prisma.reportingPeriod.create({
      data: {
        organisationId: org.id,
        label:          pd.label,
        periodStart:    new Date(pd.start),
        periodEnd:      new Date(pd.end),
        periodType:     pd.type,
      },
    })
    periodIds.push(rp.id)
  }
  console.log(`  ✓ ${periodIds.length} reporting periods`)

  // ── 11. Routes (50) ───────────────────────────────────────────────────────
  console.log('→ Routes')
  const routeTemplates: [string, number, number, string, number, number, number][] = [
    ['Nairobi CBD',      -1.2921, 36.8219, 'Mombasa Port',       -4.0435, 39.6682, 480],
    ['Nairobi CBD',      -1.2921, 36.8219, 'Kisumu City',        -0.0917, 34.7679, 340],
    ['Nakuru Town',      -0.3031, 36.0800, 'Eldoret CBD',         0.5143, 35.2698, 155],
    ['Thika Road Mall',  -1.0332, 37.0693, 'Garissa Depot',      -0.4532, 39.6460, 370],
    ['Mombasa Port',     -4.0435, 39.6682, 'Malindi Town',       -3.2175, 40.1169, 120],
    ['Kisumu City',      -0.0917, 34.7679, 'Kakamega Town',       0.2827, 34.7519,  55],
    ['Nairobi CBD',      -1.2921, 36.8219, 'Nyeri Town',         -0.4167, 36.9511, 155],
    ['Eldoret CBD',       0.5143, 35.2698, 'Kitale Market',       1.0154, 35.0062,  80],
    ['Nakuru Town',      -0.3031, 36.0800, 'Naivasha Depot',     -0.7167, 36.4313,  85],
    ['Nairobi CBD',      -1.2921, 36.8219, 'Machakos Town',      -1.5177, 37.2634,  65],
    ['Mombasa Port',     -4.0435, 39.6682, 'Garissa Depot',      -0.4532, 39.6460, 560],
    ['Nairobi CBD',      -1.2921, 36.8219, 'Lodwar Town',         3.1189, 35.5986, 760],
    ['Nairobi CBD',      -1.2921, 36.8219, 'Kakamega Town',       0.2827, 34.7519, 360],
    ['Eldoret CBD',       0.5143, 35.2698, 'Kisumu City',        -0.0917, 34.7679, 115],
    ['Nairobi CBD',      -1.2921, 36.8219, 'Embu CBD',           -0.5300, 37.4568,  130],
    ['Nakuru Town',      -0.3031, 36.0800, 'Kisumu City',        -0.0917, 34.7679,  165],
    ['Mombasa Port',     -4.0435, 39.6682, 'Nairobi CBD',        -1.2921, 36.8219,  480],
    ['Thika Road Mall',  -1.0332, 37.0693, 'Nyeri Town',         -0.4167, 36.9511,   90],
    ['Nairobi CBD',      -1.2921, 36.8219, 'Kericho CBD',        -0.3686, 35.2863,  250],
    ['Nairobi CBD',      -1.2921, 36.8219, 'Homa Bay Town',      -0.5271, 34.4571,  375],
    ['Mombasa Port',     -4.0435, 39.6682, 'Malindi Town',       -3.2175, 40.1169,  120],
    ['Kisumu City',      -0.0917, 34.7679, 'Homa Bay Town',      -0.5271, 34.4571,   65],
    ['Eldoret CBD',       0.5143, 35.2698, 'Nakuru Town',        -0.3031, 36.0800,  155],
    ['Nairobi CBD',      -1.2921, 36.8219, 'Isiolo Depot',        0.3527, 37.5820,  285],
    ['Garissa Depot',    -0.4532, 39.6460, 'Nairobi CBD',        -1.2921, 36.8219,  370],
  ]

  const routeIds: string[] = []
  // Create 50 routes by cycling through the 25 templates twice with isActive variation
  for (let i = 0; i < 50; i++) {
    const rt = routeTemplates[i % routeTemplates.length]!
    const route = await prisma.route.create({
      data: {
        organisationId:  org.id,
        name:            `${rt[0]} → ${rt[3]}${i >= 25 ? ' (Return)' : ''}`,
        originName:      i >= 25 ? rt[3] : rt[0],
        originLat:       i >= 25 ? rt[4] : rt[1],
        originLng:       i >= 25 ? rt[5] : rt[2],
        destinationName: i >= 25 ? rt[0] : rt[3],
        destinationLat:  i >= 25 ? rt[1] : rt[4],
        destinationLng:  i >= 25 ? rt[2] : rt[5],
        distanceKm:      rt[6],
        isActive:        i < 45,
      },
    })
    routeIds.push(route.id)
  }
  console.log(`  ✓ ${routeIds.length} routes`)

  // ── 12. RouteWaypoints (4 per route = 200) ────────────────────────────────
  console.log('→ Route waypoints')
  const wpNames = ['Bypass Interchange','Toll Plaza','Rest Stop','Junction','Checkpoint']
  const wpRows: {
    routeId: string; sequence: number; name: string; lat: number; lng: number; radiusM: number
  }[] = []
  for (let ri = 0; ri < routeIds.length; ri++) {
    const rt = routeTemplates[ri % routeTemplates.length]!
    for (let seq = 1; seq <= 4; seq++) {
      const frac = seq / 5
      wpRows.push({
        routeId:  routeIds[ri]!,
        sequence: seq,
        name:     `${pick(wpNames, ri + seq)} ${seq}`,
        lat:      rt[1] + (rt[4] - rt[1]) * frac,
        lng:      rt[2] + (rt[5] - rt[2]) * frac,
        radiusM:  pick([100, 150, 200, 250], seq),
      })
    }
  }
  await prisma.routeWaypoint.createMany({ data: wpRows })
  console.log(`  ✓ ${wpRows.length} route waypoints`)

  // ── 13. Geofences (20) ────────────────────────────────────────────────────
  console.log('→ Geofences')
  const geoNames = [
    'Nairobi CBD Zone','Mombasa Port Area','Industrial Park','Main Depot Boundary',
    'Fuel Station — Westlands','Restricted Storage Yard','JKIA Perimeter',
    'Thika Superhighway Corridor','Upper Hill Warehouse','Karen Logistics Hub',
    'Kisumu Port Zone','Nakuru Depot Boundary','Eldoret Distribution Centre',
    'Mombasa Kilindini Wharf','Kisumu Airport Road','Nakuru Industrial Area',
    'Nairobi South B Depot','Ngong Road Fuel Station','Uhuru Highway Corridor','Limuru Tea Factory',
  ]
  const geoRows: {
    organisationId: string; name: string; type: 'CIRCLE'|'POLYGON'; mode: 'ALLOWLIST'|'BLOCKLIST';
    centerLat: number|null; centerLng: number|null; radiusM: number|null;
    polygonCoords: number[][] | typeof Prisma.JsonNull; isActive: boolean
  }[] = []
  for (let i = 0; i < 20; i++) {
    const [baseLat, baseLng] = KE_COORDS[i % KE_COORDS.length]!
    const isCircle = i % 2 === 0
    const r        = 0.01
    geoRows.push({
      organisationId: org.id,
      name:           geoNames[i]!,
      type:           isCircle ? 'CIRCLE' : 'POLYGON',
      mode:           i % 5 === 0 ? 'BLOCKLIST' : 'ALLOWLIST',
      centerLat:      isCircle ? baseLat : null,
      centerLng:      isCircle ? baseLng : null,
      radiusM:        isCircle ? pick([500, 1000, 1500, 2000, 2500], i) : null,
      polygonCoords:  !isCircle
        ? [[baseLng - r, baseLat - r],[baseLng + r, baseLat - r],[baseLng + r, baseLat + r],[baseLng - r, baseLat + r],[baseLng - r, baseLat - r]]
        : Prisma.JsonNull,
      isActive: i < 18,
    })
  }
  await prisma.geofence.createMany({ data: geoRows })
  const geofences = await prisma.geofence.findMany()
  console.log(`  ✓ ${geofences.length} geofences`)

  // ── 14. VehicleAssignments (200) ──────────────────────────────────────────
  console.log('→ Vehicle assignments')
  const baseDate = new Date('2026-01-01T06:00:00Z')
  const vaRows: {
    vehicleId: string; userId: string; assignmentType: 'PRIMARY'|'RELIEF';
    assignedAt: Date; unassignedAt: Date|null; notes: string|null
  }[] = []
  for (let i = 0; i < 200; i++) {
    const assignedAt = addD(baseDate, i % 90)
    vaRows.push({
      vehicleId:      pick(vehicles, i).id,
      userId:         pick(users, i).id,
      assignmentType: i % 6 === 0 ? 'RELIEF' : 'PRIMARY',
      assignedAt,
      unassignedAt:   i < 160 ? null : addD(assignedAt, 30),
      notes:          i % 12 === 0 ? 'Temporary cover during scheduled maintenance' : null,
    })
  }
  await prisma.vehicleAssignment.createMany({ data: vaRows })
  console.log(`  ✓ ${vaRows.length} vehicle assignments`)

  // ── 15. VehicleGeofences (200) ────────────────────────────────────────────
  console.log('→ Vehicle geofences')
  const vgfRows: { vehicleId: string; geofenceId: string; assignedAt: Date }[] = []
  const vgfSet  = new Set<string>()
  outerVgf: for (const vehicle of vehicles) {
    for (const fence of geofences) {
      if (vgfRows.length >= 200) break outerVgf
      const key = `${vehicle.id}:${fence.id}`
      if (vgfSet.has(key)) continue
      vgfSet.add(key)
      vgfRows.push({ vehicleId: vehicle.id, geofenceId: fence.id, assignedAt: addD(baseDate, vgfRows.length % 60) })
    }
  }
  await prisma.vehicleGeofence.createMany({ data: vgfRows })
  console.log(`  ✓ ${vgfRows.length} vehicle geofences`)

  // ── 16. Trips (200) ───────────────────────────────────────────────────────
  console.log('→ Trips')
  const tripIds: string[] = []
  const weekStart = new Date('2026-06-08T06:00:00Z')
  for (let i = 0; i < 200; i++) {
    const vehicle     = pick(vehicles, i)
    const periodId    = pick(periodIds, i)
    const routeId     = i % 5 === 0 ? null : pick(routeIds, i)
    const driverId    = i % 10 === 0 ? null : pick(users, i).id
    const beganAt     = addH(addD(weekStart, i % 7), (i * 3) % 16)
    const durationSec = pick([1800, 3600, 7200, 14400, 21600, 28800, 5400, 10800], i)
    const mileageKm   = pick([25, 48, 120, 240, 350, 60, 90, 180], i) + (i % 10)
    const trip = await prisma.trip.create({
      data: {
        vehicleId:               vehicle.id,
        driverId,
        reportingPeriodId:       periodId,
        routeId,
        beganAt,
        endedAt:                 addH(beganAt, durationSec / 3600),
        initialLocation:         pick(KE_PLACES, i),
        finalLocation:           pick(KE_PLACES, i + 7),
        durationSeconds:         durationSec,
        mileageKm,
        avgSpeedKmh:             pick([45, 60, 75, 55, 80, 50, 65, 70], i),
        maxSpeedKmh:             pick([90, 110, 100, 120, 95, 105, 115, 85], i),
        consumedMl:              pick([15000, 30000, 60000, 90000, 45000, 20000, 75000, 50000], i),
        consumedByFlsMl:         pick([14500, 29000, 58000, 88000, 44000, 19500, 73000, 49000], i),
        ratesDeviationByFls:     pick([2.1, 3.5, 1.8, 4.2, 0.9, 2.7, 3.1, 1.5], i),
        avgConsumptionL100km:    pick([20, 25, 30, 18, 22, 28, 15, 35], i),
        avgConsumptionByFls:     pick([19, 24, 29, 17, 21, 27, 14, 34], i),
        avgIdleConsumptionByFls: pick([2.5, 3.0, 1.8, 2.2, 3.5, 2.0, 2.8, 1.5], i),
        avgMileagePerUnitFls:    pick([3.2, 2.8, 4.1, 5.0, 2.5, 3.8, 4.5, 2.0], i),
        initialFuelLevelMl:      pick([200000, 150000, 100000, 250000, 300000, 80000, 180000, 120000], i),
        finalFuelLevelMl:        pick([185000, 120000, 40000, 160000, 255000, 60000, 105000, 70000], i),
        maxFuelLevelMl:          pick([210000, 155000, 105000, 260000, 310000, 85000, 185000, 125000], i),
        minFuelLevelMl:          pick([180000, 115000, 35000, 155000, 250000, 55000, 100000, 65000], i),
      },
    })
    tripIds.push(trip.id)
  }
  console.log(`  ✓ ${tripIds.length} trips`)

  // ── 17. CargoManifests (200 — one per trip) ───────────────────────────────
  console.log('→ Cargo manifests')
  const cmRows = tripIds.map((tripId, i) => ({
    tripId,
    description:       pick(CARGO_DESCS, i),
    cargoType:         pick(['BULK','PACKAGED','LIVESTOCK','HAZMAT','FUEL','MACHINERY','OTHER','PACKAGED'], i) as
                         'BULK'|'PACKAGED'|'LIVESTOCK'|'HAZMAT'|'FUEL'|'MACHINERY'|'OTHER',
    declaredWeightKg:  pick([5000, 10000, 15000, 8000, 12000, 3000, 20000, 7000], i),
    departureWeightKg: pick([4980,  9950, 14900, 7980, 11950, 2990, 19900, 6980], i),
    arrivalWeightKg:   pick([4950,  9900, 14850, 7950, 11900, 2970, 19850, 6950], i),
    weightVarianceKg:  pick([30, 50, 50, 30, 50, 20, 50, 30], i),
    notes:             i % 8 === 0 ? 'Sealed containers — manifest weight only' : null,
  }))
  await prisma.cargoManifest.createMany({ data: cmRows })
  console.log(`  ✓ ${cmRows.length} cargo manifests`)

  // ── 18. EngineHourSessions (200) ──────────────────────────────────────────
  console.log('→ Engine hour sessions')
  const ehsRows: any[] = []
  for (let i = 0; i < 200; i++) {
    const vehicle  = pick(vehicles, i + 3)
    const periodId = pick(periodIds, i + 2)
    const beganAt  = addH(addD(new Date('2026-06-08T05:00:00Z'), i % 7), (i * 2) % 12)
    const totalSec = pick([3600, 7200, 14400, 21600, 28800, 10800, 18000, 25200], i)
    ehsRows.push({
      vehicleId:               vehicle.id,
      reportingPeriodId:       periodId,
      beganAt,
      endedAt:                 addH(beganAt, totalSec / 3600),
      initialLocation:         pick(KE_PLACES, i + 2),
      finalLocation:           pick(KE_PLACES, i + 9),
      engineHoursSeconds:      totalSec - pick([600, 1200, 1800, 900, 1500, 300, 2100, 750], i),
      totalTimeSeconds:        totalSec,
      offTimeSeconds:          pick([600, 1200, 1800, 900, 1500, 300, 2100, 750], i),
      inMotionSeconds:         Math.round(totalSec * 0.68),
      idlingSeconds:           Math.round(totalSec * 0.12),
      mileageKm:               pick([50, 100, 200, 300, 80, 150, 250, 120], i),
      avgSpeedKmh:             pick([45, 60, 55, 70, 50, 65, 75, 40], i),
      maxSpeedKmh:             pick([90, 110, 100, 120, 95, 105, 115, 85], i),
      consumedMl:              pick([15000, 30000, 60000, 90000, 45000, 20000, 75000, 50000], i),
      consumedByFlsMl:         pick([14500, 29000, 58000, 88000, 44000, 19500, 73000, 49000], i),
      consumedFlsMotionMl:     pick([12000, 25000, 50000, 76000, 38000, 17000, 63000, 42000], i),
      consumedFlsIdleMl:       pick([2500,  4000,  8000, 12000,  6000,  2500, 10000,  7000], i),
      avgConsumptionByFls:     pick([19, 24, 29, 17, 21, 27, 14, 34], i),
      avgConsumptionFlsMotion: pick([18, 22, 27, 16, 20, 25, 13, 32], i),
      avgConsumptionFlsIdle:   pick([3.5, 4.0, 3.0, 2.8, 3.2, 4.5, 2.5, 5.0], i),
      avgConsumptionFlsTrips:  pick([20, 25, 30, 18, 22, 28, 15, 35], i),
      initialFuelLevelMl:      pick([200000, 150000, 100000, 250000, 300000, 80000, 180000, 120000], i),
      finalFuelLevelMl:        pick([185000, 120000, 40000, 160000, 255000, 60000, 105000, 70000], i),
      maxFuelLevelMl:          pick([210000, 155000, 105000, 260000, 310000, 85000, 185000, 125000], i),
      minFuelLevelMl:          pick([180000, 115000, 35000, 155000, 250000, 55000, 100000, 65000], i),
    })
  }
  await prisma.engineHourSession.createMany({ data: ehsRows })
  console.log(`  ✓ ${ehsRows.length} engine hour sessions`)

  // ── 19. FuelFillings (200) ────────────────────────────────────────────────
  console.log('→ Fuel fillings')
  const ffRows: any[] = []
  for (let i = 0; i < 200; i++) {
    ffRows.push({
      vehicleId:          pick(vehicles, i + 1).id,
      reportingPeriodId:  pick(periodIds, i),
      filledAt:           addH(addD(new Date('2026-06-08T07:00:00Z'), i % 7), (i * 5) % 14),
      location:           pick(KE_PLACES, i + 4),
      initialFuelLevelMl: pick([50000, 80000, 30000, 60000, 100000, 40000, 70000, 90000], i),
      filledMl:           pick([50000, 80000, 100000, 60000, 120000, 70000, 90000, 110000], i),
      finalFuelLevelMl:   pick([100000, 160000, 130000, 120000, 220000, 110000, 160000, 200000], i),
      mileageAtFillKm:    pick([5000, 12000, 8000, 15000, 3000, 10000, 7000, 20000], i) + i,
    })
  }
  await prisma.fuelFilling.createMany({ data: ffRows })
  console.log(`  ✓ ${ffRows.length} fuel fillings`)

  // ── 20. FuelThefts (200) ──────────────────────────────────────────────────
  console.log('→ Fuel thefts')
  const ftRows: any[] = []
  for (let i = 0; i < 200; i++) {
    const beganAt = addH(addD(new Date('2026-06-08T22:00:00Z'), i % 7), (i * 2) % 4)
    ftRows.push({
      vehicleId:          pick(vehicles, i + 2).id,
      driverId:           i % 5 === 0 ? null : pick(users, i).id,
      reportingPeriodId:  pick(periodIds, i + 1),
      beganAt,
      detectedAt:         addH(beganAt, pick([0.5, 1, 1.5, 0.25, 2], i)),
      initialLocation:    pick(KE_PLACES, i + 6),
      initialFuelLevelMl: pick([150000, 100000, 200000, 80000, 250000, 130000, 180000, 220000], i),
      finalFuelLevelMl:   pick([100000,  60000, 140000, 50000, 180000,  80000, 120000, 160000], i),
      stolenMl:           pick([50000, 40000, 60000, 30000, 70000, 50000, 60000, 60000], i),
      initialSpeedKmh:    pick([0, 0, 0, 5, 0, 0, 3, 0], i),
      finalSpeedKmh:      pick([0, 0, 0, 5, 0, 0, 3, 0], i),
    })
  }
  await prisma.fuelTheft.createMany({ data: ftRows })
  console.log(`  ✓ ${ftRows.length} fuel thefts`)

  // ── 21. GeofenceViolations (200) ──────────────────────────────────────────
  console.log('→ Geofence violations')
  const gvRows: any[] = []
  for (let i = 0; i < 200; i++) {
    const fence      = pick(geofences, i)
    const occurredAt = addH(addD(new Date('2026-06-08T00:00:00Z'), i % 7), (i * 3) % 22)
    const [lat, lng] = KE_COORDS[i % KE_COORDS.length]!
    gvRows.push({
      vehicleId:   pick(vehicles, i + 4).id,
      geofenceId:  fence.id,
      driverId:    i % 6 === 0 ? null : pick(users, i).id,
      occurredAt,
      resolvedAt:  i % 3 === 0 ? addH(occurredAt, pick([0.5, 1, 2, 3], i)) : null,
      lat:         lat + i * 0.001,
      lng:         lng + i * 0.001,
      speedKmh:    pick([45, 80, 0, 60, 110, 25, 95, 55], i),
      notifiedAt:  addH(occurredAt, 0.08),
    })
  }
  await prisma.geofenceViolation.createMany({ data: gvRows })
  console.log(`  ✓ ${gvRows.length} geofence violations`)

  // ── 22. VehicleTelemetry (200) ────────────────────────────────────────────
  console.log('→ Vehicle telemetry')
  const telemetryIds: bigint[] = []
  const telSet    = new Set<string>()
  const telStart  = new Date('2026-06-14T00:00:00Z')
  for (let i = 0; i < 200; i++) {
    const vehicle    = pick(vehicles, i)
    const capturedAt = addH(telStart, i * 0.12)
    const key        = `${vehicle.deviceId}:${capturedAt.toISOString()}`
    if (telSet.has(key)) continue
    telSet.add(key)
    const [lat, lng] = KE_COORDS[i % KE_COORDS.length]!
    const t = await prisma.vehicleTelemetry.create({
      data: {
        vehicleId:     vehicle.id,
        deviceId:      vehicle.deviceId,
        driverId:      i % 8 === 0 ? null : pick(users, i).id,
        capturedAt,
        receivedAt:    addH(capturedAt, 0.001),
        lat:           lat  + i * 0.0005,
        lng:           lng  + i * 0.0005,
        altitudeM:     pick([1600, 10, 1130, 1850, 2100, 1000, 1900, 1700], i),
        headingDeg:    pick([0, 45, 90, 135, 180, 225, 270, 315], i),
        accuracyM:     pick([3.5, 5.0, 2.1, 8.0, 4.5, 6.0, 3.0, 7.5], i),
        speedKmh:      pick([0, 45, 60, 80, 95, 30, 70, 110], i),
        engineOn:      i % 5 !== 0,
        fuelLevelMl:   pick([180000, 120000, 60000, 240000, 300000, 90000, 150000, 200000], i),
        fuelUsedMl:    pick([500, 1000, 2000, 800, 1500, 600, 1200, 900], i),
        cargoWeightKg: i % 3 === 0 ? pick([5000, 8000, 12000, 3000, 10000, 6000, 9000, 4000], i) : null,
      },
    })
    telemetryIds.push(t.id)
  }
  console.log(`  ✓ ${telemetryIds.length} vehicle telemetry records`)

  // ── 23. VehicleTelemetryRaw (200) ─────────────────────────────────────────
  console.log('→ Vehicle telemetry raw')
  const rawRows = telemetryIds.map((id, i) => ({
    telemetryId: id,
    payload: {
      vendor:         pick(GPS_VENDORS, i),
      protocol:       pick(['MQTT','HTTP','TCP','UDP'], i),
      rawPacket:      `PKT_${String(i).padStart(6, '0')}`,
      sequence:       1000 + i,
      checksum:       `0x${((i + 1) * 31337).toString(16).padStart(8, '0').toUpperCase()}`,
      receivedIso:    new Date().toISOString(),
      deviceFirmware: `v${2 + (i % 3)}.${(i * 7) % 10}.${i % 5}`,
    },
  }))
  await prisma.vehicleTelemetryRaw.createMany({ data: rawRows })
  console.log(`  ✓ ${rawRows.length} vehicle telemetry raw records`)

  // ── 24. VehiclePeriodSummaries (200) ──────────────────────────────────────
  console.log('→ Vehicle period summaries')
  const vpsRows: any[] = []
  const vpsSet  = new Set<string>()
  outer: for (const vehicle of vehicles) {
    for (const periodId of periodIds) {
      if (vpsRows.length >= 200) break outer
      const key = `${vehicle.id}:${periodId}`
      if (vpsSet.has(key)) continue
      vpsSet.add(key)
      const i = vpsRows.length
      vpsRows.push({
        vehicleId:            vehicle.id,
        reportingPeriodId:    periodId,
        mileageInTripsKm:     pick([500, 1200, 800, 2000, 350, 900, 1500, 600], i),
        mileageAllMessagesKm: pick([520, 1250, 820, 2050, 370, 930, 1540, 620], i),
        avgSpeedKmh:          pick([55, 65, 70, 50, 60, 75, 45, 80], i),
        maxSpeedKmh:          pick([110, 120, 105, 100, 115, 125, 95, 130], i),
        timeInTripsSeconds:   pick([36000, 72000, 57600, 86400, 28800, 50400, 79200, 43200], i),
        engineHoursSeconds:   pick([43200, 86400, 64800, 93600, 32400, 57600, 82800, 50400], i),
        consumedByFlsMl:      pick([300000, 600000, 450000, 900000, 200000, 400000, 700000, 350000], i),
        avgConsumptionByFls:  pick([25, 30, 28, 20, 35, 22, 32, 18], i),
        avgMileagePerUnitFls: pick([3.5, 4.0, 3.8, 5.0, 2.8, 4.5, 3.2, 5.5], i),
        initialFuelLevelMl:   pick([250000, 300000, 200000, 350000, 150000, 280000, 320000, 180000], i),
        finalFuelLevelMl:     pick([80000, 100000, 60000, 120000, 40000, 90000, 110000, 50000], i),
        totalFilledMl:        pick([200000, 400000, 300000, 500000, 150000, 350000, 450000, 250000], i),
        totalStolenMl:        i % 4 === 0 ? pick([50000, 30000, 70000, 20000, 60000], i) : 0,
        refreshedAt:          new Date(),
      })
    }
  }
  await prisma.vehiclePeriodSummary.createMany({ data: vpsRows })
  console.log(`  ✓ ${vpsRows.length} vehicle period summaries`)

  // ── summary ───────────────────────────────────────────────────────────────
  const counts = await Promise.all([
    prisma.organisation.count(),
    prisma.role.count(),
    prisma.permission.count(),
    prisma.rolePermission.count(),
    prisma.user.count(),
    prisma.userRole.count(),
    prisma.ingestApiKey.count(),
    prisma.vehicleGroup.count(),
    prisma.vehicle.count(),
    prisma.vehicleAssignment.count(),
    prisma.reportingPeriod.count(),
    prisma.route.count(),
    prisma.routeWaypoint.count(),
    prisma.geofence.count(),
    prisma.vehicleGeofence.count(),
    prisma.trip.count(),
    prisma.engineHourSession.count(),
    prisma.fuelFilling.count(),
    prisma.fuelTheft.count(),
    prisma.geofenceViolation.count(),
    prisma.vehicleTelemetry.count(),
    prisma.vehicleTelemetryRaw.count(),
    prisma.cargoManifest.count(),
    prisma.vehiclePeriodSummary.count(),
  ])

  const labels = [
    'organisations','roles','permissions','role_permissions',
    'users','user_roles','ingest_api_keys','vehicle_groups',
    'vehicles','vehicle_assignments','reporting_periods','routes',
    'route_waypoints','geofences','vehicle_geofences','trips',
    'engine_hour_sessions','fuel_fillings','fuel_thefts','geofence_violations',
    'vehicle_telemetries','vehicle_telemetry_raws','cargo_manifests','vehicle_period_summaries',
  ]

  console.log('\n✅  Seed complete — record counts:\n')
  labels.forEach((label, i) => {
    const count = counts[i]!
    const bar   = '█'.repeat(Math.min(Math.round(count / 10), 25))
    console.log(`  ${label.padEnd(32)} ${String(count).padStart(4)}  ${bar}`)
  })
}

main()
  .catch(err => {
    console.error('\n❌  Seed failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
    await pool.end()
  })
