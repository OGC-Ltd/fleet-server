/**
 * Move the super admins off the platform grant and onto each organisation's
 * own System Administrator role.
 *
 * ## What this is for
 *
 * `super_admin` is a PLATFORM role: one row, `organisation_id IS NULL`, and
 * holding it makes `canReachOrg` true everywhere and `platform:admin` satisfy
 * every permission check in every tenant. That is why an account page could
 * show "applies in every organisation" above a list of organisations most of
 * which said "No role assigned" — the access was real and the per-organisation
 * roster had nothing to show for it.
 *
 * The replacement is `admin`, now displayed as "System Administrator", which
 * seed-rbac writes into EVERY organisation and which carries the same
 * org-scoped permissions the platform wildcard was standing in for.
 *
 * ## The order is the whole safety argument
 *
 * GRANT FIRST, REVOKE SECOND, and never the other way round. Between the two
 * the person holds both, which is harmless. Reversed, there is a window — and
 * on a failure a permanent state — in which they hold neither, and the routes
 * that would let them fix it are the ones they just lost. Both halves run in
 * ONE transaction so a failure leaves the grants untouched.
 *
 * ## What it deliberately does NOT do
 *
 * It does not delete the `super_admin` role, and it does not revoke it from
 * everybody. Platform-only surface exists — `requirePermission` on a route with
 * no `:orgId` is satisfied only by `subject.isPlatform` — so the organisation
 * list itself becomes unadministrable if nobody holds it. `--keep` names the
 * accounts that stay platform administrators; at least one is required unless
 * `--allow-none` is passed, because leaving zero is a decision, not a default.
 *
 * ## Usage
 *
 *   npx tsx scripts/retire-platform-super-admin.ts --keep sadmin@example.com
 *   npx tsx scripts/retire-platform-super-admin.ts --keep sadmin@example.com --apply
 *
 * Dry run unless `--apply` is passed. The dry run prints exactly the writes the
 * real run would make and touches nothing.
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const ALLOW_NONE = args.includes('--allow-none')
const KEEP = args
  .map((a, i) => (a === '--keep' ? args[i + 1] : null))
  .filter((v): v is string => Boolean(v))
  .map((v) => v.toLowerCase())

async function main(): Promise<void> {
  if (KEEP.length === 0 && !ALLOW_NONE) {
    throw new Error(
      'Refusing to run with no --keep. Removing the platform role from everybody leaves the '
      + 'organisation list unadministrable, because a route with no :orgId is satisfied only by a '
      + 'platform role. Name at least one account to keep, or pass --allow-none if that is what you mean.',
    )
  }

  const platformRole = await prisma.role.findFirst({
    where: { organisationId: null, slug: 'super_admin' },
    select: { id: true, name: true },
  })
  if (!platformRole) throw new Error('No platform super_admin role found — nothing to retire.')

  // Everybody currently holding it, and every organisation they can reach.
  const holders = await prisma.userRole.findMany({
    where: { roleId: platformRole.id, revokedAt: null, user: { deletedAt: null } },
    select: {
      id: true,
      user: {
        select: {
          id: true, fullName: true, email: true, organisationId: true,
          memberships: {
            where: { revokedAt: null },
            select: { organisationId: true, organisation: { select: { name: true } } },
          },
        },
      },
    },
  })

  const orgs = await prisma.organisation.findMany({ select: { id: true, name: true, code: true } })
  const orgAdminRoles = await prisma.role.findMany({
    where:  { slug: 'admin', organisationId: { in: orgs.map((o) => o.id) } },
    select: { id: true, organisationId: true, name: true },
  })
  const adminRoleFor = new Map(orgAdminRoles.map((r) => [r.organisationId as string, r]))

  // An organisation with no `admin` row cannot receive the replacement grant,
  // and discovering that AFTER revoking is the failure this whole script is
  // shaped to avoid. Seed first, then run this.
  const missing = orgs.filter((o) => !adminRoleFor.has(o.id))
  if (missing.length) {
    throw new Error(
      `These organisations have no 'admin' role to grant: ${missing.map((o) => o.code).join(', ')}. `
      + 'Run `npx tsx prisma/seed-rbac.ts` first — it writes the role into every organisation.',
    )
  }

  console.log(`platform role: ${platformRole.name} (super_admin)`)
  console.log(`organisations: ${orgs.length}`)
  console.log(`holders:       ${holders.length}\n`)

  const grants: { userId: string; roleId: string; who: string; where: string }[] = []
  const revokes: { id: string; who: string }[] = []

  for (const h of holders) {
    const who = `${h.user.fullName} <${h.user.email ?? 'no email'}>`
    if (h.user.email && KEEP.includes(h.user.email.toLowerCase())) {
      console.log(`KEEP    ${who} — stays a platform administrator`)
      continue
    }

    // Their home organisation counts even when no membership row names it:
    // `users.organisation_id` is where they belong, and a super admin often has
    // never needed a membership anywhere.
    const reach = new Map<string, string>([[h.user.organisationId, 'home']])
    for (const m of h.user.memberships) reach.set(m.organisationId, m.organisation.name)

    for (const [orgId] of reach) {
      const role = adminRoleFor.get(orgId)
      if (!role) continue
      const org = orgs.find((o) => o.id === orgId)
      const already = await prisma.userRole.findFirst({
        where:  { userId: h.user.id, roleId: role.id, revokedAt: null },
        select: { id: true },
      })
      if (already) {
        console.log(`HAS     ${who} already System Administrator at ${org?.code}`)
        continue
      }
      grants.push({ userId: h.user.id, roleId: role.id, who, where: org?.code ?? orgId })
    }
    revokes.push({ id: h.id, who })
  }

  console.log('')
  for (const g of grants) console.log(`GRANT   System Administrator at ${g.where} to ${g.who}`)
  for (const r of revokes) console.log(`REVOKE  platform super_admin from ${r.who}`)

  const stillPlatform = holders.length - revokes.length
  console.log(`\nplatform administrators after this: ${stillPlatform}`)
  if (stillPlatform === 0 && !ALLOW_NONE) {
    throw new Error('That would leave nobody with a platform role. Re-run with --keep, or --allow-none.')
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to make these changes.')
    return
  }

  // One transaction: grants before revocations, and neither without the other.
  await prisma.$transaction(async (tx) => {
    for (const g of grants) {
      await tx.userRole.create({ data: { userId: g.userId, roleId: g.roleId } })
    }
    for (const r of revokes) {
      await tx.userRole.update({ where: { id: r.id }, data: { revokedAt: new Date() } })
    }
  })

  console.log(`\napplied: ${grants.length} granted, ${revokes.length} revoked.`)
  console.log('Resolved permissions are cached per user — bump the authz epoch or restart the server.')
}

main()
  .catch((err) => { console.error(String(err instanceof Error ? err.message : err)); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
