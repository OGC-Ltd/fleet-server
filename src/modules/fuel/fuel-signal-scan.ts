/**
 * Stored telemetry → `fuel-signal-alerts` events, for one vehicle. Pure.
 *
 * Everything between the database and the detector lives here — which row of
 * the table a vehicle is judged by, what consumption it is given, how fixes
 * become samples with cumulative work — so that the API
 * (`fuel-signal-alerts.service`) and the measurement harness
 * (`prisma/signal-alerts-replay.ts`) run the SAME arithmetic by different data
 * routes. A harness with its own copy would measure a detector that is not the
 * one being served, which is the failure `judgeDrain` was written to end.
 */

import { haversineM } from '../../lib/dispatch-trip.js'
import { resolveBasis, resolveClass } from './fuel-theft-classifier.js'
import { MAX_ENGINE_GAP_SECONDS } from './fuel-drop-shape.js'
import type { BandInputs } from './fuel-rate.js'
import {
  detectFuelSignals, thresholdsFor, FuelSignalDetector, PROFILES,
  type ProfileType, type SignalEvent, type SignalSample, type SignalThresholds, type SignalStats,
} from './fuel-signal-alerts.js'

/**
 * Read this much before `from` so the median, the Kalman filter and the stable
 * count have settled by the time the window opens. Events confirmed inside the
 * warm-up are dropped.
 */
export const SIGNAL_WARMUP_MS = 30 * 60_000
/** A step implying more than this is a GPS jump, not distance travelled. */
const MAX_PLAUSIBLE_KMH = 150

export type ConsumptionSource = 'vehicle' | 'type-median' | 'table' | 'caller'

export interface ResolvedProfile {
  type: ProfileType
  /** Why this row of the table was chosen. */
  reason: string
  consumptionSource: ConsumptionSource
  tankCapacityL: number | null
  thresholds: SignalThresholds
}

export interface ProfileOverrides {
  profile?: ProfileType | undefined
  consumption?: number | undefined
  tankCapacityL?: number | undefined
}

/** A vehicle with nothing known about it — the caller names a profile instead. */
export const NO_BAND_INPUTS: BandInputs = {
  orgCode: '', plate: '', rate: null, lPerKm: null, vehicleType: null, tankCapacityLitres: null,
}

/**
 * Which row of the specification's table a vehicle is judged by.
 *
 * The table has no tractor, and tractors are most of the machinery here. A
 * machine this codebase judges per engine-hour (`resolveBasis`) and that no
 * class places more precisely gets the excavator row — the nearest machinery
 * profile. Everything else judged per kilometre gets the truck row.
 */
export function profileTypeFor(b: Pick<BandInputs, 'orgCode' | 'plate' | 'vehicleType' | 'tankCapacityLitres'>): { type: ProfileType; reason: string } {
  const identity = { plate: b.plate, vehicleType: b.vehicleType, tankCapacityLitres: b.tankCapacityLitres }
  const type = b.vehicleType?.toUpperCase() ?? ''
  const cls = resolveClass(b.orgCode, identity)

  if (cls === 'GENERATOR' || type === 'GENERATOR') return { type: 'generator', reason: cls ? `class ${cls}` : `type ${type}` }
  if (cls?.startsWith('DOZER')) return { type: 'bulldozer', reason: `class ${cls}` }
  if (cls?.startsWith('EXCAVATOR')) return { type: 'excavator', reason: `class ${cls}` }
  if (type === 'BUS') return { type: 'bus', reason: 'type BUS' }
  if (type === 'SALOON' || type === 'COMPANY_VEHICLE') return { type: 'car', reason: `type ${type}` }
  if (type === 'MOTORCYCLE' || type === 'MOTORBIKE') return { type: 'motorcycle', reason: `type ${type}` }
  if (type === 'FORKLIFT') return { type: 'forklift', reason: 'type FORKLIFT' }
  if (resolveBasis(b.orgCode, identity) === 'HOURS') {
    return { type: 'excavator', reason: `judged per engine-hour (${cls ?? (type || 'unclassed')}); nearest machinery row` }
  }
  return { type: 'truck', reason: `judged per km (${type || 'untyped'}); road-vehicle default` }
}

/**
 * The vehicle's own measured consumption in place of the table's, where there
 * is one. Per-hour figures may be a type median (`resolveRates`); per-km ones
 * are only ever the vehicle's own, for the reason `BandInputs` gives.
 */
function consumptionFor(b: BandInputs, type: ProfileType): { value: number | null; source: ConsumptionSource } {
  if (PROFILES[type].workUnit === 'hours') {
    if (b.rate != null && b.rate.lPerHour > 0) {
      return { value: b.rate.lPerHour, source: b.rate.basis === 'vehicle' ? 'vehicle' : 'type-median' }
    }
  } else if (b.lPerKm != null && b.lPerKm > 0) {
    return { value: b.lPerKm, source: 'vehicle' }
  }
  return { value: null, source: 'table' }
}

export function resolveProfile(b: BandInputs, override: ProfileOverrides = {}): ResolvedProfile {
  const picked = override.profile
    ? { type: override.profile, reason: 'requested' }
    : profileTypeFor(b)
  const measured = consumptionFor(b, picked.type)
  const consumption = override.consumption ?? measured.value
  const tankCapacityL = override.tankCapacityL ?? b.tankCapacityLitres ?? null
  return {
    ...picked,
    consumptionSource: override.consumption != null ? 'caller' : measured.source,
    tankCapacityL,
    thresholds: thresholdsFor(picked.type, { tankCapacityL, consumption }),
  }
}

/** The `vehicle_telemetries` columns a scan reads. */
export interface SignalTelemetryRow {
  capturedAt: Date
  lat: number | null
  lng: number | null
  speedKmh: number | null
  engineOn: boolean
  ignitionKnown: boolean | null
  fuelLevelMl: number | null
}

/**
 * Stored fixes → detector samples, with cumulative work in the profile's unit.
 *
 * Engine-hours are integrated over the pings rather than read from
 * `engine_hours_meter`, the same way `engineOnSeconds` does it: an interval is
 * credited when the reading that OPENS it has a MEASURED engine state, and one
 * longer than MAX_ENGINE_GAP_SECONDS is not credited at all. `engine_on` alone
 * is never read as the engine — the adapter fills it from speed where ignition
 * is unknown — so an interval opened by an unknown reading is marked
 * unmeasured, which keeps the detector from judging loss across it.
 */
export function toSignalSamples(rows: readonly SignalTelemetryRow[], unit: 'km' | 'hours'): SignalSample[] {
  const step = new SampleStepper(unit)
  return rows.map(r => step.next(r))
}

/** toSignalSamples one fix at a time, for a caller that receives them live. */
export class SampleStepper {
  private work = 0
  private prev: SignalTelemetryRow | null = null

  constructor(private readonly unit: 'km' | 'hours') {}

  next(r: SignalTelemetryRow): SignalSample {
    const prev = this.prev
    let measured = true
    if (prev) {
      const dtS = (r.capturedAt.getTime() - prev.capturedAt.getTime()) / 1000
      if (this.unit === 'hours') {
        if (prev.ignitionKnown !== true || dtS > MAX_ENGINE_GAP_SECONDS) measured = false
        else if (prev.engineOn) this.work += dtS / 3600
      } else if (prev.lat != null && prev.lng != null && r.lat != null && r.lng != null && dtS > 0) {
        const km = haversineM({ lat: prev.lat, lng: prev.lng }, { lat: r.lat, lng: r.lng }) / 1000
        if (km / (dtS / 3600) > MAX_PLAUSIBLE_KMH) measured = false
        else this.work += km
      } else {
        measured = false
      }
    }
    this.prev = r
    return {
      t: r.capturedAt.getTime() / 1000,
      fuelL: r.fuelLevelMl != null ? r.fuelLevelMl / 1000 : null,
      work: this.work,
      workMeasured: measured,
      speedKmh: r.speedKmh,
      ignitionOff: r.ignitionKnown === true ? !r.engineOn : null,
    }
  }
}

/**
 * One vehicle fed fixes as they arrive: the live form of scanTelemetry.
 *
 * Same profile, same samples, same detector, so over the same rows it confirms
 * the same events — one at a time, and before mergeContiguous; a consumer asks
 * `continuesEvent` whether a confirmation extends the one before it.
 */
export class SignalStream {
  readonly profile: ResolvedProfile
  private readonly step: SampleStepper
  private readonly detector: FuelSignalDetector

  constructor(bands: BandInputs, override: ProfileOverrides = {}) {
    this.profile = resolveProfile(bands, override)
    this.step = new SampleStepper(this.profile.thresholds.workUnit)
    this.detector = new FuelSignalDetector(this.profile.thresholds)
  }

  push(r: SignalTelemetryRow): SignalEvent[] {
    return this.detector.push(this.step.next(r))
  }

  get stats(): SignalStats {
    return this.detector.stats
  }
}

/**
 * One vehicle's scan: profile, events confirmed at or after `from`, stats.
 *
 * `rows` must be ascending and should start SIGNAL_WARMUP_MS before `from`.
 */
export function scanTelemetry(
  rows: readonly SignalTelemetryRow[],
  bands: BandInputs,
  from: Date,
  override: ProfileOverrides = {},
): { profile: ResolvedProfile; events: SignalEvent[]; stats: SignalStats } {
  const profile = resolveProfile(bands, override)
  const { events, stats } = detectFuelSignals(toSignalSamples(rows, profile.thresholds.workUnit), profile.thresholds)
  const fromS = from.getTime() / 1000
  return { profile, events: events.filter(e => e.at >= fromS), stats }
}

// ── API shapes ───────────────────────────────────────────────────────────────

const r1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10)
const iso = (s: number | null) => (s == null ? null : new Date(s * 1000).toISOString())

export function shapeEvent(e: SignalEvent, workUnit: 'km' | 'hours') {
  return {
    type: e.type,
    at: iso(e.at)!,
    since: iso(e.since)!,
    windowStart: iso(e.windowStart),
    rule: e.rule,
    fuelL: r1(e.fuelL)!,
    deltaFuelL: r1(e.deltaFuelL),
    expectedL: r1(e.expectedL),
    residualL: r1(e.residualL),
    workDelta: e.workDelta == null ? null : Math.round(e.workDelta * 100) / 100,
    workUnit,
  }
}

export function shapeProfile(p: ResolvedProfile) {
  const { thresholds: th } = p
  return {
    type: p.type,
    reason: p.reason,
    workUnit: th.workUnit,
    consumption: Math.round(th.consumption * 1000) / 1000,
    consumptionSource: p.consumptionSource,
    tankCapacityL: p.tankCapacityL,
    thresholds: th,
  }
}

export function shapeStats(s: SignalStats) {
  return { ...s, medianGapS: s.medianGapS == null ? null : Math.round(s.medianGapS) }
}
