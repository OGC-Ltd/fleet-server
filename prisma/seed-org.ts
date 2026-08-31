/**
 * Create an EMPTY organisation — the org row plus role/permission scaffolding.
 *
 * Minimal by design, and that is the whole point of it existing separately
 * from `seed-orgs.ts`. That script invents a fleet: run it and MENENGAI
 * appears with 15 fabricated vehicles on KMG plates, 23 fabricated drivers and
 * a fortnight of fabricated trips, because it was written to populate the
 * simulator. Onboarding a real customer must not go near it — the vehicles
 * come from `sync:wialon`, the telemetry from the live poller, and anything
 * this script invented would sit in the same tables as the real rows with no
 * way to tell them apart later.
 *
 * So: no users, no vehicles, no trips. Roles only, so RBAC behaves the same as
 * it does for every other org.
 *
 * NON-destructive and idempotent: an org whose code already exists is a no-op,
 * so it is safe to re-run.
 *
 * Run: npm run seed:org -- --code=MENENGAI --name="Menengai Group"
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { findFleet } from '../src/providers/wialon/wialon.account.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma  = new PrismaClient({ adapter })

/** Read a `--flag=value` argument; the last occurrence wins, as in sync-wialon. */
const argValue = (flag: string): string | null => {
  for (let i = process.argv.length - 1; i >= 0; i--) {
    const a = process.argv[i]!
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1)
  }
  return null
}

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
  const code = argValue('--code')?.trim().toUpperCase()
  if (!code) throw new Error('--code=CODE is required, e.g. --code=MENENGAI')

  // The fleet registry already names every org this platform syncs from
  // Wialon, so --name is optional for those and the two can never drift.
  const name = argValue('--name')?.trim() || findFleet(code)?.orgName
  if (!name) throw new Error(`--name is required for ${code} (it has no entry in providers/wialon/wialon.account)`)

  console.log(`\n🌱  Additive seed — ${name} (${code})\n`)

  const existing = await prisma.organisation.findUnique({ where: { code }, select: { id: true, name: true } })
  if (existing) {
    console.log(`  ⏭  already exists (${existing.id}, "${existing.name}") — nothing to do.`)
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

  const org = await prisma.organisation.create({ data: { name, code } })
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

  const fleet = findFleet(code)
  console.log(`\n✅  ${name} seeded — no vehicles, no users, nothing invented.`)
  if (fleet) console.log(`    Next:  npm run sync:wialon -- --org=${code}          (preview the fleet)\n`)
  else       console.log(`    Its vehicles must come from a provider sync.\n`)
}

main()
  .catch(err => {
    console.error('\n❌  seed-org failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
    await pool.end()
  })
