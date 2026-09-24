/**
 * Where did these units go?
 *
 * A name that misses on the KASULU account is not necessarily a name that does
 * not exist: `wialon.account` records that retired Kasulu units get renamed
 * `XNMUFINDI: …`, and the token sees eight accounts, so a unit may have moved
 * rather than vanished. This searches the WHOLE token by substring and says
 * which account each hit belongs to.
 *
 * Read-only.
 *
 *   npx tsx prisma/find-units.ts --q=354002391056692,864022086893947,"012"
 */

import { WialonClient } from '../src/providers/wialon/wialon.client.js'
import { KASULU_WIALON_ACCOUNT_ID } from '../src/providers/wialon/wialon.account.js'
import { env } from '../src/config/env.js'

const arg = (k: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')

const QUERIES = (arg('q') ?? '354002391056692,864022086893947,012')
  .split(',').map(s => s.trim()).filter(Boolean)

async function main(): Promise<void> {
  const token = env.WIALON_TOKEN || process.env['access_token'] || ''
  const client = new WialonClient(token, env.WIALON_API_URL)
  try {
    const all = await client.listUnits()
    console.log(`\nSearching ${all.length} units visible on this token\n`)

    for (const q of QUERIES) {
      const hits = all.filter(u => (u.nm ?? '').toUpperCase().includes(q.toUpperCase()))
      console.log(`── "${q}" — ${hits.length} match${hits.length === 1 ? '' : 'es'}`)
      for (const u of hits) {
        const own = u.bact === KASULU_WIALON_ACCOUNT_ID ? 'KASULU' : `bact ${u.bact ?? '?'}`
        const last = u.lmsg?.t ? new Date(u.lmsg.t * 1000).toISOString() : 'never'
        console.log(`     ${u.nm}`)
        console.log(`       unit ${u.id} · ${own} · ${Object.keys(u.sens ?? {}).length} sensors · last msg ${last}`)
      }
      if (hits.length === 0) console.log('     nothing on this token carries that string')
      console.log('')
    }
  } finally {
    await client.logout().catch(() => { /* best effort */ })
  }
}

main().catch((e: unknown) => { console.error(e); process.exitCode = 1 })
