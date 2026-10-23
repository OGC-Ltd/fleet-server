/**
 * Two things from a `theft-rule-replay` run, read-only:
 *
 *  1. THE COOLING TEST — could the fall be fuel shrinking as it cools after
 *     the machine shut down, rather than fuel leaving the tank?
 *
 *     Diesel contracts ~0.083% per °C. A tank heated by the injection return
 *     during a working shift and cooling 30–35 °C afterwards loses ~3% of its
 *     volume on the gauge, fastest just after shutdown and slowing as it
 *     approaches ambient. So cooling needs all three of:
 *       - the engine worked beforehand (≥30 min in the 3 h before the fall),
 *       - the fall began soon after it stopped (≤2 h),
 *       - the fall is within what contraction can do (≤3% of the fuel in the tank),
 *     and it should LOOK like cooling: bending towards a level (a decay fits
 *     markedly better than a straight line), where a siphon runs straight.
 *
 *  2. THE CHECK LIST — falls to put to each organisation's operator, as CSV:
 *     every alert on CTR 12 (the one confirmed theft, and its unreported
 *     neighbours), the largest falls that stayed down, one small fall per unit
 *     across organisations, and a few the cooling test would remove, so the
 *     test itself gets checked.
 *
 *   node theft-review.cjs [--in=theft-rule.json] [--csv=theft-check-list.csv] [--env=PATH]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import pg from 'pg'
import dotenv from 'dotenv'
import { fitDecay, fitLinear, stepFraction, type ShapeSample } from '../src/modules/fuel/fuel-drop-shape.js'

const arg = (k: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')

const EAT = 3 * 3_600_000
const PRIOR_MS = 3 * 3_600_000
const COOL_MIN_RUN_MIN = 30
const COOL_MAX_SINCE_MIN = 120
const COOL_MAX_SHARE = 0.03
/** A decay must beat the line by this much before the fall is called bending. */
const DECAY_BETTER = 0.7

pg.types.setTypeParser(1114, (s: string) => new Date(s.replace(' ', 'T') + 'Z'))
const ts = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '')
const day = (ms: number) => new Date(ms + EAT).toISOString().slice(0, 10)
const hm = (ms: number) => new Date(ms + EAT).toISOString().slice(11, 16)

interface Alert {
  vehicleId: string; org: string; plate: string; engineEvidence: 'sensor' | 'counter'
  settledAt: string; dropL: number; baselineL: number; troughL: number; stillMin: number; engineOnS: number
  outcome: string; oldWatch: number; oldDrain: number
}
interface Fall { vehicleId: string; excluded?: string; outcome?: string }
interface Row { t: number; fuelMl: number | null; speed: number | null; engineOn: boolean; known: boolean; meter: number | null; lat: number | null; lng: number | null }

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function main(): Promise<void> {
  const R = JSON.parse(readFileSync(arg('in') ?? 'theft-rule.json', 'utf8')) as { days: number; alerts: Alert[]; falls: Fall[] }
  const csvPath = arg('csv') ?? 'theft-check-list.csv'
  const envPath = arg('env') ?? `${homedir()}/prod/fleet-server/.env`
  const boxEnv = dotenv.parse(readFileSync(envPath))
  const url = boxEnv['DIRECT_URL'] ?? boxEnv['DATABASE_URL']
  if (!url) throw new Error(`no DIRECT_URL in ${envPath}`)
  const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, application_name: 'theft-rule-review' })
  await db.connect()
  await db.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
  await db.query("SET statement_timeout = '60s'")
  const ro = await db.query('SHOW transaction_read_only')
  if (ro.rows[0]?.transaction_read_only !== 'on') throw new Error('session is not read-only; refusing to run')

  const ids = [...new Set(R.alerts.map(a => a.vehicleId))]
  const vres = await db.query('SELECT id, vehicle_type, tank_capacity_litres FROM vehicles WHERE id = ANY($1)', [ids])
  const veh = new Map(vres.rows.map(r => [r.id as string, r]))

  // ── features for every alert ──
  const rows = [] as (Alert & {
    t: number; fallStart: number; fallMin: number; rateLph: number | null; stepFrac: number | null; kT: number | null
    decayRatio: number | null; runPriorMin: number; sinceRunMin: number | null; share: number
    coolingPossible: boolean; bending: boolean; cooling: boolean; lat: number | null; lng: number | null
    moved: boolean; tankL: number | null; type: string | null
  })[]
  for (const a of R.alerts) {
    const t = Date.parse(a.settledAt)
    const res = await db.query(`
      SELECT captured_at, lat, lng, speed_kmh, engine_on, ignition_known, fuel_level_ml, engine_hours_meter
        FROM vehicle_telemetries
       WHERE vehicle_id = $1 AND captured_at >= $2::timestamp AND captured_at <= $3::timestamp
       ORDER BY captured_at`, [a.vehicleId, ts(new Date(t - PRIOR_MS - 60 * 60_000)), ts(new Date(t + 10 * 60_000))])
    const rs: Row[] = res.rows.map(r => ({
      t: r.captured_at.getTime(), fuelMl: r.fuel_level_ml, speed: r.speed_kmh, engineOn: r.engine_on === true,
      known: r.ignition_known === true, meter: r.engine_hours_meter, lat: r.lat, lng: r.lng,
    }))
    const fuel = rs.filter(r => r.fuelMl != null && r.t <= t)
    // Where the fall began: the last reading still within 10% of the drop (≥1 L) of the old level.
    const nearBase = a.baselineL - Math.max(1, 0.1 * a.dropL)
    let fallStart = fuel.length ? fuel[0]!.t : t
    for (let i = fuel.length - 1; i >= 0; i--) if (fuel[i]!.fuelMl! / 1000 >= nearBase) { fallStart = fuel[i]!.t; break }
    const fallMin = (t - fallStart) / 60_000
    const shape: ShapeSample[] = fuel.filter(r => r.t >= fallStart).map(r => ({ capturedAt: new Date(r.t), fuelLevelMl: r.fuelMl! }))
    const lin = fitLinear(shape), dec = fitDecay(shape)
    const decayRatio = lin && dec && lin.rmse > 0 ? dec.rmse / lin.rmse : null

    // How hard the engine worked in the 3 h before the fall, and when it last ran.
    let runPriorMin = 0
    let lastRun: number | null = null
    const before = rs.filter(r => r.t >= fallStart - PRIOR_MS && r.t <= fallStart)
    if (a.engineEvidence === 'sensor') {
      for (let i = 0; i < before.length - 1; i++) {
        if (before[i]!.known && before[i]!.engineOn) {
          runPriorMin += Math.min(before[i + 1]!.t - before[i]!.t, 900_000) / 60_000
          lastRun = before[i + 1]!.t
        }
      }
    } else {
      const m = before.filter(r => r.meter != null)
      if (m.length >= 2) {
        runPriorMin = Math.max(0, (m[m.length - 1]!.meter! - m[0]!.meter!) * 60)
        for (let i = m.length - 1; i > 0; i--) if (m[i]!.meter! > m[i - 1]!.meter!) { lastRun = m[i]!.t; break }
      }
    }
    const sinceRunMin = lastRun == null ? null : (fallStart - lastRun) / 60_000
    const share = a.baselineL > 0 ? a.dropL / a.baselineL : 1
    const coolingPossible = runPriorMin >= COOL_MIN_RUN_MIN && sinceRunMin != null && sinceRunMin <= COOL_MAX_SINCE_MIN && share <= COOL_MAX_SHARE
    const bending = dec != null && dec.kT >= 1 && decayRatio != null && decayRatio <= DECAY_BETTER
    const at = rs.filter(r => r.lat != null && r.lng != null).sort((x, y) => Math.abs(x.t - t) - Math.abs(y.t - t))[0]
    rows.push({
      ...a, t, fallStart, fallMin, rateLph: fallMin > 0 ? (a.dropL * 60) / fallMin : null,
      stepFrac: shape.length >= 3 ? stepFraction(shape) : null, kT: dec?.kT ?? null, decayRatio,
      runPriorMin, sinceRunMin, share, coolingPossible, bending, cooling: coolingPossible && bending,
      lat: at?.lat ?? null, lng: at?.lng ?? null,
      moved: rs.some(r => r.t >= fallStart && r.t <= t && (r.speed ?? 0) > 5),
      tankL: veh.get(a.vehicleId)?.tank_capacity_litres ?? null, type: veh.get(a.vehicleId)?.vehicle_type ?? null,
    })
  }
  await db.end()

  // ── 1. the cooling test ──
  const band = (l: number) => (l < 10 ? '5-10 L' : l < 15 ? '10-15 L' : l < 30 ? '15-30 L' : '30+ L')
  const tally = <T>(xs: T[], f: (x: T) => string) => {
    const m = new Map<string, number>()
    for (const x of xs) m.set(f(x), (m.get(f(x)) ?? 0) + 1)
    return [...m].sort((p, q) => q[1] - p[1]).map(([k, n]) => `${k} ${n}`).join(', ')
  }
  const isCtr12 = (a: Alert) => a.org === 'KASULU' && /CTR\s*12$/i.test(a.plate)
  console.log(`alerts: ${rows.length}`)
  console.log(`engine work in the 3 h before the fall: ${tally(rows, r => r.runPriorMin < 5 ? '<5 min' : r.runPriorMin < 30 ? '5-30 min' : r.runPriorMin < 90 ? '30-90 min' : '90+ min')}`)
  console.log(`fall began after the engine last ran: ${tally(rows, r => r.sinceRunMin == null ? 'no run in 3 h' : r.sinceRunMin <= 30 ? '≤30 min' : r.sinceRunMin <= 120 ? '30-120 min' : '>2 h')}`)
  console.log(`fall as a share of the fuel in the tank: ${tally(rows, r => r.share <= 0.01 ? '≤1%' : r.share <= 0.03 ? '1-3%' : r.share <= 0.1 ? '3-10%' : '>10%')}`)
  console.log(`shape: ${tally(rows, r => r.stepFrac != null && r.stepFrac >= 0.6 ? 'step (one interval)' : r.bending ? 'bending (decay fits better)' : 'steady (straight)')}`)
  console.log(`\ncooling possible (worked ≥${COOL_MIN_RUN_MIN} min, fell ≤${COOL_MAX_SINCE_MIN} min after, ≤${COOL_MAX_SHARE * 100}% of the fuel): ${rows.filter(r => r.coolingPossible).length}` +
    ` — of which bending like cooling: ${rows.filter(r => r.cooling).length}`)
  console.log(`  by size: possible ${tally(rows.filter(r => r.coolingPossible), r => band(r.dropL))}; cooling ${tally(rows.filter(r => r.cooling), r => band(r.dropL)) || 'none'}`)
  console.log(`  what happened after, cooling: ${tally(rows.filter(r => r.cooling), r => r.outcome) || '—'}`)
  console.log(`  CTR 12: ${rows.filter(isCtr12).map(r => `${day(r.t)} ${hm(r.t)} -${r.dropL.toFixed(1)} L: worked ${r.runPriorMin.toFixed(0)} min before, ` +
    `fell ${r.sinceRunMin == null ? '—' : r.sinceRunMin.toFixed(0) + ' min'} after, ${(r.share * 100).toFixed(1)}% of fuel, ` +
    `${r.stepFrac != null && r.stepFrac >= 0.6 ? 'step' : r.bending ? 'bending' : 'steady'} → ${r.cooling ? 'COOLING' : 'not cooling'}`).join('\n          ')}`)

  // The replay's tightening, then the cooling filter on top.
  const quick = new Map<string, number>()
  for (const f of R.falls) if (f.excluded === 'came back within 5 min' || f.outcome === 'came back within 20 min') quick.set(f.vehicleId, (quick.get(f.vehicleId) ?? 0) + 1)
  // No per-unit cap: CTR 12's confirmed theft was its fifth parked fall that week,
  // so capping a unit drops exactly the machine being targeted again and again.
  const kept = rows.filter(r => r.troughL > Math.max(5, 0.03 * (r.tankL ?? 0)) && (quick.get(r.vehicleId) ?? 0) < 2)
  const afterCooling = kept.filter(r => !r.cooling)
  const perDay = (n: number) => (n / R.days).toFixed(1)
  const theft = (xs: typeof rows) => xs.some(r => isCtr12(r) && day(r.t) === '2026-09-25' && hm(r.t) === '15:24') ? 'kept' : 'LOST'
  console.log(`\nafter probe-reads-empty and swinging probes: ${kept.length} = ${perDay(kept.length)}/day; minus cooling: ${afterCooling.length} = ${perDay(afterCooling.length)}/day ` +
    `(CTR 12's theft ${theft(afterCooling)}); of which ≥15 L ${afterCooling.filter(r => r.dropL >= 15).length} = ${perDay(afterCooling.filter(r => r.dropL >= 15).length)}/day`)
  console.log(`  left, by size: ${tally(afterCooling, r => band(r.dropL))}; by shape: ${tally(afterCooling, r => r.stepFrac != null && r.stepFrac >= 0.6 ? 'step' : r.bending ? 'bending' : 'steady')}`)

  // ── 2. the check list ──
  type Pick = (typeof rows)[number] & { why: string }
  const picks: Pick[] = []
  const has = (r: (typeof rows)[number]) => picks.some(p => p.vehicleId === r.vehicleId && p.t === r.t)
  for (const r of rows.filter(isCtr12)) {
    picks.push({ ...r, why: r.t >= Date.parse('2026-09-25T12:00:00Z') && r.t < Date.parse('2026-09-25T15:00:00Z')
      ? 'CTR 12: the theft reported on 25 Sep, for reference' : 'CTR 12: same machine as the reported theft, not reported' })
  }
  const holds = new Set(['stayed down', 'stayed down (readings end)', 'topped up while parked, no filling', 'refuelled (filling on the ledger)'])
  const perUnitPick = new Map<string, number>()
  for (const r of [...afterCooling].filter(r => r.dropL >= 15 && holds.has(r.outcome) && !isCtr12(r)).sort((x, y) => y.dropL - x.dropL)) {
    if (picks.filter(p => p.why.startsWith('large')).length >= 10) break
    if ((perUnitPick.get(r.vehicleId) ?? 0) >= 2 || has(r)) continue
    perUnitPick.set(r.vehicleId, (perUnitPick.get(r.vehicleId) ?? 0) + 1)
    picks.push({ ...r, why: 'large fall that did not come back' })
  }
  const smallPool = afterCooling.filter(r => r.dropL < 15 && (r.outcome === 'stayed down' || r.outcome === 'topped up while parked, no filling') && !isCtr12(r))
  const byOrg = new Map<string, typeof smallPool>()
  for (const r of smallPool.sort((x, y) => y.dropL - x.dropL)) byOrg.set(r.org, [...(byOrg.get(r.org) ?? []), r])
  let added = 0
  while (added < 8 && [...byOrg.values()].some(l => l.length)) {
    for (const [org, list] of byOrg) {
      while (list.length && (perUnitPick.has(list[0]!.vehicleId) || has(list[0]!))) list.shift()
      const r = list.shift()
      if (!r || added >= 8) continue
      perUnitPick.set(r.vehicleId, 1)
      picks.push({ ...r, why: `small fall (${org}): tells us whether 5-15 L falls matter` })
      added++
    }
  }
  // Cooling-filtered falls that did not come back first: those are the ones where hiding a theft would matter.
  for (const r of rows.filter(r => r.cooling && !has(r)).sort((x, y) => Number(holds.has(y.outcome)) - Number(holds.has(x.outcome)) || y.dropL - x.dropL).slice(0, 3)) {
    picks.push({ ...r, why: 'the cooling test would hide this: check it is not theft' })
  }

  // Patterns an operator should see beside each fall: other machines in the same
  // organisation, within 3 km, losing fuel inside the same hour; and a unit that
  // went quiet straight after its fall.
  const km = (a: { lat: number | null; lng: number | null }, b: { lat: number | null; lng: number | null }) => {
    if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return Infinity
    const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2
    return 12_742 * Math.asin(Math.sqrt(h))
  }
  const pattern = (p: (typeof rows)[number]) => {
    const notes: string[] = []
    const others = rows.filter(o => o.org === p.org && o.vehicleId !== p.vehicleId && Math.abs(o.t - p.t) <= 60 * 60_000 && km(o, p) <= 3)
    if (others.length > 0) {
      notes.push(`${others.length} other machine${others.length > 1 ? 's' : ''} nearby lost fuel within the hour: ` +
        others.sort((x, y) => x.t - y.t).map(o => `${o.plate} ${hm(o.t)} -${o.dropL.toFixed(0)} L`).join(', '))
    }
    if (p.outcome === 'stayed down (readings end)') notes.push('the unit stopped reporting soon after')
    return notes.join('; ')
  }

  const outcomeWords: Record<string, string> = {
    'stayed down': 'stayed down for 2 h+',
    'stayed down (readings end)': 'stayed down (unit stopped reporting)',
    'topped up while parked, no filling': 'topped up while parked, no filling recorded',
    'refuelled (filling on the ledger)': 'refuelled (filling recorded)',
    'came back after moving': 'came back after the machine moved',
    'came back within 20 min': 'came back within 20 min',
    'came back slowly while parked': 'crept back while parked',
  }
  const header = ['#', 'Org', 'Vehicle', 'Date (EAT)', 'Fall began (EAT)', 'Fall ended (EAT)', 'Litres lost', 'Level before (L)', 'Level after (L)',
    'Tank (L)', 'Engine', 'What happened next', 'Pattern', 'Map', 'Older system alerted?', 'Why it is on the list',
    'Operator verdict (Theft / Not theft / Don\'t know)', 'Operator notes']
  const lines = [header.map(csvCell).join(',')]
  picks.sort((x, y) => x.org.localeCompare(y.org) || x.t - y.t)
  for (const [i, p] of picks.entries()) {
    const engine = `off (${p.engineEvidence === 'sensor' ? 'ignition line' : 'hours counter'})` +
      (p.engineOnS > 0 ? `, ran ${Math.round(p.engineOnS / 60) || 1} min just before` : '')
    lines.push([
      i + 1, p.org, p.plate, day(p.t), hm(p.fallStart), hm(p.t), p.dropL.toFixed(1), p.baselineL.toFixed(1), p.troughL.toFixed(1),
      p.tankL ?? '', engine, outcomeWords[p.outcome] ?? p.outcome, pattern(p),
      p.lat != null && p.lng != null ? `https://maps.google.com/?q=${p.lat.toFixed(5)},${p.lng.toFixed(5)}` : '',
      p.oldWatch + p.oldDrain > 0 ? [p.oldWatch ? 'live watch' : '', p.oldDrain ? 'fuel alert' : ''].filter(Boolean).join(' + ') : 'no',
      p.why, '', '',
    ].map(csvCell).join(','))
  }
  writeFileSync(csvPath, '﻿' + lines.join('\r\n') + '\r\n')
  console.log(`\ncheck list: ${picks.length} falls → ${csvPath}`)
  for (const [i, p] of picks.entries()) {
    console.log(`  ${String(i + 1).padStart(2)}. ${p.org.padEnd(9)} ${p.plate.slice(0, 28).padEnd(28)} ${day(p.t)} ${hm(p.fallStart)}-${hm(p.t)} -${p.dropL.toFixed(1).padStart(5)} L  ` +
      `${(outcomeWords[p.outcome] ?? p.outcome).padEnd(44)} ${p.why}`)
    const pat = pattern(p)
    if (pat) console.log(`      pattern: ${pat}`)
  }
}

main().catch(e => { console.error('FATAL', e instanceof Error ? e.message : e); process.exit(1) })
