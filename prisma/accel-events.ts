/**
 * The actual harsh-driving events: when, what kind, how hard.
 *
 * `accel-history.ts` counts occurrences. This prints them, decoded, because a
 * count cannot tell an operator whether the channel is usable — 74 events in
 * 90,000 messages is either a working safety signal or noise, and only the
 * values and their spacing say which.
 *
 * Teltonika Green Driving, AVL IDs 253/254:
 *   io_253  event type — 1 harsh acceleration, 2 harsh braking, 3 harsh cornering
 *   io_254  magnitude, hundredths (the account's sensor divides by 100, and its
 *           own sensor name states the threshold as 2.7 m/s/s)
 *
 * Read-only.
 *
 *   npm run accel:events -- --units="MUFINDI - FT 13" --hours=48
 */

import { WialonClient, type WialonUnit } from '../src/providers/wialon/wialon.client.js'
import { KASULU_WIALON_ACCOUNT_ID } from '../src/providers/wialon/wialon.account.js'
import { env } from '../src/config/env.js'

const arg = (k: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')

const HOURS = Number(arg('hours') ?? 48)
const MAX   = Number(arg('max') ?? 8000)
const PAGE  = 1000

const GREEN_DRIVING: Record<string, string> = {
  '1': 'harsh acceleration',
  '2': 'harsh braking',
  '3': 'harsh cornering',
}

const key = (n: string): string =>
  n.trim().toUpperCase().replace(/^MUFINDI\s*[-:]?\s*/, '').replace(/\s+/g, ' ').trim()

interface Msg { t?: number; p?: Record<string, unknown>; pos?: { y?: number; x?: number; s?: number } }

async function loadMessages(c: WialonClient, unitId: number, from: number, to: number): Promise<Msg[]> {
  const loaded = await c.call<{ count?: number; messages?: Msg[] }>('messages/load_interval', {
    itemId: unitId, timeFrom: from, timeTo: to, flags: 0, flagsMask: 0, loadCount: MAX,
  })
  if (Array.isArray(loaded.messages) && loaded.messages.length > 0) return loaded.messages
  const count = Math.min(loaded.count ?? 0, MAX)
  const out: Msg[] = []
  for (let i = 0; i < count; i += PAGE) {
    const page = await c.call<Record<string, Msg> | Msg[]>('messages/get_messages', {
      indexFrom: i, indexTo: Math.min(i + PAGE, count) - 1,
    })
    out.push(...(Array.isArray(page) ? page : Object.values(page)))
  }
  return out
}

/** EAT, which is what the operations room reads. */
const eat = (unix: number): string =>
  new Date(unix * 1000).toLocaleString('en-GB', { timeZone: 'Africa/Nairobi', hour12: false })

const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length)

async function main(): Promise<void> {
  const token = env.WIALON_TOKEN || process.env['access_token'] || ''
  const names = (arg('units') ?? 'MUFINDI - FT 13,MUFINDI: MTR 09,MUFINDI - EX 16,MUFINDI - WL 03,MUFINDI: GR 01')
    .split(',').map(s => s.trim()).filter(Boolean)

  const to   = Math.floor(Date.now() / 1000)
  const from = to - HOURS * 3600

  const client = new WialonClient(token, env.WIALON_API_URL)
  try {
    const all = await client.listUnits(KASULU_WIALON_ACCOUNT_ID)
    const byKey = new Map(all.map(u => [key(u.nm ?? ''), u]))
    const units = names.map(n => byKey.get(key(n))).filter((u): u is WialonUnit => !!u)

    console.log(`\n  Green Driving events · ${HOURS}h to ${eat(to)} EAT\n`)

    const kinds = new Map<string, number>()
    let grand = 0

    for (const u of units) {
      let msgs: Msg[] = []
      try { msgs = await loadMessages(client, u.id, from, to) }
      finally { await client.call('messages/unload', {}).catch(() => {}) }

      const events = msgs
        .filter(m => m.p && ('io_253' in m.p))
        .map(m => ({
          t: m.t ?? 0,
          type: String(m.p!['io_253']),
          value: Number(m.p!['io_254'] ?? NaN),
          speed: m.pos?.s ?? null,
        }))
        .sort((a, b) => a.t - b.t)

      console.log(`  ${'─'.repeat(78)}`)
      console.log(`  ${u.nm}   ${msgs.length.toLocaleString()} messages · ${events.length} events`)
      console.log(`  ${'─'.repeat(78)}`)
      if (events.length === 0) { console.log('    none\n'); continue }

      for (const e of events) {
        const label = GREEN_DRIVING[e.type] ?? `type ${e.type}`
        kinds.set(label, (kinds.get(label) ?? 0) + 1)
        grand++
        const mag = Number.isFinite(e.value) ? `${(e.value / 100).toFixed(2)} m/s²` : '—'
        console.log(`    ${eat(e.t)}   ${pad(label, 20)} ${pad(mag, 12)} ${e.speed ?? '—'} km/h`)
      }
      // Spacing tells you whether this is a usable signal or a trickle.
      const spans = events.slice(1).map((e, i) => (e.t - events[i]!.t) / 3600)
      if (spans.length > 0) {
        const med = spans.sort((a, b) => a - b)[Math.floor(spans.length / 2)]!
        console.log(`\n    median gap between events: ${med.toFixed(2)} h`)
      }
      console.log('')
    }

    console.log(`  ${'═'.repeat(78)}`)
    console.log(`  ${grand} events across ${units.length} units`)
    for (const [k, n] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${pad(k, 22)} ${n}`)
    }
    console.log('')
  } finally {
    await client.call('messages/unload', {}).catch(() => {})
    await client.logout().catch(() => {})
  }
}

main().catch((e: unknown) => { console.error(e); process.exitCode = 1 })
