/**
 * A unit's fuel over a period, worked out as Vehicle analytics works it out
 * (new-ui lib/fuelReport.js, buildFuelReport), so a report that quotes these
 * figures reads the same as that page for the same period (operator, 4 Nov
 * 2026). A change there has to be made here too; __match on the box compares
 * the two on live units.
 *
 *   Initial/Final  the middle of the first and last 7 readings that read a tank.
 *   Filled         the ledger's fillings judged REFILL or PENDING, each by the
 *                  rise it observed, else the volume it recorded.
 *   Theft          the ledger's drains judged DRAIN with cause SIPHON, except
 *                  one ending on a dead probe, which is the probe going dark.
 *   Consumed       initial + filled - theft - final, each rounded to 0.1 L first
 *                  so the figures shown add up, and never below nothing.
 *   Distance       "Mileage in trips": the moving stretches of the track.
 *
 * Pure.
 */
import { haversineM } from '../../lib/geofence.js'

const MOVING_KMH = 3
const GAP_MS = 20 * 60_000
const JITTER_M = 20
const EDGE_READINGS = 7
const DEAD_PROBE_ML = 1000

export interface BalanceReading { t: number; lat: number | null; lng: number | null; speedKmh: number | null; fuelMl: number | null }
export interface BalanceFilling { at: number; verdict: string | null; observedRiseMl: number | null; filledMl: number | null }
export interface BalanceDrain {
  at: number; verdict: string | null; drainCause: string | null
  cleanDropMl: number | null; measuredDropMl: number | null; stolenMl: number | null; finalFuelLevelMl: number | null
}
export interface FuelBalance {
  startL: number | null; endL: number | null; filledL: number; theftL: number
  consumedL: number | null; unrecordedL: number | null; distanceKm: number
  /** Km to the litre, once the unit burned fuel and went a kilometre. */
  kmPerL: number | null
}

const r1 = (v: number) => Math.round(v * 10) / 10
const orNull = (ml: number | null | undefined) => (ml != null && Number.isFinite(ml) ? ml / 1000 : null)
const readsFuel = (ml: number | null): ml is number => ml != null && Number.isFinite(ml) && ml >= DEAD_PROBE_ML
const hasFix = (p: BalanceReading) => p.lat != null && p.lng != null && !(p.lat === 0 && p.lng === 0)

function median(xs: number[]): number {
  const v = [...xs].sort((a, b) => a - b)
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2
}

/**
 * A stored reading as the day series sends it to that page: the time to the
 * second and the position to about a metre. Distance is measured off these, so
 * the same rounding gives the same kilometres.
 */
export function asDaySeries(r: BalanceReading): BalanceReading {
  const round = (v: number | null, dp: number) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp)
  return { t: Math.round(r.t / 1000) * 1000, lat: round(r.lat, 5), lng: round(r.lng, 5), speedKmh: round(r.speedKmh, 0), fuelMl: round(r.fuelMl, 0) }
}

/** Mileage in trips: moving stretches, broken by a gap in the readings, jitter left out, a blip dropped. */
export function tripDistanceKm(readings: BalanceReading[]): number {
  let km = 0
  let moving: boolean | null = null
  let start = 0, end = 0, metres = 0
  let prev: BalanceReading | null = null
  const close = () => {
    if (moving && (metres >= 50 || end - start >= 60_000)) km += metres / 1000
    moving = null
  }
  for (const p of readings) {
    const now = Number(p.speedKmh) >= MOVING_KMH
    if (prev && p.t - prev.t > GAP_MS) { close(); prev = null }
    if (moving !== now) {
      close()
      moving = now
      start = end = p.t
      metres = 0
    } else {
      end = p.t
    }
    if (prev && hasFix(prev) && hasFix(p) && now) {
      const d = haversineM(prev.lat!, prev.lng!, p.lat!, p.lng!)
      if (d >= JITTER_M) metres += d
    }
    prev = p
  }
  close()
  return km
}

/** The period [from, to): readings once each in time order, and the ledger's events, any wider. */
export function fuelBalance(o: { readings: BalanceReading[]; fillings: BalanceFilling[]; drains: BalanceDrain[]; from: number; to: number }): FuelBalance {
  const seen = new Set<number>()
  const rows = o.readings.filter(p => p.t >= o.from && p.t < o.to && !seen.has(p.t) && Boolean(seen.add(p.t)))
  const inSpan = (at: number) => at >= o.from && at < o.to

  const levels = rows.map(p => p.fuelMl).filter(readsFuel)
  const startL = levels.length ? r1(median(levels.slice(0, EDGE_READINGS)) / 1000) : null
  const endL = levels.length ? r1(median(levels.slice(-EDGE_READINGS)) / 1000) : null

  const filledL = r1(o.fillings
    .filter(f => inSpan(f.at) && (f.verdict === 'REFILL' || f.verdict === 'PENDING' || f.verdict == null))
    .reduce((n, f) => n + r1(orNull(f.observedRiseMl ?? f.filledMl) ?? 0), 0))
  const theftL = r1(o.drains
    .filter(d => inSpan(d.at) && d.verdict === 'DRAIN' && d.drainCause === 'SIPHON'
      && !(d.finalFuelLevelMl != null && Number.isFinite(d.finalFuelLevelMl) && d.finalFuelLevelMl < DEAD_PROBE_ML))
    .reduce((n, d) => n + r1(orNull(d.cleanDropMl ?? d.measuredDropMl ?? d.stolenMl) ?? 0), 0))

  const gap = startL != null && endL != null ? r1(startL + filledL - theftL - endL) : null
  const consumedL = gap == null ? null : Math.max(0, gap)
  const distanceKm = tripDistanceKm(rows)
  return {
    startL, endL, filledL, theftL, consumedL,
    unrecordedL: gap == null ? null : Math.max(0, -gap),
    distanceKm,
    kmPerL: consumedL != null && consumedL > 0 && distanceKm >= 1 ? distanceKm / consumedL : null,
  }
}
