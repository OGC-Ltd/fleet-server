/**
 * N concurrent real-time users, the way the dashboard actually uses the server:
 * each holds one org-wide SSE stream (/live) and the population as a whole
 * makes API calls at a fixed OFFERED rate (open loop — a slow server is not
 * allowed to slow the test down, which is what a crowd of browsers does too).
 *
 * Run against bench/server.mts with a synthetic fleet, e.g.
 *
 *   npx tsx bench/server.mts --fleet 600 --tick 30
 *   node bench/realtime.mjs --users 3000 --ramp 100 --hold 120 --rps 250
 *
 * What it reports every 5 s:
 *   streams  open / failed / closed by the server
 *   lag      how late a position event arrives after the server's tick
 *            (sampled on every --sample'th stream; parsing all of them would
 *            make this process the bottleneck instead of the server)
 *   http     offered, completed, errors, p50/p99 latency
 *   cpu      this process's own CPU, so a saturated CLIENT is not misread as
 *            a slow server
 *
 * No dependencies, like load.mjs.
 */

import http from 'node:http'
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
const PATHS   = (arg('--paths', `/api/v1/organisations/${ORG}/vehicles/snapshot,/api/v1/organisations/${ORG}/dashboard/summary`)).split(',')

const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0)
const f = (n) => (n >= 100 ? n.toFixed(0) : n.toFixed(1))

/* ── streams ──────────────────────────────────────────────────────────── */

const sseAgent = new http.Agent({ keepAlive: true, maxSockets: Infinity })
let open = 0, failed = 0, closed = 0, bytes = 0, events = 0
let lags = []
const failCodes = {}
const reqs = []

function openStream(i) {
  const sampled = i % SAMPLE === 0
  const connectedAt = Date.now()
  const req = http.request({
    agent: sseAgent, hostname: BASE.hostname, port: BASE.port,
    path: `/api/v1/organisations/${ORG}/live${DELTA ? '?delta=1' : ''}`, method: 'GET',
    headers: { accept: 'text/event-stream' },
  }, (res) => {
    if (res.statusCode !== 200) { failed++; failCodes[res.statusCode] = (failCodes[res.statusCode] ?? 0) + 1; res.resume(); return }
    open++
    let buf = ''
    res.on('data', (c) => {
      bytes += c.length
      if (!sampled) return
      buf += c
      let cut
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const msg = buf.slice(0, cut); buf = buf.slice(cut + 2)
        // `event: position` and `event: position_delta` (an array, one
        // sentAt per changed vehicle) both start this way.
        if (!msg.startsWith('event: position')) continue
        events++
        // Replayed positions are old by design; lag counts only live ticks,
        // i.e. ones the server sent after this stream connected.
        for (const m of msg.matchAll(/"sentAt":(\d+)/g)) {
          if (Number(m[1]) >= connectedAt) lags.push(Date.now() - Number(m[1]))
        }
      }
    })
    res.on('end', () => { open--; closed++ })
    res.on('error', () => {})
  })
  req.on('error', (e) => { failed++; failCodes[e.code ?? 'ERR'] = (failCodes[e.code ?? 'ERR'] ?? 0) + 1 })
  req.end()
  reqs.push(req)
}

/* ── open-loop API calls ──────────────────────────────────────────────── */

const apiAgent = new http.Agent({ keepAlive: true, maxSockets: 1024 })
let offered = 0, done = 0, httpErr = 0, inflight = 0
let lat = []
const httpCodes = {}
function fire() {
  const path = PATHS[offered % PATHS.length]
  offered++; inflight++
  const t0 = performance.now()
  const req = http.request({ agent: apiAgent, hostname: BASE.hostname, port: BASE.port, path, method: 'GET', timeout: 15_000 }, (res) => {
    res.resume()
    res.on('end', () => {
      inflight--
      if (res.statusCode >= 400) { httpErr++; httpCodes[res.statusCode] = (httpCodes[res.statusCode] ?? 0) + 1 }
      else { done++; lat.push(performance.now() - t0) }
    })
  })
  req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })))
  req.on('error', (e) => { inflight--; httpErr++; httpCodes[e.code ?? 'ERR'] = (httpCodes[e.code ?? 'ERR'] ?? 0) + 1 })
  req.end()
}

/* ── run ──────────────────────────────────────────────────────────────── */

const t0 = Date.now()
let started = 0
const rampTimer = setInterval(() => {
  const n = Math.min(Math.ceil(RAMP / 10), USERS - started)
  for (let k = 0; k < n; k++) openStream(started++)
  if (started >= USERS) clearInterval(rampTimer)
}, 100)

let carry = 0
const apiTimer = RPS > 0 ? setInterval(() => {
  carry += RPS / 100
  while (carry >= 1) { fire(); carry-- }
}, 10) : null

let cpu = process.cpuUsage(), cpuAt = Date.now()
const report = () => {
  const d = process.cpuUsage(cpu), ms = Date.now() - cpuAt
  cpu = process.cpuUsage(); cpuAt = Date.now()
  const L = lags.sort((a, b) => a - b), H = lat.sort((a, b) => a - b)
  console.log(
    `t+${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s  `
    + `streams open ${open}/${USERS} failed ${failed} closed ${closed}  `
    + `| lag n=${L.length} p50 ${f(pct(L, 50))}ms p99 ${f(pct(L, 99))}ms max ${f(L[L.length - 1] ?? 0)}ms  `
    + `| http ${done} ok ${httpErr} err inflight ${inflight} p50 ${f(pct(H, 50))}ms p99 ${f(pct(H, 99))}ms  `
    + `| rx ${(bytes / 1048576).toFixed(0)}MB  client cpu ${(((d.user + d.system) / 1000 / ms) * 100).toFixed(0)}%`,
  )
  lags = []; lat = []
}
const reportTimer = setInterval(report, 5000)

const totalS = USERS / RAMP + HOLD
setTimeout(() => {
  clearInterval(reportTimer); if (apiTimer) clearInterval(apiTimer)
  report()
  console.log('\nfail codes', JSON.stringify(failCodes), ' http codes', JSON.stringify(httpCodes), ` offered ${offered}`)
  for (const r of reqs) r.destroy()
  sseAgent.destroy(); apiAgent.destroy()
  process.exit(0)
}, totalS * 1000)
