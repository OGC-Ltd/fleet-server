/**
 * Additive seed — the ControlTech technician account.
 *
 * ControlTech East Africa fit and service the trackers and probes. This script
 * creates the technician account; assign organisation-specific groups from the
 * User accounts administration page when needed.
 *
 * ## It goes through provisionUser, not prisma.user.create
 *
 * Every other seed in here writes rows directly, and this one deliberately does
 * not. The account needs a home organisation, four memberships, fleet-wide
 * vehicle access on each, a group resolved from its address, and the subject and
 * roster caches invalidated afterwards — and provisionUser is where all of that
 * already lives, in the order the API does it. Hand-rolling the inserts would be
 * a second implementation of the rules, free to drift from the first.
 *
 * ## The password is NOT in this file
 *
 * It is read from CONTROLTECH_PASSWORD at run time and never written down here,
 * because this file is committed. Nothing echoes it either.
 *
 * ## Idempotent
 *
 * An existing account with this address is reported and left alone — including
 * its password, which provisionUser would otherwise overwrite.
 *
 * Run: CONTROLTECH_PASSWORD='…' npm run seed:controltech-user
 */

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { disconnectRedis } from '../src/lib/redis.js'
import { provisionUser } from '../src/modules/users/provisioning.service.js'

const EMAIL     = 'tech@controltech-ea.com'
const FULL_NAME = 'Technician'

async function main(): Promise<void> {
  const password = process.env.CONTROLTECH_PASSWORD
  if (!password || password.length < 12) {
    console.error('Set CONTROLTECH_PASSWORD (at least 12 characters) and run again.')
    console.error('It is read from the environment on purpose — this file is committed.')
    process.exitCode = 1
    return
  }

  const existing = await prisma.user.findFirst({
    where:  { email: EMAIL },
    select: { id: true, deletedAt: true, organisationId: true },
  })
  if (existing) {
    console.log(`${EMAIL} already exists (${existing.id})${existing.deletedAt ? ' — and is deleted' : ''}.`)
    console.log('Nothing written. Change it through the user administration screen rather than here.')
    return
  }

  /* Every organisation, as asked. Each membership carries `allVehicles`, which
     is what a contractor servicing trackers needs: the unit whose probe failed
     this morning may have been added to the fleet yesterday. */
  const orgs = await prisma.organisation.findMany({
    select: { id: true, code: true, name: true },
    orderBy: { name: 'asc' },
  })
  if (orgs.length === 0) {
    console.error('No organisations exist. Seed those first.')
    process.exitCode = 1
    return
  }

  /* NO ROLES, at the operator's instruction — they are being assigned later.
     Worth knowing what that means until then: the account can sign in and it
     is a member of all four organisations, but every permission check fails,
     so it sees no vehicles, no sensors and no repairs. `technician` is the role
     that fits it (repair:create / read / resolve, sensor:read, telemetry:read,
     vehicle:read, notification:read — and it exists in all four organisations
     already). Grant it from User accounts. */
  const { user, created } = await provisionUser({
    fullName:   FULL_NAME,
    email:      EMAIL,
    password,
    memberships: orgs.map((o) => ({
      organisationId:  o.id,
      roleSlugs:       [],
      allVehicles:     true,
      vehicleIds:      [],
      vehicleGroupIds: [],
    })),
  }, { allowPlatformRoles: false })

  const row = await prisma.user.findUnique({
    where:  { id: user!.id },
    select: {
      id: true,
      email: true,
      organisationId: true,
      groups: { select: { group: { select: { slug: true } } } },
    },
  })

  console.log(`${created ? 'Created' : 'Updated'} ${row?.email}`)
  console.log(`  id            ${row?.id}`)
  console.log(`  groups        ${row?.groups.map(({ group }) => group.slug).join(', ') || '(assign from User accounts)'}`)
  console.log(`  home org      ${orgs.find(o => o.id === row?.organisationId)?.name ?? row?.organisationId}`)
  console.log(`  memberships   ${orgs.map(o => o.code).join(', ')}`)
  console.log('  roles         none — assign one from User accounts before they can see anything')
}

/* Redis as well as Postgres, which the other seeds do not need to do.
   provisionUser invalidates the subject and roster caches, and that opens a
   cache connection — so without this the work commits, the summary prints, and
   the process then sits there with a live socket and never exits. Measured on
   the box: the account was created and the script was still running two minutes
   later. */
main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(async () => {
    await prisma.$disconnect()
    await disconnectRedis()
  })
