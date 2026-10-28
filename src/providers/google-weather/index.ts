/**
 * Google Weather API current conditions, for the map's weather layer
 * (operator, 2026-10-27: "use the google map apis to show weather on the map
 * in real time").
 *
 * Google sells weather by POINT, not as map tiles, so the layer is a grid of
 * points over what the map is showing. The grid is snapped to fixed cells, so
 * two operators looking at roughly the same area ask for the same points, and
 * each point is cached for CACHE_TTL_MS for everyone: panning about the map
 * costs nothing new until it reaches cells nobody has looked at lately.
 *
 * Same key as the routing calls (GOOGLE_ROUTING_API_KEY): the browser's Maps
 * key is restricted by referrer and is never sent from here.
 */

import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'

export interface WeatherPoint {
  lat: number
  lng: number
  /** Google's condition, e.g. PARTLY_CLOUDY, LIGHT_RAIN, THUNDERSTORM. */
  type: string
  /** "Partly sunny", in English. */
  text: string
  /** Google's icon, without the extension: add `.svg` (or `_dark.svg`). */
  icon: string | null
  tempC: number | null
  feelsLikeC: number | null
  /** Chance of rain (or snow) now, 0–100. */
  rainPct: number | null
  thunderPct: number | null
  windKmh: number | null
  gustKmh: number | null
  windFrom: string | null
  /** Bearing the wind blows FROM, degrees clockwise from north. */
  windDeg: number | null
  /** Rain expected this hour, mm. */
  rainMm: number | null
  visibilityKm: number | null
  humidityPct: number | null
  isDay: boolean | null
  /** When Google measured it. */
  at: string
}

export function googleWeatherAvailable(): boolean {
  return env.GOOGLE_ROUTING_API_KEY.length > 0
}

/** Google refreshes current conditions about every quarter of an hour. */
const CACHE_TTL_MS = 15 * 60_000
const CACHE_MAX = 5_000
const TIMEOUT_MS = 8_000
/** Points asked of Google at once: a fresh 8-across view is up to 81. */
const PARALLEL = 24
/**
 * Longest the map waits for a grid (operator, 2026-10-28: "make sure that the
 * map grids respond fast without lagging"). Cells Google has not answered by
 * then are left out and counted in `pending`; their lookups carry on into
 * the cache, and the map asks again shortly for the rest.
 */
export const ANSWER_WITHIN_MS = 1_200
/** At most this many cells across either side of the view. */
const CELLS_ACROSS = 8 // 5 left a town's rain smeared over a whole district
/** Cell sizes in degrees, finest first. 0.05° is about 5.5 km. */
const STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5]

export interface Bounds { south: number; west: number; north: number; east: number }

/**
 * The cell centres covering `b`: the finest step that keeps the view to at
 * most CELLS_ACROSS cells a side, then every cell centre inside the view.
 */
export function gridFor(b: Bounds): { step: number; cells: { i: number; j: number; lat: number; lng: number }[] } {
  const span = Math.max(b.north - b.south, b.east - b.west)
  const step = STEPS.find((s) => span / s <= CELLS_ACROSS) ?? STEPS[STEPS.length - 1]!
  const cells: { i: number; j: number; lat: number; lng: number }[] = []
  const i0 = Math.floor(b.south / step), i1 = Math.floor(b.north / step)
  const j0 = Math.floor(b.west / step),  j1 = Math.floor(b.east / step)
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const lat = +((i + 0.5) * step).toFixed(4)
      const lng = +((j + 0.5) * step).toFixed(4)
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue
      cells.push({ i, j, lat, lng })
    }
  }
  return { step, cells }
}

interface Entry { at: number; point: WeatherPoint | null }
const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<WeatherPoint | null>>()

function remember(key: string, point: WeatherPoint | null): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.delete(key)
  cache.set(key, { at: Date.now(), point })
}

type Measure = { degrees?: number; value?: number; distance?: number; percent?: number }
interface Conditions {
  weatherCondition?: { iconBaseUri?: string; description?: { text?: string }; type?: string }
  temperature?: Measure
  feelsLikeTemperature?: Measure
  precipitation?: { probability?: Measure; qpf?: { quantity?: number } }
  thunderstormProbability?: number
  wind?: { direction?: { cardinal?: string; degrees?: number }; speed?: Measure; gust?: Measure }
  visibility?: Measure
  relativeHumidity?: number
  isDaytime?: boolean
  currentTime?: string
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Google's reply as the layer draws it. Exported for the tests. */
export function toPoint(lat: number, lng: number, c: Conditions): WeatherPoint {
  return {
    lat, lng,
    type: c.weatherCondition?.type ?? 'UNKNOWN',
    text: c.weatherCondition?.description?.text ?? '',
    icon: c.weatherCondition?.iconBaseUri ?? null,
    tempC: num(c.temperature?.degrees),
    feelsLikeC: num(c.feelsLikeTemperature?.degrees),
    rainPct: num(c.precipitation?.probability?.percent),
    thunderPct: num(c.thunderstormProbability),
    windKmh: num(c.wind?.speed?.value),
    gustKmh: num(c.wind?.gust?.value),
    windFrom: c.wind?.direction?.cardinal ?? null,
    windDeg: num(c.wind?.direction?.degrees),
    rainMm: num(c.precipitation?.qpf?.quantity),
    visibilityKm: num(c.visibility?.distance),
    humidityPct: num(c.relativeHumidity),
    isDay: typeof c.isDaytime === 'boolean' ? c.isDaytime : null,
    at: c.currentTime ?? new Date().toISOString(),
  }
}

/**
 * Google turned the key itself away (API not enabled, key invalid or
 * restricted, quota). Not cached, so it clears the moment the console is
 * fixed, and reported to the map rather than read as "no weather".
 */
export class KeyRefused extends Error {}
const REFUSING = new Set([401, 403, 429])

async function lookup(lat: number, lng: number): Promise<WeatherPoint | null> {
  const url = new URL('https://weather.googleapis.com/v1/currentConditions:lookup')
  url.searchParams.set('key', env.GOOGLE_ROUTING_API_KEY)
  url.searchParams.set('location.latitude', String(lat))
  url.searchParams.set('location.longitude', String(lng))
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  const j = await res.json().catch(() => ({})) as Conditions & { error?: { message?: string } }
  if (REFUSING.has(res.status)) throw new KeyRefused(j.error?.message ?? `HTTP ${res.status}`)
  if (!res.ok) {
    // Google has no conditions for some places (open sea); not worth a retry.
    logger.warn({ status: res.status, lat, lng, msg: j.error?.message }, 'google weather: lookup refused')
    return null
  }
  return toPoint(lat, lng, j)
}

function cached(key: string, lat: number, lng: number): Promise<WeatherPoint | null> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.point)
  const going = inflight.get(key)
  if (going) return going
  const p = lookup(lat, lng)
    .then((point) => { remember(key, point); return point })
    .catch((err) => {
      if (err instanceof KeyRefused) throw err
      logger.warn({ err, lat, lng }, 'google weather: lookup failed')
      return hit?.point ?? null
    })
    .finally(() => { inflight.delete(key) })
  inflight.set(key, p)
  return p
}

/** Current conditions across the view, one point a cell. */
export async function weatherGrid(
  b: Bounds,
  { within = ANSWER_WITHIN_MS }: { within?: number } = {},
): Promise<{ step: number; points: WeatherPoint[]; pending: number; refused?: string }> {
  const { step, cells } = gridFor(b)
  const out: (WeatherPoint | null)[] = new Array(cells.length).fill(null)
  let refused: string | undefined
  let next = 0
  let answered = 0
  const worker = async () => {
    while (next < cells.length) {
      const k = next++
      const c = cells[k]!
      const key = `${step}:${c.i}:${c.j}`
      try {
        out[k] = await cached(key, c.lat, c.lng)
      } catch (err) {
        if (!(err instanceof KeyRefused)) throw err
        refused ??= err.message
        out[k] = cache.get(key)?.point ?? null // the last answer, however old
      }
      answered++
    }
  }
  const all = Promise.all(Array.from({ length: Math.min(PARALLEL, cells.length) }, worker))
  let timer: NodeJS.Timeout | undefined
  const done = await Promise.race([
    all.then(() => true),
    new Promise<false>((r) => { timer = setTimeout(() => r(false), within) }),
  ])
  clearTimeout(timer)
  if (!done) all.catch((err) => logger.warn({ err }, 'google weather: late lookups failed'))
  const pending = done ? 0 : cells.length - answered
  const points = out.filter((p): p is WeatherPoint => p != null)
  if (refused) logger.warn({ msg: refused }, 'google weather: key refused')
  return refused ? { step, points, pending, refused } : { step, points, pending }
}
