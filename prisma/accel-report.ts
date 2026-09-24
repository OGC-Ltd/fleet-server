/**
 * Does this named list of units carry an accelerometer, and does it deliver?
 *
 * `accel-census.ts` answers that for the whole KASULU fleet as a percentage.
 * This one answers it for a SPECIFIC list — the shape the question takes when a
 * case is being built about particular machines rather than about coverage.
 *
 * Read-only: one `core/search_items` sweep against the KASULU account. No
 * writes, and no provider state is changed.
 *
 *   npm run accel:report                     # the list in prisma/accel-units.txt
 *   npm run accel:report -- --file=other.txt
 *   npm run accel:report -- --units="MUFINDI - EX 16,MUFINDI: DZ 13"
 *   npm run accel:report -- --csv            # machine-readable, for a spreadsheet
 *
 * ## Reading the output
 *
 * CONFIGURED and DELIVERING are different questions and the gap between them is
 * the finding. `io_253`/`io_254` are Teltonika Green Driving — EVENT parameters,
 * sent only in the message where a harsh event fired. `lmsg` is one snapshot, so
 * absent-from-last-message is the NORMAL reading for a healthy device that
 * simply is not braking hard right now. It is evidence about this instant, not
 * about the hardware.
 *
 * `wln_accel_max` is different: Wialon computes it per message, so a unit
 * carrying it has a continuous acceleration figure and one that is absent from
 * `lmsg` genuinely is not sending one.
 */

import { readFileSync } from 'node:fs'
import { WialonClient, type WialonUnit } from '../src/providers/wialon/wialon.client.js'
import { KASULU_WIALON_ACCOUNT_ID } from '../src/providers/wialon/wialon.account.js'
import { env } from '../src/config/env.js'

const arg = (k: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
const CSV = process.argv.includes('--csv')

/** Same pattern as wialon-sensor-census, kept identical so the two agree. */
const ACCEL_RE = /accel|g[-_ ]?sensor|gsensor|vibrat|shock|tilt|incline|pitch|roll/i

/**
 * The comparable part of a unit name.
 *
 * Wialon's own naming on this account uses `MUFINDI - X`, `MUFINDI: X` and
 * `MUFINDI : X` interchangeably, and operator-supplied lists mirror that
 * inconsistency. Matching on the raw string would miss units for a reason that
 * has nothing to do with the question being asked, so the prefix and its
 * separator are stripped and only the identifier is compared.
 *
 * Internal separators are preserved — `OPTIM - LMV 01` keeps its dash — because
 * only the FIRST separator is the naming convention; the rest is the name.
 */
function key(name: string): string {
  return name
    .trim().toUpperCase()
    .replace(/^MUFINDI\s*[-:]?\s*/, '')   // prefix + whichever separator
    .replace(/\s+/g, ' ')                  // collapse internal runs
    .trim()
}

function baseParams(expr: string): string[] {
  const ios = [...expr.matchAll(/\bio_\d+/g)].map(m => m[0])
  if (ios.length > 0) return [...new Set(ios)]
  return /^[a-z][a-z0-9_]*$/i.test(expr) ? [expr] : []
}

interface Sensor { name: string; type: string; param: string; delivering: boolean }

function accelSensors(u: WialonUnit): Sensor[] {
  const live = new Set(Object.keys(u.lmsg?.p ?? {}))
  const out: Sensor[] = []
  for (const s of Object.values(u.sens ?? {})) {
    if (!ACCEL_RE.test(s?.n ?? '') && !ACCEL_RE.test(s?.t ?? '')) continue
    const param = s?.p ?? '(none)'
    const bases = baseParams(param)
    out.push({
      name: s?.n ?? '', type: s?.t ?? '', param,
      delivering: bases.length > 0 && bases.some(b => live.has(b)),
    })
  }
  return out
}

function wantedNames(): string[] {
  const inline = arg('units')
  if (inline) return inline.split(',').map(s => s.trim()).filter(Boolean)
  const file = arg('file') ?? new URL('./accel-units.txt', import.meta.url).pathname
  return readFileSync(file, 'utf8')
    .split('\n').map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'))
}

const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length)

async function main(): Promise<void> {
  const token = env.WIALON_TOKEN || process.env['access_token'] || ''
  if (!token) throw new Error('No WIALON_TOKEN (or access_token) in the environment')

  const names = wantedNames()
  const client = new WialonClient(token, env.WIALON_API_URL)
  try {
    const units = await client.listUnits(KASULU_WIALON_ACCOUNT_ID)
    const byKey = new Map(units.map(u => [key(u.nm ?? ''), u]))

    interface Row {
      asked: string; found: WialonUnit | null; sensors: Sensor[]
    }
    const rows: Row[] = names.map(asked => {
      const u = byKey.get(key(asked)) ?? null
      return { asked, found: u, sensors: u ? accelSensors(u) : [] }
    })

    if (CSV) {
      console.log('asked,matched_unit,unit_id,found,accel_configured,accel_delivering,sensors,params')
      for (const r of rows) {
        const params = r.sensors.map(s => s.param).join(' | ')
        const sens = r.sensors.map(s => s.name).join(' | ')
        console.log([
          `"${r.asked}"`, `"${r.found?.nm ?? ''}"`, r.found?.id ?? '',
          r.found ? 'yes' : 'NOT FOUND',
          r.sensors.length > 0 ? 'yes' : 'no',
          r.sensors.some(s => s.delivering) ? 'yes' : 'no',
          `"${sens}"`, `"${params}"`,
        ].join(','))
      }
      return
    }

    console.log(`\n  KASULU / MUFINDI — Wialon account ${KASULU_WIALON_ACCOUNT_ID}`)
    console.log(`  ${units.length} units on the account · ${names.length} asked about\n`)
    console.log('  ' + '─'.repeat(88))
    console.log(`  ${pad('UNIT', 34)}${pad('ACCELEROMETER', 16)}${pad('DELIVERING', 13)}CHANNEL`)
    console.log('  ' + '─'.repeat(88))

    for (const r of rows) {
      if (!r.found) {
        console.log(`  ${pad(r.asked, 34)}${pad('— not found —', 16)}`)
        continue
      }
      const configured = r.sensors.length > 0
      const delivering = r.sensors.some(s => s.delivering)
      const channel = r.sensors.map(s => s.param).join(', ') || '—'
      console.log(
        `  ${pad(r.found.nm ?? r.asked, 34)}` +
        `${pad(configured ? 'yes' : 'NO', 16)}` +
        `${pad(delivering ? 'yes' : 'no', 13)}` +
        `${channel.length > 34 ? channel.slice(0, 31) + '...' : channel}`,
      )
    }

    const found       = rows.filter(r => r.found)
    const missing     = rows.filter(r => !r.found)
    const configured  = found.filter(r => r.sensors.length > 0)
    const noAccel     = found.filter(r => r.sensors.length === 0)
    const delivering  = found.filter(r => r.sensors.some(s => s.delivering))

    console.log('  ' + '─'.repeat(88))
    console.log(`\n  SUMMARY  (of ${names.length} asked)`)
    console.log(`    matched on the account                 ${found.length}`)
    if (missing.length) {
      console.log(`    NOT FOUND                              ${missing.length}`)
      for (const m of missing) console.log(`        ${m.asked}`)
    }
    console.log(`    accelerometer CONFIGURED               ${configured.length}`)
    console.log(`    accelerometer NOT configured           ${noAccel.length}`)
    for (const n of noAccel) console.log(`        ${n.found!.nm}`)
    console.log(`    channel DELIVERING in last message     ${delivering.length}`)
    for (const d of delivering) {
      console.log(`        ${pad(d.found!.nm ?? '', 32)} ${d.sensors.filter(s => s.delivering).map(s => s.param).join(', ')}`)
    }

    // Which channel each configured unit is bound to — the distinction that
    // decides whether "not delivering" means anything.
    const byChannel = new Map<string, number>()
    for (const r of configured) {
      for (const s of r.sensors) byChannel.set(s.param, (byChannel.get(s.param) ?? 0) + 1)
    }
    console.log(`\n    channels configured across those units`)
    for (const [p, n] of [...byChannel.entries()].sort((a, b) => b[1] - a[1])) {
      const note = /io_25[34]/.test(p) ? '  (Teltonika Green Driving — EVENT only)'
                 : /wln_accel/.test(p) ? '  (Wialon computed, per message)' : ''
      console.log(`      ${pad(p, 26)} ${String(n).padStart(3)} units${note}`)
    }
    console.log('')
  } finally {
    await client.logout().catch(() => { /* best effort */ })
  }
}

main().catch((err: unknown) => { console.error(err); process.exitCode = 1 })
