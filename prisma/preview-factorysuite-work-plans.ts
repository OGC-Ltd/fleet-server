/**
 * FactorySuite work plans, read-only preview — `GET /fuel/plans` joined to the
 * machine register (`GET /machines`) the way a stored sync would join them:
 * line.machine → register.reference → gpsUnitId → our `wialon:<id>` vehicle.
 * Talks to the API only; no database, no writes.
 *
 *   npm run preview:work-plans                               today and tomorrow (EAT)
 *   npm run preview:work-plans -- --from=2026-11-11 --to=2026-11-14
 *   npm run preview:work-plans -- --factory=SANDBOX
 *   npm run preview:work-plans -- --summary                  one line per plan
 *   npm run preview:work-plans -- --json                     the joined rows as JSON
 */

import 'dotenv/config'
import {
  RaiFactorySuiteClient,
  type RaiFactorySuiteMachineRow,
  type RaiFactorySuiteWorkPlanLine,
} from '../src/providers/raifactorysuite/raifactorysuite.client.js'

const API_URL = process.env.RAIFACTORYSUITE_API_URL || process.env.CONTROLTECH_API_URL || 'https://factorysuite.org/api/external/v1'
const API_KEY = process.env.RAIFACTORYSUITE_API_KEY || process.env.CONTROLTECH_API_KEY || ''

const arg = (name: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)

/** YYYY-MM-DD in East Africa (UTC+3, no DST) — Kasulu and the Kenyan mills alike. */
function eatDay(offsetDays = 0): string {
  return new Date(Date.now() + 3 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10)
}

const norm = (s: string | null | undefined): string => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

function pad(v: unknown, n: number): string {
  const s = v == null ? '—' : String(v)
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n)
}

async function main(): Promise<void> {
  if (!API_KEY) throw new Error('RAIFACTORYSUITE_API_KEY (or CONTROLTECH_API_KEY) is not set')
  const from    = arg('from') ?? eatDay(0)
  const to      = arg('to') ?? eatDay(1)
  const factory = arg('factory') ?? 'MUFINDI PAPER MILLS'
  const client  = new RaiFactorySuiteClient(API_URL, API_KEY)

  const [plans, machines] = await Promise.all([client.listWorkPlans(from, to, factory), client.listMachines()])
  const byRef = new Map<string, RaiFactorySuiteMachineRow>()
  for (const m of machines) byRef.set(norm(m.reference), m)

  const joined = plans.map(p => ({
    ...p,
    lines: (p.lines ?? []).map((l: RaiFactorySuiteWorkPlanLine) => {
      const m = byRef.get(norm(l.machine))
      return { ...l, registerMatched: Boolean(m), gpsUnitId: m?.gpsUnitId ?? null, vehicleExternalId: m?.gpsUnitId ? `wialon:${m.gpsUnitId}` : null }
    }),
  }))

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(joined, null, 2))
    return
  }

  const lines = joined.flatMap(p => p.lines)
  const machinesOnPlans = new Set(lines.map(l => norm(l.machine)))
  const withGps = new Set(lines.filter(l => l.gpsUnitId).map(l => norm(l.machine)))
  const noRegister = [...new Set(lines.filter(l => !l.registerMatched).map(l => l.machine))]
  const noGps = [...new Set(lines.filter(l => l.registerMatched && !l.gpsUnitId).map(l => `${l.machine} (${l.machineName ?? '?'})`))]
  const status: Record<string, number> = {}
  for (const p of joined) status[p.status] = (status[p.status] ?? 0) + 1

  console.log(`work plans ${from} → ${to} (${factory}): ${joined.length} plans, ${lines.length} machine-shifts`)
  console.log(`status: ${Object.entries(status).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`)
  console.log(`machines: ${machinesOnPlans.size} on plans, ${withGps.size} with a GPS unit (joinable to our vehicles)`)
  if (noRegister.length) console.log(`   not on the register: ${noRegister.join(', ')}`)
  if (noGps.length) console.log(`   on the register, no GPS id: ${noGps.join(', ')}`)

  for (const p of joined.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.planCode.localeCompare(b.planCode))) {
    const summary = process.argv.includes('--summary')
    console.log(`${summary ? '' : '\n'}${p.startDate}  ${p.planCode}  ${p.department}  ${p.status}  ${p.lines.length} lines` +
      `  submitted ${p.submittedBy ?? '—'} ${p.submittedAt?.slice(0, 16) ?? ''}` +
      (p.reviewedBy ? `  reviewed ${p.reviewedBy} ${p.reviewedAt?.slice(0, 16) ?? ''}` : '') +
      (p.title ? `  “${p.title}”` : ''))
    if (summary) continue
    console.log(`   ${pad('machine', 10)} ${pad('gps', 9)} ${pad('shift', 9)} ${pad('hours', 5)} ${pad('km', 5)} ${pad('activity', 34)} ${pad('work location', 20)} ${pad('output', 14)}`)
    for (const l of p.lines) {
      const out = l.expectedOutput == null ? null : `${l.expectedOutput} ${l.outputUnit ?? l.unit ?? ''}`.trim()
      console.log(`   ${pad(l.machine, 10)} ${pad(l.gpsUnitId ?? (l.registerMatched ? 'no gps' : 'unknown'), 9)} ${pad(`${l.shiftNo ?? '?'} ${l.shiftStart?.slice(0, 5) ?? ''}`, 9)} ${pad(l.plannedHours, 5)} ${pad(l.plannedKm, 5)} ${pad(l.activity, 34)} ${pad(l.workLocation, 20)} ${pad(out, 14)}`)
    }
  }
}

main().catch(err => { console.error(err); process.exitCode = 1 })
