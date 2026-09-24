/**
 * Follow-up to `accel-census.ts`: name the outlier, name the units whose accel
 * channel is actually arriving, and check whether any OTHER motion channel
 * exists on the account that the sensor-name pattern would have missed.
 *
 * The last question is the one that matters. `io_253`/`io_254` are Teltonika
 * Green Driving — EVENT parameters, present in a message only when a harsh
 * event fired — so "not in last message" is not evidence the hardware is
 * absent or broken, and a raw continuous g-channel (if one existed) would be a
 * completely different thing to build on.
 *
 * Read-only.
 */

import { WialonClient, type WialonUnit } from '../src/providers/wialon/wialon.client.js'
import { KASULU_WIALON_ACCOUNT_ID } from '../src/providers/wialon/wialon.account.js'
import { env } from '../src/config/env.js'

const ACCEL_RE = /accel|g[-_ ]?sensor|gsensor|vibrat|shock|tilt|incline|pitch|roll/i
/** Parameter names, as opposed to sensor names — a channel nobody configured. */
const ACCEL_PARAM_RE = /accel|gsensor|g_sensor|vibrat|shock|tilt|incline|pitch|roll|crash|impact|axis|\bax\b|\bay\b|\baz\b/i

const hasAccelSensor = (u: WialonUnit): boolean =>
  Object.values(u.sens ?? {}).some(s => ACCEL_RE.test(s?.n ?? '') || ACCEL_RE.test(s?.t ?? ''))

function baseParams(expr: string): string[] {
  const ios = [...expr.matchAll(/\bio_\d+/g)].map(m => m[0])
  if (ios.length > 0) return [...new Set(ios)]
  return /^[a-z][a-z0-9_]*$/i.test(expr) ? [expr] : []
}

const accelArriving = (u: WialonUnit): boolean => {
  const live = new Set(Object.keys(u.lmsg?.p ?? {}))
  return Object.values(u.sens ?? {}).some(s => {
    if (!ACCEL_RE.test(s?.n ?? '') && !ACCEL_RE.test(s?.t ?? '')) return false
    return baseParams(s?.p ?? '').some(b => live.has(b))
  })
}

async function main(): Promise<void> {
  const token = env.WIALON_TOKEN || process.env['access_token'] || ''
  const client = new WialonClient(token, env.WIALON_API_URL)
  try {
    const units = await client.listUnits(KASULU_WIALON_ACCOUNT_ID)

    console.log(`\n=== UNITS WITH NO ACCELEROMETER SENSOR (${units.filter(u => !hasAccelSensor(u)).length}) ===`)
    for (const u of units.filter(u => !hasAccelSensor(u))) {
      console.log(`  ${u.nm}  (unit id ${u.id}, ${Object.keys(u.sens ?? {}).length} sensors)`)
      for (const s of Object.values(u.sens ?? {})) {
        console.log(`      "${s?.n}"  type=${s?.t}  param=${s?.p}`)
      }
    }

    const live = units.filter(accelArriving)
    console.log(`\n=== UNITS WHOSE ACCEL CHANNEL IS IN THE LAST MESSAGE (${live.length}) ===`)
    for (const u of live) {
      const p = u.lmsg?.p ?? {}
      const vals = Object.entries(p).filter(([k]) => k === 'io_253' || k === 'io_254')
      console.log(`  ${u.nm}  ${vals.map(([k, v]) => `${k}=${v}`).join('  ')}`)
    }

    // ── every distinct parameter present across the fleet's last messages ──
    // The configured-sensor view can only see channels somebody bound a sensor
    // to. This is the raw truth about what the devices actually transmit.
    const paramUnits = new Map<string, number>()
    for (const u of units) {
      for (const k of Object.keys(u.lmsg?.p ?? {})) {
        paramUnits.set(k, (paramUnits.get(k) ?? 0) + 1)
      }
    }
    console.log(`\n=== RAW PARAMETERS ACROSS ${units.length} LAST MESSAGES (top 30 by unit count) ===`)
    for (const [k, n] of [...paramUnits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
      const flag = ACCEL_PARAM_RE.test(k) ? '   <-- motion-ish' : ''
      console.log(`  ${k.padEnd(24)} ${String(n).padStart(4)} units${flag}`)
    }

    const motion = [...paramUnits.entries()].filter(([k]) => ACCEL_PARAM_RE.test(k))
    console.log(`\n=== ANY MOTION-NAMED RAW PARAMETER (${motion.length} distinct) ===`)
    for (const [k, n] of motion.sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${n} units`)
    if (motion.length === 0) console.log('  none — no continuous g/vibration channel is transmitted by any unit')

    // Is io_253/io_254 configured but simply never sent? Count units carrying
    // the SENSOR against units transmitting the PARAM.
    for (const p of ['io_253', 'io_254']) {
      console.log(`\n  ${p}: present in ${paramUnits.get(p) ?? 0} of ${units.length} last messages`)
    }
    console.log('')
  } finally {
    await client.logout().catch(() => { /* best effort */ })
  }
}

main().catch((e: unknown) => { console.error(e); process.exitCode = 1 })
