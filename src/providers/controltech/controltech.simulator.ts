/**
 * Controltech EA — vehicle state simulator.
 *
 * Each vehicle is assigned one of ten realistic fleet scenarios.  The state
 * machine evolves on every tick (30 s) to produce convincing multi-cycle
 * timelines (speed ramps, fuel drain, position interpolation, etc.).
 *
 * Routing is classified by vehicleType:
 *  - TRACTOR          : shuttles Sukari Industries ↔ a nearby sugarcane farm.
 *                        Runs out empty, returns loaded with harvested cane.
 *  - TRUCK / LORRY     : shuttles Sukari Industries ↔ a sugar distribution depot.
 *                        Runs out loaded with processed sugar, returns empty.
 *  - everything else   : keeps the original free-roaming Kenyan-city routing
 *                        (used by TANKER, BUS, AMBULANCE, etc.).
 *
 * Design principle: the simulator is an internal implementation detail of
 * ControltechMockAdapter.  Nothing outside the providers/ directory should
 * import it.
 */

import type { CtDeviceSnapshot } from './controltech.types.js'

// ─── scenario catalogue ────────────────────────────────────────────────────

export type ScenarioId =
  | 'IN_TRANSIT'
  | 'APPROACHING_DESTINATION'
  | 'AT_DEPOT'
  | 'IDLING'
  | 'OUTSIDE_GEOFENCE'
  | 'OVERSPEEDING'
  | 'DOOR_OPEN_IN_MOTION'
  | 'FUEL_INCONSISTENCY'
  | 'ENGINE_OFF_IN_FIELD'
  | 'LOW_FUEL'

// Kenyan route anchors — [lat, lng, name] — used by non-sugar-logistics vehicles
// (TANKER, BUS, AMBULANCE, PICKUP, VAN, MINIBUS, TIPPER, …)
const ANCHORS: [number, number, string][] = [
  [-1.2921,  36.8219, 'Nairobi CBD'],
  [-4.0435,  39.6682, 'Mombasa Port'],
  [-0.0917,  34.7679, 'Kisumu City'],
  [-0.3031,  36.0800, 'Nakuru Town'],
  [ 0.5143,  35.2698, 'Eldoret CBD'],
  [-1.0332,  37.0693, 'Thika Town'],
  [-1.5177,  37.2634, 'Machakos Town'],
  [-0.4167,  36.9511, 'Nyeri Town'],
  [-0.7167,  36.4313, 'Naivasha Depot'],
  [ 0.2827,  34.7519, 'Kakamega Town'],
  [ 1.0154,  35.0062, 'Kitale Market'],
  [-3.2175,  40.1169, 'Malindi Town'],
  [-0.4532,  39.6460, 'Garissa Depot'],
  [ 0.5635,  34.5606, 'Bungoma CBD'],
  [-0.5300,  37.4568, 'Embu CBD'],
]

// Depot anchors (non-sugar-logistics vehicles "at depot" sit here)
const DEPOTS: [number, number][] = [
  [-1.3100,  36.8050],   // Nairobi depot
  [-4.0500,  39.6500],   // Mombasa depot
  [-0.1000,  34.7500],   // Kisumu depot
  [-0.3200,  36.0600],   // Nakuru depot
  [ 0.5000,  35.2500],   // Eldoret depot
]

// Sukari Industries processing plant — master hub for trucks & lorries and the
// unload point for tractors. Real coordinates (Migori / Sony-Sugar belt).
const SUKARI: [number, number, string] = [-0.8209476570106832, 34.38504854061814, 'Sukari Industries']

// Dedicated tractor parking / depot — tractors start their day here and return
// here to rest (evenings, Sundays). ~250 m from the mill.
const PARKING: [number, number, string] = [-0.8229430151411534, 34.38463011603268, 'Tractor Parking']

// Sugarcane farms tractors harvest from. Only Nyondo and Oyani are used, both
// well within the 300 km dispatch radius. (Approximate coordinates — replace
// with exact ones if you have them.)
const SUGARCANE_FARMS: [number, number, string][] = [
  [-0.7600, 34.4200, 'Nyondo Farm'],
  [-0.8950, 34.5450, 'Oyani Farm'],
]

// Maximum tractor dispatch radius from the mill (km). Farms beyond this are
// never assigned — cane is only ferried in from within range.
const TRACTOR_DISPATCH_RADIUS_KM = 300

// Sugar distribution depots trucks/lorries deliver processed sugar to — the
// five approved destinations.
const SUGAR_DEPOTS: [number, number, string][] = [
  [-4.0435, 39.6682, 'Mombasa Depot'],
  [-0.0917, 34.7679, 'Kisumu Depot'],
  [-0.3031, 36.0800, 'Nakuru Depot'],
  [-1.2921, 36.8219, 'Nairobi Depot'],
  [ 0.5143, 35.2698, 'Eldoret Depot'],
]

function isTractorType(t: string): boolean { return t === 'TRACTOR' }
function isDeliveryType(t: string): boolean { return t === 'TRUCK' || t === 'LORRY' }

function lerp(a: number, b: number, t: number) { return a + (b - a) * t }
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)) }
function jitter(base: number, delta: number) { return base + (Math.random() * 2 - 1) * delta }
function randInt(lo: number, hi: number) { return lo + Math.floor(Math.random() * (hi - lo + 1)) }

// Fuel burned over `distKm` at a real-world consumption rate (litres / 100 km),
// returned in millilitres. Independent of tank size — e.g. 25 L/100 km over
// 1 km burns 250 ml. (The old formula multiplied by tankCapacityMl/100, which
// drained a full tank every few ticks and pushed the whole fleet into low-fuel
// halts.)
function fuelDrainMl(distKm: number, litresPer100km: number): number {
  return Math.round(litresPer100km * distKm * 10)
}

// ─── simulation clock ───────────────────────────────────────────────────────
// The sim runs SIM_SCALE× faster than real time (10 real minutes = 1 sim hour),
// so journeys and daily cycles are observable in minutes rather than hours. The
// clock is paused across downtime: each cycle advances by the REAL elapsed time
// (capped) × SIM_SCALE, and the current sim time is persisted for exact resume.
const SIM_SCALE          = 6            // 60 sim-min / 10 real-min
const MAX_REAL_STEP_MS   = 5 * 60_000   // cap per-cycle real delta → downtime pauses the sim
let _simNowMs        = Date.now()
let _lastRealMs      = Date.now()
let _simHoursPerTick = (30 / 3600) * SIM_SCALE   // sim-hours advanced by the latest tick

/** Seed the sim clock on boot — resume from the persisted sim time if present. */
export function initSimClock(persistedSimMs?: number | null): void {
  _simNowMs   = persistedSimMs && persistedSimMs > 0 ? persistedSimMs : Date.now()
  _lastRealMs = Date.now()
}
/** Advance the sim clock once per poll cycle (called before ticking vehicles). */
export function advanceSimClock(): void {
  const now       = Date.now()
  const realDelta = Math.min(now - _lastRealMs, MAX_REAL_STEP_MS)
  _lastRealMs = now
  const simDelta   = realDelta * SIM_SCALE
  _simNowMs       += simDelta
  _simHoursPerTick = simDelta / 3_600_000
}
export function simNow(): number { return _simNowMs }
export function simDate(): Date { return new Date(_simNowMs) }
function simHoursThisTick(): number { return _simHoursPerTick }

// ─── wall-clock helpers — the logistics cycle is driven by the SIM clock ──────
function dayKey(d = simDate()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function isSunday(d = simDate()): boolean { return d.getDay() === 0 }
function weekKey(d = simDate()): string {
  // ISO-ish year+week — good enough to detect a week rollover for trip quotas.
  const onejan = new Date(d.getFullYear(), 0, 1)
  const week = Math.ceil((((d.getTime() - onejan.getTime()) / 86_400_000) + onejan.getDay() + 1) / 7)
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`
}
function hourOfDay(d = simDate()): number { return d.getHours() + d.getMinutes() / 60 }

// Timed-phase durations, expressed in real minutes → epoch-ms deadlines.
const MIN_MS = 60_000
const LOAD_MIN_TRACTOR    = () => randInt(15, 30)   // load cane at the farm
const UNLOAD_MIN_TRACTOR  = () => randInt(15, 25)   // offload cane at the mill
const MAINTENANCE_MIN     = () => randInt(120, 240) // 2–4 h workshop visit
// Depot offload scales with load: ~30 min base + 3 min/tonne.
const OFFLOAD_MIN_DELIVERY = (cargoKg: number) => Math.round(30 + (cargoKg / 1000) * 3)

// Legal max payload per type (kg): tractors 20 t, trucks & lorries 36 t. The
// mill always leaves a 10 t safety allowance, so a vehicle is never loaded above
// (max − 10 t) — a tractor tops out at 10 t, a truck/lorry at 26 t.
export const MAX_PAYLOAD_KG: Record<string, number> = { TRACTOR: 20_000, TRUCK: 36_000, LORRY: 36_000 }
const PAYLOAD_ALLOWANCE_KG = 10_000
function plannedLoadKg(vehicleType: string): number {
  const cap = (MAX_PAYLOAD_KG[vehicleType] ?? 20_000) - PAYLOAD_ALLOWANCE_KG
  return randInt(Math.round(cap * 0.80), cap)   // ≤ (max − 10 t), never overloaded
}

// Fleet-wide fuel-theft budget — at most a few siphoning incidents per day so
// the dashboard isn't flooded with critical fuel alerts.
const MAX_THEFTS_PER_DAY = 3
let theftsToday = 0
let theftDayKey = ''
function theftBudgetAvailable(): boolean {
  const today = dayKey()
  if (theftDayKey !== today) { theftDayKey = today; theftsToday = 0 }
  return theftsToday < MAX_THEFTS_PER_DAY
}

// ─── per-vehicle mutable state ─────────────────────────────────────────────

export interface VehicleSimState {
  deviceId:         string
  imei:             string
  scenario:         ScenarioId
  tick:             number          // increments every poll cycle

  // position
  lat:              number
  lng:              number
  originLat:        number
  originLng:        number
  destLat:          number
  destLng:          number
  headingDeg:       number

  // motion
  speedKmh:         number
  targetSpeedKmh:   number
  engineOn:         boolean

  // fuel
  tankCapacityMl:   number
  fuelLevelMl:      number
  prevFuelLevelMl:  number

  // cargo
  cargoWeightKg:    number | null

  // sensors
  batteryV:         number
  doorOpen:         boolean
  panicPressed:     boolean
  odometer:         number

  // cumulative km driven on the current route leg; resets to 0 on each restart.
  // Position is derived from routeProgressKm / totalLegKm so journey time scales
  // correctly with real-world distance regardless of scenario speed.
  routeProgressKm:  number

  // route classification — drives type-aware routing in tickVehicle()
  vehicleType:      string                    // TRACTOR, TRUCK, LORRY, TANKER, …
  legDirection:     'outbound' | 'inbound'     // outbound = away from Sukari Industries

  // geofence test — fence centre & radius assigned to this vehicle
  fenceLat:         number
  fenceLng:         number
  fenceRadiusM:     number

  // engine vitals
  engineTempC:      number   // coolant temperature in °C
  oilLevelPct:      number   // engine oil level 0–100 %

  // halt flags — each condition independently stops the vehicle
  lowFuelHalted:    boolean  // fuel < 20 %
  highTempHalted:   boolean  // engine temp > 105 °C
  lowOilHalted:     boolean  // oil level < 10 %
  haltedFuelTicks:  number   // ticks since low-fuel halt began (for auto-refuel timer)
  haltedOilTicks:   number   // ticks since low-oil halt began (for auto-service timer)

  // ── realistic logistics cycle (TRACTOR / TRUCK / LORRY only) ──────────────
  // Wall-clock driven so a full day/week of behaviour spans real time and the
  // whole thing survives restarts via the persisted state.
  phase:            LogiPhase   // current step in the daily/weekly cycle
  phaseEndsAtMs:    number      // epoch ms a timed phase (loading/dwell/service) ends; 0 = untimed
  simDayKey:        string      // 'YYYY-MM-DD' the daily plan was drawn for
  weekStartKey:     string      // 'YYYY-Www' the weekly plan was drawn for
  tripsToday:       number      // completed farm→industry hauls today (tractors)
  dailyTripTarget:  number      // 0–3 hauls planned for today (tractors)
  tripsThisWeek:    number      // completed industry→depot deliveries this week (trucks/lorries)
  weeklyTripTarget: number      // 0–4 deliveries planned this week (trucks/lorries)
  nextServiceOdoKm: number      // odometer at which the vehicle is due for maintenance

  // ── trip / incident bookkeeping (drives DB persistence in the poller) ─────
  tripBeganAtMs:    number      // epoch ms the current haul leg started (0 = not on a haul)
  tripStartOdoKm:   number      // odometer at haul start
  tripStartFuelMl:  number      // fuel level at haul start
  tripStartLoc:     string      // origin name at haul start
  tripMaxSpeedKmh:  number      // running max speed on the current haul
  tripSpeedSumKmh:  number      // running speed sum for avg
  tripSpeedSamples: number      // running speed sample count
  // one-shot event flags read + cleared by the poller each cycle
  eventTripCompleted: TripEvent | null
  eventFuelTheft:     TheftEvent | null
  eventRefuel:        RefuelEvent | null
}

// Steps in the realistic daily/weekly logistics cycle.
export type LogiPhase =
  | 'AT_PARKING'    // tractor: resting at the dedicated parking, ready for dispatch
  | 'AT_INDUSTRY'   // at the mill, ready / waiting for next dispatch
  | 'TO_FARM'       // tractor: driving out empty to a sugarcane farm
  | 'LOADING'       // tractor: loading cane at the farm (timed)
  | 'TO_INDUSTRY'   // driving to Sukari (tractor loaded / truck returning empty)
  | 'UNLOADING'     // tractor: offloading cane at the mill (timed)
  | 'TO_PARKING'    // tractor: deadheading from the mill back to parking for the day
  | 'TO_DEPOT'      // truck/lorry: driving out loaded to a sugar depot
  | 'OFFLOADING'    // truck/lorry: offloading sugar at the depot (timed, load-scaled)
  | 'DWELL'         // truck/lorry: parked at the depot overnight before returning
  | 'DONE'          // finished today's/this week's plan — parked until next day
  | 'SUNDAY'        // Sunday rest — parked
  | 'MAINTENANCE'   // service due — parked at the mill workshop (timed)

export interface TripEvent {
  beganAtMs:     number
  endedAtMs:     number
  fromLoc:       string
  toLoc:         string
  distanceKm:    number
  avgSpeedKmh:   number
  maxSpeedKmh:   number
  consumedMl:    number
  startFuelMl:   number
  endFuelMl:     number
  cargoWeightKg: number
  cargoType:     'SUGARCANE' | 'PROCESSED_SUGAR'
}

export interface TheftEvent {
  atMs:        number
  stolenMl:    number
  startFuelMl: number
  endFuelMl:   number
  speedKmh:    number
  loc:         string
}

export interface RefuelEvent {
  atMs:        number
  filledMl:    number
  startFuelMl: number
  endFuelMl:   number
  loc:         string
}

// ─── scenario distribution (assigned round-robin to vehicles) ─────────────

const SCENARIO_ROTATION: ScenarioId[] = [
  'IN_TRANSIT',
  'AT_DEPOT',
  'IN_TRANSIT',
  'APPROACHING_DESTINATION',
  'IDLING',
  'OVERSPEEDING',
  'IN_TRANSIT',
  'DOOR_OPEN_IN_MOTION',
  'AT_DEPOT',
  'FUEL_INCONSISTENCY',
  'IN_TRANSIT',
  'OUTSIDE_GEOFENCE',
  'ENGINE_OFF_IN_FIELD',
  'LOW_FUEL',
  'IN_TRANSIT',
  'APPROACHING_DESTINATION',
  'AT_DEPOT',
  'OVERSPEEDING',
  'IDLING',
  'DOOR_OPEN_IN_MOTION',
]

// ─── initialise state for a single vehicle ─────────────────────────────────

export function initVehicleState(
  deviceId: string,
  index: number,
  tankCapacityLitres: number,
  vehicleType: string = 'TRUCK',
): VehicleSimState {
  const tractor  = isTractorType(vehicleType)
  const delivery = isDeliveryType(vehicleType)

  // Every vehicle starts the simulation parked AT THE ORGANISATION — tractors at
  // the dedicated parking, everyone else on the mill premises. Support (non-sugar)
  // vehicles get a small deterministic yard offset so they don't stack on one
  // pixel. All are engine-off, FULL tank, and healthy: no movement and no alerts
  // until operations begin and vehicles are dispatched.
  const home: [number, number, string] = tractor ? PARKING : SUKARI
  const lat = home[0] + (tractor ? 0 : ((index % 8) - 4) * 0.0009)
  const lng = home[1] + (tractor ? 0 : ((Math.floor(index / 8) % 8) - 4) * 0.0009)

  // Outbound destination pool used once the vehicle is dispatched.
  const dest: [number, number, string] = tractor
    ? SUGARCANE_FARMS[index % SUGARCANE_FARMS.length]!
    : delivery ? SUGAR_DEPOTS[index % SUGAR_DEPOTS.length]!
    : home

  const tankMl = tankCapacityLitres * 1000

  return {
    deviceId,
    imei:            `35${String(index).padStart(13, '0')}`,
    scenario:        'AT_DEPOT',      // parked marker; logistics vehicles use `phase`
    tick:            0,
    lat, lng,
    originLat:       home[0],
    originLng:       home[1],
    destLat:         dest[0],
    destLng:         dest[1],
    headingDeg:      0,
    speedKmh:        0,
    targetSpeedKmh:  0,
    engineOn:        false,           // parked at the organisation
    tankCapacityMl:  tankMl,
    fuelLevelMl:     tankMl,          // FULL — every vehicle leaves the premises full
    prevFuelLevelMl: tankMl,
    cargoWeightKg:   0,               // empty at HQ
    batteryV:        jitter(12.6, 0.15),
    doorOpen:        false,
    panicPressed:    false,
    odometer:        Math.round(20_000 + index * 1500),
    routeProgressKm: 0,
    vehicleType,
    legDirection:    'outbound',
    fenceLat:        SUKARI[0],
    fenceLng:        SUKARI[1],
    fenceRadiusM:    1500,

    // Healthy vitals — engine off, so temperature is ambient. No seeded criticals:
    // a fresh fleet is all-green and the fleet-operations feed stays empty until
    // operations begin.
    engineTempC:     jitter(32, 3),
    oilLevelPct:     jitter(88, 6),

    lowFuelHalted:   false,
    highTempHalted:  false,
    lowOilHalted:    false,
    haltedFuelTicks: 0,
    haltedOilTicks:  0,

    // Realistic-cycle fields. simDayKey/weekStartKey start empty so the first
    // tick always triggers a fresh daily/weekly plan and dispatches the vehicle.
    phase:            tractor ? 'AT_PARKING' : 'AT_INDUSTRY',
    phaseEndsAtMs:    0,
    simDayKey:        '',
    weekStartKey:     '',
    tripsToday:       0,
    dailyTripTarget:  0,
    tripsThisWeek:    0,
    weeklyTripTarget: 0,
    nextServiceOdoKm: Math.round(20_000 + index * 1500) + randInt(8_000, 15_000),

    tripBeganAtMs:    0,
    tripStartOdoKm:   0,
    tripStartFuelMl:  0,
    tripStartLoc:     '',
    tripMaxSpeedKmh:  0,
    tripSpeedSumKmh:  0,
    tripSpeedSamples: 0,
    eventTripCompleted: null,
    eventFuelTheft:     null,
    eventRefuel:        null,
  }
}

// ─── halt thresholds ──────────────────────────────────────────────────────
const LOW_FUEL_HALT_RATIO   = 0.20   // < 20 % tank → halt
const HIGH_TEMP_THRESHOLD   = 105    // °C → halt and cool
const LOW_OIL_THRESHOLD     = 10     // % oil level → halt and service
const OIL_SERVICE_AFTER_TICKS = 25   // ticks halted before auto-service (~12.5 min)
// Load-aware self-heal for a critical low-fuel stop (30 s per tick):
//   loaded → 15 min (help is prioritised for a laden vehicle blocking cargo)
//   empty  → 60 min (an empty vehicle waits longer for roadside assistance)
const HEAL_TICKS_LOADED = 30
const HEAL_TICKS_EMPTY  = 120

// ─── state evolution (called every tick) ──────────────────────────────────

export function tickVehicle(s: VehicleSimState): void {
  s.tick++
  const T = s.tick

  // ── Cross-cutting halt check ───────────────────────────────────────────────
  // Three independent conditions can stop the vehicle: low fuel, engine
  // overheating, or critically low oil.  Each has its own halt flag and
  // resolution logic; the vehicle resumes only when ALL are cleared.
  const fuelRatio    = s.tankCapacityMl > 0 ? s.fuelLevelMl / s.tankCapacityMl : 1
  const shouldHalt   = s.lowFuelHalted  || s.highTempHalted || s.lowOilHalted
                    || fuelRatio < LOW_FUEL_HALT_RATIO
                    || s.engineTempC > HIGH_TEMP_THRESHOLD
                    || s.oilLevelPct  < LOW_OIL_THRESHOLD

  if (shouldHalt) {
    // Latch each halt flag on first crossing of its threshold
    if (!s.lowFuelHalted  && fuelRatio < LOW_FUEL_HALT_RATIO)         s.lowFuelHalted  = true
    if (!s.highTempHalted && s.engineTempC > HIGH_TEMP_THRESHOLD)     s.highTempHalted = true
    if (!s.lowOilHalted   && s.oilLevelPct  < LOW_OIL_THRESHOLD)     s.lowOilHalted   = true

    s.haltedFuelTicks += s.lowFuelHalted  ? 1 : 0
    s.haltedOilTicks  += s.lowOilHalted   ? 1 : 0

    s.speedKmh        = 0
    s.engineOn        = false
    s.prevFuelLevelMl = s.fuelLevelMl           // zero delta — suppresses false theft flag

    // Engine cools toward ambient while stopped (~3 °C / tick)
    s.engineTempC     = Math.max(30, s.engineTempC - 3)
    s.batteryV        = clamp(s.batteryV - 0.004, 10.5, 13.0)

    // Resolve low-fuel via the self-healing timer. A laden vehicle is helped
    // faster (15 min) than an empty one (60 min). The recovery is recorded as a
    // FuelFilling event for the poller to persist.
    const loaded    = (s.cargoWeightKg ?? 0) > 0
    const healTicks = loaded ? HEAL_TICKS_LOADED : HEAL_TICKS_EMPTY
    if (s.lowFuelHalted && s.haltedFuelTicks >= healTicks) {
      const startFuel   = s.fuelLevelMl
      s.fuelLevelMl     = Math.round(s.tankCapacityMl * jitter(0.92, 0.05))
      s.prevFuelLevelMl = s.fuelLevelMl
      s.lowFuelHalted   = false
      s.haltedFuelTicks = 0
      s.eventRefuel = {
        atMs:        simNow(),
        filledMl:    s.fuelLevelMl - startFuel,
        startFuelMl: startFuel,
        endFuelMl:   s.fuelLevelMl,
        loc:         `${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}`,
      }
    }

    // Resolve high-temp: engine has cooled sufficiently to restart
    if (s.highTempHalted && s.engineTempC < 90) {
      s.highTempHalted = false
    }

    // Resolve low-oil: driver gets an emergency oil top-up after ~12.5 min
    if (s.lowOilHalted && s.haltedOilTicks >= OIL_SERVICE_AFTER_TICKS) {
      s.oilLevelPct    = jitter(88, 5)
      s.lowOilHalted   = false
      s.haltedOilTicks = 0
    }

    return   // skip scenario movement for this tick
  }

  const tractor  = s.vehicleType === 'TRACTOR'
  const delivery  = s.vehicleType === 'TRUCK' || s.vehicleType === 'LORRY'

  if (tractor || delivery) {
    // Sugar-logistics vehicles follow the realistic daily/weekly cycle
    // (trips-per-day quota, farm/depot dwell, maintenance, Sunday rest).
    tickLogistics(s, tractor)
  } else {
    // Non-logistics vehicles are support assets that remain parked at the mill —
    // they are not part of the sugar-haulage cycle, so they do not move or raise
    // alerts. This keeps the fleet-operations feed empty until logistics vehicles
    // are dispatched, and keeps every asset "at the organisation".
    s.speedKmh      = 0
    s.engineOn      = false
    s.cargoWeightKg = 0
    s.batteryV      = clamp(jitter(12.6, 0.1), 12.0, 13.0)
  }

  // ── Engine vitals evolution (runs every non-halted tick) ──────────────────
  if (s.engineOn && s.speedKmh > 0) {
    // Running: gravitate toward operating range; OVERSPEEDING generates more heat
    const targetTemp = 87 + (s.speedKmh / 100) * 10
    s.engineTempC    = clamp(lerp(s.engineTempC, targetTemp, 0.07) + jitter(0, 1.2), 70, 120)
  } else if (s.engineOn) {
    // Idling: steady moderate temperature
    s.engineTempC = clamp(lerp(s.engineTempC, 82, 0.06) + jitter(0, 0.5), 70, 95)
  } else {
    // Engine off: cooling toward ambient
    s.engineTempC = Math.max(28, s.engineTempC - jitter(2, 0.5))
  }

  // Oil depletes very slowly while the engine is running (~0.08 % / tick)
  if (s.engineOn) {
    s.oilLevelPct = Math.max(0, s.oilLevelPct - 0.08)
  }
}

// ─── realistic Sukari logistics cycle (TRACTOR / TRUCK / LORRY) ─────────────

/** Resolve a coordinate back to a known place name for trip records. */
function placeName(lat: number, lng: number): string {
  const pools: [number, number, string][] = [SUKARI, ...SUGARCANE_FARMS, ...SUGAR_DEPOTS]
  let best = `${lat.toFixed(4)}, ${lng.toFixed(4)}`
  let bestKm = 5   // only match within 5 km
  for (const [pLat, pLng, name] of pools) {
    const d = haversineApproxKm(lat, lng, pLat, pLng)
    if (d < bestKm) { bestKm = d; best = name }
  }
  return best
}

/** Park the vehicle at a fixed point (engine off, small GPS drift). */
function parkAt(s: VehicleSimState, lat: number, lng: number): void {
  s.speedKmh = 0
  s.engineOn = false
  s.lat = lat + jitter(0, 0.00006)
  s.lng = lng + jitter(0, 0.00006)
  s.batteryV = clamp(jitter(12.6, 0.15), 12.0, 13.0)
}

function setLeg(s: VehicleSimState, from: [number, number], to: [number, number]): void {
  s.originLat = from[0]; s.originLng = from[1]
  s.destLat   = to[0];   s.destLng   = to[1]
  s.routeProgressKm = 0
}

/** Move along the current leg. Returns progress [0,1]. Applies rare overspeed
 *  and fuel-theft overlays so the fleet still produces realistic incidents. */
function advanceLeg(s: VehicleSimState, targetKmh: number, drainPer100: number): number {
  const overspeed = Math.random() < 0.015
  s.speedKmh = overspeed
    ? clamp(jitter(115, 12), 101, 135)
    : clamp(jitter(targetKmh, targetKmh * 0.12), targetKmh * 0.6, targetKmh * 1.25)

  const distKm = s.speedKmh * simHoursThisTick()
  s.odometer        += distKm
  s.routeProgressKm += distKm
  const drain = fuelDrainMl(distKm, drainPer100)   // drainPer100 = L/100 km
  s.prevFuelLevelMl = s.fuelLevelMl
  s.fuelLevelMl = Math.max(s.fuelLevelMl - drain, 0)

  const total    = haversineApproxKm(s.originLat, s.originLng, s.destLat, s.destLng)
  const progress = Math.min(s.routeProgressKm / Math.max(total, 1), 1)
  s.lat = lerp(s.originLat, s.destLat, progress) + jitter(0, 0.0002)
  s.lng = lerp(s.originLng, s.destLng, progress) + jitter(0, 0.0002)
  s.headingDeg = bearingDeg(s.originLat, s.originLng, s.destLat, s.destLng)
  s.engineOn = true
  s.batteryV = jitter(13.8, 0.2)

  s.tripMaxSpeedKmh = Math.max(s.tripMaxSpeedKmh, s.speedKmh)
  s.tripSpeedSumKmh += s.speedKmh
  s.tripSpeedSamples++

  // Rare in-transit siphoning — a large sudden drop the adapter flags as theft.
  // Gated by a fleet-wide daily budget so there are only a few (≤3) cases/day.
  if (!s.eventFuelTheft && theftBudgetAvailable() && Math.random() < 0.0008) {
    theftsToday++
    const startFuel = s.fuelLevelMl
    const stolen    = Math.round(30_000 + Math.random() * 40_000)
    s.fuelLevelMl   = Math.max(s.fuelLevelMl - stolen, 3_000)
    s.prevFuelLevelMl = startFuel   // large negative delta → fuelInconsistency flag
    s.eventFuelTheft = {
      atMs: simNow(), stolenMl: startFuel - s.fuelLevelMl,
      startFuelMl: startFuel, endFuelMl: s.fuelLevelMl,
      speedKmh: s.speedKmh, loc: placeName(s.lat, s.lng),
    }
  }
  return progress
}

function beginTrip(s: VehicleSimState, fromName: string): void {
  s.tripBeganAtMs    = simNow()
  s.tripStartOdoKm   = s.odometer
  s.tripStartFuelMl  = s.fuelLevelMl
  s.tripStartLoc     = fromName
  s.tripMaxSpeedKmh  = 0
  s.tripSpeedSumKmh  = 0
  s.tripSpeedSamples = 0
}

function completeTrip(
  s: VehicleSimState, toName: string,
  cargoType: 'SUGARCANE' | 'PROCESSED_SUGAR', cargoKg: number,
): void {
  const endMs   = simNow()
  const samples = Math.max(s.tripSpeedSamples, 1)
  s.eventTripCompleted = {
    beganAtMs:     s.tripBeganAtMs || endMs - 60_000,
    endedAtMs:     endMs,
    fromLoc:       s.tripStartLoc || 'Sukari Industries',
    toLoc:         toName,
    distanceKm:    Math.max(0, s.odometer - s.tripStartOdoKm),
    avgSpeedKmh:   s.tripSpeedSumKmh / samples,
    maxSpeedKmh:   s.tripMaxSpeedKmh,
    consumedMl:    Math.max(0, s.tripStartFuelMl - s.fuelLevelMl),
    startFuelMl:   s.tripStartFuelMl,
    endFuelMl:     s.fuelLevelMl,
    cargoWeightKg: cargoKg,
    cargoType,
  }
  s.tripBeganAtMs = 0
}

// A tractor's home base is the parking; a truck/lorry's is the mill premises.
function homeBase(tractor: boolean): [number, number, string] { return tractor ? PARKING : SUKARI }

/** Fill the tank — every vehicle leaves the premises (and every depot) full. */
function refuelFull(s: VehicleSimState): void {
  s.fuelLevelMl     = s.tankCapacityMl
  s.prevFuelLevelMl = s.tankCapacityMl   // no delta → never mistaken for a fill spike/theft
}

/** Sugarcane farms within the tractor dispatch radius of the mill. */
function farmsInRange(): [number, number, string][] {
  return SUGARCANE_FARMS.filter(f => haversineApproxKm(SUKARI[0], SUKARI[1], f[0], f[1]) <= TRACTOR_DISPATCH_RADIUS_KM)
}

/** Draw a fresh daily (and, on a week rollover, weekly) plan for the vehicle. */
function planDay(s: VehicleSimState, tractor: boolean): void {
  const now = simDate()
  s.simDayKey = dayKey(now)

  const wk = weekKey(now)
  if (s.weekStartKey !== wk) {
    s.weekStartKey     = wk
    s.tripsThisWeek    = 0
    s.weeklyTripTarget = randInt(0, 4)   // trucks/lorries: 0–4 depot runs / week
  }

  s.tripsToday      = 0
  s.dailyTripTarget = randInt(0, 3)      // tractors: 0–3 farm hauls / day

  // Don't yank a vehicle that's mid-haul when the calendar day rolls over.
  const midHaul = ['TO_FARM', 'TO_INDUSTRY', 'TO_DEPOT', 'TO_PARKING', 'LOADING', 'OFFLOADING', 'DWELL'].includes(s.phase)
  if (midHaul) return

  if (isSunday(now))                     { s.phase = 'SUNDAY'; return }
  if (s.odometer >= s.nextServiceOdoKm)  {
    s.phase = 'MAINTENANCE'
    s.phaseEndsAtMs = now.getTime() + MAINTENANCE_MIN() * MIN_MS
    return
  }
  s.phase = tractor ? 'AT_PARKING' : 'AT_INDUSTRY'
}

/**
 * From the home base, decide whether to dispatch a new haul or rest for the day.
 * The vehicle always leaves the premises on a FULL tank and is never loaded
 * above (legal max − 10 t). Tractors depart from their current position (parking
 * on the first run, the mill between runs); trucks/lorries always from the mill.
 */
function dispatch(s: VehicleSimState, tractor: boolean, now: Date): void {
  const idle = tractor ? 'AT_PARKING' as const : 'AT_INDUSTRY' as const

  if (isSunday(now))                    { s.phase = 'SUNDAY'; return }
  if (s.odometer >= s.nextServiceOdoKm) {
    s.phase = 'MAINTENANCE'
    s.phaseEndsAtMs = now.getTime() + MAINTENANCE_MIN() * MIN_MS
    return
  }
  // Stop dispatching in the late evening — crews go home; vehicle stays put.
  if (hourOfDay(now) >= 18) { s.phase = idle; return }

  if (tractor) {
    if (s.tripsToday >= s.dailyTripTarget) { s.phase = idle; return }
    const farms = farmsInRange()
    const farm  = farms[randInt(0, farms.length - 1)]!
    refuelFull(s)                                  // leave the premises full
    setLeg(s, [s.lat, s.lng], [farm[0], farm[1]])  // depart from current position
    s.cargoWeightKg = 0                            // empty run out to the farm
    beginTrip(s, placeName(s.lat, s.lng))
    s.phase = 'TO_FARM'
  } else {
    if (s.tripsThisWeek >= s.weeklyTripTarget) { s.phase = idle; return }
    const depot = SUGAR_DEPOTS[randInt(0, SUGAR_DEPOTS.length - 1)]!
    refuelFull(s)                                  // leave the premises full
    setLeg(s, [SUKARI[0], SUKARI[1]], [depot[0], depot[1]])
    s.cargoWeightKg = plannedLoadKg(s.vehicleType) // processed sugar, ≤ max − 10 t
    beginTrip(s, SUKARI[2])
    s.phase = 'TO_DEPOT'
  }
}

export function tickLogistics(s: VehicleSimState, tractor: boolean): void {
  const now   = simDate()
  const nowMs = simNow()
  const lorry = s.vehicleType === 'LORRY'
  const roadKmh = tractor ? 60 * 0.55 : 62 * (lorry ? 0.85 : 1)
  const home  = homeBase(tractor)

  if (s.simDayKey !== dayKey(now)) planDay(s, tractor)

  switch (s.phase) {
    case 'SUNDAY':
    case 'DONE':
      parkAt(s, home[0], home[1])
      break

    case 'MAINTENANCE':
      parkAt(s, SUKARI[0], SUKARI[1])   // serviced at the mill workshop
      if (nowMs >= s.phaseEndsAtMs) {
        s.nextServiceOdoKm = s.odometer + randInt(8_000, 15_000)
        s.oilLevelPct      = jitter(92, 4)
        s.phase = tractor ? 'AT_PARKING' : 'AT_INDUSTRY'
      }
      break

    case 'AT_PARKING':
    case 'AT_INDUSTRY':
      parkAt(s, home[0], home[1])
      if (s.oilLevelPct < 40) s.oilLevelPct = jitter(92, 4)   // routine service
      dispatch(s, tractor, now)
      break

    case 'TO_FARM': {
      const p = advanceLeg(s, roadKmh, 22)   // empty tractor ~22 L/100 km
      if (p >= 0.98) { s.phase = 'LOADING'; s.phaseEndsAtMs = nowMs + LOAD_MIN_TRACTOR() * MIN_MS }
      break
    }

    case 'LOADING':
      parkAt(s, s.destLat, s.destLng)   // parked (off-road) at the farm
      if (nowMs >= s.phaseEndsAtMs) {
        s.cargoWeightKg = plannedLoadKg('TRACTOR')   // cane, ≤ max − 10 t
        setLeg(s, [s.destLat, s.destLng], [SUKARI[0], SUKARI[1]])   // to the mill
        s.phase = 'TO_INDUSTRY'
      }
      break

    case 'TO_INDUSTRY': {
      const p = advanceLeg(s, roadKmh, tractor ? 28 : 26)   // tractor loaded / truck empty
      if (p >= 0.98) {
        if (tractor) { s.phase = 'UNLOADING'; s.phaseEndsAtMs = nowMs + UNLOAD_MIN_TRACTOR() * MIN_MS }
        else          { s.phase = 'AT_INDUSTRY' }   // truck/lorry returned empty to the mill
      }
      break
    }

    case 'UNLOADING':
      parkAt(s, SUKARI[0], SUKARI[1])
      if (nowMs >= s.phaseEndsAtMs) {
        completeTrip(s, SUKARI[2], 'SUGARCANE', s.cargoWeightKg ?? 0)
        s.cargoWeightKg = 0
        s.tripsToday++
        if (s.tripsToday < s.dailyTripTarget && hourOfDay(now) < 18 && !isSunday(now)) {
          dispatch(s, true, now)          // straight out to the next farm (leaves full)
        } else {
          setLeg(s, [SUKARI[0], SUKARI[1]], [PARKING[0], PARKING[1]])   // back to parking for the day
          s.phase = 'TO_PARKING'
        }
      }
      break

    case 'TO_PARKING': {
      const p = advanceLeg(s, roadKmh, 20)   // short empty deadhead to parking
      if (p >= 0.98) s.phase = 'AT_PARKING'
      break
    }

    case 'TO_DEPOT': {
      const p = advanceLeg(s, roadKmh, 34)   // fully-loaded delivery ~34 L/100 km
      if (p >= 0.98) {
        s.phase = 'OFFLOADING'
        s.phaseEndsAtMs = nowMs + OFFLOAD_MIN_DELIVERY(s.cargoWeightKg ?? 0) * MIN_MS
      }
      break
    }

    case 'OFFLOADING':
      parkAt(s, s.destLat, s.destLng)   // parked (off-road) at the depot
      if (nowMs >= s.phaseEndsAtMs) {
        completeTrip(s, placeName(s.destLat, s.destLng), 'PROCESSED_SUGAR', s.cargoWeightKg ?? 0)
        s.cargoWeightKg = 0
        s.tripsThisWeek++
        refuelFull(s)   // trucks refuel at the depot so they get back to the mill
        // Overnight at a far/late depot, otherwise deadhead back to the mill.
        const depotFarKm = haversineApproxKm(SUKARI[0], SUKARI[1], s.destLat, s.destLng)
        if (hourOfDay(now) >= 16 || depotFarKm > 180) {
          s.phase = 'DWELL'
        } else {
          setLeg(s, [s.destLat, s.destLng], [SUKARI[0], SUKARI[1]])
          s.phase = 'TO_INDUSTRY'
        }
      }
      break

    case 'DWELL':
      parkAt(s, s.destLat, s.destLng)
      // Head back to the mill the next morning.
      if (hourOfDay(now) >= 6 && hourOfDay(now) < 16) {
        setLeg(s, [s.destLat, s.destLng], [SUKARI[0], SUKARI[1]])
        s.phase = 'TO_INDUSTRY'
      }
      break

    default:
      s.phase = tractor ? 'AT_PARKING' : 'AT_INDUSTRY'
  }
}

// ─── render state → Controltech wire packet ────────────────────────────────

export function renderSnapshot(s: VehicleSimState): CtDeviceSnapshot {
  const fuelDelta     = s.fuelLevelMl - s.prevFuelLevelMl          // negative = used
  const isOutsideFence = haversineApproxKm(s.lat, s.lng, s.fenceLat, s.fenceLng) * 1000 > s.fenceRadiusM

  return {
    imei:            s.imei,
    device_id:       s.deviceId,
    timestamp_utc:   new Date().toISOString(),
    lat:             +s.lat.toFixed(6),
    lng:             +s.lng.toFixed(6),
    altitude_m:      +(1200 + Math.random() * 900).toFixed(1),
    heading_deg:     s.headingDeg,
    gps_accuracy_m:  +(2 + Math.random() * 6).toFixed(1),
    gps_fix:         s.engineOn ? 1 : 0,
    sat_count:       s.engineOn ? Math.round(7 + Math.random() * 5) : 0,
    speed_kmh:       +s.speedKmh.toFixed(1),
    ignition:        s.engineOn ? 1 : 0,
    engine_on:       s.engineOn ? 1 : 0,
    door_state:      s.doorOpen ? 1 : 0,
    panic:           s.panicPressed ? 1 : 0,
    fuel_level_ml:   s.fuelLevelMl,
    fuel_used_ml:    fuelDelta,                  // already negative when fuel was consumed
    cargo_weight_kg: s.cargoWeightKg,
    battery_v:       +s.batteryV.toFixed(2),
    engine_temp_c:   +s.engineTempC.toFixed(1),
    oil_level_pct:   +s.oilLevelPct.toFixed(1),
    network:         '4G',
    signal_pct:      Math.round(60 + Math.random() * 40),
    odometer_km:     +s.odometer.toFixed(1),
    io_inputs: {
      din1: s.doorOpen ? 1 : 0,
      din2: s.panicPressed ? 1 : 0,
      din3: s.speedKmh > 0 ? 1 : 0,
      din4: 0,
    },
    io_outputs: {
      dout1: 0,
      dout2: 0,
    },
    // Attach scenario/phase + flags + one-shot lifecycle events as a vendor
    // extension field. The poller reads `_sim.events` to persist completed trips
    // and fuel incidents, then the adapter clears them so each fires once.
    ...({ _sim: {
      scenario:     s.scenario,
      phase:        s.phase,
      tick:         s.tick,
      outsideFence: isOutsideFence,
      // Current journey leg so the client can draw the on-road route and mark
      // complete back-and-forth trips. `moving` is false when parked at an
      // endpoint (farm / depot / parking / mill) — where travel is off-road.
      leg: (() => {
        const totalKm   = haversineApproxKm(s.originLat, s.originLng, s.destLat, s.destLng)
        const coveredKm = Math.min(s.routeProgressKm, totalKm)
        return {
          fromLat: +s.originLat.toFixed(6), fromLng: +s.originLng.toFixed(6), from: placeName(s.originLat, s.originLng),
          toLat:   +s.destLat.toFixed(6),   toLng:   +s.destLng.toFixed(6),   to:   placeName(s.destLat, s.destLng),
          progress:  +Math.min(coveredKm / Math.max(totalKm, 1), 1).toFixed(3),
          coveredKm: +coveredKm.toFixed(1),
          totalKm:   +totalKm.toFixed(1),
          moving:    s.speedKmh > 0 && s.engineOn,
        }
      })(),
      events: {
        tripCompleted: s.eventTripCompleted ?? null,
        fuelTheft:     s.eventFuelTheft ?? null,
        refuel:        s.eventRefuel ?? null,
      },
    } } as Record<string, unknown>),
  } as CtDeviceSnapshot & { _sim: unknown }
}

// ─── geometry helpers (no dep — keeps simulator self-contained) ────────────

function haversineApproxKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R  = 6371
  const dL = ((lat2 - lat1) * Math.PI) / 180
  const dG = ((lng2 - lng1) * Math.PI) / 180
  const a  = Math.sin(dL / 2) ** 2
           + Math.cos((lat1 * Math.PI) / 180)
           * Math.cos((lat2 * Math.PI) / 180)
           * Math.sin(dG / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toR = (d: number) => (d * Math.PI) / 180
  const y   = Math.sin(toR(lng2 - lng1)) * Math.cos(toR(lat2))
  const x   = Math.cos(toR(lat1)) * Math.sin(toR(lat2))
            - Math.sin(toR(lat1)) * Math.cos(toR(lat2)) * Math.cos(toR(lng2 - lng1))
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}
