/**
 * How big is one day of dashcam evidence? (docs/dashcam-s3-archive.md, step 0)
 *
 * Read-only. Lists an organisation's alarms with evidence over the last N hours
 * through the deployed dashcam service, then asks VSS's file server for ONE
 * byte of each file (Range: bytes=0-0) and reads the size from Content-Range.
 * Nothing is downloaded, written or changed. It reuses the server's saved VSS
 * session file, so it normally does not sign in to VSS.
 *
 * Run on the box, from ~/prod/fleet-server (after `npm run build`):
 *   node scripts/dashcam-media-sizes.mjs            # Sukari, last 24 h
 *   node scripts/dashcam-media-sizes.mjs menengai 24
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dist = (p) => pathToFileURL(path.resolve('dist/src', p)).href
const { prisma } = await import(dist('lib/prisma.js'))
const { getAlarms, fileFor } = await import(dist('modules/dashcam/dashcam.service.js'))
const { fetchVssFile } = await import(dist('providers/vss/index.js'))

const want = (process.argv[2] ?? 'sukari').toLowerCase()
const hours = Math.min(Number(process.argv[3] ?? 24) || 24, 168)

const org = await prisma.organisation.findFirst({
  where: { OR: [{ code: { equals: want, mode: 'insensitive' } }, { name: { contains: want, mode: 'insensitive' } }] },
  select: { id: true, name: true },
})
if (!org) { console.error(`No organisation matching "${want}"`); process.exit(1) }

const since = new Date(Date.now() - hours * 3_600_000).toISOString()
console.log(`${org.name}: alarms since ${since} …`)
const t0 = Date.now()
const answer = await getAlarms(org.id, null, since)
console.log(`${answer.incidents.length} alarms, ${answer.cameras} cameras, search ${((Date.now() - t0) / 1000).toFixed(1)} s${answer.partial ? ' (PARTIAL: VSS refused later pages)' : ''}`)

/** Size of one VSS file from a one-byte read; null when VSS has none. */
async function sizeOf(url) {
  let res
  try { res = await fetchVssFile(url, 'bytes=0-0') } catch (e) { return { err: String(e.message ?? e) } }
  const st = res.statusCode ?? 0
  const cr = String(res.headers['content-range'] ?? '')
  const cl = Number(res.headers['content-length'] ?? NaN)
  res.destroy()
  if (st === 206) { const m = /\/(\d+)$/.exec(cr); return m ? { bytes: Number(m[1]) } : { err: `206 without size (${cr})` } }
  if (st === 200 && Number.isFinite(cl)) return { bytes: cl }
  if (st === 404 || st === 416) return { missing: true }
  return { err: `HTTP ${st}` }
}

const jobs = []
for (const inc of answer.incidents) {
  for (const [kind, list] of [['video', inc.videos], ['photo', inc.photos]]) {
    for (const m of list) {
      const k = new URL(m.url, 'http://x').searchParams.get('k')
      const vss = k ? fileFor(org.id, k) : null
      if (vss) jobs.push({ inc, kind, label: m.label, vss })
    }
  }
}
console.log(`${jobs.length} files; reading sizes 4 at a time …`)

let next = 0, done = 0
const results = []
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < jobs.length) {
    const j = jobs[next++]
    results.push({ ...j, ...(await sizeOf(j.vss)) })
    if (++done % 200 === 0) console.log(`  ${done}/${jobs.length}`)
  }
}))

const MB = (b) => (b / 1_048_576).toFixed(2)
const sized = results.filter((r) => r.bytes != null)
const sum = (rs) => rs.reduce((a, r) => a + r.bytes, 0)
const pct = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }
const group = (key) => {
  const g = new Map()
  for (const r of sized) { const k = key(r); g.set(k, [...(g.get(k) ?? []), r]) }
  return [...g.entries()].sort((a, b) => sum(b[1]) - sum(a[1]))
}

console.log('\n── files ──')
console.log(`sized ${sized.length} · not on VSS ${results.filter((r) => r.missing).length} · errors ${results.filter((r) => r.err).length}`)
const errs = [...new Set(results.filter((r) => r.err).map((r) => r.err))].slice(0, 5)
if (errs.length) console.log('  errors seen:', errs.join(' | '))
console.log(`total ${MB(sum(sized))} MB over ${hours} h`)

for (const [title, key] of [['kind', (r) => r.kind], ['camera', (r) => `${r.kind} · ${r.label}`], ['severity', (r) => r.inc.severity]]) {
  console.log(`\n── by ${title} ──`)
  for (const [k, rs] of group(key)) {
    const b = rs.map((r) => r.bytes)
    console.log(`${k.padEnd(28)} ${String(rs.length).padStart(5)} files  ${MB(sum(rs)).padStart(9)} MB  median ${MB(pct(b, 0.5))}  p90 ${MB(pct(b, 0.9))}  max ${MB(Math.max(...b))}`)
  }
}

const withFiles = new Set(sized.map((r) => r.inc.id)).size
console.log('\n── per alarm ──')
console.log(`${withFiles} alarms with a sized file · ${MB(withFiles ? sum(sized) / withFiles : 0)} MB average evidence per alarm`)
console.log(`per camera per day: ${MB(answer.cameras ? sum(sized) / answer.cameras * (24 / hours) : 0)} MB`)

await prisma.$disconnect()
process.exit(0)
