/**
 * Machine register sync, by hand — RaiFactorySuite `GET /machines` → KASULU
 * `vehicles`. The reconcile poller runs the same sync hourly; this script is
 * for the match report and for forcing a pass. The logic, and why the join is
 * on the GPS id alone, is in src/providers/raifactorysuite/raifactorysuite.machine-sync.ts.
 *
 *   npm run sync:machines                     preview: match report, no writes
 *   npm run sync:machines -- --apply          write (changed rows only)
 *   npm run sync:machines -- --by-reference   also try fleet-number matches
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { RaiFactorySuiteClient } from '../src/providers/raifactorysuite/raifactorysuite.client.js'
import { syncMachineRegister } from '../src/providers/raifactorysuite/raifactorysuite.machine-sync.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma  = new PrismaClient({ adapter })

const API_URL = process.env.RAIFACTORYSUITE_API_URL || process.env.CONTROLTECH_API_URL || 'https://factorysuite.org/api/external/v1'
const API_KEY = process.env.RAIFACTORYSUITE_API_KEY || process.env.CONTROLTECH_API_KEY || ''

const APPLY        = process.argv.includes('--apply')
const BY_REFERENCE = process.argv.includes('--by-reference')

async function main(): Promise<void> {
  if (!API_KEY) throw new Error('RAIFACTORYSUITE_API_KEY (or CONTROLTECH_API_KEY) is not set')
  const machines = await new RaiFactorySuiteClient(API_URL, API_KEY).listMachines()
  const r = await syncMachineRegister(prisma, machines, { apply: APPLY, byReference: BY_REFERENCE })

  const viaGps = r.matched.filter(m => m.via === 'gps').length
  console.log(`register: ${r.register} machines`)
  console.log(`matched:   ${r.matched.length} (gps ${viaGps}, reference ${r.matched.length - viaGps}); ${r.rated} with a rated consumption`)
  console.log(`register rows with a GPS id but no active vehicle: ${r.noVehicle.length}`)
  for (const m of r.noVehicle) console.log(`   ${m.reference.padEnd(14)} ${String(m.category).padEnd(22)} gps ${m.gpsUnitId}`)
  console.log(`register rows with no GPS id (unmatched): ${r.noGps}`)
  console.log(`active vehicles the register does not cover: ${r.unregistered.length}`)
  for (const n of r.unregistered.slice(0, 40)) console.log(`   ${n}`)
  if (r.unregistered.length > 40) console.log(`   … ${r.unregistered.length - 40} more`)
  console.log('types:')
  for (const [t, n] of [...r.types].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)}  ${t}`)
  for (const m of r.matched.filter(x => x.via === 'reference')) console.log(`   ref  ${m.reference} → ${m.vehicle}`)

  console.log(APPLY ? `\nwrote ${r.written} vehicles; cleared ${r.cleared}` : '\npreview only — re-run with --apply to write')
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(async () => { await prisma.$disconnect(); await pool.end() })
