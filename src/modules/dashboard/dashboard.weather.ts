/**
 * Route weather proxy — server-side OpenWeather fetch for the org's key route
 * hubs (Sukari HQ + regional depots). Keeps the API key off the client, and
 * caches the aggregated result in-process (15 min TTL) to stay well inside the
 * free-tier rate limit.
 *
 * Sources:
 *   • /data/2.5/forecast       — 5-day / 3-hour → aggregated to daily min/max + icon
 *   • /data/2.5/air_pollution  — PM2.5 → US-AQI (matches the numeric AQI in the mockup)
 */

import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'

interface Loc { name: string; lat: number; lng: number }

// Route hubs per organisation — the org's plant/HQ plus the towns its fleet
// delivers to. Keyed by org code; unknown orgs fall back to Sukari's set.
//
// The first entry was "Sukari HQ" at 0.3358 / 34.4928 until 2026-09-13, which
// is near Kakamega and forecast weather for a town this fleet does not work in
// — the factory is at Ndhiwa, 129 km south, where the operator says it is and
// where 268,032 of the org's own fixes sit. Renamed as well as moved, because
// "HQ" at the mill's coordinates would just be the same mislabel in reverse.
const LOCATIONS_BY_ORG: Record<string, Loc[]> = {
  SUKARI: [
    { name: 'Sukari Factory', lat: -0.82340, lng: 34.38449 },
    { name: 'Kisumu',    lat: -0.0917, lng: 34.7679 },
    { name: 'Nakuru',    lat: -0.3031, lng: 36.0800 },
    { name: 'Nairobi',   lat: -1.2921, lng: 36.8219 },
    { name: 'Eldoret',   lat:  0.5143, lng: 35.2698 },
    { name: 'Mombasa',   lat: -4.0435, lng: 39.6682 },
  ],
  // The three sites this org actually works from, MEASURED on 2026-08-31 as
  // the densest 1.1 km cell of each business unit's last known fixes — 53 of
  // 210 Menengai units, 11 of 20 Rai MDF, 5 of 14 MORL. Nakuru is the town the
  // refinery sits in and is the only entry here not derived from telemetry.
  //
  // No delivery towns. Sukari's list above names six because its routes are
  // known; inventing an equivalent for Menengai would put weather on the
  // screen for roads its fleet may never take.
  MENENGAI: [
    { name: 'Menengai Refinery', lat: -0.2889, lng: 36.0446 },
    { name: 'Rai MDF',           lat: -0.2186, lng: 35.9081 },
    { name: 'MORL Farm',         lat: -0.1989, lng: 35.8661 },
    { name: 'Nakuru',            lat: -0.3031, lng: 36.0800 },
  ],
  // Same method: the densest 1.1 km cell per site, 2026-08-31. Kabras holds 82
  // of the 448 reporting units, Naitiri 49 of 104, Amuka 3 of 9. Khalaba and
  // the winches are too sparse to site this way and are left out rather than
  // guessed. Kakamega is the county town by the factory — the only entry here
  // not derived from telemetry.
  WESTSUGAR: [
    { name: 'Kabras Factory', lat: 0.3781, lng: 34.8333 },
    { name: 'Naitiri',        lat: 0.7821, lng: 34.8776 },
    { name: 'Amuka',          lat: 1.0714, lng: 34.9972 },
    { name: 'Kakamega',       lat: 0.2827, lng: 34.7519 },
  ],
  // The densest 1.1 km cell per fleet, 2026-10-07: Elburgon holds 54 of 114
  // located Timsales units; Limuru 43 of 77 Aquamist, Mombasa the next 8.
  TIMSALES: [
    { name: 'Elburgon', lat: -0.3008, lng: 35.8016 },
  ],
  AQUAMIST: [
    { name: 'Limuru',  lat: -1.2045, lng: 36.6580 },
    { name: 'Mombasa', lat: -4.0568, lng: 39.6556 },
  ],
}
const DEFAULT_ORG_CODE = 'SUKARI'

const OWM = 'https://api.openweathermap.org/data/2.5'
const CACHE_TTL_MS = 15 * 60_000
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// One cache entry per org code — the location sets differ.
const cache = new Map<string, { ts: number; data: unknown }>()

// EPA breakpoints — PM2.5 (µg/m³) → US AQI (0–500).
function pm25ToUsAqi(pm: number): number {
  const bp: [number, number, number, number][] = [
    [0, 12, 0, 50], [12.1, 35.4, 51, 100], [35.5, 55.4, 101, 150],
    [55.5, 150.4, 151, 200], [150.5, 250.4, 201, 300], [250.5, 500.4, 301, 500],
  ]
  for (const [clo, chi, alo, ahi] of bp) {
    if (pm <= chi) return Math.round(((ahi - alo) / (chi - clo)) * (pm - clo) + alo)
  }
  return 500
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function fetchLocation(loc: Loc, key: string) {
  const res = await fetch(`${OWM}/forecast?lat=${loc.lat}&lon=${loc.lng}&units=metric&appid=${key}`)
  if (!res.ok) throw new Error(`forecast ${res.status}`)
  const json: any = await res.json()
  const tzMs = (json.city?.timezone ?? 0) * 1000

  // Bucket 3-hourly entries by the location's LOCAL calendar date.
  const byDate = new Map<string, { temps: number[]; entries: any[] }>()
  for (const e of (json.list ?? []) as any[]) {
    const local   = new Date(e.dt * 1000 + tzMs)
    const dateKey = local.toISOString().slice(0, 10)
    const g = byDate.get(dateKey) ?? { temps: [], entries: [] }
    g.temps.push(e.main.temp_min, e.main.temp_max)
    g.entries.push({ ...e, localHour: local.getUTCHours() })
    byDate.set(dateKey, g)
  }

  const todayKey = new Date(Date.now() + tzMs).toISOString().slice(0, 10)
  const days = [...byDate.entries()].slice(0, 5).map(([date, g]) => {
    // Representative condition = the reading closest to local noon.
    const rep = g.entries.reduce(
      (best, e) => (Math.abs(e.localHour - 12) < Math.abs(best.localHour - 12) ? e : best),
      g.entries[0],
    )
    const d = new Date(`${date}T00:00:00Z`)
    return {
      date,
      dayLabel:  date === todayKey ? 'Today' : DAY[d.getUTCDay()],
      icon:      rep.weather?.[0]?.icon ?? '01d',
      condition: rep.weather?.[0]?.main ?? 'Clear',
      tempMin:   Math.round(Math.min(...g.temps)),
      tempMax:   Math.round(Math.max(...g.temps)),
    }
  })

  let aqi = 0
  try {
    const ap = await fetch(`${OWM}/air_pollution?lat=${loc.lat}&lon=${loc.lng}&appid=${key}`)
    if (ap.ok) {
      const apJson: any = await ap.json()
      const pm = apJson.list?.[0]?.components?.pm2_5
      if (pm != null) aqi = pm25ToUsAqi(pm)
    }
  } catch { /* AQI is optional — don't fail the whole location */ }

  return { name: loc.name, lat: loc.lat, lng: loc.lng, aqi, days }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function getRouteWeather(orgCode: string = DEFAULT_ORG_CODE) {
  const code   = LOCATIONS_BY_ORG[orgCode] ? orgCode : DEFAULT_ORG_CODE
  const cached = cache.get(code)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data

  const key = env.OPENWEATHER_API_KEY
  if (!key) return { locations: [], error: 'OPENWEATHER_API_KEY not configured' }

  const locs      = LOCATIONS_BY_ORG[code]!
  const results   = await Promise.allSettled(locs.map(l => fetchLocation(l, key)))
  const locations = results
    .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof fetchLocation>>> => r.status === 'fulfilled')
    .map(r => r.value)

  const failed = results.length - locations.length
  if (failed > 0) {
    const reasons = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map(r => (r.reason instanceof Error ? r.reason.message : String(r.reason)))
    logger.warn({ failed, reasons }, 'Some weather locations failed to fetch')
  }

  const data = { locations }
  if (locations.length > 0) cache.set(code, { ts: Date.now(), data }) // don't cache a total failure
  return data
}
