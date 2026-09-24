/**
 * Does this unit REPORT an ignition, and are we reading it?
 *
 * `engineEvidence: 0` on MUFINDI - FT 13's drain sent its cause to gate 7
 * (`engine-state-unknown`), which is the only reason it could never reach the
 * parked branch — and the parked branch is the sole route to a SIPHON verdict,
 * so that unit is structurally incapable of raising a theft alert.
 *
 * That is only acceptable if the hardware genuinely sends nothing. This checks
 * the other possibility: the channel arrives and we are not mapping it.
 *
 * Read-only.
 */

import { WialonClient, type WialonUnit } from '../src/providers/wialon/wialon.client.js'
import { KASULU_WIALON_ACCOUNT_ID } from '../src/providers/wialon/wialon.account.js'
import { readIgnition } from '../src/providers/wialon/wialon.sensors.js'
import { env } from '../src/config/env.js'

const arg = (k: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')

const key = (n: string): string =>
  n.trim().toUpperCase().replace(/^MUFINDI\s*[-:]?\s*/, '').replace(/\s+/g, ' ').trim()

/**
 * Fleet-wide: how many units can never produce a SIPHON verdict because we
 * cannot read their ignition, and how many of those are sending `io_239`
 * anyway — i.e. how many are a mapping bug rather than a hardware gap.
 */
function sweep(all: WialonUnit[]): void {
  const rows = all.map(u => {
    const live = u.lmsg?.p ?? {}
    return {
      name:     u.nm ?? String(u.id),
      decoded:  readIgnition(u.sens, u.lmsg?.p),
      has239:   'io_239' in live,
      reporting: (u.lmsg?.t ?? 0) > Date.now() / 1000 - 7 * 86_400,
      param:    Object.values(u.sens ?? {}).find(s => (s?.t ?? '') === 'engine operation')?.p ?? null,
    }
  })

  const unreadable = rows.filter(r => r.decoded === null)
  const recoverable = unreadable.filter(r => r.has239)

  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  FLEET — ${all.length} units`)
  console.log(`${'═'.repeat(70)}`)
  console.log(`  ignition readable by readIgnition()        ${rows.length - unreadable.length}`)
  console.log(`  UNREADABLE — cannot ever reach SIPHON      ${unreadable.length}`)
  console.log(`    …but io_239 IS in their last message     ${recoverable.length}  <- mapping bug, not hardware`)
  console.log(`    …genuinely sending nothing               ${unreadable.length - recoverable.length}`)

  if (unreadable.length > 0) {
    console.log(`\n  ${'UNIT'.padEnd(34)}${'ign SENSOR param'.padEnd(20)}io_239?`)
    console.log('  ' + '─'.repeat(64))
    for (const r of unreadable.slice(0, 30)) {
      console.log(`  ${r.name.padEnd(34)}${String(r.param ?? '(no sensor)').padEnd(20)}` +
                  `${r.has239 ? 'YES — recoverable' : 'no'}${r.reporting ? '' : '  (dormant)'}`)
    }
    if (unreadable.length > 30) console.log(`  …and ${unreadable.length - 30} more`)
  }
  console.log('')
}

async function main(): Promise<void> {
  const names = (arg('units') ?? 'MUFINDI - FT 13,MUFINDI: MTR 04').split(',').map(s => s.trim())
  const client = new WialonClient(env.WIALON_TOKEN, env.WIALON_API_URL)
  try {
    const all = await client.listUnits(KASULU_WIALON_ACCOUNT_ID)
    if (process.argv.includes('--all')) { sweep(all); return }
    const byKey = new Map(all.map(u => [key(u.nm ?? ''), u]))

    for (const n of names) {
      const u = byKey.get(key(n))
      if (!u) { console.log(`\n  ${n} — not found`); continue }
      const live = u.lmsg?.p ?? {}

      console.log(`\n${'═'.repeat(70)}`)
      console.log(`  ${u.nm}`)
      console.log(`${'═'.repeat(70)}`)

      // The sensor the adapter looks for: Wialon type "engine operation".
      const ign = Object.values(u.sens ?? {}).filter(s => (s?.t ?? '') === 'engine operation')
      console.log(`\n  'engine operation' sensors configured: ${ign.length}`)
      for (const s of ign) {
        console.log(`    "${s?.n}"  param=${s?.p}  ` +
                    `${Object.keys(live).some(k => (s?.p ?? '').includes(k)) ? 'param IS in lmsg' : 'param not in lmsg'}`)
      }

      // The raw channel itself, whatever any sensor is bound to.
      console.log(`\n  io_239 (standard Teltonika ignition) in last message: ` +
                  `${'io_239' in live ? `YES — value ${live['io_239']}` : 'no'}`)

      // What the adapter's own decoder makes of it — this is the value that
      // becomes `ignition_known` in the raw payload.
      const decoded = readIgnition(u.sens, u.lmsg?.p)
      console.log(`  readIgnition() returns: ${decoded === null ? 'null (UNKNOWN)' : decoded}`)

      // Any other sensor bound to io_239 under a different type.
      const on239 = Object.values(u.sens ?? {}).filter(s => (s?.p ?? '').includes('io_239'))
      console.log(`\n  sensors bound to io_239: ${on239.length}`)
      for (const s of on239) console.log(`    "${s?.n}"  type=${s?.t}  param=${s?.p}`)
    }
  } finally {
    await client.logout().catch(() => {})
  }
}

main().catch((e: unknown) => { console.error(e); process.exitCode = 1 })
