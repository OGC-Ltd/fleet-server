#!/usr/bin/env node
/**
 * How much a heavy report holds up everything else.
 *
 * Fires one large report request at a bench server (bench/server.mts, started
 * with --loop-port) and, while it runs, asks the cheap /health route every
 * PING_MS. Prints, per case: the report's input, its own time, the /health
 * latencies seen meanwhile, and the server's event-loop delay over the run.
 *
 *   npx tsx bench/server.mts --loop-port 3101          # terminal 1
 *   node bench/heavy-reports.mjs                       # terminal 2
 *   node bench/heavy-reports.mjs --case geofences-60k --parallel 3
 *
 * Flags: --base http://127.0.0.1:3100  --loop http://127.0.0.1:3101
 *        --case <name>[,<name>]  --parallel N (N copies of the report at once)
 *        --json (one JSON line per case)
 */

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : dflt
}
const BASE = arg('--base', 'http://127.0.0.1:3100')
const LOOP = arg('--loop', 'http://127.0.0.1:3101')
const PARALLEL = Number(arg('--parallel', 1))
const PING_MS = Number(arg('--ping', 10))
const ONLY = arg('--case', '')?.split(',').filter(Boolean)
const JSON_OUT = process.argv.includes('--json')
const ORG = 'bench-org-0000-0000-000000000000'
const R = `${BASE}/api/v1/organisations/${ORG}/reports`

const DAY = 86_400_000
const t0 = Date.UTC(2026, 10, 20, 5)
const plate = (i) => `KD${String.fromCharCode(65 + (i % 26))} ${String(100 + (i % 900))}${String.fromCharCode(65 + ((i * 7) % 26))}`

function geofences(n) {
  return {
    fleet: 'Bench Fleet', from: t0 - 7 * DAY, to: t0, places: null, failed: 0,
    rows: Array.from({ length: n }, (_, i) => ({
      vehicle: plate(i % 640), vehicleId: `v${i % 640}`, place: `Site ${i % 180} — Weighbridge ${i % 7}`,
      in: t0 - 7 * DAY + i * 9_000, out: t0 - 7 * DAY + i * 9_000 + 1_800_000, open: i % 97 === 0,
    })),
  }
}

function tatFuel(n) {
  return {
    fleet: 'Bench Fleet', day: '2026-11-20', to: '2026-11-26', group: 'all',
    rows: Array.from({ length: n }, (_, i) => ({
      vehicleId: `v${i}`, plate: plate(i), group: `Group ${i % 9}`,
      dispatchedAt: t0 + i * 1000, leftAt: t0 + i * 1000 + 600_000, returnedAt: t0 + i * 1000 + 9 * 3_600_000,
      station: `Station ${i % 12}`,
      fuel: { initial: 120.5, topUps: 40, total: 160.5, consumption: 88.2, theft: i % 50 === 0 ? 12 : null, final: 72.3 },
      km: 212.4, rate: 2.41, tankL: 300, comment: i % 11 === 0 ? 'Probe off for 2 h' : '', base: 'MORL',
    })),
  }
}

function deliveries(n, stopsEach) {
  return {
    fleet: 'Bench Fleet', from: t0 - DAY, at: t0, group: 'all', stops: true,
    rows: Array.from({ length: n }, (_, i) => ({
      plate: plate(i), leftAt: t0 - DAY + i * 60_000, leftFrom: { short: 'MORL', label: 'Mombasa Road' }, notLeft: null,
      fulfilled: stopsEach - 1, planned: stopsEach, place: `Town ${i % 40}`, arrivedAt: t0 - 3_600_000, arrivedTo: 'MORL', arrivedShort: 'MORL',
      run: `Delivered ${stopsEach - 1} of ${stopsEach}`, runSub: null,
      customers: Array.from({ length: stopsEach }, (_, k) => ({ label: `Customer ${i}-${k} Wholesalers Ltd`, at: k === 0 ? null : t0 - DAY + k * 3_600_000, missing: k === 0 })),
    })),
  }
}

/** A Reports-page sheet (new-ui lib/reportDocs) of `tables` tables of `rows` rows × 9 columns. */
function documentDoc(tables, rows) {
  const cols = Array.from({ length: 9 }, (_, i) => ({ w: i === 0 ? 40 : 20, align: i > 3 ? 'right' : 'left' }))
  const head = ['Unit', 'Group', 'Driver', 'Site', 'Km', 'Hours', 'Fuel L', 'L/100', 'Score']
  const blocks = [{ kind: 'h2', title: 'Fleet utilisation' }, { kind: 'figures', items: [{ label: 'Units', value: String(rows) }] }]
  for (let t = 0; t < tables; t++) {
    blocks.push({ kind: 'bar', title: `Section ${t + 1}` })
    blocks.push({
      kind: 'table', cols, head,
      rows: Array.from({ length: rows }, (_, i) => [
        { text: plate(i), bold: true }, { text: `Group ${i % 9}` }, { text: `Driver ${i % 300}` }, { text: `Site ${i % 50}` },
        { text: (i * 1.7).toFixed(1) }, { text: (i % 24).toFixed(1) }, { text: (i * 0.9).toFixed(1) },
        { text: '34.2', tone: i % 13 === 0 ? 'flag' : undefined }, { text: String(60 + (i % 40)) },
      ]),
    })
  }
  return { title: 'Utilisation report', reportNo: 'UT-BENCH-1', date: '26/11/2026', meta: [{ label: 'Fleet', value: 'Bench' }], blocks, footer: 'bench', filename: 'bench-utilisation' }
}

const CASES = [
  { name: 'geofences-5k', path: '/geofences.pdf', size: '5,000 visits', body: () => geofences(5_000) },
  { name: 'geofences-20k', path: '/geofences.pdf', size: '20,000 visits', body: () => geofences(20_000) },
  { name: 'geofences-60k', path: '/geofences.pdf', size: '60,000 visits (schema max)', body: () => geofences(60_000) },
  { name: 'tat-fuel-5k', path: '/tat-fuel.pdf', size: '5,000 trips', body: () => tatFuel(5_000) },
  { name: 'deliveries-600x12', path: '/deliveries.pdf', size: '600 vehicles × 12 stops', body: () => deliveries(600, 12) },
  { name: 'document-4x2500', path: '/document.pdf', size: '4 tables × 2,500 rows × 9 cols', body: () => documentDoc(4, 2_500) },
  { name: 'document-8x5000', path: '/document.pdf', size: '8 tables × 5,000 rows × 9 cols', body: () => documentDoc(8, 5_000) },
]

const pct = (xs, p) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]
}
const fmt = (n) => (Number.isFinite(n) ? n.toFixed(n < 10 ? 1 : 0) : '—')

async function runCase(c) {
  const body = JSON.stringify(c.body())
  // Settle, then reset the server's histogram
  await fetch(`${BASE}/health`).then((r) => r.arrayBuffer())
  await fetch(`${LOOP}/loop?reset=1`).then((r) => r.json())

  let running = true
  const pings = []
  const pinger = (async () => {
    while (running) {
      const s = performance.now()
      await fetch(`${BASE}/health`).then((r) => r.arrayBuffer())
      pings.push(performance.now() - s)
      await new Promise((r) => setTimeout(r, PING_MS))
    }
  })()

  const start = performance.now()
  const results = await Promise.all(Array.from({ length: PARALLEL }, async () => {
    const s = performance.now()
    const res = await fetch(`${R}${c.path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    const buf = await res.arrayBuffer()
    return { status: res.status, ms: performance.now() - s, bytes: buf.byteLength, type: res.headers.get('content-type') }
  }))
  const wall = performance.now() - start
  running = false
  await pinger
  const loop = await fetch(`${LOOP}/loop`).then((r) => r.json())
  return {
    case: c.name, input: c.size, bodyMB: +(body.length / 1048576).toFixed(2), parallel: PARALLEL,
    status: [...new Set(results.map((r) => r.status))].join('/'),
    pdfKB: Math.round(results[0].bytes / 1024), reportMs: Math.round(Math.max(...results.map((r) => r.ms))), wallMs: Math.round(wall),
    pings: pings.length, healthP50: +fmt(pct(pings, 50)), healthP99: +fmt(pct(pings, 99)), healthMax: +fmt(Math.max(...pings)),
    loopP99: loop.p99, loopMax: loop.max,
  }
}

const rows = []
for (const c of CASES) {
  if (ONLY.length && !ONLY.includes(c.name)) continue
  const r = await runCase(c)
  rows.push(r)
  if (JSON_OUT) console.log(JSON.stringify(r))
  else console.log(`${r.case.padEnd(20)} ${r.input.padEnd(32)} body ${String(r.bodyMB).padStart(5)} MB ×${r.parallel}  `
    + `status ${r.status}  pdf ${String(r.pdfKB).padStart(6)} KB  report ${String(r.reportMs).padStart(6)} ms  `
    + `| /health p50 ${fmt(r.healthP50)} p99 ${fmt(r.healthP99)} max ${fmt(r.healthMax)} ms (${r.pings})  `
    + `| loop p99 ${r.loopP99} max ${r.loopMax} ms`)
}
