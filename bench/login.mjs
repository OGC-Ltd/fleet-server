/**
 * Sign in once, for a load test against a REAL server, and keep the tokens in a
 * local file the load generator reads (bench/realtime.mjs --token-file).
 *
 * Run it yourself, in a terminal: it asks for the password with echo off, so
 * the password never appears on screen, in shell history, or in any file —
 * only the access and refresh tokens are written, to bench/.bench-token.json
 * (gitignored). Use a dedicated test account with read access to the org, and
 * delete the file when the test is done. The access token lives 15 minutes.
 *
 *   node bench/login.mjs --url https://fleettrack.co.ke --email loadtest@example.com
 */

import { writeFileSync } from 'node:fs'
import { stdin, stdout } from 'node:process'

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const BASE  = arg('--url', 'https://fleettrack.co.ke')
const EMAIL = arg('--email')
const OUT   = arg('--out', new URL('./.bench-token.json', import.meta.url))
if (!EMAIL) { console.error('usage: node bench/login.mjs --url <base> --email <address>'); process.exit(1) }

function askHidden(prompt) {
  return new Promise((resolve) => {
    stdout.write(prompt)
    let s = ''
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const on = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode?.(false); stdin.pause(); stdin.off('data', on); stdout.write('\n'); resolve(s)
      } else if (ch === '\u0003') { process.exit(130) }
      else if (ch === '\u007f' || ch === '\b') { s = s.slice(0, -1) }
      else { s += ch }
    }
    stdin.on('data', on)
  })
}

const password = await askHidden(`Password for ${EMAIL}: `)
const res = await fetch(new URL('/api/v1/auth/login', BASE), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password }),
})
const body = await res.json().catch(() => ({}))
const data = body.data ?? body
if (!res.ok || !data.accessToken) {
  console.error(`sign-in failed: HTTP ${res.status} ${body.message ?? ''}`)
  process.exit(1)
}
writeFileSync(OUT, JSON.stringify({
  base: BASE, email: EMAIL, at: new Date().toISOString(),
  accessToken: data.accessToken, refreshToken: data.refreshToken ?? null,
}, null, 2), { mode: 0o600 })
console.log(`signed in; tokens written to ${OUT instanceof URL ? OUT.pathname : OUT} (valid ~15 min — start the test now)`)
