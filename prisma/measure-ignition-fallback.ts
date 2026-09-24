/**
 * What would an `io_239` fallback in `readIgnition` actually recover?
 *
 * READ-ONLY. It writes nothing and changes nothing.
 *
 * ## The claim
 *
 * `readIgnition` trusts a sensor of type `engine operation` only when its
 * parameter carries a genuine binary value, and that guard is right: this
 * account binds "1.IGN" to five different parameters and only `io_239` and
 * `io_1` are digital. `io_9` runs 0, 43, 86, 87, 130, 172, 174 and `pwr_ext` is
 * a supply voltage that is live whenever the tracker is wired in.
 *
 * But rejecting the misbound SENSOR is not the same as having no signal. On
 * many of those units the standard Teltonika ignition line `io_239` is arriving
 * in the very same message — it simply has no sensor pointing at it. This
 * measures how many, and confirms the values really are binary before anything
 * is built on them.
 *
 * `engineEvidence >= 0.5` is a precondition of the parked branch, which is the
 * only route to a SIPHON verdict, so every unit this recovers is a unit that
 * can raise a fuel-theft alert for the first time.
 *
 *   npx tsx prisma/measure-ignition-fallback.ts
 */

import { WialonClient, type WialonUnit } from '../src/providers/wialon/wialon.client.js'
import { KASULU_WIALON_ACCOUNT_ID } from '../src/providers/wialon/wialon.account.js'
import { readIgnition } from '../src/providers/wialon/wialon.sensors.js'
import { env } from '../src/config/env.js'

/** The fallback under test, written here exactly as it is proposed. */
function fallbackIgnition(u: WialonUnit): boolean | null {
  const raw = u.lmsg?.p?.['io_239']
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || (n !== 0 && n !== 1)) return null
  return n === 1
}

const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length)

async function main(): Promise<void> {
  const client = new WialonClient(env.WIALON_TOKEN, env.WIALON_API_URL)
  try {
    const units = await client.listUnits(KASULU_WIALON_ACCOUNT_ID)

    const rows = units.map(u => ({
      name:      u.nm ?? String(u.id),
      current:   readIgnition(u.sens, u.lmsg?.p),
      fallback:  fallbackIgnition(u),
      sensorParam: Object.values(u.sens ?? {}).find(s => (s?.t ?? '') === 'engine operation')?.p ?? null,
      raw239:    u.lmsg?.p?.['io_239'],
      reporting: (u.lmsg?.t ?? 0) > Date.now() / 1000 - 7 * 86_400,
    }))

    const blind     = rows.filter(r => r.current === null)
    const recovered = blind.filter(r => r.fallback !== null)
    const stillBlind = blind.filter(r => r.fallback === null)

    console.log(`\n${'═'.repeat(72)}`)
    console.log(`  KASULU — ${units.length} units`)
    console.log(`${'═'.repeat(72)}`)
    console.log(`  ignition readable today                 ${units.length - blind.length}`)
    console.log(`  blind today                             ${blind.length}`)
    console.log(`    RECOVERED by the io_239 fallback      ${recovered.length}`)
    console.log(`      …of which reporting in last 7 days  ${recovered.filter(r => r.reporting).length}`)
    console.log(`    still blind                           ${stillBlind.length}`)

    // The safety check. A fallback is only as trustworthy as the channel it
    // reads, so confirm io_239 really is binary everywhere it appears — not
    // just on the units the fallback would fire for.
    const all239 = rows.map(r => r.raw239).filter(v => v != null && v !== '')
    const distinct = [...new Set(all239.map(v => String(v)))].sort()
    console.log(`\n  io_239 VALUES seen across the fleet: ${distinct.join(', ') || '(none)'}`)
    const nonBinary = distinct.filter(v => v !== '0' && v !== '1')
    console.log(`  non-binary values: ${nonBinary.length === 0 ? 'NONE — safe to trust' : nonBinary.join(', ')}`)

    // Does the fallback ever DISAGREE with a sensor we already trust? It must
    // not, or it is not a fallback but a second opinion.
    const both = rows.filter(r => r.current !== null && r.fallback !== null)
    const disagree = both.filter(r => r.current !== r.fallback)
    console.log(`\n  units where both the sensor and io_239 can be read: ${both.length}`)
    console.log(`  DISAGREEMENTS: ${disagree.length}${disagree.length ? '  <- investigate before shipping' : '  — the fallback never contradicts a trusted sensor'}`)
    for (const d of disagree.slice(0, 10)) {
      console.log(`    ${pad(d.name, 32)} sensor=${d.current} (${d.sensorParam})  io_239=${d.fallback}`)
    }

    console.log(`\n  RECOVERED UNITS (first 30)`)
    console.log(`    ${pad('UNIT', 32)}${pad('IGN SENSOR BOUND TO', 20)}io_239`)
    console.log('    ' + '─'.repeat(60))
    for (const r of recovered.slice(0, 30)) {
      console.log(`    ${pad(r.name, 32)}${pad(String(r.sensorParam ?? '(none)'), 20)}${r.raw239}` +
                  `${r.reporting ? '' : '  (dormant)'}`)
    }
    if (recovered.length > 30) console.log(`    …and ${recovered.length - 30} more`)

    console.log(`\n  STILL BLIND — no io_239 at all (first 20)`)
    for (const r of stillBlind.slice(0, 20)) {
      console.log(`    ${pad(r.name, 32)}${pad(String(r.sensorParam ?? '(none)'), 20)}` +
                  `${r.reporting ? '' : '(dormant)'}`)
    }
    console.log('')
  } finally {
    await client.logout().catch(() => { /* best effort */ })
  }
}

main().catch((e: unknown) => { console.error(e); process.exitCode = 1 })
