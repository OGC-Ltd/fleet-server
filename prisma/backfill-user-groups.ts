/**
 * Place existing accounts into their groups — and, before that, say what
 * placing them would do.
 *
 * ## A DRY RUN unless you pass --apply
 *
 * This decides who may administer whom. Under `USER_GROUP_ENFORCE` an
 * administrator sees only their own group, and an administrator with NO group
 * sees NOBODY. So the dangerous outcome of this script is not a wrong group;
 * it is an empty one, and the person who discovers it is an operator who can
 * no longer do their job.
 *
 * The dry run therefore prints the thing that actually matters: the LOCKOUT
 * LIST — every account holding `admin` or `system_admin` that no rule places.
 * That list must be empty before `USER_GROUP_ENFORCE` goes true. Everything
 * else in the output is context for reading it.
 *
 * ## It never overwrites a placement it did not make
 *
 * An account already sitting in a group that the rules would NOT have chosen
 * was put there by hand — a contractor on a personal address, somebody moved
 * during a handover. Re-running this must not quietly undo that. Such rows are
 * reported as "kept" and skipped. `--force` overrides, and says how many.
 *
 * ## Registry drivers are expected to be ungrouped
 *
 * The accounts synced from RaiFactorySuite carry no email, so no rule can
 * place them, and they are counted separately rather than reported as a
 * problem. Group scoping applies only to the administration roster, which
 * already excludes them (see users/user.repository `rosterWhere`) — nothing
 * about the drivers page or the live map depends on this column.
 *
 * Run: npm run backfill:user-groups            (dry run)
 *      npm run backfill:user-groups -- --apply
 *      npm run backfill:user-groups -- --apply --force
 */

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { groupForEmail, type GroupRule } from '../src/modules/users/user-group.match.js'


const APPLY = process.argv.includes('--apply')
const FORCE = process.argv.includes('--force')

/** The roles for whom "ungrouped" means "locked out of their own job". */
const ADMIN_SLUGS = new Set(['admin', 'system_admin'])
/** Unscoped by design — see users/user-group.scope. Never at risk. */
const PLATFORM_SLUGS = new Set(['super_admin'])

async function main(): Promise<void> {
  const rules: GroupRule[] = (await prisma.groupEmailDomain.findMany({
    select: { groupId: true, pattern: true, kind: true },
  })).map(r => ({ groupId: r.groupId, pattern: r.pattern, kind: r.kind }))

  if (rules.length === 0) {
    console.error('No domain rules exist. Run `npm run seed:user-groups` first.')
    process.exitCode = 1
    return
  }

  const groups = await prisma.userGroup.findMany({ select: { id: true, slug: true } })
  const slugOf = new Map(groups.map(g => [g.id, g.slug]))

  const users = await prisma.user.findMany({
    where:  { deletedAt: null },
    select: {
      id: true, email: true, fullName: true, groupId: true,
      userRoles: {
        where:  { revokedAt: null },
        select: { role: { select: { slug: true } } },
      },
    },
  })

  const plan: { id: string; email: string | null; from: string | null; to: string | null }[] = []
  const kept: typeof plan = []
  const lockedOut: { email: string | null; fullName: string; roles: string[] }[] = []

  let noEmail = 0
  const tally = new Map<string, number>()

  for (const u of users) {
    const slugs = u.userRoles.map(r => r.role.slug)
    const resolved = groupForEmail(u.email, rules)

    if (!u.email) noEmail++

    const key = resolved ? (slugOf.get(resolved) ?? resolved) : '(ungrouped)'
    tally.set(key, (tally.get(key) ?? 0) + 1)

    // Hand-placed: sitting somewhere the rules would not have put them.
    const handPlaced = u.groupId !== null && u.groupId !== resolved
    if (handPlaced && !FORCE) {
      kept.push({ id: u.id, email: u.email, from: u.groupId, to: resolved })
    } else if (u.groupId !== resolved) {
      plan.push({ id: u.id, email: u.email, from: u.groupId, to: resolved })
    }

    // The list that decides whether this is safe to turn on. Measured against
    // what the account WOULD end up with, not what it holds now.
    const effective = handPlaced && !FORCE ? u.groupId : resolved
    const isAdmin    = slugs.some(s => ADMIN_SLUGS.has(s))
    const isPlatform = slugs.some(s => PLATFORM_SLUGS.has(s))
    if (isAdmin && !isPlatform && effective === null) {
      lockedOut.push({ email: u.email, fullName: u.fullName, roles: slugs })
    }
  }

  console.log(`\n${users.length} live accounts, ${rules.length} rules, ${groups.length} groups.`)
  console.log(`${noEmail} carry no email (registry drivers — expected to be ungrouped).\n`)

  console.log('Would resolve to:')
  for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${k}`)
  }

  console.log(`\n${plan.length} rows would change, ${kept.length} hand-placed rows kept.`)
  for (const row of plan.slice(0, 20)) {
    const from = row.from ? (slugOf.get(row.from) ?? row.from) : '—'
    const to   = row.to   ? (slugOf.get(row.to)   ?? row.to)   : '—'
    console.log(`  ${(row.email ?? '(no email)').padEnd(40)} ${from} -> ${to}`)
  }
  if (plan.length > 20) console.log(`  … and ${plan.length - 20} more`)

  if (kept.length > 0 && !FORCE) {
    console.log('\nKept (placed by hand; pass --force to overwrite):')
    for (const row of kept) {
      console.log(`  ${(row.email ?? '(no email)').padEnd(40)} ${slugOf.get(row.from!) ?? row.from}`)
    }
  }

  // ---------------------------------------------------------------------
  // The number this script exists to print.
  // ---------------------------------------------------------------------
  console.log('\n--- LOCKOUT LIST ---')
  if (lockedOut.length === 0) {
    console.log('Empty. No administrator would lose their roster.')
    console.log('USER_GROUP_ENFORCE is safe to turn on once these placements are applied.')
  } else {
    console.log(`${lockedOut.length} ADMINISTRATOR(S) WOULD SEE NOBODY:`)
    for (const a of lockedOut) {
      console.log(`  ${(a.email ?? '(no email)').padEnd(40)} ${a.fullName}  [${a.roles.join(', ')}]`)
    }
    console.log('\nAdd a domain rule for each, or place them by hand, before enforcing.')
    console.log('DO NOT set USER_GROUP_ENFORCE=true while this list is non-empty.')
  }

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with `-- --apply` to write.')
    return
  }

  // Grouped by target so this is a handful of statements rather than one per
  // account; the roster is ~550 rows and most of them resolve the same way.
  const byTarget = new Map<string | null, string[]>()
  for (const row of plan) {
    const list = byTarget.get(row.to) ?? []
    list.push(row.id)
    byTarget.set(row.to, list)
  }
  for (const [groupId, ids] of byTarget) {
    await prisma.user.updateMany({ where: { id: { in: ids } }, data: { groupId } })
    console.log(`wrote ${ids.length} -> ${groupId ? (slugOf.get(groupId) ?? groupId) : 'ungrouped'}`)
  }
  console.log(`\nApplied. ${plan.length} rows updated.`)
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
