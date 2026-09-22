/**
 * Seed the user groups and the email-domain rules that route into them.
 *
 * ADDITIVE and idempotent, like seed-rbac and unlike seed.ts: it upserts two
 * groups and their patterns and touches no `users` row at all. Placing people
 * is a separate step on purpose — see prisma/backfill-user-groups.ts, which is
 * a dry run until told otherwise.
 *
 * The groups, as the operator described them:
 *
 *   offgrid   offgridconsultingltd.com, and anything under an `ogc-monitoring`
 *             label. The second is a LABEL rule because it was given without a
 *             TLD, so it has to match whatever domain it turns up under.
 *   kasulu    any `kasulu` label. It was `kasulu.co.ke` SUFFIX, from the
 *             example address this was specified with, and MEASURED against
 *             production on 2026-09-22 that rule matched nothing at all: the
 *             site is Tanzanian and its accounts are on `kasulu.co.tz`, with
 *             the org's own administrator on the internal `kasulu.fleet`.
 *             A label catches both, which a suffix for either would not.
 *   sukari    the same, for `sukari.fleet`. Sukari was not named when this was
 *             specified, but it is a company like the other two and its
 *             administrator has to land somewhere: ungrouped means invisible
 *             to everyone but the platform administrator once enforcement is
 *             on, which for a system_admin is a lockout.
 *
 * Adding a rule here is a real access-control change: it moves whoever it
 * matches into a group, and therefore changes who may administer them. Run the
 * backfill's dry run afterwards and read what it says before committing to it.
 *
 * Run: npm run seed:user-groups
 */

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import type { DomainMatch } from '../generated/prisma/enums.js'


interface GroupSeed {
  slug: string
  name: string
  description: string
  domains: { pattern: string; kind: DomainMatch }[]
}

const GROUPS: GroupSeed[] = [
  {
    slug: 'offgrid',
    name: 'Offgrid',
    description: 'Offgrid Consulting staff and the monitoring team.',
    domains: [
      { pattern: 'offgridconsultingltd.com', kind: 'SUFFIX' },
      { pattern: 'ogc-monitoring',           kind: 'LABEL'  },
    ],
  },
  {
    slug: 'kasulu',
    name: 'Kasulu',
    description: 'Kasulu site staff.',
    domains: [
      // LABEL, not a suffix: the live accounts are on kasulu.co.tz and
      // kasulu.fleet, which no single suffix covers.
      { pattern: 'kasulu', kind: 'LABEL' },
    ],
  },
  {
    slug: 'sukari',
    name: 'Sukari',
    description: 'Sukari Industries staff.',
    domains: [
      { pattern: 'sukari', kind: 'LABEL' },
    ],
  },
]

async function main(): Promise<void> {
  for (const g of GROUPS) {
    const group = await prisma.userGroup.upsert({
      where:  { slug: g.slug },
      update: { name: g.name, description: g.description },
      create: { slug: g.slug, name: g.name, description: g.description },
    })
    console.log(`group ${g.slug} (${group.id})`)

    for (const d of g.domains) {
      // Lowercased here as well as in the matcher: `pattern` is UNIQUE, and
      // two rows differing only in case would both be live and disagree.
      const pattern = d.pattern.trim().toLowerCase()
      await prisma.groupEmailDomain.upsert({
        where:  { pattern },
        // A pattern that already routes SOMEWHERE ELSE is repointed, and the
        // line below says so — that is a deliberate re-route, not a clash.
        update: { groupId: group.id, kind: d.kind },
        create: { groupId: group.id, pattern, kind: d.kind },
      })
      console.log(`  ${d.kind.padEnd(6)} ${pattern}`)
    }

    /* Rules this group used to have and no longer does.
       Without this the seed can only ever ADD: `kasulu.co.ke` was seeded on
       2026-09-22, measured against production, found to match nothing, and
       replaced by a label — and it would have stayed behind as a rule that
       reads like Kasulu is covered while matching no address in the fleet. A
       stale access-control rule is worse than a missing one, because somebody
       reads it and believes it.

       Scoped to THIS group's rows, so it can never touch another group's. */
    const keep = g.domains.map(d => d.pattern.trim().toLowerCase())
    const stale = await prisma.groupEmailDomain.findMany({
      where:  { groupId: group.id, pattern: { notIn: keep } },
      select: { id: true, pattern: true },
    })
    for (const r of stale) {
      await prisma.groupEmailDomain.delete({ where: { id: r.id } })
      console.log(`  removed ${r.pattern} (no longer listed)`)
    }
  }

  console.log('\nNothing has been placed in a group yet.')
  console.log('Next: npm run backfill:user-groups   (a dry run; add -- --apply to write)')
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
