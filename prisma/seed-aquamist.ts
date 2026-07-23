/**
 * Additive seed — Aquamist Limited (AQUAMIST) only.
 *
 * Unlike prisma/seed.ts (which TRUNCATEs everything and re-creates BOTH orgs),
 * this script is NON-destructive: it adds the Aquamist organisation and all of
 * its related rows WITHOUT touching Sukari or its live-accumulated simulation
 * history (telemetry, trips, fuel events, persisted sim state).
 *
 * It reuses the global `permissions` table (permissions are not org-scoped) and
 * is idempotent — if an org with code AQUAMIST already exists it exits without
 * changes, so it's safe to re-run.
 *
 * Aquamist is a bottled-beverage producer: still & sparkling water in different
 * bottle volumes, plus juice, delivered from the bottling plant DIRECTLY to
 * customers in Nairobi, Kisumu, Nakuru, and Mombasa (no depots). Live-sim fleet:
 * 10 vehicles — 4 saloon cars, 3 trucks, 3 lorries (see src/lib/sim-fleet.ts and
 * the AQUAMIST routing profile in controltech.simulator.ts).
 *
 * Run: npm run seed:aquamist
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

// ─── reference data (subset of seed.ts, only what Aquamist needs) ─────────────
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

// First 10 generic fleet roles (same definitions as seed.ts).
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

// Reporting-period calendar (same as seed.ts).
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

// Bottling plant / HQ — Kiambu County, NW of Nairobi (matches AQUAMIST_HQ).
const AQ_HQ: [number, number, string] = [-1.2060044099698617, 36.65702647381419, 'Aquamist Plant']

// Customer delivery points across the four supply cities.
const AQ_CUSTOMERS: [number, number, string][] = [
  [-1.2683, 36.8110, 'Customer — Westlands, Nairobi'],
  [-1.3197, 36.7062, 'Customer — Karen, Nairobi'],
  [-1.2906, 36.7870, 'Customer — Kilimani, Nairobi'],
  [-1.3081, 36.8330, 'Customer — South B, Nairobi'],
  [-1.2230, 36.8991, 'Customer — Kasarani, Nairobi'],
  [-1.2076, 36.7811, 'Customer — Ruaka, Nairobi'],
  [-0.1057, 34.7448, 'Customer — Milimani, Kisumu'],
  [-0.0810, 34.7720, 'Customer — Kondele, Kisumu'],
  [-0.0570, 34.7900, 'Customer — Mamboleo, Kisumu'],
  [-0.2963, 36.0517, 'Customer — Milimani, Nakuru'],
  [-0.2789, 36.0894, 'Customer — Section 58, Nakuru'],
  [-0.3070, 36.1470, 'Customer — Lanet, Nakuru'],
  [-4.0202, 39.7076, 'Customer — Nyali, Mombasa'],
  [-3.9909, 39.7276, 'Customer — Bamburi, Mombasa'],
  [-4.0842, 39.6650, 'Customer — Likoni, Mombasa'],
]

// Product catalogue — mirrors AQUAMIST_PRODUCTS in the simulator.
const AQ_PRODUCTS = [
  'Still water — 500 ml PET bottles',
  'Still water — 1 L PET bottles',
  'Still water — 5 L bottles',
  'Still water — 10 L bottles',
  'Still water — 20 L dispenser bottles',
  'Sparkling water — 330 ml glass bottles',
  'Sparkling water — 750 ml glass bottles',
  'Sparkling water — 1 L PET bottles',
  'Juice — 300 ml bottles',
  'Juice — 1 L tetra packs',
  'Juice — 5 L catering packs',
]

async function main() {
  console.log('\n🌱  Additive seed — Aquamist Limited\n')

  // ── Idempotency guard ──────────────────────────────────────────────────────
  const existing = await prisma.organisation.findUnique({ where: { code: 'AQUAMIST' }, select: { id: true } })
  if (existing) {
    console.log(`  ⏭  Aquamist already exists (${existing.id}) — nothing to do.`)
    return
  }

  // ── Permissions — reuse global table; create the standard 60 if absent ──────
  let permissions = await prisma.permission.findMany()
  if (permissions.length === 0) {
    console.log('→ Permissions (none found — creating the standard set)')
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

  // ── Organisation ────────────────────────────────────────────────────────────
  const aqOrg = await prisma.organisation.create({
    data: { name: 'Aquamist Limited', code: 'AQUAMIST' },
  })
  console.log(`  ✓ ${aqOrg.name}  (${aqOrg.id})`)

  // ── Roles (10) ──────────────────────────────────────────────────────────────
  const aqRoles: { id: string }[] = []
  for (const rd of roleDefs) {
    const role = await prisma.role.create({ data: { organisationId: aqOrg.id, ...rd } })
    aqRoles.push({ id: role.id })
  }
  console.log(`  ✓ ${aqRoles.length} roles`)

  // ── Role permissions — fleet_manager gets all, others 8 each ────────────────
  const aqRpRows: { roleId: string; permissionId: string }[] = []
  for (const perm of permissions) aqRpRows.push({ roleId: aqRoles[0]!.id, permissionId: perm.id })
  for (let ri = 1; ri < aqRoles.length; ri++) {
    const start  = (ri * 7) % permissions.length
    const subset = [...permissions.slice(start), ...permissions.slice(0, start)].slice(0, 8)
    for (const perm of subset) aqRpRows.push({ roleId: aqRoles[ri]!.id, permissionId: perm.id })
  }
  await prisma.rolePermission.createMany({ data: aqRpRows, skipDuplicates: true })
  console.log(`  ✓ ${aqRpRows.length} role permissions`)

  // ── Users (40) ──────────────────────────────────────────────────────────────
  const aqUserRows: {
    organisationId: string; fullName: string; email: string; phone: string;
    licenceNumber: string | null; employeeId: string; status: 'ACTIVE'|'SUSPENDED'|'TERMINATED'
  }[] = []
  for (let i = 0; i < 40; i++) {
    const fn = pick(FIRST_NAMES, i + 11)
    const ln = pick(LAST_NAMES, i + 23)
    aqUserRows.push({
      organisationId: aqOrg.id,
      fullName:       `${fn} ${ln}`,
      email:          `${fn.toLowerCase()}.${ln.toLowerCase()}${i}@aquamist.co.ke`,
      phone:          `+2547${String(20_000_000 + i).slice(1)}`,
      licenceNumber:  i < 24 ? `DLAQUA${String(1000 + i).padStart(4, '0')}` : null,
      employeeId:     `AQUA-EMP-${String(1000 + i).padStart(4, '0')}`,
      status:         pick(['ACTIVE','ACTIVE','ACTIVE','ACTIVE','SUSPENDED'] as const, i),
    })
  }
  await prisma.user.createMany({ data: aqUserRows })
  const aqUsers = await prisma.user.findMany({ where: { organisationId: aqOrg.id }, select: { id: true } })
  console.log(`  ✓ ${aqUsers.length} users`)

  // ── User roles ──────────────────────────────────────────────────────────────
  const aqUrRows = aqUsers.map((u, ui) => ({ userId: u.id, roleId: pick(aqRoles, ui).id }))
  await prisma.userRole.createMany({ data: aqUrRows, skipDuplicates: true })
  console.log(`  ✓ ${aqUrRows.length} user roles`)

  // ── Ingest API keys (10) ────────────────────────────────────────────────────
  const aqAkRows = Array.from({ length: 10 }, (_, i) => ({
    organisationId: aqOrg.id,
    label:          `${pick(GPS_VENDORS, i)} Device #${i + 1} (Aquamist)`,
    keyHash:        sha256(`flt_aquamist_${String(i).padStart(3, '0')}_secret_${i}`),
    isActive:       true,
    expiresAt:      null as Date | null,
  }))
  await prisma.ingestApiKey.createMany({ data: aqAkRows })
  console.log(`  ✓ ${aqAkRows.length} ingest API keys`)

  // ── Vehicle groups (3) ──────────────────────────────────────────────────────
  const aqVgDefs = ['RESIDENTIAL DELIVERY', 'BULK WATER DELIVERY', 'JUICE DELIVERY']
  const aqGroups: { id: string }[] = []
  for (const gName of aqVgDefs) {
    const vg = await prisma.vehicleGroup.create({
      data: { organisationId: aqOrg.id, name: gName, code: `AQUAMIST_${gName.replace(/\s+/g, '_')}` },
    })
    aqGroups.push({ id: vg.id })
  }
  console.log(`  ✓ ${aqGroups.length} vehicle groups`)

  // ── Vehicles (10) — 4 SALOON / 3 TRUCK / 3 LORRY ────────────────────────────
  const aqFleetDefs: { type: string; group: number; kmpl: number; tank: number }[] = [
    { type: 'SALOON', group: 0, kmpl: 12.0, tank: 50  },
    { type: 'SALOON', group: 0, kmpl: 11.5, tank: 50  },
    { type: 'SALOON', group: 0, kmpl: 12.5, tank: 55  },
    { type: 'SALOON', group: 2, kmpl: 11.0, tank: 50  },
    { type: 'TRUCK',  group: 1, kmpl: 3.0,  tank: 200 },
    { type: 'TRUCK',  group: 1, kmpl: 3.5,  tank: 200 },
    { type: 'TRUCK',  group: 2, kmpl: 3.2,  tank: 250 },
    { type: 'LORRY',  group: 1, kmpl: 2.5,  tank: 300 },
    { type: 'LORRY',  group: 1, kmpl: 2.8,  tank: 300 },
    { type: 'LORRY',  group: 2, kmpl: 2.6,  tank: 350 },
  ]
  const aqVehicleRows = aqFleetDefs.map((d, i) => {
    const plate = `KDN ${200 + i}${pick(PLATE_SUFFIXES, i + 3)}`
    return {
      organisationId:     aqOrg.id,
      vehicleGroupId:     aqGroups[d.group]!.id,
      name:               `${d.type} ${plate}`,
      registrationPlate:  plate,
      deviceId:           `DEV_${plate.replace(/\s+/g, '_')}`,
      vehicleType:        d.type,
      fuelEfficiencyKmpl: d.kmpl,
      tankCapacityLitres: d.tank,
    }
  })
  await prisma.vehicle.createMany({ data: aqVehicleRows })
  const aqVehicles = await prisma.vehicle.findMany({ where: { organisationId: aqOrg.id } })
  console.log(`  ✓ ${aqVehicles.length} vehicles (4 saloon / 3 truck / 3 lorry)`)

  // ── Reporting periods ───────────────────────────────────────────────────────
  const aqPeriodIds: string[] = []
  for (const pd of periodDefs) {
    const rp = await prisma.reportingPeriod.create({
      data: {
        organisationId: aqOrg.id,
        label:          pd.label,
        periodStart:    new Date(pd.start),
        periodEnd:      new Date(pd.end),
        periodType:     pd.type,
      },
    })
    aqPeriodIds.push(rp.id)
  }
  console.log(`  ✓ ${aqPeriodIds.length} reporting periods`)

  // ── Routes — plant → every customer delivery point ──────────────────────────
  const aqRouteIds: string[] = []
  for (const [cLat, cLng, cName] of AQ_CUSTOMERS) {
    const dLat = (cLat - AQ_HQ[0]) * 111
    const dLng = (cLng - AQ_HQ[1]) * 111 * Math.cos((cLat * Math.PI) / 180)
    const distanceKm = Math.round(Math.sqrt(dLat * dLat + dLng * dLng) * 1.25)   // ×1.25 road factor
    const route = await prisma.route.create({
      data: {
        organisationId:  aqOrg.id,
        name:            `${AQ_HQ[2]} → ${cName}`,
        originName:      AQ_HQ[2],
        originLat:       AQ_HQ[0],
        originLng:       AQ_HQ[1],
        destinationName: cName,
        destinationLat:  cLat,
        destinationLng:  cLng,
        distanceKm,
        isActive:        true,
      },
    })
    aqRouteIds.push(route.id)
  }
  console.log(`  ✓ ${aqRouteIds.length} routes`)

  // ── Geofences — plant + one customer zone per city ──────────────────────────
  const aqGeoDefs: [string, number, number, number][] = [
    ['Aquamist Plant Perimeter', AQ_HQ[0], AQ_HQ[1], 800],
    ['Nairobi Customer Zone',    -1.2864,  36.8172,  15_000],
    ['Kisumu Customer Zone',     -0.0917,  34.7679,  10_000],
    ['Nakuru Customer Zone',     -0.3031,  36.0800,  10_000],
    ['Mombasa Customer Zone',    -4.0435,  39.6682,  12_000],
  ]
  await prisma.geofence.createMany({
    data: aqGeoDefs.map(([name, lat, lng, r]) => ({
      organisationId: aqOrg.id,
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
  console.log(`  ✓ ${aqGeoDefs.length} geofences`)

  // ── Vehicle assignments — a primary driver per vehicle ──────────────────────
  const aqVaRows = aqVehicles.map((v, i) => ({
    vehicleId:      v.id,
    userId:         pick(aqUsers, i).id,
    assignmentType: 'PRIMARY' as const,
    assignedAt:     addD(new Date('2026-01-05T06:00:00Z'), i),
    unassignedAt:   null as Date | null,
    notes:          null as string | null,
  }))
  await prisma.vehicleAssignment.createMany({ data: aqVaRows })
  console.log(`  ✓ ${aqVaRows.length} vehicle assignments`)

  // ── Trips (60) + cargo manifests — plant → customer deliveries ──────────────
  const aqWeekStart = new Date('2026-06-08T05:30:00Z')
  let aqTripCount = 0
  for (let i = 0; i < 60; i++) {
    const vehicle  = pick(aqVehicles, i)
    const saloon   = vehicle.vehicleType === 'SALOON'
    // Saloons only serve the Nairobi-area customers (first 6); trucks/lorries any.
    const customer = saloon ? pick(AQ_CUSTOMERS.slice(0, 6), i) : pick(AQ_CUSTOMERS, i)
    const beganAt  = addH(addD(aqWeekStart, i % 7), 1 + (i * 2) % 10)
    const distKm   = saloon ? pick([18, 24, 30, 36, 22, 28], i) : pick([30, 280, 160, 500, 40, 300, 170, 520], i)
    const avgKmh   = saloon ? pick([48, 55, 60, 52], i) : pick([50, 62, 58, 55], i)
    const durSec   = Math.round((distKm / avgKmh) * 3600) + pick([1200, 1800, 2400, 3000], i)
    const weightKg = saloon ? pick([220, 300, 380, 450, 260, 340], i) : pick([9000, 14000, 18000, 22000, 11000, 16000], i)
    const trip = await prisma.trip.create({
      data: {
        vehicleId:          vehicle.id,
        driverId:           pick(aqUsers, i).id,
        reportingPeriodId:  pick(aqPeriodIds, i),
        routeId:            i % 4 === 0 ? null : pick(aqRouteIds, i),
        beganAt,
        endedAt:            addH(beganAt, durSec / 3600),
        initialLocation:    AQ_HQ[2],
        finalLocation:      customer[2],
        durationSeconds:    durSec,
        mileageKm:          distKm,
        avgSpeedKmh:        avgKmh,
        maxSpeedKmh:        avgKmh + pick([15, 25, 30, 20], i),
        consumedMl:         saloon ? distKm * 90 : distKm * 380,
        initialFuelLevelMl: saloon ? 50_000 : 250_000,
        finalFuelLevelMl:   (saloon ? 50_000 : 250_000) - (saloon ? distKm * 90 : distKm * 380),
      },
      select: { id: true },
    })
    await prisma.cargoManifest.create({
      data: {
        tripId:            trip.id,
        cargoType:         'PACKAGED',
        description:       pick(AQ_PRODUCTS, i),
        declaredWeightKg:  weightKg,
        departureWeightKg: weightKg,
        arrivalWeightKg:   pick([0, weightKg * 0.02], i),   // fully offloaded (± crate returns)
        weightVarianceKg:  0,
      },
    })
    aqTripCount++
  }
  console.log(`  ✓ ${aqTripCount} trips + manifests`)

  // ── Fuel fillings (20) — at the plant before dispatch ───────────────────────
  const aqFfRows = Array.from({ length: 20 }, (_, i) => {
    const vehicle = pick(aqVehicles, i)
    const saloon  = vehicle.vehicleType === 'SALOON'
    const tankMl  = (vehicle.tankCapacityLitres ?? 200) * 1000
    const startMl = Math.round(tankMl * pick([0.25, 0.35, 0.45, 0.30], i))
    return {
      vehicleId:          vehicle.id,
      reportingPeriodId:  pick(aqPeriodIds, i),
      filledAt:           addH(addD(new Date('2026-06-08T05:00:00Z'), i % 7), (i * 3) % 12),
      location:           saloon ? 'Kikuyu Total Station' : AQ_HQ[2],
      initialFuelLevelMl: startMl,
      filledMl:           tankMl - startMl,
      finalFuelLevelMl:   tankMl,
      mileageAtFillKm:    pick([4000, 9000, 15000, 22000, 6000], i) + i * 3,
    }
  })
  await prisma.fuelFilling.createMany({ data: aqFfRows })
  console.log(`  ✓ ${aqFfRows.length} fuel fillings`)

  console.log('\n✅  Aquamist added — Sukari and its live-sim history untouched.\n')
}

main()
  .catch(err => {
    console.error('\n❌  Aquamist seed failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
    await pool.end()
  })
