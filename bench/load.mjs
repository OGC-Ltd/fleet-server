/**
 * A load generator with no dependencies.
 *
 * Deliberately not autocannon/k6/artillery: this has to be runnable against
 * the production box from a maintenance window one day, and adding a tool to
 * that path means adding a tool to that box. node:http is already there.
 *
 * ## What it measures, and the one number people misread
 *
 * It reports latency percentiles under a fixed CONCURRENCY, not under a fixed
 * arrival rate. Closed-loop: each of N workers sends a request, waits for the
 * reply, and sends the next. So throughput is an OUTCOME, not an input, and a
 * server that slows down simply receives less — which is the honest way to
 * find a ceiling, but it means "rps" here is "what it managed", never "what
 * was offered". If you need offered-rate semantics (open loop), that is a
 * different tool answering a different question.
 *
 * p99 is the number to watch. A mean hides the stall a real user experiences,
 * and on an event-loop server the tail is where saturation shows first —
 * throughput stays flat and latency fans out long before any error appears.
 *
 * ## Warmup is not optional
 *
 * V8 runs the first few thousand requests through the interpreter before the
 * JIT settles, and the first request on each socket pays TCP setup. Numbers
 * from a cold process are routinely several times worse and mean nothing. The
 * warmup stage is discarded entirely rather than averaged in.
 */

import http from 'node:http'
import https from 'node:https'
import { performance } from 'node:perf_hooks'

/* ── arguments ─────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const out = { paths: [], stages: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--url':      out.url = next(); break
      case '--path':     out.paths.push(next()); break
      case '--conn':     out.conn = Number(next()); break
      case '--duration': out.duration = Number(next()); break
      case '--warmup':   out.warmup = Number(next()); break
      case '--method':   out.method = next().toUpperCase(); break
      case '--body':     out.body = next(); break
      case '--mode':     out.mode = next(); break
      case '--header':   { const h = next(); const ix = h.indexOf(':')
                           out.headers = out.headers ?? {}
                           out.headers[h.slice(0, ix).trim().toLowerCase()] = h.slice(ix + 1).trim()
                           break }
      case '--json':     out.json = true; break
      case '--help':     out.help = true; break
      case '--stages':   out.stages = next().split(',').map((s) => {
                           const [c, d] = s.split(':').map(Number)
                           return { conn: c, duration: d }
                         }); break
      default:
        if (a.startsWith('--')) throw new Error('unknown flag ' + a)
    }
  }
  return out
}

const HELP = [
  '',
  'bench/load.mjs — closed-loop load generator',
  '',
  '  --url <base>        base URL            (default http://127.0.0.1:3100)',
  '  --path <p>          path to hit; repeatable, cycled round-robin',
  '  --conn <n>          concurrent workers  (default 50)',
  '  --duration <s>      measured seconds    (default 10)',
  '  --warmup <s>        discarded seconds   (default 3)',
  '  --stages <c:d,...>  ramp, e.g. 25:10,50:10,100:10  (overrides --conn/--duration)',
  '  --method <M>        default GET',
  '  --body <json>       request body; implies POST unless --method given',
  '  --header <k: v>     extra request header; repeatable',
  '  --mode http|sse     sse holds connections open and counts what survives',
  '  --json              machine-readable output',
  '',
  'Examples',
  '  node bench/load.mjs --path /health --conn 100 --duration 15',
  '  node bench/load.mjs --stages 25:10,50:10,100:10,200:10 --path /health',
  '  node bench/load.mjs --mode sse --path /api/v1/notifications/stream --conn 500',
  '',
].join('\n')

/* ── statistics ────────────────────────────────────────────────────────── */

/**
 * Percentiles from a sorted array of samples.
 *
 * Nearest-rank, not interpolated. With tens of thousands of samples the
 * difference is invisible, and nearest-rank has the property that every value
 * reported is a latency that was actually observed, rather than one synthesised
 * between two that were.
 */
function pct(sorted, p) {
  if (sorted.length === 0) return 0
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

const fmt = (ms) => (ms < 10 ? Number(ms.toFixed(2)) : Number(ms.toFixed(1)))

function summarise(samples, statuses, errors, wallMs, conn) {
  const sorted = [...samples].sort((a, b) => a - b)
  const n = sorted.length
  return {
    conn,
    requests: n,
    errors,
    seconds: Number((wallMs / 1000).toFixed(2)),
    rps: Number((n / (wallMs / 1000)).toFixed(1)),
    latency: {
      min:  fmt(sorted[0] ?? 0),
      p50:  fmt(pct(sorted, 50)),
      p90:  fmt(pct(sorted, 90)),
      p99:  fmt(pct(sorted, 99)),
      max:  fmt(sorted[n - 1] ?? 0),
      mean: fmt(n ? sorted.reduce((a, b) => a + b, 0) / n : 0),
    },
    statuses,
  }
}

/* ── the run ───────────────────────────────────────────────────────────── */

function makeAgent(isTls, conn) {
  const Agent = isTls ? https.Agent : http.Agent
  // maxSockets must be at least the worker count, or workers queue inside the
  // agent and the "concurrency" being reported is a fiction.
  return new Agent({ keepAlive: true, maxSockets: conn * 2, maxFreeSockets: conn * 2 })
}

function once(agent, target, opts) {
  return new Promise((resolve) => {
    const started = performance.now()
    const lib = target.protocol === 'https:' ? https : http
    const req = lib.request(
      {
        agent,
        protocol: target.protocol,
        hostname: target.hostname,
        port:     target.port,
        path:     target.pathname + target.search,
        method:   opts.method,
        headers:  opts.headers,
      },
      (res) => {
        // The body MUST be drained. An undrained response holds its socket and
        // the next request on it blocks — which reads as latency that is not
        // really there.
        res.resume()
        res.on('end', () => resolve({ ms: performance.now() - started, status: res.statusCode }))
      },
    )
    req.on('error', (err) => resolve({ ms: performance.now() - started, error: err.code ?? 'ERR' }))
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

async function runStage({ base, paths, conn, seconds, method, body, collect, extraHeaders }) {
  const targets = paths.map((p) => new URL(p, base))
  const agent = makeAgent(base.protocol === 'https:', conn)

  const headers = { connection: 'keep-alive', ...(extraHeaders ?? {}) }
  if (body) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = Buffer.byteLength(body)
  }

  const samples = []
  const statuses = {}
  let errors = 0
  let stop = false

  const started = performance.now()
  const timer = setTimeout(() => { stop = true }, seconds * 1000)

  const worker = async (id) => {
    let i = id
    while (!stop) {
      const target = targets[i++ % targets.length]
      const r = await once(agent, target, { method, body, headers })
      if (!collect) continue
      if (r.error) {
        errors++
        statuses[r.error] = (statuses[r.error] ?? 0) + 1
      } else {
        samples.push(r.ms)
        statuses[r.status] = (statuses[r.status] ?? 0) + 1
      }
    }
  }

  await Promise.all(Array.from({ length: conn }, (_, i) => worker(i)))
  clearTimeout(timer)
  agent.destroy()

  return summarise(samples, statuses, errors, performance.now() - started, conn)
}

/**
 * Hold N server-sent-event streams open at once.
 *
 * Separate from the throughput path because an SSE connection is not a
 * request — it is a socket the server keeps, plus a slot in an in-process
 * registry. What matters is how many establish, how long the first byte takes
 * while the server is holding hundreds, and how many it drops under the hold.
 * Throughput is meaningless here.
 *
 * Worth knowing when reading the result: SSE viewers are invisible in nginx's
 * access log, so on a real box this is the only way to count them at all.
 */
async function runSse({ base, path, conn, seconds }) {
  const target = new URL(path, base)
  const lib = target.protocol === 'https:' ? https : http
  const agent = makeAgent(target.protocol === 'https:', conn)

  let established = 0, failed = 0, dropped = 0, bytes = 0
  const ttfb = []
  const reqs = []
  const codes = {}

  for (let i = 0; i < conn; i++) {
    const started = performance.now()
    const req = lib.request({
      agent,
      protocol: target.protocol,
      hostname: target.hostname,
      port:     target.port,
      path:     target.pathname + target.search,
      method:   'GET',
      headers:  { accept: 'text/event-stream', connection: 'keep-alive' },
    }, (res) => {
      codes[res.statusCode] = (codes[res.statusCode] ?? 0) + 1
      if (res.statusCode !== 200) { failed++; res.resume(); return }
      established++
      let first = true
      res.on('data', (c) => {
        if (first) { ttfb.push(performance.now() - started); first = false }
        bytes += c.length
      })
      res.on('end', () => { dropped++ })
    })
    req.on('error', (err) => {
      failed++
      const k = err.code ?? 'ERR'
      codes[k] = (codes[k] ?? 0) + 1
    })
    req.end()
    reqs.push(req)
  }

  await new Promise((r) => setTimeout(r, seconds * 1000))
  for (const r of reqs) r.destroy()
  agent.destroy()

  const sorted = ttfb.sort((a, b) => a - b)
  return {
    mode: 'sse',
    attempted: conn,
    established,
    failed,
    droppedByServer: dropped,
    heldSeconds: seconds,
    bytesReceived: bytes,
    statuses: codes,
    firstByteMs: {
      p50: fmt(pct(sorted, 50)),
      p99: fmt(pct(sorted, 99)),
      max: fmt(sorted[sorted.length - 1] ?? 0),
    },
  }
}

/* ── main ──────────────────────────────────────────────────────────────── */

const args = parseArgs(process.argv.slice(2))
if (args.help) { console.log(HELP); process.exit(0) }

const base   = new URL(args.url ?? 'http://127.0.0.1:3100')
const paths  = args.paths.length ? args.paths : ['/health']
const method = args.method ?? (args.body ? 'POST' : 'GET')
const warmup = args.warmup ?? 3

if (args.mode === 'sse') {
  const out = await runSse({
    base, path: paths[0], conn: args.conn ?? 100, seconds: args.duration ?? 10,
  })
  if (args.json) {
    console.log(JSON.stringify(out, null, 2))
  } else {
    const st = Object.entries(out.statuses).map(([k, v]) => k + ':' + v).join(' ')
    console.log('\nSSE  ' + base.origin + paths[0])
    console.log('  attempted ' + out.attempted + '   established ' + out.established
      + '   failed ' + out.failed + '   dropped by server ' + out.droppedByServer)
    console.log('  first byte   p50 ' + out.firstByteMs.p50 + 'ms   p99 '
      + out.firstByteMs.p99 + 'ms   max ' + out.firstByteMs.max + 'ms')
    console.log('  held ' + out.heldSeconds + 's, ' + out.bytesReceived + ' bytes, statuses ' + st)
    console.log('')
  }
  process.exit(0)
}

/**
 * Is anything actually there?
 *
 * Without this, pointing the generator at a port nothing is listening on
 * produced a full-length run of refused connections and then a table reading
 * `rps 0` with a five-figure ECONNREFUSED count — twenty seconds spent to
 * report, obscurely, that the server was not started. A benchmark that cannot
 * reach its target has not measured a slow server; it has not measured
 * anything, and it should say so immediately.
 *
 * One request, before the warmup, and a diagnosis rather than an error code.
 */
async function preflight(target) {
  const agent = makeAgent(target.protocol === 'https:', 1)
  const r = await once(agent, target, { method: 'GET', headers: {} })
  agent.destroy()
  if (!r.error) return

  const say = (line) => console.error(line)
  say('')
  say('cannot reach ' + target.origin + ' — nothing was measured.')
  say('')
  if (r.error === 'ECONNREFUSED') {
    say('  Refused: nothing is listening on that port.')
    say('  load.mjs is the CLIENT. The server it drives is a separate')
    say('  process and has to be running first:')
    say('')
    say('      npx tsx bench/server.mts')
    say('')
    say('  Leave that in its own shell, then run this again. To do both')
    say('  from one shell, background it and wait for the port:')
    say('')
    say('      npx tsx bench/server.mts > /tmp/bench.log 2>&1 &')
    say('      until curl -sf localhost:3100/health >/dev/null; do sleep 1; done')
    say('')
    say('  It takes a few seconds to boot. If it never comes up, read')
    say('  /tmp/bench.log — env validation failures are reported there.')
  } else {
    say('  ' + r.error + ' — check --url, the host, and any firewall between.')
  }
  say('')
  process.exit(1)
}

const stages = args.stages.length
  ? args.stages
  : [{ conn: args.conn ?? 50, duration: args.duration ?? 10 }]

await preflight(new URL(paths[0], base))

if (warmup > 0) {
  process.stderr.write('warming up ' + warmup + 's (discarded)...\n')
  await runStage({
    base, paths, conn: stages[0].conn, seconds: warmup,
    method, body: args.body, collect: false, extraHeaders: args.headers,
  })
}

const results = []
for (const s of stages) {
  process.stderr.write('running ' + s.conn + ' conn for ' + s.duration + 's...\n')
  results.push(await runStage({
    base, paths, conn: s.conn, seconds: s.duration,
    method, body: args.body, collect: true, extraHeaders: args.headers,
  }))
}

if (args.json) {
  console.log(JSON.stringify({ target: base.origin, paths, method, stages: results }, null, 2))
} else {
  console.log('\n' + method + '  ' + base.origin + '  ' + paths.join(' , '))
  console.log('\n  conn   requests      rps     p50     p90     p99     max  errors  statuses')
  console.log('  ' + '-'.repeat(78))
  for (const r of results) {
    const st = Object.entries(r.statuses)
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([k, v]) => k + ':' + v).join(' ')
    console.log(
      '  ' + String(r.conn).padStart(4)
      + '  ' + String(r.requests).padStart(9)
      + '  ' + String(r.rps).padStart(7)
      + '  ' + String(r.latency.p50).padStart(6)
      + '  ' + String(r.latency.p90).padStart(6)
      + '  ' + String(r.latency.p99).padStart(6)
      + '  ' + String(r.latency.max).padStart(6)
      + '  ' + String(r.errors).padStart(6)
      + '  ' + st,
    )
  }
  console.log('')
}
