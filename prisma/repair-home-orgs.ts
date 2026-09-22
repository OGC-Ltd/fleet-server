/**
 * Bring `users.organisation_id` back among the organisations people can reach.
 *
 * ## What went wrong
 *
 * The home organisation was written once, when the account was created, and
 * nothing revisited it. Memberships come and go. So an account granted four
 * organisations and later removed from three kept a home organisation naming
 * one of the three it had lost, and the account page printed
 * "Home organisation: Kabras" directly above an Organisations list with no
 * Kabras in it — two facts about one person, on one screen, disagreeing.
 *
 * `revokeMembership` now keeps the two in step going forward (see
 * users/provisioning.service `rehomeIfNeeded`). This repairs the rows that
 * diverged before it did.
 *
 * ## Who is deliberately NOT touched
 *
 * Accounts with NO live membership at all. That is the ~549 synced from the
 * RaiFactorySuite driver registry: their home organisation is the only
 * organisation they have, it is what the analytics roster reads, and there is
 * nothing to reconcile it against. Moving them would break the drivers page
 * to fix a mismatch they do not have.
 *
 * The same rule as the live path, so the two cannot disagree: only when the
 * home organisation is absent from the live memberships, and only ever to the
 * OLDEST membership that survives.
 *
 * Run: npm run repair:home-orgs            (dry run)
 *      npm run repair:home-orgs -- --apply
 */

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'

const APPLY = process.argv.includes('--apply')

async function main(): Promise<void> {
  const users = await prisma.user.findMany({
    where:  { deletedAt: null },
    select: {
      id: true, fullName: true, email: true, organisationId: true,
      organisation: { select: { name: true } },
      memberships: {
        where:   { revokedAt: null },
        orderBy: { createdAt: 'asc' },
        select:  { organisationId: true, organisation: { select: { name: true } } },
      },
    },
  })

  let noMemberships = 0
  let alreadyRight  = 0
  const plan: { id: string; who: string; from: string; to: string }[] = []

  for (const u of users) {
    if (u.memberships.length === 0) { noMemberships++; continue }
    if (u.memberships.some(m => m.organisationId === u.organisationId)) { alreadyRight++; continue }

    const survivor = u.memberships[0]!   // oldest — the ordering above
    plan.push({
      id:   u.id,
      who:  u.email ?? u.fullName,
      from: u.organisation?.name ?? u.organisationId,
      to:   survivor.organisation.name,
    })
  }

  console.log(`\n${users.length} live accounts.`)
  console.log(`  ${noMemberships} have no membership at all (registry drivers — left alone).`)
  console.log(`  ${alreadyRight} already have a home organisation they can reach.`)
  console.log(`  ${plan.length} have drifted.\n`)

  for (const row of plan) {
    console.log(`  ${row.who.padEnd(40)} ${row.from} -> ${row.to}`)
  }

  if (plan.length === 0) {
    console.log('Nothing to repair.')
    return
  }
  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with `-- --apply` to write.')
    return
  }

  for (const row of plan) {
    const target = users.find(u => u.id === row.id)!.memberships[0]!.organisationId
    await prisma.user.update({ where: { id: row.id }, data: { organisationId: target } })
  }
  console.log(`\nApplied. ${plan.length} home organisations moved.`)
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
