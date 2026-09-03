/**
 * Mint (or repair) the first platform account.
 *
 * Measured on af-south-1 on 2026-09-03: 551 users, and **not one** with a
 * password hash. Every row is a provider-synced driver — `sync:drivers` writes
 * people, not logins — so there is no account anywhere that can sign in, and
 * turning enforcement on before running this locks out everybody including
 * whoever would fix it. This script is the way in.
 *
 * It grants the `super_admin` PLATFORM role (organisation_id NULL), whose
 * permissions apply in every organisation. It also writes a membership per
 * organisation: platform reach does not need one, but the memberships make the
 * account legible in the same places every other account appears, and mean
 * demoting it later leaves something sane behind rather than an orphan.
 *
 * Requires seed-rbac to have run — the role it grants has to exist.
 *
 * PASSWORD: pass it in the environment, not on the command line. Process
 * arguments are readable by any other process on the box (`ps auxww`) and land
 * in shell history; `--password` is accepted for convenience and warns.
 *
 *   SUPERADMIN_EMAIL=ops@example.com \
 *   SUPERADMIN_PASSWORD='…' \
 *   SUPERADMIN_NAME='Ops Lead' \
 *   npm run seed:superadmin
 */

import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { prisma } from '../src/lib/prisma.js'
import { invalidateSubject } from '../src/lib/authz/subject.js'

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const BCRYPT_ROUNDS = 12

async function main(): Promise<void> {
  const email = process.env['SUPERADMIN_EMAIL'] ?? arg('--email')
  const name  = process.env['SUPERADMIN_NAME']  ?? arg('--name') ?? 'Super Administrator'
  let password = process.env['SUPERADMIN_PASSWORD']
  if (!password) {
    password = arg('--password')
    if (password) {
      console.warn('! --password is visible in `ps` and shell history. Prefer SUPERADMIN_PASSWORD.')
    }
  }

  if (!email || !password) {
    console.error('Need SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD (or --email/--password).')
    process.exitCode = 1
    return
  }
  if (password.length < 12) {
    console.error('Refusing a password under 12 characters for an account that can reach every organisation.')
    process.exitCode = 1
    return
  }

  const role = await prisma.role.findFirst({
    where:  { organisationId: null, slug: 'super_admin' },
    select: { id: true },
  })
  if (!role) {
    console.error('No platform role `super_admin`. Run `npm run seed:rbac` first.')
    process.exitCode = 1
    return
  }

  const orgs = await prisma.organisation.findMany({ select: { id: true, code: true }, orderBy: { createdAt: 'asc' } })
  const home = orgs[0]
  if (!home) {
    console.error('No organisations exist — nothing to administer.')
    process.exitCode = 1
    return
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)

  // `users.organisation_id` is NOT NULL and means WHO EMPLOYS this person. A
  // platform account still needs one; its reach comes from the role, not here.
  const existing = await prisma.user.findFirst({ where: { email }, select: { id: true } })
  const user = existing
    ? await prisma.user.update({
        where:  { id: existing.id },
        data:   { passwordHash, fullName: name, status: 'ACTIVE', deletedAt: null },
        select: { id: true },
      })
    : await prisma.user.create({
        data: {
          email, fullName: name, passwordHash,
          organisationId: home.id,
          status: 'ACTIVE',
        },
        select: { id: true },
      })

  console.log(`${existing ? 'updated' : 'created'} ${email}`)

  // Idempotent: a live grant is guaranteed unique by the partial index added in
  // 20260903090000_rbac_membership_and_sessions.
  const heldRole = await prisma.userRole.findFirst({
    where:  { userId: user.id, roleId: role.id, revokedAt: null },
    select: { id: true },
  })
  if (!heldRole) {
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } })
    console.log('granted super_admin (platform)')
  } else {
    console.log('already holds super_admin')
  }

  for (const org of orgs) {
    const has = await prisma.orgMembership.findUnique({
      where:  { userId_organisationId: { userId: user.id, organisationId: org.id } },
      select: { id: true, revokedAt: true },
    })
    if (!has) {
      await prisma.orgMembership.create({
        data: { userId: user.id, organisationId: org.id, allVehicles: true },
      })
      console.log(`  membership ${org.code}`)
    } else if (has.revokedAt) {
      await prisma.orgMembership.update({ where: { id: has.id }, data: { revokedAt: null } })
      console.log(`  membership ${org.code} (reinstated)`)
    }
  }

  // The resolver caches for 5 minutes; without this, a repair to a locked-out
  // account appears not to have worked.
  await invalidateSubject(user.id)

  console.log('\ndone — this account can sign in at POST /api/v1/auth/login')
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
