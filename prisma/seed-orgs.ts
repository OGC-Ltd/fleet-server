/**
 * Additive seed — Menengai Co-op (MENENGAI), TimSales Ltd (TIMSALES), and
 * Kabras Sugar Ltd (KABRAS).
 *
 * NON-destructive (mirrors seed-aquamist.ts): adds each organisation and its
 * related rows without touching the existing orgs or their live-accumulated
 * simulation history. Idempotent per org — an org whose code already exists is
 * skipped, so the script is safe to re-run.
 *
 * Fleet sizes match SIM_FLEET_COMPOSITION (src/lib/sim-fleet.ts):
 *   MENENGAI — 15 vehicles ( 8 TRUCK /  7 LORRY) — edible oils, Nakuru refinery
 *   TIMSALES — 20 vehicles (10 TRUCK / 10 LORRY) — timber, Elburgon mill
 *   KABRAS   — 25 vehicles (13 TRUCK / 12 LORRY) — sugar, Malava mill
 *
 * Every vehicle gets its OWN driver (1:1 — no user crews two vehicles), and
 * every assigned driver holds one of the driver roles, so the Drivers page
 * roster, the Maintenance vehicle grid, and the live map all agree from the
 * first snapshot. HQ / customer / product data must stay in lockstep with
 * DIRECT_PROFILES in src/providers/controltech/controltech.simulator.ts.
 *
 * Run: npm run seed:orgs
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

// ─── tiny helpers (mirrors seed.ts) ──────────────────────────────────────────
const pick   = <T>(arr: T[], i: number): T => arr[Math.abs(i) % arr.length]!
const addH   = (d: Date, h: number): Date  => new Date(d.getTime() + h * 3_600_000)
const addD   = (d: Date, n: number): Date  => new Date(d.getTime() + n * 86_400_000)
const sha256 = (s: string): string         => crypto.createHash('sha256').update(s).digest('hex')

// ─── reference data (same pools as seed.ts / seed-aquamist.ts) ────────────────
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
const GPS_VENDORS    = ['Queclink','Teltonika','CalAmp','Meitrack','Controltech']
const PLATE_SUFFIXES = ['A','B','C','D','E','F','G','H','J','K','L','M','N','P','Q','R','S','T','U','V']
const RESOURCES = ['vehicle','trip','fuel_theft','fuel_filling','user','route',
                   'geofence','report','ingest_key','assignment','engine_session','cargo']
const ACTIONS   = ['read','create','update','delete','export']

// Generic fleet roles (same definitions as seed.ts / seed-aquamist.ts).
// Index 1–3 are the DRIVER roles — assigned drivers cycle through these.
const roleDefs = [
  { name: 'Fleet Manager',        slug: 'fleet_manager',     description: 'Full fleet oversight and reporting access'  },
  { name: 'Senior Driver',        slug: 'senior_driver',     description: 'Experienced driver — long-haul routes'      },
  { name: 'Driver',               slug: 'driver',            description: 'Assigned vehicle operator'                  },
  { name: 'Junior Driver',        slug: 'junior_driver',     description: 'Driver under probation period'              },
  { name: 'Lead Mechanic',        slug: 'lead_mechanic',     description: 'Heads the workshop maintenance team'        },
  { name: 'Mechanic',             slug: 'mechanic',          description: 'Vehicle maintenance and repair technician'  },
  { name: 'Field Supervisor',     slug: 'field_supervisor',  description: 'Field operations supervisor'                },
  { name: 'Dispatcher',           slug: 'dispatcher',        description: 'Trip planning and vehicle dispatch'         },
  { name: 'Senior Dispatcher',    slug: 'senior_dispatcher', description: 'Oversees dispatch team and scheduling'      },
  { name: 'System Administrator', slug: 'system_admin',      description: 'Platform-level administration'              },
]

// Reporting-period calendar (same as the other seeds).
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

// ─── per-organisation configuration ──────────────────────────────────────────
// hq / customers / products MUST mirror DIRECT_PROFILES in the simulator.

interface OrgSeedConfig {
  code:        string
  name:        string
  emailDomain: string
  empPrefix:   string
  licPrefix:   string
  platePrefix: string        // e.g. 'KMG' → plates 'KMG 101A'…
  plateBase:   number
  /** [vehicleType, count, kmpl, tankLitres] — counts must match SIM_FLEET_COMPOSITION. */
  fleet:       [string, number, number, number][]
  supportStaff: number       // non-driver users on top of the per-vehicle drivers
  nameOffset:  [number, number]  // offsets into the first/last name pools
  hq:          [number, number, string]
  customers:   [number, number, string][]
  products:    string[]
  vehicleGroups: string[]
  /** [min, max] cargo kg for seeded historical trips. */
  loadKg:      [number, number]
  bulkCargo:   boolean       // BULK (sugar) vs PACKAGED manifests for seeded trips
}

const ORGS: OrgSeedConfig[] = [
  {
    code: 'MENENGAI', name: 'Menengai Co-op', emailDomain: 'menengai.co.ke',
    empPrefix: 'MEN', licPrefix: 'DLMEN', platePrefix: 'KMG', plateBase: 300,
    fleet: [['TRUCK', 8, 3.2, 200], ['LORRY', 7, 2.7, 300]],
    supportStaff: 8, nameOffset: [5, 17],
    hq: [-0.3078, 36.0559, 'Menengai Refinery, Nakuru'],
    customers: [
      [-1.2864, 36.8172, 'Distributor — CBD, Nairobi'],
      [-1.3080, 36.8510, 'Distributor — Industrial Area, Nairobi'],
      [-1.0388, 37.0834, 'Supermarket DC — Thika'],
      [-0.7167, 36.4333, 'Supermarket DC — Naivasha'],
      [ 0.5143, 35.2698, 'Wholesaler — Eldoret'],
      [-0.0917, 34.7679, 'Distributor — Kisumu'],
      [-0.4201, 36.9476, 'Wholesaler — Nyeri'],
      [-0.6817, 34.7666, 'Distributor — Kisii'],
      [-4.0435, 39.6682, 'Distributor — Mombasa'],
      [-0.5300, 37.4568, 'Wholesaler — Embu'],
    ],
    products: [
      'Cooking oil — 20 L jerricans',
      'Cooking oil — 10 L jerricans',
      'Cooking oil — 3 L bottles, cartons',
      'Cooking oil — 1 L bottles, cartons',
      'Cooking fat — 17 kg tubs',
      'Cooking fat — 2 kg tubs, cartons',
      'Margarine — 1 kg tubs, cartons',
      'Baking fat — 10 kg cartons',
      'Laundry soap — 800 g bars, cartons',
    ],
    vehicleGroups: ['OIL DISTRIBUTION', 'FATS & MARGARINE', 'REGIONAL DELIVERY'],
    loadKg: [8_000, 24_000], bulkCargo: false,
  },
  {
    code: 'TIMSALES', name: 'TimSales Ltd', emailDomain: 'timsales.co.ke',
    empPrefix: 'TIM', licPrefix: 'DLTIM', platePrefix: 'KTS', plateBase: 400,
    fleet: [['TRUCK', 10, 3.0, 220], ['LORRY', 10, 2.5, 320]],
    supportStaff: 8, nameOffset: [13, 29],
    hq: [-0.3872, 35.8103, 'Timsales Mill, Elburgon'],
    customers: [
      [-1.3080, 36.8510, 'Builders Depot — Industrial Area, Nairobi'],
      [-1.1487, 36.9608, 'Hardware — Ruiru'],
      [-1.0388, 37.0834, 'Builders Depot — Thika'],
      [-0.3031, 36.0800, 'Timber Yard — Nakuru'],
      [ 0.5143, 35.2698, 'Builders Depot — Eldoret'],
      [-0.3677, 35.2831, 'Hardware — Kericho'],
      [-0.0917, 34.7679, 'Timber Yard — Kisumu'],
      [-0.7167, 36.4333, 'Construction Site — Naivasha'],
      [ 0.0167, 37.0733, 'Hardware — Nanyuki'],
      [-1.5220, 37.2650, 'Construction Site — Machakos'],
    ],
    products: [
      'Cypress timber — 4×2 sawn lengths',
      'Pine timber — 6×1 sawn lengths',
      'Treated blue gum posts',
      'Plywood sheets — 18 mm',
      'Block boards — 25 mm',
      'MDF boards — 12 mm',
      'Flush doors — semi-solid',
      'Fascia boards — cypress',
      'Tongue & groove ceiling boards',
    ],
    vehicleGroups: ['SAWN TIMBER', 'BOARDS & PANELS', 'SITE DELIVERY'],
    loadKg: [10_000, 26_000], bulkCargo: false,
  },
  {
    code: 'KABRAS', name: 'Kabras Sugar Ltd', emailDomain: 'kabras.co.ke',
    empPrefix: 'KAB', licPrefix: 'DLKAB', platePrefix: 'KSB', plateBase: 500,
    fleet: [['TRUCK', 13, 3.1, 210], ['LORRY', 12, 2.6, 310]],
    supportStaff: 8, nameOffset: [21, 7],
    hq: [0.4457, 34.8560, 'Kabras Sugar Mill, Malava'],
    customers: [
      [ 0.2827, 34.7519, 'Wholesaler — Kakamega Town'],
      [ 0.5635, 34.5606, 'Distributor — Bungoma'],
      [ 0.6167, 34.7667, 'Wholesaler — Webuye'],
      [ 0.3350, 34.4870, 'Wholesaler — Mumias'],
      [ 0.5143, 35.2698, 'Distributor — Eldoret'],
      [ 1.0157, 35.0062, 'Distributor — Kitale'],
      [-0.0917, 34.7679, 'Wholesaler — Kisumu'],
      [-0.6817, 34.7666, 'Distributor — Kisii'],
      [-0.3031, 36.0800, 'Distributor — Nakuru'],
      [-1.2864, 36.8172, 'Wholesaler — Nairobi CBD'],
    ],
    products: [
      'Kabras Premium — 1 kg packets, 24-pack bales',
      'Kabras Premium — 2 kg packets, 12-pack bales',
      'Kabras Sugar — 50 kg bags',
      'Kabras Sugar — 25 kg bags',
      'Industrial sugar — 50 kg bags',
      'Brown sugar — 1 kg packets, bales',
    ],
    vehicleGroups: ['RETAIL SUGAR', 'BULK BAGS', 'REGIONAL DELIVERY'],
    loadKg: [10_000, 26_000], bulkCargo: true,
  },
]

// ─── seed one organisation ────────────────────────────────────────────────────

async function seedOrg(cfg: OrgSeedConfig, permissions: { id: string }[]): Promise<void> {
  console.log(`\n→ ${cfg.name} (${cfg.code})`)

  const existing = await prisma.organisation.findUnique({ where: { code: cfg.code }, select: { id: true } })
  if (existing) {
    console.log(`  ⏭  already exists (${existing.id}) — skipped.`)
    return
  }

  const org = await prisma.organisation.create({ data: { name: cfg.name, code: cfg.code } })
  console.log(`  ✓ organisation ${org.id}`)

  // Roles + permissions (fleet_manager gets all, others 8 each).
  const roles: { id: string; slug: string }[] = []
  for (const rd of roleDefs) {
    const role = await prisma.role.create({ data: { organisationId: org.id, ...rd } })
    roles.push({ id: role.id, slug: rd.slug })
  }
  const rpRows: { roleId: string; permissionId: string }[] = []
  for (const perm of permissions) rpRows.push({ roleId: roles[0]!.id, permissionId: perm.id })
  for (let ri = 1; ri < roles.length; ri++) {
    const start  = (ri * 7) % permissions.length
    const subset = [...permissions.slice(start), ...permissions.slice(0, start)].slice(0, 8)
    for (const perm of subset) rpRows.push({ roleId: roles[ri]!.id, permissionId: perm.id })
  }
  await prisma.rolePermission.createMany({ data: rpRows, skipDuplicates: true })
  console.log(`  ✓ ${roles.length} roles, ${rpRows.length} role permissions`)

  // Users — one dedicated driver per vehicle (first `vehicleCount` users), then
  // support staff. All drivers ACTIVE with a licence.
  const vehicleCount = cfg.fleet.reduce((n, [, c]) => n + c, 0)
  const userCount    = vehicleCount + cfg.supportStaff
  const [fOff, lOff] = cfg.nameOffset
  const userRows: Prisma.UserCreateManyInput[] = []
  for (let i = 0; i < userCount; i++) {
    const fn = pick(FIRST_NAMES, fOff + i)
    const ln = pick(LAST_NAMES, lOff + i)
    const driver = i < vehicleCount
    userRows.push({
      organisationId: org.id,
      fullName:       `${fn} ${ln}`,
      email:          `${fn.toLowerCase()}.${ln.toLowerCase()}${i}@${cfg.emailDomain}`,
      phone:          `+2547${String(30_000_000 + cfg.plateBase * 1000 + i).slice(1)}`,
      licenceNumber:  driver ? `${cfg.licPrefix}${String(1000 + i).padStart(4, '0')}` : null,
      employeeId:     `${cfg.empPrefix}-EMP-${String(1000 + i).padStart(4, '0')}`,
      status:         'ACTIVE',
    })
  }
  await prisma.user.createMany({ data: userRows })
  // createMany doesn't return rows — re-read in employeeId order so users[i]
  // matches userRows[i] (drivers first).
  const users = await prisma.user.findMany({
    where:   { organisationId: org.id },
    orderBy: { employeeId: 'asc' },
    select:  { id: true },
  })
  console.log(`  ✓ ${users.length} users (${vehicleCount} drivers + ${cfg.supportStaff} staff)`)

  // User roles — drivers cycle senior_driver/driver/junior_driver (indices
  // 1–3); support staff cycle the remaining roles.
  const urRows = users.map((u, ui) => ({
    userId: u.id,
    roleId: ui < vehicleCount
      ? roles[1 + (ui % 3)]!.id
      : roles[4 + (ui % (roles.length - 4))]!.id,
  }))
  await prisma.userRole.createMany({ data: urRows, skipDuplicates: true })
  console.log(`  ✓ ${urRows.length} user roles`)

  // Ingest API keys.
  const akRows = Array.from({ length: 8 }, (_, i) => ({
    organisationId: org.id,
    label:          `${pick(GPS_VENDORS, i)} Device #${i + 1} (${cfg.name})`,
    keyHash:        sha256(`flt_${cfg.code.toLowerCase()}_${String(i).padStart(3, '0')}_secret_${i}`),
    isActive:       true,
    expiresAt:      null as Date | null,
  }))
  await prisma.ingestApiKey.createMany({ data: akRows })

  // Vehicle groups.
  const groups: { id: string }[] = []
  for (const gName of cfg.vehicleGroups) {
    const vg = await prisma.vehicleGroup.create({
      data: { organisationId: org.id, name: gName, code: `${cfg.code}_${gName.replace(/\s+/g, '_')}` },
    })
    groups.push({ id: vg.id })
  }

  // Vehicles — exact per-type counts from cfg.fleet (must match
  // SIM_FLEET_COMPOSITION so the whole fleet is in the live sim).
  const vehicleRows: Prisma.VehicleCreateManyInput[] = []
  let vi = 0
  for (const [type, count, kmpl, tank] of cfg.fleet) {
    for (let t = 0; t < count; t++, vi++) {
      const plate = `${cfg.platePrefix} ${cfg.plateBase + vi}${pick(PLATE_SUFFIXES, vi + 5)}`
      vehicleRows.push({
        organisationId:     org.id,
        vehicleGroupId:     groups[vi % groups.length]!.id,
        name:               `${type} ${plate}`,
        registrationPlate:  plate,
        deviceId:           `DEV_${plate.replace(/\s+/g, '_')}`,
        vehicleType:        type,
        fuelEfficiencyKmpl: kmpl + (t % 3) * 0.2,
        tankCapacityLitres: tank,
      })
    }
  }
  await prisma.vehicle.createMany({ data: vehicleRows })
  const vehicles = await prisma.vehicle.findMany({
    where:   { organisationId: org.id },
    orderBy: { registrationPlate: 'asc' },
  })
  console.log(`  ✓ ${vehicles.length} vehicles (${cfg.fleet.map(([t, c]) => `${c} ${t}`).join(' / ')})`)

  // Reporting periods.
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

  // Routes — HQ → every customer.
  const routeIds: string[] = []
  for (const [cLat, cLng, cName] of cfg.customers) {
    const dLat = (cLat - cfg.hq[0]) * 111
    const dLng = (cLng - cfg.hq[1]) * 111 * Math.cos((cLat * Math.PI) / 180)
    const distanceKm = Math.round(Math.sqrt(dLat * dLat + dLng * dLng) * 1.25)   // ×1.25 road factor
    const route = await prisma.route.create({
      data: {
        organisationId:  org.id,
        name:            `${cfg.hq[2]} → ${cName}`,
        originName:      cfg.hq[2],
        originLat:       cfg.hq[0],
        originLng:       cfg.hq[1],
        destinationName: cName,
        destinationLat:  cLat,
        destinationLng:  cLng,
        distanceKm,
        isActive:        true,
      },
    })
    routeIds.push(route.id)
  }
  console.log(`  ✓ ${periodIds.length} periods, ${routeIds.length} routes`)

  // Geofences — HQ perimeter + a zone per distinct customer city (first 5).
  const geoDefs: [string, number, number, number][] = [
    [`${cfg.hq[2]} Perimeter`, cfg.hq[0], cfg.hq[1], 800],
    ...cfg.customers.slice(0, 5).map(([lat, lng, name]) =>
      [`${name.split('— ')[1] ?? name} Zone`, lat, lng, 10_000] as [string, number, number, number]),
  ]
  await prisma.geofence.createMany({
    data: geoDefs.map(([name, lat, lng, r]) => ({
      organisationId: org.id,
      name,
      type:           'CIRCLE' as const,
      mode:           'ALLOWLIST' as const,
      centerLat:      lat,
      centerLng:      lng,
      radiusM:        r,
      polygonCoords:  Prisma.JsonNull,
      isActive:       true,
    })),
  })

  // Vehicle assignments — a UNIQUE primary driver per vehicle (user i ↔ vehicle i).
  const vaRows = vehicles.map((v, i) => ({
    vehicleId:      v.id,
    userId:         users[i]!.id,
    assignmentType: 'PRIMARY' as const,
    assignedAt:     addD(new Date('2026-02-02T06:00:00Z'), i),
    unassignedAt:   null as Date | null,
    notes:          null as string | null,
  }))
  await prisma.vehicleAssignment.createMany({ data: vaRows })
  console.log(`  ✓ ${vaRows.length} vehicle assignments (1:1 unique drivers)`)

  // Historical trips + manifests — ~2 per vehicle, attributed to the vehicle's
  // OWN assigned driver so the Drivers page aggregates line up with the map
  // and maintenance grid from day one.
  const weekStart = new Date('2026-06-15T05:30:00Z')
  let tripCount = 0
  for (let i = 0; i < vehicles.length * 2; i++) {
    const vIdx     = i % vehicles.length
    const vehicle  = vehicles[vIdx]!
    const driverId = users[vIdx]!.id
    const customer = pick(cfg.customers, i * 3 + vIdx)
    const beganAt  = addH(addD(weekStart, i % 12), 1 + (i * 2) % 10)
    const dLat     = (customer[0] - cfg.hq[0]) * 111
    const dLng     = (customer[1] - cfg.hq[1]) * 111 * Math.cos((customer[0] * Math.PI) / 180)
    const distKm   = Math.max(15, Math.round(Math.sqrt(dLat * dLat + dLng * dLng) * 1.25))
    const avgKmh   = pick([50, 62, 58, 55], i)
    const durSec   = Math.round((distKm / avgKmh) * 3600) + pick([1200, 1800, 2400, 3000], i)
    const weightKg = cfg.loadKg[0] + ((i * 2917) % (cfg.loadKg[1] - cfg.loadKg[0]))
    const trip = await prisma.trip.create({
      data: {
        vehicleId:          vehicle.id,
        driverId,
        reportingPeriodId:  pick(periodIds, i),
        routeId:            i % 4 === 0 ? null : pick(routeIds, i),
        beganAt,
        endedAt:            addH(beganAt, durSec / 3600),
        initialLocation:    cfg.hq[2],
        finalLocation:      customer[2],
        durationSeconds:    durSec,
        mileageKm:          distKm,
        avgSpeedKmh:        avgKmh,
        maxSpeedKmh:        avgKmh + pick([15, 25, 30, 20], i),
        consumedMl:         distKm * 380,
        initialFuelLevelMl: 250_000,
        finalFuelLevelMl:   250_000 - distKm * 380,
      },
      select: { id: true },
    })
    await prisma.cargoManifest.create({
      data: {
        tripId:            trip.id,
        cargoType:         cfg.bulkCargo ? 'BULK' : 'PACKAGED',
        description:       pick(cfg.products, i),
        declaredWeightKg:  weightKg,
        departureWeightKg: weightKg,
        arrivalWeightKg:   weightKg,   // delivered in full (matches live persistence)
        weightVarianceKg:  0,
      },
    })
    tripCount++
  }
  console.log(`  ✓ ${tripCount} trips + manifests`)

  // Fuel fillings — at the HQ before dispatch.
  const ffRows = Array.from({ length: vehicles.length }, (_, i) => {
    const vehicle = vehicles[i % vehicles.length]!
    const tankMl  = (vehicle.tankCapacityLitres ?? 200) * 1000
    const startMl = Math.round(tankMl * pick([0.25, 0.35, 0.45, 0.30], i))
    return {
      vehicleId:          vehicle.id,
      reportingPeriodId:  pick(periodIds, i),
      filledAt:           addH(addD(new Date('2026-06-15T05:00:00Z'), i % 7), (i * 3) % 12),
      location:           cfg.hq[2],
      initialFuelLevelMl: startMl,
      filledMl:           tankMl - startMl,
      finalFuelLevelMl:   tankMl,
      mileageAtFillKm:    pick([4000, 9000, 15000, 22000, 6000], i) + i * 3,
    }
  })
  await prisma.fuelFilling.createMany({ data: ffRows })
  console.log(`  ✓ ${ffRows.length} fuel fillings`)
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🌱  Additive seed — Menengai, TimSales, Kabras Sugar\n')

  // Permissions — reuse global table; create the standard set if absent.
  let permissions = await prisma.permission.findMany()
  if (permissions.length === 0) {
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
    permissions = await prisma.permission.findMany()
  }
  console.log(`  ✓ ${permissions.length} permissions available`)

  for (const cfg of ORGS) {
    await seedOrg(cfg, permissions)
  }

  console.log('\n✅  All three organisations seeded — existing orgs untouched.\n')
}

main()
  .catch(err => {
    console.error('\n❌  seed-orgs failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
    await pool.end()
  })
