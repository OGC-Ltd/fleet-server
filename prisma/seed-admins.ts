/**
 * Additive seed — one "Fleet Admin" user per organisation.
 *
 * The 2026-07-25 database clean (pre-Controltech) removed every user, which
 * breaks AUTH_BYPASS: middleware/auth.ts attaches the first ACTIVE user and
 * 401s the whole API when none exists. This restores exactly one non-driver
 * admin per org (no licence, no vehicle assignment) so the API authenticates
 * again while the Drivers page stays empty — the roster joins on vehicle
 * assignments, which admins never have.
 *
 * Idempotent: an org that already has an ACTIVE admin email is skipped.
 *
 * Run: npm run seed:admins
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma  = new PrismaClient({ adapter })

async function main() {
  console.log('\n🌱  Additive seed — per-org Fleet Admin users\n')

  const orgs = await prisma.organisation.findMany({ select: { id: true, code: true, name: true } })
  for (const org of orgs) {
    const email = `admin@${org.code.toLowerCase()}.fleet`
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } })
    if (existing) {
      console.log(`  ⏭  ${org.code}: ${email} already exists — skipped.`)
      continue
    }

    const user = await prisma.user.create({
      data: {
        organisationId: org.id,
        fullName:       `${org.name} Admin`,
        email,
        employeeId:     `${org.code}-ADM-0001`,
        status:         'ACTIVE',
      },
    })

    const adminRole = await prisma.role.findFirst({
      where:  { organisationId: org.id, slug: 'system_admin' },
      select: { id: true },
    })
    if (adminRole) {
      await prisma.userRole.create({ data: { userId: user.id, roleId: adminRole.id } })
    }
    console.log(`  ✓ ${org.code}: ${email}${adminRole ? ' (system_admin)' : ' (no system_admin role found)'}`)
  }

  console.log('\n✅  Admin users ensured for every organisation.\n')
}

main()
  .catch(err => {
    console.error('\n❌  seed-admins failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
    await pool.end()
  })
