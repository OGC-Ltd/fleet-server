/**
 * Controltech EA — vehicle state simulator.
 *
 * Each vehicle is assigned one of ten realistic fleet scenarios.  The state
 * machine evolves on every tick (30 s) to produce convincing multi-cycle
 * timelines (speed ramps, fuel drain, position interpolation, etc.).
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

// Kenyan route anchors — [lat, lng, name]
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

// Depot anchors (vehicles "at depot" sit here)
const DEPOTS: [number, number][] = [
  [-1.3100,  36.8050],   // Nairobi depot
  [-4.0500,  39.6500],   // Mombasa depot
  [-0.1000,  34.7500],   // Kisumu depot
  [-0.3200,  36.0600],   // Nakuru depot
  [ 0.5000,  35.2500],   // Eldoret depot
]

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

  // geofence test — fence centre & radius assigned to this vehicle
  fenceLat:         number
  fenceLng:         number
  fenceRadiusM:     number
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
): VehicleSimState {
  const scenario = SCENARIO_ROTATION[index % SCENARIO_ROTATION.length]!
  const origin   = ANCHORS[index % ANCHORS.length]!
  const dest     = ANCHORS[(index + 7) % ANCHORS.length]!
  const depot    = DEPOTS[index % DEPOTS.length]!

  const tankMl  = tankCapacityLitres * 1000
  const fuelPct = scenario === 'LOW_FUEL' ? 0.07 : scenario === 'AT_DEPOT' ? 0.95 : 0.55

  // Starting position
  let lat = origin[0], lng = origin[1]
  if (scenario === 'AT_DEPOT' || scenario === 'ENGINE_OFF_IN_FIELD') {
    lat = depot[0]; lng = depot[1]
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

  const speedMap: Record<ScenarioId, number> = {
    IN_TRANSIT:              65,
    APPROACHING_DESTINATION: 30,
    AT_DEPOT:                0,
    IDLING:                  0,
    OUTSIDE_GEOFENCE:        50,
    OVERSPEEDING:            115,
    DOOR_OPEN_IN_MOTION:     55,
    FUEL_INCONSISTENCY:      60,
    ENGINE_OFF_IN_FIELD:     0,
    LOW_FUEL:                45,
  }

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
    cargoWeightKg:   index % 3 === 0 ? Math.round(3000 + Math.random() * 8000) : null,
    batteryV:        scenario === 'AT_DEPOT' ? jitter(12.6, 0.2) : jitter(13.8, 0.3),
    doorOpen:        scenario === 'DOOR_OPEN_IN_MOTION',
    panicPressed:    false,
    odometer:        Math.round(20_000 + index * 1500),
    fenceLat:        origin[0],
    fenceLng:        origin[1],
    fenceRadiusM:    1500,
  }
}

// ─── state evolution (called every tick) ──────────────────────────────────

export function tickVehicle(s: VehicleSimState): void {
  s.tick++
  const T = s.tick

  // 30 s of simulated time per tick; ~0.0083 h/tick
  const TIME_H = 30 / 3600

  switch (s.scenario) {

    case 'IN_TRANSIT': {
      // Speed varies ±10 km/h around 65; fuel drains at ~25 L/100 km
      s.speedKmh = clamp(jitter(65, 8), 40, 85)
      const distKm = s.speedKmh * TIME_H
      s.odometer  += distKm
      const drain  = Math.round((s.tankCapacityMl / 100) * 0.025 * distKm * 1000)
      s.prevFuelLevelMl = s.fuelLevelMl
      s.fuelLevelMl = Math.max(s.fuelLevelMl - drain, 0)
      // Move toward destination
      const totalDist = haversineApproxKm(s.originLat, s.originLng, s.destLat, s.destLng)
      const progress  = Math.min(T * distKm / Math.max(totalDist, 1), 1)
      s.lat = lerp(s.originLat, s.destLat, progress) + jitter(0, 0.0002)
      s.lng = lerp(s.originLng, s.destLng, progress) + jitter(0, 0.0002)
      s.headingDeg = bearingDeg(s.originLat, s.originLng, s.destLat, s.destLng)
      // Restart route when near destination
      if (progress >= 0.98) {
        [s.originLat, s.originLng] = [s.destLat, s.destLng]
        s.destLat = ANCHORS[(s.tick + 3) % ANCHORS.length]![0]
        s.destLng = ANCHORS[(s.tick + 3) % ANCHORS.length]![1]
        s.tick = 0
      }
      s.engineOn  = true
      s.batteryV  = jitter(13.8, 0.2)
      break
    }

    case 'APPROACHING_DESTINATION': {
      // Decelerating — speed ramps down from 30 → 5 over ~10 ticks
      s.targetSpeedKmh = Math.max(5, 30 - T * 2.5)
      s.speedKmh = clamp(lerp(s.speedKmh, s.targetSpeedKmh, 0.3), 3, 35)
      const distKm = s.speedKmh * TIME_H
      s.odometer  += distKm
      const drain  = Math.round((s.tankCapacityMl / 100) * 0.022 * distKm * 1000)
      s.prevFuelLevelMl = s.fuelLevelMl
      s.fuelLevelMl = Math.max(s.fuelLevelMl - drain, 0)
      // Close in on destination (already 90 % there)
      const closeT = clamp(0.90 + T * 0.01, 0.90, 1.0)
      s.lat = lerp(s.originLat, s.destLat, closeT) + jitter(0, 0.0001)
      s.lng = lerp(s.originLng, s.destLng, closeT) + jitter(0, 0.0001)
      s.engineOn = true
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
      s.speedKmh = clamp(jitter(50, 10), 30, 70)
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
      // Speed spikes 110–130 km/h; every 8th tick it briefly slows
      s.speedKmh   = T % 8 === 0 ? jitter(85, 5) : clamp(jitter(120, 10), 105, 135)
      const distKm = s.speedKmh * TIME_H
      s.odometer  += distKm
      const drain  = Math.round((s.tankCapacityMl / 100) * 0.030 * distKm * 1000)
      s.prevFuelLevelMl = s.fuelLevelMl
      s.fuelLevelMl = Math.max(s.fuelLevelMl - drain, 0)
      const progress = Math.min(T * 0.05, 1)
      s.lat = lerp(s.originLat, s.destLat, progress) + jitter(0, 0.0002)
      s.lng = lerp(s.originLng, s.destLng, progress) + jitter(0, 0.0002)
      s.headingDeg = bearingDeg(s.originLat, s.originLng, s.destLat, s.destLng)
      s.engineOn = true
      break
    }

    case 'DOOR_OPEN_IN_MOTION': {
      // Moving with door open; occasionally door closes momentarily
      s.speedKmh = clamp(jitter(55, 8), 35, 70)
      s.doorOpen = T % 6 !== 5   // door closes briefly every 6th tick
      const distKm = s.speedKmh * TIME_H
      s.odometer  += distKm
      const drain  = Math.round((s.tankCapacityMl / 100) * 0.025 * distKm * 1000)
      s.prevFuelLevelMl = s.fuelLevelMl
      s.fuelLevelMl = Math.max(s.fuelLevelMl - drain, 0)
      const progress = Math.min(T * 0.04, 1)
      s.lat = lerp(s.originLat, s.destLat, progress) + jitter(0, 0.0002)
      s.lng = lerp(s.originLng, s.destLng, progress) + jitter(0, 0.0002)
      s.engineOn = true
      break
    }

    case 'FUEL_INCONSISTENCY': {
      // Normal driving; every 4th tick a sudden large fuel drop (theft/siphon simulation)
      s.speedKmh = clamp(jitter(60, 5), 40, 75)
      const distKm = s.speedKmh * TIME_H
      s.odometer  += distKm
      s.prevFuelLevelMl = s.fuelLevelMl
      if (T % 4 === 0) {
        // Sudden drop: 40–80 L stolen
        const stolen = Math.round((40_000 + Math.random() * 40_000))
        s.fuelLevelMl = Math.max(s.fuelLevelMl - stolen, 5_000)
      } else {
        const drain = Math.round((s.tankCapacityMl / 100) * 0.025 * distKm * 1000)
        s.fuelLevelMl = Math.max(s.fuelLevelMl - drain, 0)
      }
      const progress = Math.min(T * 0.04, 1)
      s.lat = lerp(s.originLat, s.destLat, progress) + jitter(0, 0.0002)
      s.lng = lerp(s.originLng, s.destLng, progress) + jitter(0, 0.0002)
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
      s.speedKmh = clamp(jitter(45, 8), 20, 60)
      const distKm = s.speedKmh * TIME_H
      s.odometer  += distKm
      const drain  = Math.round((s.tankCapacityMl / 100) * 0.025 * distKm * 1000)
      s.prevFuelLevelMl = s.fuelLevelMl
      s.fuelLevelMl = Math.max(s.fuelLevelMl - drain, 500)
      const progress = Math.min(T * 0.035, 1)
      s.lat = lerp(s.originLat, s.destLat, progress) + jitter(0, 0.0002)
      s.lng = lerp(s.originLng, s.destLng, progress) + jitter(0, 0.0002)
      s.engineOn = true
      break
    }
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
