/**
 * What a place is, read by OpenAI from its exact name (operator, 2026-10-09:
 * "capitalize on OpenAI … to determine the activity based on the exact name of
 * the place"). Google lists many owner-added places only as a "point of
 * interest" ("Ka mwalimu jim", "MULTIDOSE AGRO SUPPLIES"), and no list of words
 * reads those the way a person does; the model does, given the name and, when
 * there is one, Google's own type as a hint.
 *
 * The answer is always one of ACTIVITIES — the groups lib/placeActivity (page)
 * and usage-review.poi (OpenStreetMap) already use — or null; anything else the
 * model says is dropped. One request per batch of names, answers kept in memory
 * for 30 days by name (a business does not change trade), and concurrent asks
 * for the same name share one request.
 *
 * OpenAI is asked first; when it cannot answer (no key, no credit left, a
 * timeout) DeepSeek is asked instead (operator, 2026-10-09: "make the fallback
 * for OpenAI DeepSeek") — its API speaks OpenAI's chat-completions. A provider
 * that refuses for its key or its credit is skipped for ten minutes rather than
 * asked again on every Logbook.
 *
 * Never on anyone's critical path and never throws: with neither key, on a
 * timeout or a malformed reply, the caller keeps the activity it already had.
 */

import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { persistentStore } from './usage-review.store.js'

// The operator's words (2026-10-09): mechanical, entertainment, haircut, work.
export const ACTIVITIES = [
  'Fuel', 'Mechanical', 'Banking', 'Medical', 'Barber / salon', 'Entertainment', 'Lodging', 'Food and drink',
  'Worship', 'Education', 'Government', 'Shopping', 'Transport', 'Work', 'Farm', 'Offices',
] as const
export type Activity = (typeof ACTIVITIES)[number]

const TTL_MS = 30 * 86_400_000
const CACHE_MAX = 5_000
const BATCH = 40

const SYSTEM_PROMPT = `You say what kind of place a business or building is, from its name, for a fleet report in Kenya and East Africa.
Answer with exactly one of these groups for each place, or null when the name does not say:
${ACTIVITIES.join(' | ')}.
Read every word of the name and decide what a driver most likely went there to do. Local words matter:
- Mechanical: garages, motor or motorcycle spares, tyres, auto parts, welding, panel beaters, car wash ("Diamond Motorcycle Spares").
- Entertainment: resorts, clubs, lounges, parks, stadiums, gyms ("jim"), casinos ("Rhumba Resort").
- Barber / salon: "kinyozi" (Swahili for barber), barbers, salons and "saloons", beauty parlours, hair, nails, spa.
- Work: sugar companies and their factories, workshops, weighbridges ("waybridge"), cane buying centres, depots, mills, yards ("West Kenya Sugar - Lake Agro workshop").
- Food and drink: restaurants, cafes, butcheries, "nyama choma", and a small Kenyan "hotel", which is usually an eatery unless the hint says lodging.
- Banking: banks, saccos, M-Pesa agents, microfinance. Medical: hospitals, clinics, chemists, dispensaries. Shopping: shops, stores, supermarkets, agrovets, "supplies", phones.
A hint, when given, is Google's own type for the place; use it when the name says nothing, but the words of the name come first.
Do not guess from a person's name alone. Reply with JSON only: {"items":[{"i":<index>,"activity":<group or null>}]}.`

// Kept on disk (usage-review.store), so a deploy does not pay for the same
// names again.
const cache = persistentStore<Activity | null>('activity-ai', { hitTtlMs: TTL_MS, missTtlMs: TTL_MS, max: CACHE_MAX })
const inFlight = new Map<string, Promise<Activity | null>>()

/** "Diamond Motorcycle Spares, 0.5 km away" → "Diamond Motorcycle Spares": the
 *  page labels the nearest place some way off with its distance. */
export const bareName = (name: string) => name.replace(/,\s*[\d.]+\s*km away$/i, '').trim()

/** The cache key: case, spacing and a distance do not make a different business. */
export const nameKey = (name: string) => bareName(name).toLowerCase().replace(/\s+/g, ' ')

const isActivity = (v: unknown): v is Activity => typeof v === 'string' && (ACTIVITIES as readonly string[]).includes(v)

/** The model's answer for `name` if it has been asked: undefined when not. */
export function cachedActivity(name: string | null | undefined): Activity | null | undefined {
  if (!name) return undefined
  return cache.get(nameKey(name))
}

const remember = (k: string, a: Activity | null) => cache.set(k, a)

/** Exported for the tests: the model's reply, kept only where it names a group. */
export function readReply(content: string, count: number): (Activity | null)[] | null {
  let parsed: unknown
  try { parsed = JSON.parse(content) } catch { return null }
  const items = (parsed as { items?: unknown })?.items
  if (!Array.isArray(items)) return null
  const out: (Activity | null)[] = Array.from({ length: count }, () => null)
  for (const it of items) {
    const i = (it as { i?: unknown })?.i, a = (it as { activity?: unknown })?.activity
    if (typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < count) out[i] = isActivity(a) ? a : null
  }
  return out
}

type Provider = { name: string; url: string; key: string; model: string }

/** The providers to ask, in order: OpenAI, then DeepSeek. */
function providers(): Provider[] {
  const out: Provider[] = []
  if (env.OPENAI_API_KEY) out.push({ name: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', key: env.OPENAI_API_KEY, model: env.OPENAI_MODEL })
  if (env.DEEPSEEK_API_KEY) out.push({ name: 'DeepSeek', url: 'https://api.deepseek.com/chat/completions', key: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL })
  return out
}
/** Provider name → when it may be asked again, after refusing its key or credit. */
const restingUntil = new Map<string, number>()
/** Provider name → its last failure, as HTTP status and error code only. */
const lastProblem = new Map<string, string>()

async function askOne(p: Provider, batch: { name: string; hint: string | null }[]): Promise<(Activity | null)[] | null> {
  try {
    const res = await fetch(p.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
      body: JSON.stringify({
        model: p.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(batch.map((b, i) => ({ i, name: b.name, ...(b.hint ? { hint: b.hint } : {}) }))) },
        ],
        response_format: { type: 'json_object' },
        // A lookup, not a puzzle: OpenAI's reasoning models answer far sooner
        // with the least reasoning (gpt-5-nano took over 12 s at its default).
        ...(p.name === 'OpenAI' && /^(gpt-5|o\d)/.test(p.model) ? { reasoning_effort: 'minimal' } : {}),
      }),
      signal: AbortSignal.timeout(45_000),
    })
    if (!res.ok) {
      // A bad key or no credit will not mend in the next minute.
      if ([401, 402, 403, 429].includes(res.status)) restingUntil.set(p.name, Date.now() + 10 * 60_000)
      const text = await res.text()
      let code = ''
      try { const e = (JSON.parse(text) as { error?: { code?: unknown; type?: unknown } }).error; code = String(e?.code ?? e?.type ?? '') } catch { /* not JSON */ }
      lastProblem.set(p.name, `HTTP ${res.status}${code ? ` ${code.slice(0, 40)}` : ''}`)
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    const body = await res.json() as { choices?: { message?: { content?: string } }[] }
    const got = readReply(body.choices?.[0]?.message?.content ?? '', batch.length)
    if (!got) { lastProblem.set(p.name, 'unreadable reply'); throw new Error('unreadable reply') }
    lastProblem.delete(p.name)
    return got
  } catch (err) {
    if (!lastProblem.has(p.name)) lastProblem.set(p.name, err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'no answer')
    logger.warn({ provider: p.name, err: String(err), names: batch.length }, 'Usage review: place activities not read by the model')
    return null
  }
}

/** The first provider's answer that comes back readable, or null. */
async function askModel(batch: { name: string; hint: string | null }[]): Promise<(Activity | null)[] | null> {
  for (const p of providers()) {
    if ((restingUntil.get(p.name) ?? 0) > Date.now()) continue
    const got = await askOne(p, batch)
    if (got) return got
  }
  return null
}

/** Whether any provider is configured. */
export const aiConfigured = () => providers().length > 0

/**
 * Each provider as the server sees it — configured or not, resting, its last
 * failure — never the key. Answered beside the activities so a blank Activity
 * column can be explained without reading the server's logs.
 */
export function aiStatus() {
  const on = new Set(providers().map(p => p.name))
  return ['OpenAI', 'DeepSeek'].map(name => ({
    name,
    configured: on.has(name),
    resting: (restingUntil.get(name) ?? 0) > Date.now(),
    lastProblem: lastProblem.get(name) ?? null,
  }))
}

/**
 * The model's group for each place name, keyed by nameKey. `hint` is Google's
 * own type for the place when known ("Gas station", "Point of interest").
 * Names it was not asked about, or could not answer, are absent.
 */
export async function aiActivities(places: { name: string; hint?: string | null }[]): Promise<Map<string, Activity | null>> {
  const out = new Map<string, Activity | null>()
  const ask: { k: string; name: string; hint: string | null }[] = []
  const waits: Promise<void>[] = []
  for (const p of places) {
    const name = p.name?.trim()
    if (!name) continue
    const k = nameKey(name)
    if (out.has(k) || ask.some(a => a.k === k)) continue
    const hit = cachedActivity(name)
    if (hit !== undefined) { out.set(k, hit); continue }
    const pending = inFlight.get(k)
    if (pending) { waits.push(pending.then(a => { out.set(k, a) }, () => {})); continue }
    ask.push({ k, name: bareName(name).slice(0, 120), hint: p.hint?.trim().slice(0, 60) || null })
  }
  if (ask.length && aiConfigured()) {
    for (let i = 0; i < ask.length; i += BATCH) {
      const part = ask.slice(i, i + BATCH)
      const job = askModel(part)
      part.forEach((a, j) => {
        const one = job.then(r => {
          if (!r) throw new Error('no answer')
          remember(a.k, r[j] ?? null)
          return r[j] ?? null
        })
        one.catch(() => {}).finally(() => inFlight.delete(a.k))
        inFlight.set(a.k, one)
        waits.push(one.then(v => { out.set(a.k, v) }, () => {}))
      })
    }
  }
  await Promise.all(waits)
  return out
}
