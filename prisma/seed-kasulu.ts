/**
 * Additive seed — Kasulu Ltd (KASULU).
 *
 * Minimal by design: the org row + role/permission scaffolding ONLY. Vehicles,
 * drivers, and telemetry arrive from the real RaiFactorySuite API integration —
 * nothing is mocked here.
 *
 * NON-destructive and idempotent: if the KASULU code already exists the script
 * is a no-op, so it is safe to re-run.
 *
 * Run: npm run seed:kasulu
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma  = new PrismaClient({ adapter })

const ORG_CODE = 'KASULU'
const ORG_NAME = 'Kasulu Ltd'

// Same role set as the other seeds so RBAC behaves identically across orgs.
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

const RESOURCES = ['vehicle','trip','fuel_theft','fuel_filling','user','route',
                   'geofence','report','ingest_key','assignment','engine_session','cargo']
const ACTIONS   = ['read','create','update','delete','export']

async function main() {
  console.log(`\n🌱  Additive seed — ${ORG_NAME} (${ORG_CODE})\n`)

  const existing = await prisma.organisation.findUnique({ where: { code: ORG_CODE }, select: { id: true } })
  if (existing) {
    console.log(`  ⏭  already exists (${existing.id}) — nothing to do.`)
    return
  }

  // Permissions — reuse the global table; create the standard set if absent.
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

  const org = await prisma.organisation.create({ data: { name: ORG_NAME, code: ORG_CODE } })
  console.log(`  ✓ organisation ${org.id}`)

  // Roles + permissions (fleet_manager gets all, others 8 each — same split as
  // the other org seeds).
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

  console.log(`\n✅  ${ORG_NAME} seeded — fleet/driver data comes from the RaiFactorySuite integration.\n`)
}

main()
  .catch(err => {
    console.error('\n❌  seed-kasulu failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
    await pool.end()
  })
