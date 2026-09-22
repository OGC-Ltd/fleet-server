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
 *   kasulu    kasulu.co.ke and every subdomain — `admin.kasulu.co.ke` is the
 *             address that prompted this.
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
      { pattern: 'kasulu.co.ke', kind: 'SUFFIX' },
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
  }

  console.log('\nNothing has been placed in a group yet.')
  console.log('Next: npm run backfill:user-groups   (a dry run; add -- --apply to write)')
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
