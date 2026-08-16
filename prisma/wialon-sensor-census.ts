/**
 * What sensors are actually fitted across the Wialon account?
 *
 * Step 1 of `docs/fuel-theft-discrimination-plan.md`. Read-only: one
 * `core/search_items` sweep, no writes anywhere.
 *
 * ## Why this runs before anything else is designed
 *
 * The theft/burn/slosh discrimination outline leans on four Wialon parameters —
 * `fuel_level`, `engine.ignition`, `engine_hours` and `accel_total`/`g_sensor`.
 * The first two are known to be present (222 of 224 units carry an
 * `engine operation` sensor on `io_239`) and the fourth is not ingested
 * anywhere in this codebase. Before Phase 3 of that plan is designed around a
 * vibration signal, we need to know whether the hardware reports one at all.
 *
 * The answer changes the design rather than merely informing it:
 *
 *   - A g-sensor or RPM channel on a useful share of units means the "machine
 *     is working" gate can be measured directly, and a theft alert can be
 *     suppressed on vibration the way the outline describes.
 *   - No such channel means the gate collapses onto `engine_on = false AND
 *     speed = 0`, which is what the plan currently assumes.
 *
 * Either way the plan must not depend on a signal nobody verified was there.
 *
 * ## What it prints
 *
 * Every distinct sensor TYPE with the number of units carrying it, then the
 * same for the raw PARAMETER each sensor reads (`io_239`, `io_270`, …) — the
 * parameter matters because two accounts name the same channel differently and
 * the parameter is what the adapter would have to read. Finally, the units
 * matching a set of patterns we specifically care about.
 *
 * Sensor names are operator-written free text on this account (tank capacity is
 * encoded in them — see `wialon.sensors`), so names are reported alongside
 * types rather than trusted as a classification.
 */

import { WialonClient, type WialonUnit } from '../src/providers/wialon/wialon.client.js'
import { KASULU_WIALON_ACCOUNT_ID } from '../src/providers/wialon/wialon.account.js'
import { readIgnition } from '../src/providers/wialon/wialon.sensors.js'
import { env } from '../src/config/env.js'

/**
 * The token sees eight customers and 1,504 units; we operate two fleets out of
 * it. A census over all of them would answer a question nobody asked — West
 * Kenya Sugar's hardware does not tell us what our excavators report.
 *
 * KASULU is `bact`; SUKARI cannot be, because its units share the RAI GROUP
 * account with West Kenya Sugar's. The `SUKARI*` name mask is the same
 * boundary `sync:sukari-gps` uses. See `wialon.account` for why.
 */
const SUKARI_NAME = /^SUKARI/i

/**
 * Base parameters a sensor expression reads.
 *
 * A sensor's `p` is not always a bare parameter — the account uses arithmetic
 * (`io_254/const100`, `(io_622+#io_622)/const2`) and named references
 * (`[25.Engine Hours Coefficient]`). To ask "does this signal actually arrive"
 * we need the underlying channels, so every `io_NNN`-shaped token is pulled out
 * and the `const`/`#`/bracket decoration discarded.
 *
 * Non-`io_` channels (`clls1`, `timp`, `wln_accel_max`, `pwr_ext`) are real
 * parameter names too and are kept as-is when the whole expression is one.
 */
function baseParams(expr: string): string[] {
  const ios = [...expr.matchAll(/\bio_\d+/g)].map(m => m[0])
  if (ios.length > 0) return [...new Set(ios)]
  // A bare, undecorated name — no operators, no brackets.
  return /^[a-z][a-z0-9_]*$/i.test(expr) ? [expr] : []
}

/** Sensor types and names that would give us a work-state signal. */
const WANTED: Array<{ label: string; re: RegExp }> = [
  { label: 'accelerometer / g-sensor', re: /accel|g[-_ ]?sensor|gsensor|vibrat|shock|tilt|incline|pitch|roll/i },
  { label: 'engine RPM',               re: /\brpm\b|revolution|tacho/i },
  { label: 'engine hours',             re: /engine[-_ ]?hours?|motohour|moto[-_ ]?hour|hour[-_ ]?meter|absolute hours/i },
  { label: 'hydraulic pressure',       re: /hydraul|pressure/i },
  { label: 'engine load / temp',       re: /\bload\b|coolant|engine temp/i },
  { label: 'ignition / engine on',     re: /ignition|engine operation/i },
  { label: 'fuel level',               re: /fuel[-_ ]?level|fuel level/i },
]

/** Count occurrences, then report descending. */
function tally<T>(rows: readonly T[], key: (t: T) => string): Array<[string, number]> {
  const m = new Map<string, number>()
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}

const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length)

interface Row {
  unitId: number; unit: string; name: string; type: string; param: string
  /** Do the channels this sensor reads appear in the unit's last message? */
  arriving: boolean
}

function report(scope: string, units: WialonUnit[]): void {
  console.log(`\n${'='.repeat(72)}\n${scope} — ${units.length} units\n${'='.repeat(72)}`)
  if (units.length === 0) return

  const rows: Row[] = []
  let withoutSensors = 0

  for (const u of units) {
    const sens = u.sens
    if (!sens || Object.keys(sens).length === 0) { withoutSensors++; continue }
    const live = new Set(Object.keys(u.lmsg?.p ?? {}))
    for (const s of Object.values(sens)) {
      const param = s?.p ?? '(none)'
      const bases = baseParams(param)
      rows.push({
        unitId: u.id, unit: u.nm,
        name:   s?.n ?? '',
        type:   s?.t ?? '(none)',
        param,
        // "Arriving" means at least one underlying channel is in the last
        // message. Where the expression yields no resolvable channel we cannot
        // say, and report false rather than guessing true.
        arriving: bases.length > 0 && bases.some(b => live.has(b)),
      })
    }
  }

  console.log(`\nUnits with no configured sensors: ${withoutSensors}   ·   configured sensors: ${rows.length}\n`)

  // ── what we came for ──
  //
  // Two columns, and the gap between them is the whole point of this script.
  // CONFIGURED is what the account says the machine has. ARRIVING is whether
  // the channel appears in the unit's most recent message. A signal configured
  // on 82% of units and arriving on none of them is not a signal we can build
  // a theft gate on, and only the second column can tell us that.
  console.log('signal                        configured        arriving in last msg')
  console.log('─'.repeat(72))
  for (const { label, re } of WANTED) {
    const hits    = rows.filter(r => re.test(r.type) || re.test(r.name))
    const cfg     = new Set(hits.map(h => h.unitId))
    const live    = new Set(hits.filter(h => h.arriving).map(h => h.unitId))
    const cfgPct  = ((cfg.size  / units.length) * 100).toFixed(1)
    const livePct = ((live.size / units.length) * 100).toFixed(1)
    console.log(`  ${pad(label, 27)} ${pad(String(cfg.size), 5)} ${pad(cfgPct + '%', 8)}   ${pad(String(live.size), 5)} ${pad(livePct + '%', 8)}`)
    for (const [shape, n] of tally(hits, h => `${h.type} :: ${h.param}`).slice(0, 4)) {
      const sample  = hits.find(h => `${h.type} :: ${h.param}` === shape)!
      const nLive   = hits.filter(h => `${h.type} :: ${h.param}` === shape && h.arriving).length
      const shown   = shape.length > 46 ? shape.slice(0, 43) + '...' : shape
      console.log(`      ${pad(shown, 47)} cfg ${pad(String(n), 5)} live ${pad(String(nLive), 5)} e.g. "${sample.name.slice(0, 34)}"`)
    }
  }

  // ── arrival, split by whether the engine is currently running ──
  //
  // The single most important correction to the table above. `lmsg` is ONE
  // message, and a device has no reason to transmit an RPM channel on a
  // machine that is switched off — so a flat arrival rate conflates "this
  // device never sends the signal" with "this machine happens to be parked
  // right now", and only the first is a reason not to build on it.
  //
  // Splitting by the unit's own ignition reading separates them. Where
  // ignition itself is unreadable the unit is excluded rather than assumed
  // off: it cannot answer the question either way.
  const running: WialonUnit[] = []
  const stopped: WialonUnit[] = []
  for (const u of units) {
    const ign = readIgnition(u.sens, u.lmsg?.p)
    if (ign === true) running.push(u)
    else if (ign === false) stopped.push(u)
  }

  const arrivingIn = (subset: WialonUnit[], re: RegExp): number => {
    let n = 0
    for (const u of subset) {
      const live = new Set(Object.keys(u.lmsg?.p ?? {}))
      const hit = Object.values(u.sens ?? {}).some((s) => {
        if (!re.test(s?.t ?? '') && !re.test(s?.n ?? '')) return false
        return baseParams(s?.p ?? '').some(b => live.has(b))
      })
      if (hit) n++
    }
    return n
  }

  console.log(`\n  arrival split by ignition — engine ON: ${running.length} units, OFF: ${stopped.length} units, unreadable: ${units.length - running.length - stopped.length}`)
  if (running.length > 0) {
    console.log('  signal                        arriving/ON            arriving/OFF')
    for (const { label, re } of WANTED) {
      const on  = arrivingIn(running, re)
      const off = arrivingIn(stopped, re)
      const onPct  = ((on  / running.length) * 100).toFixed(1)
      const offPct = stopped.length ? ((off / stopped.length) * 100).toFixed(1) : '—'
      console.log(`    ${pad(label, 27)} ${pad(String(on), 5)} ${pad(onPct + '%', 8)}      ${pad(String(off), 5)} ${pad(offPct + '%', 8)}`)
    }
  }

  // ── the counters, which are unit properties rather than sensors ──
  // `cneh` and `cnm_km` arrive with flag 0x2000 and are what the adapter
  // already carries into the raw payload. Engine hours is the outline's
  // preferred X-axis and the plan argues it is too coarse, so how many units
  // even populate it is a fact worth having.
  const withEh  = units.filter(u => typeof u.cneh   === 'number' && u.cneh   > 0).length
  const withOdo = units.filter(u => typeof u.cnm_km === 'number' && u.cnm_km > 0).length
  console.log(`\n  engine-hours counter (cneh)   ${pad(String(withEh), 5)} ${((withEh / units.length) * 100).toFixed(1)}%`)
  console.log(`  mileage counter (cnm_km)      ${pad(String(withOdo), 5)} ${((withOdo / units.length) * 100).toFixed(1)}%`)

  // ── sensor types present, for anything the patterns above did not name ──
  const unitsPerType = new Map<string, Set<number>>()
  for (const r of rows) {
    if (!unitsPerType.has(r.type)) unitsPerType.set(r.type, new Set())
    unitsPerType.get(r.type)!.add(r.unitId)
  }
  console.log('\n  sensor types by unit count:')
  for (const [type, set] of [...unitsPerType.entries()].sort((a, b) => b[1].size - a[1].size)) {
    console.log(`    ${pad(type, 30)} ${pad(String(set.size), 5)} ${((set.size / units.length) * 100).toFixed(1)}%`)
  }
}

async function main(): Promise<void> {
  const token = env.WIALON_TOKEN || process.env['access_token'] || ''
  if (!token) throw new Error('No WIALON_TOKEN (or access_token) in the environment')

  const client = new WialonClient(token, env.WIALON_API_URL)
  try {
    // Two sweeps, not three. `bact` only comes back when an account id is
    // asked for (BILLING_PROPS_FLAG), so Kasulu needs its own call; SUKARI and
    // the whole-token view are both filters over the unscoped sweep.
    const kasulu = await client.listUnits(KASULU_WIALON_ACCOUNT_ID)
    const all    = await client.listUnits()

    console.log(`\nUnits visible on this token: ${all.length}`)
    report(`KASULU (bact ${KASULU_WIALON_ACCOUNT_ID})`, kasulu)
    report('SUKARI (name SUKARI*)', all.filter(u => SUKARI_NAME.test(u.nm ?? '')))
    report('ALL UNITS ON TOKEN', all)
    console.log('')
  } finally {
    await client.logout().catch(() => { /* best effort */ })
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
