/**
 * Set each organisation's registered legal name.
 *
 * The names shipped as working shorthand — "Kasulu", "Menengai", "West Kenya"
 * — which is what an operator calls the site, not what the company is called.
 * That shorthand reaches paper: `modules/reports/report-pdf.service.ts:56`
 * reads `organisation.name` and the renderer prints it on the cover and in the
 * running header of every PDF, so a report for Mufindi Paper Mills went out
 * titled "KASULU".
 *
 * Matched on `code`, which is the stable key — the names being corrected here
 * are exactly the values that cannot be trusted to match.
 *
 * The dashboard keeps its own copy in dash/src/data/companyData.jsx, where
 * `name` is the legal name and `short` stays the shorthand for compact UI and
 * report filenames. The two must agree; change both or neither.
 *
 * Idempotent — re-running renames nothing that is already correct.
 *
 * Run: npx tsx prisma/rename-orgs.ts   (DOTENV_CONFIG_PATH selects the database)
 */

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'

const NAMES: Record<string, string> = {
  KASULU:    'Mufindi Paper Mills Ltd',
  MENENGAI:  'Menengai Oil Refineries Ltd',
  WESTSUGAR: 'West Kenya Sugar Ltd',
  KABRAS:    'Kabras Sugar',
  NZOIA:     'Nzoia Sugar',
  TIMSALES:  'Timsales Ltd',
  AQUAMIST:  'Aquamist Ltd',
}

async function main(): Promise<void> {
  for (const [code, name] of Object.entries(NAMES)) {
    const org = await prisma.organisation.findUnique({ where: { code }, select: { id: true, name: true } })
    if (!org) {
      console.warn(`skip  ${code} — no organisation with that code`)
      continue
    }
    if (org.name === name) {
      console.log(`ok    ${code} — already "${name}"`)
      continue
    }
    await prisma.organisation.update({ where: { id: org.id }, data: { name } })
    console.log(`renamed ${code} — "${org.name}" -> "${name}"`)
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
