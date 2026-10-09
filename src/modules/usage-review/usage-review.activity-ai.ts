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

export const ACTIVITIES = [
  'Fuel', 'Vehicle service', 'Banking', 'Medical', 'Lodging', 'Food and drink', 'Worship', 'Education',
  'Government', 'Shopping', 'Transport', 'Industrial / works', 'Farm', 'Offices', 'Leisure',
] as const
export type Activity = (typeof ACTIVITIES)[number]

const TTL_MS = 30 * 86_400_000
const CACHE_MAX = 5_000
const BATCH = 40

const SYSTEM_PROMPT = `You say what kind of place a business or building is, from its name, for a fleet report in Kenya and East Africa.
Answer with exactly one of these groups for each place, or null when the name does not say:
${ACTIVITIES.join(' | ')}.
Read local words: "hotel" on a small Kenyan business usually means an eatery (Food and drink) unless the hint says lodging; "sacco" and "M-Pesa" are Banking; "chemist" and "dispensary" are Medical; "agrovet" and "supplies" are Shopping; "jim" is a gym (Leisure); a weighbridge, "waybridge", cane buying centre, factory, depot or workshop is Industrial / works.
A hint, when given, is Google's own type for the place; trust it unless it is only "point of interest" or "establishment".
Do not guess from a person's name alone. Reply with JSON only: {"items":[{"i":<index>,"activity":<group or null>}]}.`

type Entry = { a: Activity | null; at: number }
const cache = new Map<string, Entry>()
const inFlight = new Map<string, Promise<Activity | null>>()

/** The cache key: case and spacing do not make a different business. */
export const nameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ')

const isActivity = (v: unknown): v is Activity => typeof v === 'string' && (ACTIVITIES as readonly string[]).includes(v)

/** The model's answer for `name` if it has been asked: undefined when not. */
export function cachedActivity(name: string | null | undefined): Activity | null | undefined {
  if (!name) return undefined
  const e = cache.get(nameKey(name))
  if (!e) return undefined
  if (Date.now() - e.at > TTL_MS) { cache.delete(nameKey(name)); return undefined }
  return e.a
}

function remember(k: string, a: Activity | null) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
  cache.set(k, { a, at: Date.now() })
}

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
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const body = await res.json() as { choices?: { message?: { content?: string } }[] }
    const got = readReply(body.choices?.[0]?.message?.content ?? '', batch.length)
    if (!got) throw new Error('unreadable reply')
    return got
  } catch (err) {
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

/** Whether any provider is configured — for the tests and the page's note. */
export const aiConfigured = () => providers().length > 0

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
    ask.push({ k, name: name.slice(0, 120), hint: p.hint?.trim().slice(0, 60) || null })
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
