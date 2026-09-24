/**
 * Do the harsh-driving channels ever actually fire?
 *
 * `accel-report.ts` reads `lmsg` — ONE message — and finds `io_253`/`io_254` in
 * none of them. That cannot distinguish "this device never sends it" from "no
 * harsh event happened at the instant of the last message", because Green
 * Driving is an EVENT parameter and absence is its normal resting state.
 *
 * This settles it by scanning real message history over a window. If a working
 * excavator produces no `io_253` in 24-48 hours of operation, the channel is
 * not merely quiet — it is not being sent.
 *
 * Read-only. Wialon serialises requests per session, so units are scanned one
 * at a time and the interval is unloaded between them.
 *
 *   npm run accel:history
 *   npm run accel:history -- --hours=48 --units="MUFINDI - FT 13,MUFINDI: MTR 09"
 *   npm run accel:history -- --sample=20 --hours=24
 */

import { readFileSync } from 'node:fs'
import { WialonClient, type WialonUnit } from '../src/providers/wialon/wialon.client.js'
import { KASULU_WIALON_ACCOUNT_ID } from '../src/providers/wialon/wialon.account.js'
import { env } from '../src/config/env.js'

const arg = (k: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')

const HOURS  = Number(arg('hours')  ?? 24)
const SAMPLE = Number(arg('sample') ?? 12)
/** Hard cap per unit, so one chatty device cannot run the scan away. */
const MAX_MESSAGES = Number(arg('max') ?? 6000)
const PAGE = 1000

/** The channels in question, plus the one that is known to work on 3 units. */
const WATCH = ['io_253', 'io_254', 'wln_accel_max'] as const

function key(name: string): string {
  return name.trim().toUpperCase().replace(/^MUFINDI\s*[-:]?\s*/, '').replace(/\s+/g, ' ').trim()
}

function wantedNames(): string[] | null {
  const inline = arg('units')
  if (inline) return inline.split(',').map(s => s.trim()).filter(Boolean)
  const file = arg('file')
  if (!file) return null
  return readFileSync(file, 'utf8').split('\n').map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
}

interface Msg { t?: number; p?: Record<string, unknown> }

/**
 * Pull a unit's messages for the window.
 *
 * `messages/load_interval` returns a count and loads the interval into the
 * SESSION; the rows come back from `messages/get_messages` in index ranges.
 * Some deployments also return `messages` inline on the load call, so that is
 * used when present rather than paging for data already in hand.
 */
async function loadMessages(client: WialonClient, unitId: number, from: number, to: number): Promise<Msg[]> {
  const loaded = await client.call<{ count?: number; messages?: Msg[] }>('messages/load_interval', {
    itemId: unitId, timeFrom: from, timeTo: to,
    flags: 0, flagsMask: 0, loadCount: MAX_MESSAGES,
  })

  if (Array.isArray(loaded.messages) && loaded.messages.length > 0) return loaded.messages

  const count = Math.min(loaded.count ?? 0, MAX_MESSAGES)
  const out: Msg[] = []
  for (let i = 0; i < count; i += PAGE) {
    const page = await client.call<Record<string, Msg> | Msg[]>('messages/get_messages', {
      indexFrom: i, indexTo: Math.min(i + PAGE, count) - 1,
    })
    out.push(...(Array.isArray(page) ? page : Object.values(page)))
  }
  return out
}

const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length)

async function main(): Promise<void> {
  const token = env.WIALON_TOKEN || process.env['access_token'] || ''
  if (!token) throw new Error('No WIALON_TOKEN (or access_token) in the environment')

  const to   = Math.floor(Date.now() / 1000)
  const from = to - HOURS * 3600

  const client = new WialonClient(token, env.WIALON_API_URL)
  try {
    const all = await client.listUnits(KASULU_WIALON_ACCOUNT_ID)
    const names = wantedNames()
    let units: WialonUnit[]
    if (names) {
      const byKey = new Map(all.map(u => [key(u.nm ?? ''), u]))
      units = names.map(n => byKey.get(key(n))).filter((u): u is WialonUnit => !!u)
    } else {
      // Units that have actually reported recently — a dormant unit proves
      // nothing about whether the channel works.
      units = all
        .filter(u => (u.lmsg?.t ?? 0) > from)
        .sort((a, b) => (b.lmsg?.t ?? 0) - (a.lmsg?.t ?? 0))
        .slice(0, SAMPLE)
    }

    console.log(`\n  Scanning ${units.length} units · ${HOURS}h window · cap ${MAX_MESSAGES} msgs/unit`)
    console.log(`  ${new Date(from * 1000).toISOString()} → ${new Date(to * 1000).toISOString()}\n`)
    console.log('  ' + '─'.repeat(84))
    console.log(`  ${pad('UNIT', 32)}${pad('MSGS', 8)}${pad('io_253', 9)}${pad('io_254', 9)}${pad('wln_accel', 11)}PARAMS SEEN`)
    console.log('  ' + '─'.repeat(84))

    const totals: Record<string, number> = { io_253: 0, io_254: 0, wln_accel_max: 0 }
    let totalMsgs = 0
    const allParams = new Map<string, number>()

    for (const u of units) {
      let msgs: Msg[] = []
      try {
        msgs = await loadMessages(client, u.id, from, to)
      } catch (err) {
        console.log(`  ${pad(u.nm ?? String(u.id), 32)}  load failed: ${(err as Error).message}`)
        continue
      } finally {
        await client.call('messages/unload', {}).catch(() => { /* best effort */ })
      }

      const hits: Record<string, number> = { io_253: 0, io_254: 0, wln_accel_max: 0 }
      const seen = new Set<string>()
      for (const m of msgs) {
        for (const k of Object.keys(m.p ?? {})) {
          seen.add(k)
          allParams.set(k, (allParams.get(k) ?? 0) + 1)
          if (k in hits) hits[k]!++
        }
      }
      totalMsgs += msgs.length
      for (const w of WATCH) totals[w]! += hits[w]!

      const mark = (n: number): string => n > 0 ? String(n) : '·'
      console.log(
        `  ${pad(u.nm ?? String(u.id), 32)}${pad(String(msgs.length), 8)}` +
        `${pad(mark(hits['io_253']!), 9)}${pad(mark(hits['io_254']!), 9)}` +
        `${pad(mark(hits['wln_accel_max']!), 11)}${seen.size}`,
      )
    }

    console.log('  ' + '─'.repeat(84))
    console.log(`\n  TOTALS over ${totalMsgs.toLocaleString()} messages from ${units.length} units`)
    for (const w of WATCH) {
      const n = totals[w]!
      const verdict = n > 0 ? `${n} occurrences` : 'NEVER SENT in this window'
      console.log(`    ${pad(w, 18)} ${verdict}`)
    }

    console.log(`\n  Every parameter that DID arrive (top 25 by occurrence):`)
    for (const [k, n] of [...allParams.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
      console.log(`    ${pad(k, 22)} ${n.toLocaleString()}`)
    }
    console.log('')
  } finally {
    await client.call('messages/unload', {}).catch(() => { /* best effort */ })
    await client.logout().catch(() => { /* best effort */ })
  }
}

main().catch((err: unknown) => { console.error(err); process.exitCode = 1 })
