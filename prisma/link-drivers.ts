/**
 * Create drivers by hand and assign each to the vehicle they drive.
 *
 * ## Why this exists at all
 *
 * "Control Tech" is RaiFactorySuite, and `sync-drivers.ts` pulls its registry
 * into `users` + `vehicle_assignments` automatically. But its FACTORY_TO_ORG
 * map is `{ NDHIWA: 'SUKARI' }` and nothing else, so **only Sukari has an
 * upstream driver source**. Menengai, West Kenya and Mufindi drivers cannot be
 * pulled from anywhere; somebody reads them off a roster and types them in.
 * This is that, done once rather than six times in a UI.
 *
 * ## Editing it for the next batch
 *
 * Change ORG_CODE and ROSTER. Everything else holds. Plates go in the WRITTEN
 * form, with the space, exactly as they are painted on the vehicle and stored
 * in the column — see `fix-plate-format.ts` for why that distinction matters.
 *
 * `externalId` is deliberately left NULL on everyone created here. It is the
 * key `sync:drivers` upserts on, so a NULL is what guarantees a provider sync
 * can never match one of these rows and overwrite a name typed off a roster.
 *
 * The role is granted by SLUG, never by name: every organisation has its own
 * row called "Driver", and picking by name picks somebody else's.
 *
 * ## Re-runnable
 *
 *   • a user is matched on exact fullName within the org before being created
 *   • the role is granted only if no LIVE grant exists — grants are
 *     soft-revoked, so "already granted" has to ignore revoked rows
 *   • an assignment is created only if the vehicle has no open one
 *
 * A vehicle already assigned to somebody ELSE is REPORTED, never reassigned.
 * Moving a driver off a truck is an operational decision, not a script's.
 *
 * Dry run unless --apply.
 *
 * Run: npm run link:drivers
 *      npm run link:drivers -- --apply
 *
 * First applied 2026-09-15 for the six Menengai drivers below — that org's
 * first vehicle assignments, and the roster left in place as the worked
 * example for the next one.
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

const APPLY = process.argv.includes('--apply')
const ORG_CODE = 'MENENGAI'

/** plate as written on the vehicle, driver as given by the operator */
const ROSTER: Array<[string, string]> = [
  ['KCP 131P', 'Isaac Oite'],
  ['KCB 303Z', 'Duncan Mwangi'],
  ['KCP 134P', 'Dickson Kiplagat'],
  ['KCP 043S', 'Evanson Wainaina'],
  ['KCP 136P', 'Maxwell Masinde'],
  ['KBY 003A', 'Francis Kipsang'],
]

const norm = (p: string) => p.toUpperCase().replace(/[^A-Z0-9]/g, '')

async function main() {
  console.log(`\n🚚  Menengai driver roster — ${APPLY ? 'APPLYING' : 'DRY RUN'}\n`)

  const org = await prisma.organisation.findUnique({
    where: { code: ORG_CODE }, select: { id: true, name: true },
  })
  if (!org) throw new Error(`organisation ${ORG_CODE} not found`)

  const role = await prisma.role.findFirst({
    where: { organisationId: org.id, slug: 'driver' }, select: { id: true, name: true },
  })
  if (!role) throw new Error(`${ORG_CODE} has no 'driver' role`)
  console.log(`org:  ${org.name}\nrole: ${role.name} (slug driver)\n`)

  // Plates are stored in WRITTEN form, but compare on the normalised form so a
  // re-run still matches if a sync ever rewrites the spelling.
  const rows = await prisma.$queryRaw<Array<{ id: string; plate: string; key: string }>>`
    SELECT id, registration_plate AS plate,
           upper(replace(registration_plate, ' ', '')) AS key
      FROM vehicles
     WHERE organisation_id = ${org.id}
       AND upper(replace(registration_plate, ' ', '')) = ANY(${ROSTER.map(([p]) => norm(p))}::text[])`
  const vehicleByKey = new Map(rows.map((r) => [r.key, r]))

  const missing = ROSTER.filter(([p]) => !vehicleByKey.has(norm(p)))
  if (missing.length) {
    console.error('✗ these plates are not in the fleet — resolve before writing:')
    missing.forEach(([p, n]) => console.error(`    ${p}  (${n})`))
    throw new Error(`${missing.length} plate(s) missing`)
  }

  let usersCreated = 0, rolesGranted = 0, assigned = 0, conflicts = 0, noop = 0

  for (const [plate, fullName] of ROSTER) {
    const vehicle = vehicleByKey.get(norm(plate))!
    const notes: string[] = []

    let user = await prisma.user.findFirst({
      where: { organisationId: org.id, fullName, deletedAt: null },
      select: { id: true },
    })
    if (!user) {
      notes.push('user CREATE')
      usersCreated++
      if (APPLY) {
        user = await prisma.user.create({
          // email/externalId/passwordHash stay NULL: drivers do not log in, and
          // a NULL externalId keeps them outside any provider upsert.
          data: { organisationId: org.id, fullName },
          select: { id: true },
        })
      }
    } else {
      notes.push('user exists')
    }

    if (user) {
      const live = await prisma.userRole.findFirst({
        where: { userId: user.id, roleId: role.id, revokedAt: null }, select: { id: true },
      })
      if (!live) {
        notes.push('role GRANT')
        rolesGranted++
        if (APPLY) await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } })
      } else {
        notes.push('role held')
      }
    } else {
      notes.push('role GRANT')
      rolesGranted++
    }

    const open = await prisma.vehicleAssignment.findFirst({
      where: { vehicleId: vehicle.id, unassignedAt: null },
      select: { id: true, userId: true, user: { select: { fullName: true } } },
    })
    if (open && user && open.userId === user.id) {
      notes.push('already assigned')
      noop++
    } else if (open) {
      notes.push(`✗ CONFLICT: held by ${open.user.fullName} — left alone`)
      conflicts++
    } else {
      notes.push('assign PRIMARY')
      assigned++
      if (APPLY && user) {
        await prisma.vehicleAssignment.create({
          data: {
            vehicleId: vehicle.id, userId: user.id,
            assignmentType: 'PRIMARY',
            notes: 'Manual roster — not in the Control Tech driver registry',
          },
        })
      }
    }

    console.log(`  ${plate.padEnd(9)} ${fullName.padEnd(18)} ${notes.join(' · ')}`)
  }

  console.log(
    `\nusers created ${usersCreated} · roles granted ${rolesGranted} · ` +
    `assignments ${assigned} · unchanged ${noop} · conflicts ${conflicts}`)
  if (!APPLY) console.log('\nDRY RUN — nothing written. Re-run with --apply.')
  if (conflicts) console.log('Conflicts were NOT touched; they need an operator decision.')
}

main()
  .catch((e) => { console.error('\n✗', e.message); process.exitCode = 1 })
  .finally(async () => { await prisma.$disconnect(); await pool.end() })
