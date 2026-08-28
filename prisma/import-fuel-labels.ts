/**
 * Load a reviewed spreadsheet back in as FuelEventLabel rows.
 *
 * Reads whatever `export-fuel-labels.ts` wrote, plus the three columns the
 * reviewer filled in. Rows with no label are skipped silently — a half-finished
 * sheet is the normal case, not an error.
 *
 * ## What it refuses to do
 *
 * - Invent a reviewer. A row with a label and no name is REJECTED, not filed
 *   under "unknown". The unique key is (event, type, reviewer), so an anonymous
 *   label would collide with every other anonymous label and the last import
 *   would silently overwrite the rest.
 * - Trust the event id. Every id is checked against `fuel_thefts` before
 *   writing, because the table carries no foreign key — see the schema note on
 *   why a discriminated id cannot have one. A typo would otherwise become a
 *   label attached to nothing, which scores as a missing event rather than as
 *   an error.
 * - Guess at a spelling. `theft`, `THEFT`, `Theft` are one value; anything else
 *   is reported with its row number and skipped, so a reviewer who wrote
 *   "probably theft" is told rather than having it dropped or coerced.
 *
 * Re-importing a corrected sheet UPDATES that reviewer's answer rather than
 * accumulating, which is what the unique key is for. Two reviewers importing
 * their own sheets both keep their answers.
 *
 *     npx cross-env DOTENV_CONFIG_PATH=.env.example tsx prisma/import-fuel-labels.ts reviewed.xlsx
 *     ...                                                                           reviewed.xlsx --apply
 */

import { readFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma.js'
import * as XLSX from 'xlsx'

const APPLY = process.argv.includes('--apply')
const FILE  = process.argv.slice(2).find(a => !a.startsWith('--'))
if (!FILE) {
  console.error('\n  usage: tsx prisma/import-fuel-labels.ts <reviewed.xlsx> [--apply]\n')
  process.exit(1)
}

const LABEL_COL  = 'LABEL (THEFT / NOT_THEFT / UNSURE)'
const VALID = new Set(['THEFT', 'NOT_THEFT', 'UNSURE'])

// `XLSX.read` on a Buffer, NOT `XLSX.readFile`. The latter needs the library's
// fs binding, which is not wired up under this ESM setup — it is simply absent,
// and calling it throws "XLSX.readFile is not a function" at the first operator
// who tries to load a reviewed sheet.
const wb = XLSX.read(readFileSync(FILE), { type: 'buffer' })
const first = wb.SheetNames[0]
if (!first) { console.error('\n  no sheets in that file\n'); process.exit(1) }
const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[first]!)

const str = (v: unknown) => (v == null ? '' : String(v).trim())

interface Pending { eventId: string; label: string; by: string; note: string | null; row: number }
const pending: Pending[] = []
const problems: string[] = []
let blank = 0

raw.forEach((r, i) => {
  const row = i + 2                       // 1-based, plus the header
  const eventId = str(r['event id'])
  const label   = str(r[LABEL_COL]).toUpperCase().replace(/[\s-]+/g, '_')
  const by      = str(r['YOUR NAME'])
  const note    = str(r['NOTE'])

  if (label === '') { blank++; return }   // not yet reviewed — normal
  if (eventId === '') { problems.push(`row ${row}: labelled but no event id`); return }
  if (!VALID.has(label)) {
    problems.push(`row ${row}: "${str(r[LABEL_COL])}" is not THEFT, NOT_THEFT or UNSURE`)
    return
  }
  if (by === '') {
    problems.push(`row ${row}: labelled "${label}" but YOUR NAME is empty — a label needs an author`)
    return
  }
  pending.push({ eventId, label, by, note: note === '' ? null : note, row })
})

// Every id checked before anything is written. The table has no FK, so an
// unmatched id would become a label pointing at nothing.
const known = new Set(
  (await prisma.fuelTheft.findMany({
    where:  { id: { in: [...new Set(pending.map(p => p.eventId))] } },
    select: { id: true },
  })).map(t => t.id),
)
const good = pending.filter(p => {
  if (known.has(p.eventId)) return true
  problems.push(`row ${p.row}: event id ${p.eventId} is not a drain in this database`)
  return false
})

console.log(`\n  ${FILE}`)
console.log(`  ${raw.length} rows · ${blank} unreviewed · ${good.length} to ${APPLY ? 'import' : 'import (dry run)'}`)

const byLabel = new Map<string, number>()
const byWho   = new Map<string, number>()
for (const p of good) {
  byLabel.set(p.label, (byLabel.get(p.label) ?? 0) + 1)
  byWho.set(p.by, (byWho.get(p.by) ?? 0) + 1)
}
if (byLabel.size > 0) {
  console.log(`\n  ${[...byLabel].map(([k, n]) => `${k} ${n}`).join(' · ')}`)
  console.log(`  reviewers: ${[...byWho].map(([k, n]) => `${k} (${n})`).join(', ')}`)
}

if (problems.length > 0) {
  console.log(`\n  ${problems.length} row(s) NOT imported:`)
  for (const p of problems) console.log(`    ${p}`)
}

let written = 0
if (APPLY) {
  for (const p of good) {
    await prisma.fuelEventLabel.upsert({
      where: {
        eventId_eventType_labelledBy: {
          eventId: p.eventId, eventType: 'THEFT', labelledBy: p.by,
        },
      },
      create: {
        eventId: p.eventId, eventType: 'THEFT',
        label: p.label as 'THEFT' | 'NOT_THEFT' | 'UNSURE',
        labelledBy: p.by, note: p.note,
      },
      // A reviewer correcting themselves replaces their own answer, and the
      // timestamp moves with it so the correction is the one on record.
      update: {
        label: p.label as 'THEFT' | 'NOT_THEFT' | 'UNSURE',
        note: p.note, labelledAt: new Date(),
      },
    })
    written++
  }
  console.log(`\n  ${written} label(s) written.\n`)
} else {
  console.log('\n  Dry run — nothing written. Re-run with --apply\n')
}

process.exit(0)
