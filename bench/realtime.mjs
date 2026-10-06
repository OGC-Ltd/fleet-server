/**
 * N concurrent real-time users, the way the dashboard actually uses the server:
 * each holds one org-wide SSE stream (/live) and the population as a whole
 * makes API calls at a fixed OFFERED rate (open loop — a slow server is not
 * allowed to slow the test down, which is what a crowd of browsers does too).
 *
 * Local, against bench/server.mts with a synthetic fleet:
 *
 *   npx tsx bench/server.mts --fleet 600 --tick 30
 *   node bench/realtime.mjs --users 3000 --ramp 100 --hold 120 --rps 250 [--delta]
 *
 * Against a REAL server (sign in first with bench/login.mjs):
 *
 *   node bench/realtime.mjs --url https://fleettrack.co.ke --org <orgId> \
 *     --token-file bench/.bench-token.json --delta \
 *     --users 3000 --ramp 10 --hold 180 --rps 80 --abort-p99 2000 --abort-err 0.01
 *
 * Every simulated user sends its own X-Device-Id, as a browser does, so
 * per-machine rate limits treat them as separate machines. The GLOBAL limiter
 * is per IP, though, so one load machine shares one 100/s budget — keep --rps
 * under it, or the run measures the limiter (429s), not the server.
 *
 * Reported every 5 s:
 *   streams  open / failed / closed by the server / stalled (open, silent
 *            > 60 s — the server heartbeats every 25 s, so silence is a fault)
 *   lag      synthetic fleet only: how late a position arrives after the tick
 *   http     completed, errors, in flight, p50/p99 latency
 *   rx       bytes received; client cpu, so a saturated CLIENT is not misread
 *
 * Abort (real servers): two consecutive windows with API p99 over --abort-p99
 * ms, or error ratio over --abort-err (min. 20 requests), or more than 5 % of
 * streams refused, end the run immediately and say why.
 *
 * No dependencies, like load.mjs.
 */

import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : dflt
}
const BASE    = new URL(arg('--url', 'http://127.0.0.1:3100'))
const ORG     = arg('--org', 'bench-org-0000-0000-000000000000')
const USERS   = Number(arg('--users', 3000))
const RAMP    = Number(arg('--ramp', 100))      // new streams per second
const HOLD    = Number(arg('--hold', 120))      // seconds after the ramp ends
const RPS     = Number(arg('--rps', 0))         // offered API calls per second
const SAMPLE  = Number(arg('--sample', 25))     // parse every Nth stream for lag
const DELTA   = process.argv.includes('--delta')   // open /live?delta=1
const ABORT_P99 = Number(arg('--abort-p99', 0))    // ms; 0 = never
const ABORT_ERR = Number(arg('--abort-err', 0))    // ratio; 0 = never
const TOKEN_FILE = arg('--token-file')
const PATHS   = (arg('--paths', `/api/v1/organisations/${ORG}/vehicles/snapshot,/api/v1/organisations/${ORG}/dashboard/summary`)).split(',')

const lib = BASE.protocol === 'https:' ? https : http
const port = BASE.port || (BASE.protocol === 'https:' ? 443 : 80)
const auth = TOKEN_FILE ? { authorization: `Bearer ${JSON.parse(readFileSync(TOKEN_FILE, 'utf8')).accessToken}` } : {}
const RUN = randomBytes(4).toString('hex')
const deviceOf = (i) => `bench-${RUN}-${i}`

const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0)
const f = (n) => (n >= 100 ? n.toFixed(0) : n.toFixed(1))

/* ── streams ──────────────────────────────────────────────────────────── */

const sseAgent = new lib.Agent({ keepAlive: true, maxSockets: Infinity })
let open = 0, failed = 0, closed = 0, bytes = 0, events = 0
let lags = []
const failCodes = {}
const reqs = []
const lastHeard = new Map()   // stream index → ms of last byte

function openStream(i) {
  const sampled = i % SAMPLE === 0
  const connectedAt = Date.now()
  const req = lib.request({
    agent: sseAgent, hostname: BASE.hostname, port,
    path: `/api/v1/organisations/${ORG}/live${DELTA ? '?delta=1' : ''}`, method: 'GET',
    headers: { accept: 'text/event-stream', 'x-device-id': deviceOf(i), ...auth },
  }, (res) => {
    if (res.statusCode !== 200) { failed++; failCodes[res.statusCode] = (failCodes[res.statusCode] ?? 0) + 1; res.resume(); return }
    open++
    lastHeard.set(i, Date.now())
    let buf = ''
    res.on('data', (c) => {
      bytes += c.length
      lastHeard.set(i, Date.now())
      if (!sampled) return
      buf += c
      let cut
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const msg = buf.slice(0, cut); buf = buf.slice(cut + 2)
        // `event: position` and `event: position_delta` both start this way.
        if (!msg.startsWith('event: position')) continue
        events++
        // Synthetic fleet only (real payloads carry no sentAt). Replayed
        // positions are old by design; only ones sent after connect count.
        for (const m of msg.matchAll(/"sentAt":(\d+)/g)) {
          if (Number(m[1]) >= connectedAt) lags.push(Date.now() - Number(m[1]))
        }
      }
    })
    res.on('end', () => { open--; closed++; lastHeard.delete(i) })
    res.on('error', () => {})
  })
  req.on('error', (e) => { failed++; failCodes[e.code ?? 'ERR'] = (failCodes[e.code ?? 'ERR'] ?? 0) + 1 })
  req.end()
  reqs.push(req)
}

/* ── open-loop API calls ──────────────────────────────────────────────── */

const apiAgent = new lib.Agent({ keepAlive: true, maxSockets: 1024 })
let offered = 0, done = 0, httpErr = 0, inflight = 0
let lat = [], winOk = 0, winErr = 0
const httpCodes = {}
function fire() {
  const path = PATHS[offered % PATHS.length]
  const device = deviceOf(offered % USERS)
  offered++; inflight++
  const t0 = performance.now()
  const req = lib.request({
    agent: apiAgent, hostname: BASE.hostname, port, path, method: 'GET', timeout: 15_000,
    headers: { 'x-device-id': device, ...auth },
  }, (res) => {
    res.resume()
    res.on('end', () => {
      inflight--
      if (res.statusCode >= 400) { httpErr++; winErr++; httpCodes[res.statusCode] = (httpCodes[res.statusCode] ?? 0) + 1 }
      else { done++; winOk++; lat.push(performance.now() - t0) }
    })
  })
  req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })))
  req.on('error', (e) => { inflight--; httpErr++; winErr++; httpCodes[e.code ?? 'ERR'] = (httpCodes[e.code ?? 'ERR'] ?? 0) + 1 })
  req.end()
}

/* ── run ──────────────────────────────────────────────────────────────── */

const t0 = Date.now()
let started = 0
const rampTimer = setInterval(() => {
  const n = Math.min(Math.max(1, Math.round(RAMP / 10)), USERS - started)
  for (let k = 0; k < n; k++) openStream(started++)
  if (started >= USERS) clearInterval(rampTimer)
}, 100)

let carry = 0
const apiTimer = RPS > 0 ? setInterval(() => {
  carry += RPS / 100
  while (carry >= 1) { fire(); carry-- }
}, 10) : null

let cpu = process.cpuUsage(), cpuAt = Date.now()
let badWindows = 0
const report = () => {
  const d = process.cpuUsage(cpu), ms = Date.now() - cpuAt
  cpu = process.cpuUsage(); cpuAt = Date.now()
  const now = Date.now()
  let stalled = 0
  for (const at of lastHeard.values()) if (now - at > 60_000) stalled++
  const L = lags.sort((a, b) => a - b), H = lat.sort((a, b) => a - b)
  const p99 = pct(H, 99)
  console.log(
    `t+${String(Math.round((now - t0) / 1000)).padStart(3)}s  `
    + `streams open ${open}/${started} failed ${failed} closed ${closed} stalled ${stalled}  `
    + (L.length ? `| lag p50 ${f(pct(L, 50))}ms p99 ${f(pct(L, 99))}ms  ` : '')
    + `| http ${done} ok ${httpErr} err inflight ${inflight} p50 ${f(pct(H, 50))}ms p99 ${f(p99)}ms  `
    + `| rx ${(bytes / 1048576).toFixed(0)}MB  client cpu ${(((d.user + d.system) / 1000 / ms) * 100).toFixed(0)}%`,
  )
  // Abort rules — judged on THIS window.
  const n = winOk + winErr
  const bad = (ABORT_P99 && H.length >= 20 && p99 > ABORT_P99)
    || (ABORT_ERR && n >= 20 && winErr / n > ABORT_ERR)
  badWindows = bad ? badWindows + 1 : 0
  const refused = started >= 50 && failed / started > 0.05
  lags = []; lat = []; winOk = 0; winErr = 0
  if (badWindows >= 2 || refused) {
    finish(refused ? `ABORT: ${failed} of ${started} streams refused` : `ABORT: two windows over the limit (p99 > ${ABORT_P99} ms or errors > ${ABORT_ERR * 100}%)`)
  }
}
const reportTimer = setInterval(report, 5000)

let finished = false
function finish(reason) {
  if (finished) return
  finished = true
  clearInterval(reportTimer); clearInterval(rampTimer); if (apiTimer) clearInterval(apiTimer)
  if (reason) console.log('\n' + reason)
  console.log(`\nreached ${started} users, ${open} streams open at the end`)
  console.log('fail codes', JSON.stringify(failCodes), ' http codes', JSON.stringify(httpCodes), ` offered ${offered}`)
  for (const r of reqs) r.destroy()
  sseAgent.destroy(); apiAgent.destroy()
  setTimeout(() => process.exit(reason ? 2 : 0), 200)
}

setTimeout(() => { report(); finish(null) }, (USERS / RAMP + HOLD) * 1000)
process.on('SIGINT', () => finish('stopped by hand'))
