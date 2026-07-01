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

// Sukari Industries processing plant — master hub for tractors, trucks & lorries
const SUKARI: [number, number, string] = [0.3358, 34.4928, 'Sukari Industries']

// Sugarcane farms tractors harvest from (≈10–35 km radius around Sukari)
const SUGARCANE_FARMS: [number, number, string][] = [
  [ 0.4100, 34.4200, 'Lugari Farm'],
  [ 0.2900, 34.5600, 'Mumias Farm'],
  [ 0.3900, 34.5400, 'Butere Farm'],
  [ 0.2200, 34.4500, 'Navakholo Farm'],
  [ 0.3700, 34.3700, 'Butula Farm'],
  [ 0.4400, 34.4600, 'Likuyani Farm'],
  [ 0.2600, 34.4000, 'Matungu Farm'],
  [ 0.3100, 34.6000, 'Khwisero Farm'],
]

// Sugar distribution depots trucks/lorries deliver finished product to
const SUGAR_DEPOTS: [number, number, string][] = [
  [-0.0917, 34.7679, 'Kisumu Depot'],
  [-0.3031, 36.0800, 'Nakuru Depot'],
  [-1.2921, 36.8219, 'Nairobi Depot'],
  [ 0.5143, 35.2698, 'Eldoret Depot'],
  [-4.0435, 39.6682, 'Mombasa Depot'],
  [-1.5177, 37.2634, 'Machakos Depot'],
  [ 0.2827, 34.7519, 'Kakamega Depot'],
  [-0.4167, 36.9511, 'Nyeri Depot'],
  [-1.0332, 37.0693, 'Thika Depot'],
  [-0.7167, 36.4313, 'Naivasha Depot'],
  [ 1.0154, 35.0062, 'Kitale Depot'],
  [-3.2175, 40.1169, 'Malindi Depot'],
]

function isTractorType(t: string): boolean { return t === 'TRACTOR' }
function isDeliveryType(t: string): boolean { return t === 'TRUCK' || t === 'LORRY' }

function lerp(a: number, b: number, t: number) { return a + (b - a) * t }
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)) }
function jitter(base: number, delta: number) { return base + (Math.random() * 2 - 1) * delta }

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
  const scenario = SCENARIO_ROTATION[index % SCENARIO_ROTATION.length]!

  const tractor  = isTractorType(vehicleType)
  const delivery = isDeliveryType(vehicleType)

  let origin: [number, number, string]
  let dest:   [number, number, string]

  if (tractor) {
    // Tractors start at Sukari, heading out empty to a nearby farm
    origin = SUKARI
    dest   = SUGARCANE_FARMS[index % SUGARCANE_FARMS.length]!
  } else if (delivery) {
    // Trucks/lorries start at Sukari, heading out loaded to a depot
    origin = SUKARI
    dest   = SUGAR_DEPOTS[index % SUGAR_DEPOTS.length]!
  } else {
    // Tankers and everything else keep the original free-roaming routing
    origin = ANCHORS[index % ANCHORS.length]!
    dest   = ANCHORS[(index + 7) % ANCHORS.length]!
  }
  const legDirection: 'outbound' | 'inbound' = 'outbound'

  const depot = DEPOTS[index % DEPOTS.length]!

  const tankMl  = tankCapacityLitres * 1000
  const fuelPct = scenario === 'LOW_FUEL' ? 0.07 : scenario === 'AT_DEPOT' ? 0.95 : 0.55

  // Starting position
  let lat = origin[0], lng = origin[1]
  if (scenario === 'AT_DEPOT' || scenario === 'ENGINE_OFF_IN_FIELD') {
    if (tractor || delivery) { lat = SUKARI[0]; lng = SUKARI[1] }
    else                     { lat = depot[0];  lng = depot[1]  }
  }
  if (scenario === 'APPROACHING_DESTINATION') {
    // ~90 % of the way to destination
    lat = lerp(origin[0], dest[0], 0.90)
    lng = lerp(origin[1], dest[1], 0.90)
  }
  if (scenario === 'IN_TRANSIT') {
    const t = 0.1 + (index % 8) * 0.1   // spread vehicles along route
    lat = lerp(origin[0], dest[0], t)
    lng = lerp(origin[1], dest[1], t)
  }
  if (scenario === 'OUTSIDE_GEOFENCE') {
    // place vehicle 3 km outside origin (fence centre)
    lat = origin[0] + 0.03
    lng = origin[1] + 0.03
  }
  if (scenario === 'IDLING' && (tractor || delivery)) {
    lat = SUKARI[0]; lng = SUKARI[1]
  }

  // Speed profile — tractors run unsealed farm roads (much slower), lorries a
  // touch slower than trucks on the highway; everything else unchanged.
  const speedScale = tractor ? 0.55 : vehicleType === 'LORRY' ? 0.85 : 1

  const speedMap: Record<ScenarioId, number> = {
    IN_TRANSIT:              65  * speedScale,
    APPROACHING_DESTINATION: 30  * speedScale,
    AT_DEPOT:                0,
    IDLING:                  0,
    OUTSIDE_GEOFENCE:        50  * speedScale,
    OVERSPEEDING:            115 * speedScale,
    DOOR_OPEN_IN_MOTION:     55  * speedScale,
    FUEL_INCONSISTENCY:      60  * speedScale,
    ENGINE_OFF_IN_FIELD:     0,
    LOW_FUEL:                45  * speedScale,
  }

  // Cargo: tractors start empty (heading out to a farm); trucks/lorries start
  // loaded (heading out to a depot); everything else keeps the old randomised
  // cargo so non-sugar vehicles still occasionally show a payload.
  const cargoWeightKg: number | null =
    tractor    ? 0
    : delivery ? Math.round(10_000 + Math.random() * 8_000)
    : index % 3 === 0 ? Math.round(3000 + Math.random() * 8000) : null

  // Seed routeProgressKm to match the starting position so the vehicle doesn't
  // teleport on the first tick.
  const legKm = haversineApproxKm(origin[0], origin[1], dest[0], dest[1])
  const startFraction =
    scenario === 'APPROACHING_DESTINATION' ? 0.90
    : scenario === 'IN_TRANSIT'            ? 0.1 + (index % 8) * 0.1
    : 0

  return {
    deviceId,
    imei:            `35${String(index).padStart(13, '0')}`,
    scenario,
    tick:            0,
    lat, lng,
    originLat:       origin[0],
    originLng:       origin[1],
    destLat:         dest[0],
    destLng:         dest[1],
    headingDeg:      Math.round(Math.random() * 360),
    speedKmh:        speedMap[scenario],
    targetSpeedKmh:  speedMap[scenario],
    engineOn:        scenario !== 'AT_DEPOT' && scenario !== 'ENGINE_OFF_IN_FIELD',
    tankCapacityMl:  tankMl,
    fuelLevelMl:     Math.round(tankMl * fuelPct),
    prevFuelLevelMl: Math.round(tankMl * fuelPct),
    cargoWeightKg,
    batteryV:        scenario === 'AT_DEPOT' ? jitter(12.6, 0.2) : jitter(13.8, 0.3),
    doorOpen:        scenario === 'DOOR_OPEN_IN_MOTION',
    panicPressed:    false,
    odometer:        Math.round(20_000 + index * 1500),
    routeProgressKm: legKm * startFraction,
    vehicleType,
    legDirection,
    fenceLat:        origin[0],
    fenceLng:        origin[1],
    fenceRadiusM:    1500,

    // Engine vitals — some vehicles start in a critical state to seed demos.
    // Vehicles at index % 9 === 8 start overheating; index % 11 === 10 start
    // with near-empty oil.  All others start in a healthy operating range.
    engineTempC:     scenario === 'OVERSPEEDING' ? jitter(102, 4)
                   : index % 9 === 8            ? jitter(108, 3)
                   : jitter(86, 5),
    oilLevelPct:     index % 11 === 10 ? jitter(7, 2)
                   : scenario === 'ENGINE_OFF_IN_FIELD' ? jitter(18, 4)
                   : jitter(82, 12),

    lowFuelHalted:   false,
    highTempHalted:  false,
    lowOilHalted:    false,
    haltedFuelTicks: 0,
    haltedOilTicks:  0,
  }
}

// ─── halt thresholds ──────────────────────────────────────────────────────
const LOW_FUEL_HALT_RATIO   = 0.20   // < 20 % tank → halt
const HIGH_TEMP_THRESHOLD   = 105    // °C → halt and cool
const LOW_OIL_THRESHOLD     = 10     // % oil level → halt and service
const REFUEL_AFTER_TICKS    = 20     // ticks halted before auto-refuel (~10 min)
const OIL_SERVICE_AFTER_TICKS = 25   // ticks halted before auto-service (~12.5 min)

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

    // Resolve low-fuel: driver reaches a fuel stop after ~10 min
    if (s.lowFuelHalted && s.haltedFuelTicks >= REFUEL_AFTER_TICKS) {
      s.fuelLevelMl     = Math.round(s.tankCapacityMl * jitter(0.92, 0.05))
      s.prevFuelLevelMl = s.fuelLevelMl
      s.lowFuelHalted   = false
      s.haltedFuelTicks = 0
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

  // 30 s of simulated time per tick; ~0.0083 h/tick
  const TIME_H = 30 / 3600

  const tractor    = s.vehicleType === 'TRACTOR'
  const delivery   = s.vehicleType === 'TRUCK' || s.vehicleType === 'LORRY'
  const speedScale = tractor ? 0.55 : s.vehicleType === 'LORRY' ? 0.85 : 1

  // Advance to the next leg of the journey, picking up/dropping cargo as
  // appropriate, and reset progress counters.
  //
  // Tractors and delivery vehicles shuttle back and forth through Sukari
  // Industries (outbound → farm/depot → inbound → Sukari → outbound → …);
  // everything else keeps the original free-roaming anchor-to-anchor routing.
  function restartLeg(approachFraction = 0): void {
    if (tractor || delivery) {
      if (s.legDirection === 'outbound') {
        // Arrived at the farm/depot — head back to Sukari Industries
        ;[s.originLat, s.originLng] = [s.destLat, s.destLng]
        s.destLat = SUKARI[0]; s.destLng = SUKARI[1]
        s.legDirection = 'inbound'
        s.cargoWeightKg = tractor
          ? Math.round(8_000 + Math.random() * 4_000)   // loaded with harvested sugarcane
          : 0                                            // truck/lorry emptied out at the depot
      } else {
        // Arrived at Sukari Industries — head out again
        s.originLat = SUKARI[0]; s.originLng = SUKARI[1]
        const pool = tractor ? SUGARCANE_FARMS : SUGAR_DEPOTS
        const pick = pool[(s.tick + 3) % pool.length]!
        s.destLat = pick[0]; s.destLng = pick[1]
        s.legDirection = 'outbound'
        s.cargoWeightKg = tractor
          ? 0                                              // empty run out to the next farm
          : Math.round(10_000 + Math.random() * 8_000)     // freshly loaded with processed sugar
      }
    } else {
      ;[s.originLat, s.originLng] = [s.destLat, s.destLng]
      s.destLat = ANCHORS[(s.tick + 3) % ANCHORS.length]![0]
      s.destLng = ANCHORS[(s.tick + 3) % ANCHORS.length]![1]
    }
    s.tick = 0
    const newLegKm = haversineApproxKm(s.originLat, s.originLng, s.destLat, s.destLng)
    s.routeProgressKm = newLegKm * approachFraction
  }

  switch (s.scenario) {

    case 'IN_TRANSIT': {
      // Speed varies ±10 km/h around 65 (scaled by vehicle type); fuel drains at ~25 L/100 km
      s.speedKmh = clamp(jitter(65, 8), 40, 85) * speedScale
      const distKm = s.speedKmh * TIME_H
      s.odometer       += distKm
      s.routeProgressKm += distKm
      const drain  = Math.round((s.tankCapacityMl / 100) * 0.025 * distKm * 1000)
      s.prevFuelLevelMl = s.fuelLevelMl
      s.fuelLevelMl = Math.max(s.fuelLevelMl - drain, 0)
      // Move toward destination using cumulative km so journey time matches real distance
      const totalDist = haversineApproxKm(s.originLat, s.originLng, s.destLat, s.destLng)
      const progress  = Math.min(s.routeProgressKm / Math.max(totalDist, 1), 1)
      s.lat = lerp(s.originLat, s.destLat, progress) + jitter(0, 0.0002)
      s.lng = lerp(s.originLng, s.destLng, progress) + jitter(0, 0.0002)
      s.headingDeg = bearingDeg(s.originLat, s.originLng, s.destLat, s.destLng)
      if (progress >= 0.98) restartLeg()
      s.engineOn  = true
      s.batteryV  = jitter(13.8, 0.2)
      break
    }

    case 'APPROACHING_DESTINATION': {
      // Decelerating — speed ramps down from 30 → 15 over ~8 ticks then holds (scaled by type)
      s.targetSpeedKmh = Math.max(15, 30 - T * 2) * speedScale
      s.speedKmh = clamp(lerp(s.speedKmh, s.targetSpeedKmh, 0.3), 10 * speedScale, 35 * speedScale)
      const distKm = s.speedKmh * TIME_H
      s.odometer       += distKm
      s.routeProgressKm += distKm
      const drain  = Math.round((s.tankCapacityMl / 100) * 0.022 * distKm * 1000)
      s.prevFuelLevelMl = s.fuelLevelMl
      s.fuelLevelMl = Math.max(s.fuelLevelMl - drain, 0)
      // Close in on destination from 90 % onward using distance-based progress
      const td = haversineApproxKm(s.originLat, s.originLng, s.destLat, s.destLng)
      const progress = Math.min(s.routeProgressKm / Math.max(td, 1), 1)
      s.lat = lerp(s.originLat, s.destLat, progress) + jitter(0, 0.0001)
      s.lng = lerp(s.originLng, s.destLng, progress) + jitter(0, 0.0001)
      s.engineOn = true
      // On arrival, restart as a new leg (vehicle is still in this scenario)
      if (progress >= 0.99) restartLeg(0.90)
      break
    }

    case 'AT_DEPOT': {
      s.speedKmh   = 0
      s.engineOn   = false
      s.batteryV   = clamp(jitter(12.6, 0.1), 12.0, 13.0)
      // Tiny GPS drift
      s.lat += jitter(0, 0.00005)
      s.lng += jitter(0, 0.00005)
      break
    }

    case 'IDLING': {
      s.speedKmh = 0
      s.engineOn = true
      // Slow fuel burn while idling (~2 L/h)
      const idleDrain = Math.round((2_000 / 3600) * 30)
      s.prevFuelLevelMl = s.fuelLevelMl
      s.fuelLevelMl = Math.max(s.fuelLevelMl - idleDrain, 0)
      s.batteryV = jitter(13.6, 0.2)
      break
    }

    case 'OUTSIDE_GEOFENCE': {
      // Vehicle drifts further outside the fence
      s.speedKmh = clamp(jitter(50, 10), 30, 70) * speedScale
      const distKm = s.speedKmh * TIME_H
      s.odometer  += distKm
      s.lat += 0.0005 + jitter(0, 0.0002)   // drifting north-east from fence
      s.lng += 0.0005 + jitter(0, 0.0002)
      const drain = Math.round((s.tankCapacityMl / 100) * 0.025 * distKm * 1000)
      s.prevFuelLevelMl = s.fuelLevelMl
      s.fuelLevelMl = Math.max(s.fuelLevelMl - drain, 0)
      s.engineOn = true
      break
    }

    case 'OVERSPEEDING': {
      // Speed spikes 110–130 km/h (scaled by type); every 8th tick it briefly slows
      s.speedKmh   = (T % 8 === 0 ? jitter(85, 5) : clamp(jitter(120, 10), 105, 135)) * speedScale
      const distKm = s.speedKmh * TIME_H
      s.odometer       += distKm
      s.routeProgressKm += distKm
      const drain  = Math.round((s.tankCapacityMl / 100) * 0.030 * distKm * 1000)
      s.prevFuelLevelMl = s.fuelLevelMl
      s.fuelLevelMl = Math.max(s.fuelLevelMl - drain, 0)
      const totalDist = haversineApproxKm(s.originLat, s.originLng, s.destLat, s.destLng)
      const progress = Math.min(s.routeProgressKm / Math.max(totalDist, 1), 1)
      s.lat = lerp(s.originLat, s.destLat, progress) + jitter(0, 0.0002)
      s.lng = lerp(s.originLng, s.destLng, progress) + jitter(0, 0.0002)
      s.headingDeg = bearingDeg(s.originLat, s.originLng, s.destLat, s.destLng)
      if (progress >= 0.98) restartLeg()
      s.engineOn = true
      break
    }

    case 'DOOR_OPEN_IN_MOTION': {
      // Moving with door open; occasionally door closes momentarily
      s.speedKmh = clamp(jitter(55, 8), 35, 70) * speedScale
      s.doorOpen = T % 6 !== 5   // door closes briefly every 6th tick
      const distKm = s.speedKmh * TIME_H
      s.odometer       += distKm
      s.routeProgressKm += distKm
      const drain  = Math.round((s.tankCapacityMl / 100) * 0.025 * distKm * 1000)
      s.prevFuelLevelMl = s.fuelLevelMl
      s.fuelLevelMl = Math.max(s.fuelLevelMl - drain, 0)
      const totalDist = haversineApproxKm(s.originLat, s.originLng, s.destLat, s.destLng)
      const progress = Math.min(s.routeProgressKm / Math.max(totalDist, 1), 1)
      s.lat = lerp(s.originLat, s.destLat, progress) + jitter(0, 0.0002)
      s.lng = lerp(s.originLng, s.destLng, progress) + jitter(0, 0.0002)
      if (progress >= 0.98) restartLeg()
      s.engineOn = true
      break
    }

    case 'FUEL_INCONSISTENCY': {
      // Normal driving; every 4th tick a sudden large fuel drop (theft/siphon simulation)
      s.speedKmh = clamp(jitter(60, 5), 40, 75) * speedScale
      const distKm = s.speedKmh * TIME_H
      s.odometer       += distKm
      s.routeProgressKm += distKm
      s.prevFuelLevelMl = s.fuelLevelMl
      if (T % 4 === 0) {
        // Sudden drop: 40–80 L stolen
        const stolen = Math.round((40_000 + Math.random() * 40_000))
        s.fuelLevelMl = Math.max(s.fuelLevelMl - stolen, 5_000)
      } else {
        const drain = Math.round((s.tankCapacityMl / 100) * 0.025 * distKm * 1000)
        s.fuelLevelMl = Math.max(s.fuelLevelMl - drain, 0)
      }
      const totalDist = haversineApproxKm(s.originLat, s.originLng, s.destLat, s.destLng)
      const progress = Math.min(s.routeProgressKm / Math.max(totalDist, 1), 1)
      s.lat = lerp(s.originLat, s.destLat, progress) + jitter(0, 0.0002)
      s.lng = lerp(s.originLng, s.destLng, progress) + jitter(0, 0.0002)
      if (progress >= 0.98) restartLeg()
      s.engineOn = true
      break
    }

    case 'ENGINE_OFF_IN_FIELD': {
      s.speedKmh  = 0
      s.engineOn  = false
      s.batteryV  = clamp(s.batteryV - 0.01, 10.5, 12.8)  // slow discharge
      s.lat += jitter(0, 0.00003)
      s.lng += jitter(0, 0.00003)
      break
    }

    case 'LOW_FUEL': {
      s.speedKmh = clamp(jitter(45, 8), 20, 60) * speedScale
      const distKm = s.speedKmh * TIME_H
      s.odometer       += distKm
      s.routeProgressKm += distKm
      const drain  = Math.round((s.tankCapacityMl / 100) * 0.025 * distKm * 1000)
      s.prevFuelLevelMl = s.fuelLevelMl
      s.fuelLevelMl = Math.max(s.fuelLevelMl - drain, 500)
      const totalDist = haversineApproxKm(s.originLat, s.originLng, s.destLat, s.destLng)
      const progress = Math.min(s.routeProgressKm / Math.max(totalDist, 1), 1)
      s.lat = lerp(s.originLat, s.destLat, progress) + jitter(0, 0.0002)
      s.lng = lerp(s.originLng, s.destLng, progress) + jitter(0, 0.0002)
      if (progress >= 0.98) restartLeg()
      s.engineOn = true
      break
    }
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
    // Attach scenario + flags as a vendor extension field — useful for debugging
    // and will be stored verbatim in vehicle_telemetry_raws.
    ...({ _sim: { scenario: s.scenario, tick: s.tick, outsideFence: isOutsideFence } } as Record<string, unknown>),
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
