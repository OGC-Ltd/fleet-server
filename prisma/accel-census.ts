/**
 * Which MUFINDI units carry an accelerometer / g-sensor?
 *
 * A narrowing of `prisma/wialon-sensor-census.ts`, which answers the same
 * question as a fleet percentage. This one names the units, because the case
 * being analysed is about specific machines rather than about coverage.
 *
 * Read-only: one `core/search_items` sweep against the KASULU account, no
 * writes anywhere.
 *
 * MUFINDI is KASULU — Wialon account 30394506 ("Mufindi Paper Mills"). It is
 * NOT a RaiFactorySuite/ControlTech fleet: that provider serves SUKARI, exposes
 * no coordinates, and its API carries only alerts, dispatches, sales and
 * weighbridge tickets. There is no sensor endpoint on it to ask.
 *
 * Usage:
 *   DOTENV_CONFIG_PATH=.env npx tsx prisma/accel-census.ts [--sample=10]
 */

import { WialonClient, type WialonUnit } from '../src/providers/wialon/wialon.client.js'
import { KASULU_WIALON_ACCOUNT_ID } from '../src/providers/wialon/wialon.account.js'
import { env } from '../src/config/env.js'

const arg = (k: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')

const SAMPLE = Number(arg('sample') ?? 10)

/**
 * The same pattern `wialon-sensor-census` uses, kept identical on purpose so
 * the two scripts cannot come to disagree about what counts as one.
 *
 * Deliberately WIDE — it catches tilt, shock and vibration as well as a named
 * accelerometer, because the account's sensor names are operator-written free
 * text and a narrow `/accelerometer/` would miss a channel called "G Sensor"
 * or "Shock". A wide pattern that over-reports is the safe direction here: a
 * false positive is visible in the printed sensor name, a false negative is
 * not visible at all.
 */
const ACCEL_RE = /accel|g[-_ ]?sensor|gsensor|vibrat|shock|tilt|incline|pitch|roll/i

/** Base `io_NNN` channels a sensor expression reads — see wialon-sensor-census. */
function baseParams(expr: string): string[] {
  const ios = [...expr.matchAll(/\bio_\d+/g)].map(m => m[0])
  if (ios.length > 0) return [...new Set(ios)]
  return /^[a-z][a-z0-9_]*$/i.test(expr) ? [expr] : []
}

interface Hit { name: string; type: string; param: string; arriving: boolean }

function accelSensors(u: WialonUnit): Hit[] {
  const live = new Set(Object.keys(u.lmsg?.p ?? {}))
  const out: Hit[] = []
  for (const s of Object.values(u.sens ?? {})) {
    const name = s?.n ?? ''
    const type = s?.t ?? ''
    if (!ACCEL_RE.test(name) && !ACCEL_RE.test(type)) continue
    const param = s?.p ?? '(none)'
    const bases = baseParams(param)
    out.push({ name, type, param, arriving: bases.length > 0 && bases.some(b => live.has(b)) })
  }
  return out
}

const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length)

async function main(): Promise<void> {
  const token = env.WIALON_TOKEN || process.env['access_token'] || ''
  if (!token) throw new Error('No WIALON_TOKEN (or access_token) in the environment')

  const client = new WialonClient(token, env.WIALON_API_URL)
  try {
    const units = await client.listUnits(KASULU_WIALON_ACCOUNT_ID)
    console.log(`\nMUFINDI / KASULU — Wialon account ${KASULU_WIALON_ACCOUNT_ID}, ${units.length} units\n`)

    const withAccel:    Array<{ u: WialonUnit; hits: Hit[] }> = []
    const withoutAccel: WialonUnit[] = []
    let noSensorsAtAll = 0

    for (const u of units) {
      if (!u.sens || Object.keys(u.sens).length === 0) noSensorsAtAll++
      const hits = accelSensors(u)
      if (hits.length > 0) withAccel.push({ u, hits })
      else withoutAccel.push(u)
    }

    const arriving = withAccel.filter(w => w.hits.some(h => h.arriving))

    console.log('═'.repeat(74))
    console.log('  SUMMARY')
    console.log('═'.repeat(74))
    console.log(`  units total                              ${units.length}`)
    console.log(`  WITH an accelerometer configured         ${withAccel.length}`)
    console.log(`     …and the channel arriving in lmsg     ${arriving.length}`)
    console.log(`  WITHOUT an accelerometer                 ${withoutAccel.length}`)
    console.log(`  (units with no configured sensors at all ${noSensorsAtAll})`)

    console.log(`\n${'═'.repeat(74)}`)
    console.log(`  SAMPLE — ${Math.min(SAMPLE, units.length)} MUFINDI units`)
    console.log('═'.repeat(74))
    // Lead with units that HAVE one, so the sample shows the shape of the
    // signal where it exists; top up from those that do not.
    const sample = [...withAccel.map(w => w.u), ...withoutAccel].slice(0, SAMPLE)
    for (const u of sample) {
      const hits = accelSensors(u)
      const mark = hits.length === 0 ? 'NO accelerometer'
                 : hits.some(h => h.arriving) ? 'accelerometer, ARRIVING'
                 : 'accelerometer, configured but NOT arriving'
      console.log(`\n  ${pad(u.nm ?? String(u.id), 34)} ${mark}`)
      console.log(`    unit id ${u.id}   sensors configured: ${Object.keys(u.sens ?? {}).length}`)
      for (const h of hits) {
        console.log(`      "${h.name}"  type=${h.type}  param=${h.param}  ` +
                    `${h.arriving ? 'arriving' : 'not in last msg'}`)
      }
    }

    // What the ones without an accelerometer DO carry, so the gap is legible
    // rather than just a count.
    const types = new Map<string, number>()
    for (const u of withoutAccel) {
      for (const s of Object.values(u.sens ?? {})) {
        const t = s?.t ?? '(none)'
        types.set(t, (types.get(t) ?? 0) + 1)
      }
    }
    console.log(`\n${'═'.repeat(74)}`)
    console.log(`  WHAT THE ${withoutAccel.length} UNITS WITHOUT AN ACCELEROMETER DO CARRY`)
    console.log('═'.repeat(74))
    for (const [t, n] of [...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`    ${pad(t, 34)} ${n} sensors`)
    }
    console.log('')
  } finally {
    await client.logout().catch(() => { /* best effort */ })
  }
}

main().catch((err: unknown) => { console.error(err); process.exitCode = 1 })
