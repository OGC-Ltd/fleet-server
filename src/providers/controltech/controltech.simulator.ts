/**
 * Controltech EA — vehicle state simulator.
 *
 * Each vehicle is assigned one of ten realistic fleet scenarios.  The state
 * machine evolves on every tick (30 s) to produce convincing multi-cycle
 * timelines (speed ramps, fuel drain, position interpolation, etc.).
 *
 * Routing is classified by organisation profile + vehicleType:
 *
 *  SUKARI (sugar logistics):
 *  - TRACTOR          : shuttles Sukari Industries ↔ a nearby sugarcane farm.
 *                        Runs out empty, returns loaded with harvested cane.
 *  - TRUCK / LORRY     : shuttles Sukari Industries ↔ a sugar distribution depot.
 *                        Runs out loaded with processed sugar, returns empty.
 *  - everything else   : keeps the original free-roaming Kenyan-city routing
 *                        (used by TANKER, BUS, AMBULANCE, etc.).
 *
 *  AQUAMIST (direct-to-customer beverage distribution — NO depots):
 *  - SALOON            : several small residential drops per day, delivering
 *                        bottled products to customers around Nairobi.
 *  - TRUCK / LORRY     : bulk orders from the Aquamist plant straight to
 *                        customers in different parts of Nairobi, Kisumu,
 *                        Nakuru, and Mombasa. Runs out loaded, returns empty.
 *  Products: still water & sparkling water in a range of bottle volumes, and
 *  juice (product 2) — see AQUAMIST_PRODUCTS.
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
  [-3.3573, 40.0206, 'Watamu Depot'],
]

// Third-party repair garages, spread across the operating region (mill +
// every depot town) so "nearest garage" is meaningful no matter where an
// overdue vehicle currently is — not just near the mill.
const GARAGES: [number, number, string][] = [
  [-0.8280, 34.3920, 'Migori Fleet Garage'],       // near Sukari Industries / the mill
  [-0.0980, 34.7610, 'Kisumu Motors & Tyres'],     // near Kisumu Depot
  [-0.3110, 36.0680, 'Nakuru Truck Clinic'],       // near Nakuru Depot
  [-1.3050, 36.8280, 'Nairobi Heavy Vehicle Garage'], // near Nairobi Depot
  [ 0.5210, 35.2610, 'Eldoret Auto Care'],         // near Eldoret Depot
  [-4.0510, 39.6600, 'Mombasa Coastal Garage'],    // near Mombasa Depot
  [-3.3600, 40.0250, 'Watamu Marine & Motors'],    // near Watamu Depot
  [-1.2110, 36.6620, 'Kikuyu Auto Garage'],        // near the Aquamist plant
]

// ─── Aquamist Limited — direct-to-customer routing profile ─────────────────
// Aquamist has NO depots: every delivery leaves the bottling plant and goes
// straight to a customer. Customers reside in different parts of Nairobi,
// Kisumu, Nakuru, and Mombasa.

export type RoutingProfile = 'SUKARI' | 'AQUAMIST'

// Aquamist bottling plant / HQ — exact coordinates (Kiambu County, NW of Nairobi).
const AQUAMIST_HQ: [number, number, string] =
  [-1.2060044099698617, 36.65702647381419, 'Aquamist Plant']

// Customer delivery points — [lat, lng, name] — spread across different parts
// of the four supply cities. Saloon cars only serve the Nairobi-area customers
// (within SALOON_RANGE_KM of the plant); trucks and lorries serve all of them.
const AQUAMIST_CUSTOMERS: [number, number, string][] = [
  // Nairobi — different parts of the city
  [-1.2683, 36.8110, 'Customer — Westlands, Nairobi'],
  [-1.3197, 36.7062, 'Customer — Karen, Nairobi'],
  [-1.2906, 36.7870, 'Customer — Kilimani, Nairobi'],
  [-1.3081, 36.8330, 'Customer — South B, Nairobi'],
  [-1.2230, 36.8991, 'Customer — Kasarani, Nairobi'],
  [-1.2076, 36.7811, 'Customer — Ruaka, Nairobi'],
  // Kisumu
  [-0.1057, 34.7448, 'Customer — Milimani, Kisumu'],
  [-0.0810, 34.7720, 'Customer — Kondele, Kisumu'],
  [-0.0570, 34.7900, 'Customer — Mamboleo, Kisumu'],
  // Nakuru
  [-0.2963, 36.0517, 'Customer — Milimani, Nakuru'],
  [-0.2789, 36.0894, 'Customer — Section 58, Nakuru'],
  [-0.3070, 36.1470, 'Customer — Lanet, Nakuru'],
  // Mombasa
  [-4.0202, 39.7076, 'Customer — Nyali, Mombasa'],
  [-3.9909, 39.7276, 'Customer — Bamburi, Mombasa'],
  [-4.0842, 39.6650, 'Customer — Likoni, Mombasa'],
]

// Saloons handle nearby residential drops only — customers within this radius
// of the plant (covers the Nairobi metro; the upcountry/coast cities are
// truck/lorry territory).
const SALOON_RANGE_KM = 60

function aquamistCustomersFor(vehicleType: string): [number, number, string][] {
  if (vehicleType !== 'SALOON') return AQUAMIST_CUSTOMERS
  return AQUAMIST_CUSTOMERS.filter(
    c => haversineApproxKm(AQUAMIST_HQ[0], AQUAMIST_HQ[1], c[0], c[1]) <= SALOON_RANGE_KM,
  )
}

// Product catalogue — still & sparkling water packaged in different bottle
// volumes, plus juice (product 2). A random product is drawn per dispatch and
// carried through to the trip's cargo manifest.
export type AquamistCargoKind = 'STILL_WATER' | 'SPARKLING_WATER' | 'JUICE'

const AQUAMIST_PRODUCTS: { kind: AquamistCargoKind; desc: string }[] = [
  { kind: 'STILL_WATER',     desc: 'Still water — 500 ml PET bottles' },
  { kind: 'STILL_WATER',     desc: 'Still water — 1 L PET bottles' },
  { kind: 'STILL_WATER',     desc: 'Still water — 5 L bottles' },
  { kind: 'STILL_WATER',     desc: 'Still water — 10 L bottles' },
  { kind: 'STILL_WATER',     desc: 'Still water — 20 L dispenser bottles' },
  { kind: 'SPARKLING_WATER', desc: 'Sparkling water — 330 ml glass bottles' },
  { kind: 'SPARKLING_WATER', desc: 'Sparkling water — 750 ml glass bottles' },
  { kind: 'SPARKLING_WATER', desc: 'Sparkling water — 1 L PET bottles' },
  { kind: 'JUICE',           desc: 'Juice — 300 ml bottles' },
  { kind: 'JUICE',           desc: 'Juice — 1 L tetra packs' },
  { kind: 'JUICE',           desc: 'Juice — 5 L catering packs' },
]

function isTractorType(t: string): boolean { return t === 'TRACTOR' }
// SALOON is a delivery type too — only Aquamist seeds saloons, and its whole
// fleet runs the direct-to-customer delivery cycle.
function isDeliveryType(t: string): boolean { return t === 'TRUCK' || t === 'LORRY' || t === 'SALOON' }

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

// Truck/lorry consumption scales with how loaded the vehicle is — real-world
// reference points a fleet fuel audit would use:
//   Empty / light load   ~30 L/100 km  (~145 L one-way over a ~480 km haul)
//   Standard loaded      ~38 L/100 km  (~184 L one-way)
//   Maximum load (40+ t) ~45 L/100 km  (~218 L one-way)
// Modelled as a straight line between the empty and max-load points and
// evaluated at the vehicle's actual cargo weight, rather than a flat rate per
// phase — so a truck only 60% loaded burns proportionally less than one at
// max, matching the table instead of jumping between two fixed numbers.
const DELIVERY_CONSUMPTION_EMPTY_L100    = 30
const DELIVERY_CONSUMPTION_MAXLOAD_L100  = 45
const DELIVERY_CONSUMPTION_MAXLOAD_REF_KG = 40_000   // the table's "40+ tons" reference point

function deliveryConsumptionL100(cargoWeightKg: number | null): number {
  const loadFraction = clamp((cargoWeightKg ?? 0) / DELIVERY_CONSUMPTION_MAXLOAD_REF_KG, 0, 1)
  return lerp(DELIVERY_CONSUMPTION_EMPTY_L100, DELIVERY_CONSUMPTION_MAXLOAD_L100, loadFraction)
}

// Overspeeding burns disproportionately more fuel than the extra distance
// alone accounts for (aerodynamic drag rises with the square of speed) — so
// an overspeed tick bumps the effective L/100 km rate, not just the ground
// covered. Fuel theft is a separate, deliberate sudden-drop event (see
// advanceLeg below) and never goes through this multiplier — overspeeding
// drives consumption, theft drives the fuel-inconsistency flag, and the two
// never overlap.
const OVERSPEED_CONSUMPTION_MULTIPLIER = 1.35

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
// Depot offload scales with load: ~30 min base + 3 min/tonne.
const OFFLOAD_MIN_DELIVERY = (cargoKg: number) => Math.round(30 + (cargoKg / 1000) * 3)

// Legal max payload per type (kg): tractors 20 t, trucks & lorries 36 t. The
// mill always leaves a 10 t safety allowance, so a vehicle is never loaded above
// (max − 10 t) — a tractor tops out at 10 t, a truck/lorry at 26 t.
export const MAX_PAYLOAD_KG: Record<string, number> = { TRACTOR: 20_000, TRUCK: 36_000, LORRY: 36_000, SALOON: 500 }
const PAYLOAD_ALLOWANCE_KG = 10_000
function plannedLoadKg(vehicleType: string): number {
  const cap = (MAX_PAYLOAD_KG[vehicleType] ?? 20_000) - PAYLOAD_ALLOWANCE_KG
  return randInt(Math.round(cap * 0.80), cap)   // ≤ (max − 10 t), never overloaded
}

/** Profile-aware load planner. Aquamist loads are crates/pallets of bottled
 *  product — a saloon boot-load for residential drops, a part-to-full pallet
 *  load for trucks/lorries — rather than the Sukari bulk-haul formula (whose
 *  10 t allowance would go negative on a 500 kg saloon). */
function plannedLoadFor(s: VehicleSimState): number {
  if (s.profile !== 'AQUAMIST') return plannedLoadKg(s.vehicleType)
  if (s.vehicleType === 'SALOON') return randInt(180, 450)      // crates in the boot & back seat
  return randInt(8_000, 24_000)                                  // palletised bulk order
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
  cargoKind:        string          // what's on board ('' when empty) — e.g. STILL_WATER, JUICE
  cargoDesc:        string          // human product description for the trip's manifest

  // sensors
  batteryV:         number
  doorOpen:         boolean
  panicPressed:     boolean
  odometer:         number

  // cumulative km driven on the current route leg; resets to 0 on each restart.
  // Position is derived from routeProgressKm / totalLegKm so journey time scales
  // correctly with real-world distance regardless of scenario speed.
  routeProgressKm:  number

  // ── current leg's real departure/ETA (drives the dashboard's Fleet grid:
  // Departure / Expected Arrival / Late-Early columns) ──────────────────────
  legBeganAtMs:        number   // sim-time epoch ms this leg started (set in setLeg)
  legPlannedArrivalMs: number   // legBeganAtMs + (distance / this vehicle type's typical cruising speed) — the
                                 // same baseline speed tickLogistics targets before jitter/overspeed/halts, so
                                 // "late" genuinely means slower-than-planned, not just a fabricated number

  // route classification — drives type-aware routing in tickVehicle()
  vehicleType:      string                    // TRACTOR, TRUCK, LORRY, SALOON, TANKER, …
  profile:          RoutingProfile             // which organisation's cycle this vehicle runs
  legDirection:     'outbound' | 'inbound'     // outbound = away from the home base

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
  // Road position captured the moment a halt begins. Held until all halt
  // conditions clear so renderSnapshot always reports the exact stop point
  // regardless of any downstream state mutation.
  haltLat:          number | null
  haltLng:          number | null

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

  // ── garage redirect (overdue-service handling) ────────────────────────────
  garageDestLat:     number      // chosen garage's coords — 0 when not en route/at a garage
  garageDestLng:     number
  garageDestName:    string
  garageEnteredAtMs: number      // epoch ms the vehicle arrived at the garage (0 = not there yet)
  // Baseline odometer the 13-item checklist cycles are measured FROM (see
  // MAINTENANCE_CATALOG below) — 0 until the vehicle's first garage visit,
  // then reset to the odometer at every visit so a serviced vehicle actually
  // reads "Good" again afterwards instead of immediately re-qualifying for
  // another redirect. Must mirror the dash's maintenanceSchedule.js exactly:
  // that's what computes the SAME per-item statuses for display, using this
  // same baseline (sent to the client as `_sim.maintenance.resetOdoKm`).
  maintenanceResetOdoKm: number

  // ── trip / incident bookkeeping (drives DB persistence in the poller) ─────
  tripBeganAtMs:    number      // epoch ms the current haul leg started (0 = not on a haul)
  tripStartOdoKm:   number      // odometer at haul start
  tripStartFuelMl:  number      // fuel level at haul start
  tripStartLoc:     string      // origin name at haul start
  tripMaxSpeedKmh:  number      // running max speed on the current haul
  tripSpeedSumKmh:  number      // running speed sum for avg
  tripSpeedSamples: number      // running speed sample count
  tripOverspeedTicks: number    // count of sim ticks this haul where the overspeed roll hit —
                                 // feeds the per-trip driver-rating penalty (see simulation.persistence.ts)
  // one-shot event flags read + cleared by the poller each cycle
  eventTripCompleted:      TripEvent | null
  eventFuelTheft:          TheftEvent | null
  eventRefuel:             RefuelEvent | null
  eventServiceCompleted:   ServiceEvent | null
  eventGarageVisitCompleted: GarageVisitEvent | null
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
  | 'TO_GARAGE'     // service overdue — driving to the nearest garage for a fix
  | 'AT_GARAGE'     // being serviced at the garage (timed, severity-scaled, capped at 2h)
  | 'FROM_GARAGE'   // serviced — driving back from the garage to resume its normal cycle

export interface TripEvent {
  beganAtMs:     number
  endedAtMs:     number
  fromLoc:       string
  toLoc:         string
  distanceKm:    number
  avgSpeedKmh:   number
  maxSpeedKmh:   number
  overspeedTicks: number
  consumedMl:    number
  startFuelMl:   number
  endFuelMl:     number
  cargoWeightKg: number
  cargoType:     SimCargoKind
  cargoDesc?:    string   // product description (Aquamist) — manifest text
}

/** Cargo kinds across both organisation profiles. */
export type SimCargoKind = 'SUGARCANE' | 'PROCESSED_SUGAR' | AquamistCargoKind

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

export interface ServiceEvent {
  completedAtMs:    number
  odometerKm:       number
  nextServiceOdoKm: number
}

export interface GarageVisitItem {
  name:     string
  replaced: boolean   // true = new part fitted; false = inspected/topped-up/serviced only
}

/** Emitted when an overdue vehicle finishes being serviced at a garage —
 *  see the TO_GARAGE / AT_GARAGE phase handling below. */
export interface GarageVisitEvent {
  garageName:   string
  garageLat:    number
  garageLng:    number
  enteredAtMs:  number
  exitedAtMs:   number
  odometerKm:   number
  severityScore: number   // 0–1, drives both the duration and how many items get addressed
  itemsFixed:   GarageVisitItem[]
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
  profile: RoutingProfile = 'SUKARI',
): VehicleSimState {
  const aquamist = profile === 'AQUAMIST'
  const tractor  = !aquamist && isTractorType(vehicleType)
  const delivery = isDeliveryType(vehicleType)

  // Every vehicle starts the simulation parked AT ITS ORGANISATION — Sukari
  // tractors at the dedicated parking, other Sukari vehicles on the mill
  // premises, Aquamist vehicles at the bottling plant. Support (non-logistics)
  // vehicles get a small deterministic yard offset so they don't stack on one
  // pixel. All are engine-off, FULL tank, and healthy: no movement and no alerts
  // until operations begin and vehicles are dispatched.
  const home: [number, number, string] = aquamist ? AQUAMIST_HQ : tractor ? PARKING : SUKARI
  const lat = home[0] + (tractor ? 0 : ((index % 8) - 4) * 0.0009)
  const lng = home[1] + (tractor ? 0 : ((Math.floor(index / 8) % 8) - 4) * 0.0009)

  // Outbound destination pool used once the vehicle is dispatched.
  const dest: [number, number, string] = aquamist
    ? aquamistCustomersFor(vehicleType)[index % aquamistCustomersFor(vehicleType).length]!
    : tractor ? SUGARCANE_FARMS[index % SUGARCANE_FARMS.length]!
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
    cargoKind:       '',
    cargoDesc:       '',
    batteryV:        jitter(12.6, 0.15),
    doorOpen:        false,
    panicPressed:    false,
    odometer:        Math.round(20_000 + index * 1500),
    routeProgressKm: 0,
    legBeganAtMs:        0,
    legPlannedArrivalMs: 0,
    vehicleType,
    profile,
    legDirection:    'outbound',
    fenceLat:        home[0],
    fenceLng:        home[1],
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
    haltLat:         null,
    haltLng:         null,

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

    garageDestLat:     0,
    garageDestLng:     0,
    garageDestName:    '',
    garageEnteredAtMs: 0,
    maintenanceResetOdoKm: 0,

    tripBeganAtMs:    0,
    tripStartOdoKm:   0,
    tripStartFuelMl:  0,
    tripStartLoc:     '',
    tripMaxSpeedKmh:  0,
    tripSpeedSumKmh:  0,
    tripSpeedSamples: 0,
    tripOverspeedTicks: 0,
    eventTripCompleted:        null,
    eventFuelTheft:            null,
    eventRefuel:               null,
    eventServiceCompleted:     null,
    eventGarageVisitCompleted: null,
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

    // Freeze the stop position the first time we enter a halt so the vehicle
    // stays exactly where it was on the road for the full duration. Reset when
    // all conditions clear (see below).
    if (s.haltLat == null) { s.haltLat = s.lat; s.haltLng = s.lng }

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
        loc:         `${(s.haltLat ?? s.lat).toFixed(4)}, ${(s.haltLng ?? s.lng).toFixed(4)}`,
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

    // Once all conditions are clear, unfreeze position so the vehicle can resume
    if (!s.lowFuelHalted && !s.highTempHalted && !s.lowOilHalted) {
      s.lat    = s.haltLat ?? s.lat    // restore exact road stop point as starting position
      s.lng    = s.haltLng ?? s.lng
      s.haltLat = null
      s.haltLng = null
    }

    return   // skip scenario movement for this tick
  }

  const tractor  = s.vehicleType === 'TRACTOR'
  const delivery  = isDeliveryType(s.vehicleType)

  if (tractor || delivery) {
    // Logistics vehicles follow the realistic daily/weekly cycle (trips-per-day
    // quota, load/offload dwell, maintenance, Sunday rest) — Sukari's sugar
    // haulage and Aquamist's direct-to-customer deliveries alike.
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
  const pools: [number, number, string][] =
    [SUKARI, AQUAMIST_HQ, ...SUGARCANE_FARMS, ...SUGAR_DEPOTS, ...AQUAMIST_CUSTOMERS, ...GARAGES]
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

// Same baseline cruising speed tickLogistics targets for this vehicle type
// before per-tick jitter/overspeed rolls (see the `roadKmh` computed at the
// top of tickLogistics) — used only to plan an ETA, not to drive movement.
function typicalSpeedKmh(vehicleType: string): number {
  if (vehicleType === 'SALOON') return 78   // light passenger car — quickest of the fleet
  const tractor = vehicleType === 'TRACTOR'
  const lorry   = vehicleType === 'LORRY'
  return tractor ? 60 * 0.55 : 62 * (lorry ? 0.85 : 1)
}

function setLeg(s: VehicleSimState, from: [number, number], to: [number, number]): void {
  s.originLat = from[0]; s.originLng = from[1]
  s.destLat   = to[0];   s.destLng   = to[1]
  s.routeProgressKm = 0

  // Real departure time + a planned-duration ETA for this leg, at this
  // vehicle's typical cruising speed — feeds the dashboard's Fleet grid
  // (Departure / Expected Arrival / Late-Early). Halts (fuel/temp/oil) and
  // the occasional overspeed roll both push the actual arrival later or
  // earlier than this plan, which is exactly what "late/early" measures.
  s.legBeganAtMs = simNow()
  const totalKm  = haversineApproxKm(from[0], from[1], to[0], to[1])
  // A few legs are genuinely tiny intra-facility hops (e.g. TO_PARKING is
  // only the mill-to-parking ~250m) — distance/speed alone can compute a
  // planned duration under 30s there, which rounds the departure and
  // arrival times shown on the dashboard to the exact same minute and
  // reads as broken data rather than "this trip is just very short". A
  // floor of a few minutes is itself realistic (pulling out, parking,
  // slowing/stopping) rather than a fudge on top of the distance/speed
  // estimate, which still drives every longer, real haul unchanged.
  const MIN_PLANNED_MINUTES = 3
  const plannedHours = Math.max(totalKm / typicalSpeedKmh(s.vehicleType), MIN_PLANNED_MINUTES / 60)
  s.legPlannedArrivalMs = s.legBeganAtMs + plannedHours * 3_600_000
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
  // Overspeeding bumps the effective consumption rate, not just the distance
  // covered — see OVERSPEED_CONSUMPTION_MULTIPLIER above.
  const effectiveDrainPer100 = overspeed ? drainPer100 * OVERSPEED_CONSUMPTION_MULTIPLIER : drainPer100
  const drain = fuelDrainMl(distKm, effectiveDrainPer100)   // drainPer100 = L/100 km
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
  if (overspeed) s.tripOverspeedTicks++

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
  s.tripOverspeedTicks = 0
}

function completeTrip(
  s: VehicleSimState, toName: string,
  cargoType: SimCargoKind, cargoKg: number,
): void {
  const endMs   = simNow()
  const samples = Math.max(s.tripSpeedSamples, 1)
  s.eventTripCompleted = {
    beganAtMs:     s.tripBeganAtMs || endMs - 60_000,
    endedAtMs:     endMs,
    fromLoc:       s.tripStartLoc || homeBaseOf(s)[2],
    toLoc:         toName,
    distanceKm:    Math.max(0, s.odometer - s.tripStartOdoKm),
    avgSpeedKmh:   s.tripSpeedSumKmh / samples,
    maxSpeedKmh:   s.tripMaxSpeedKmh,
    overspeedTicks: s.tripOverspeedTicks,
    consumedMl:    Math.max(0, s.tripStartFuelMl - s.fuelLevelMl),
    startFuelMl:   s.tripStartFuelMl,
    endFuelMl:     s.fuelLevelMl,
    cargoWeightKg: cargoKg,
    cargoType,
    cargoDesc:     s.cargoDesc || undefined,
  }
  s.tripBeganAtMs = 0
}

// Home base: Aquamist vehicles → the bottling plant; Sukari tractors → the
// dedicated parking; Sukari trucks/lorries → the mill premises.
function homeBaseOf(s: VehicleSimState): [number, number, string] {
  if (s.profile === 'AQUAMIST') return AQUAMIST_HQ
  return s.vehicleType === 'TRACTOR' ? PARKING : SUKARI
}

/** Consumption (L/100 km) for a delivery leg — a saloon car burns car-like
 *  fuel regardless of a few crates in the boot; trucks/lorries use the
 *  load-scaled haulage table. */
function deliveryLegL100(s: VehicleSimState): number {
  if (s.vehicleType === 'SALOON') return (s.cargoWeightKg ?? 0) > 0 ? 9 : 8
  return deliveryConsumptionL100(s.cargoWeightKg)
}

/** Fill the tank — every vehicle leaves the premises (and every depot) full. */
function refuelFull(s: VehicleSimState): void {
  s.fuelLevelMl     = s.tankCapacityMl
  s.prevFuelLevelMl = s.tankCapacityMl   // no delta → never mistaken for a fill spike/theft
}

/** Sugarcane farms within the tractor dispatch radius of the mill. */
function farmsInRange(): [number, number, string][] {
  return SUGARCANE_FARMS.filter(f => haversineApproxKm(SUKARI[0], SUKARI[1], f[0], f[1]) <= TRACTOR_DISPATCH_RADIUS_KM)
}

// ─── overdue-service → garage redirect ─────────────────────────────────────
// A vehicle gets redirected to a garage for EITHER of two reasons:
//   1. The coarse major-service cycle (nextServiceOdoKm) has come due — the
//      original signal, still feeds the "scheduled service" record.
//   2. The dashboard's own per-item checklist (MAINTENANCE_CATALOG below) —
//      the SAME 13 items/intervals/thresholds the Maintenance page grid
//      shows as Good/Monitor/Due Soon/Overdue — has its worst item at
//      Due Soon or Overdue. This must mirror dash/src/lib/maintenanceSchedule.js
//      exactly, because the redirect has to happen for precisely the
//      vehicles the UI is already labelling Due Soon/Overdue — not some
//      separately-drifting backend approximation.
// Either way the vehicle finds the nearest garage to wherever it actually is
// and drives there (no more teleporting to the mill workshop).

// Kept in lockstep with dash/src/lib/maintenanceSchedule.js's MAINTENANCE_CATALOG.
const MAINTENANCE_CATALOG: [string, number][] = [
  ['Engine Oil & Filter',           5_000],
  ['Tyre Rotation',                 8_000],
  ['Tyre Tread & Pressure',        10_000],
  ['Engine Air Filter',            15_000],
  ['Cabin/Pollen Filter',          15_000],
  ['Wheel Alignment & Suspension', 15_000],
  ['Battery & Terminals',          20_000],
  ['Wiper Blades & Lights',        20_000],
  ['Brake Pads & Rotors',          20_000],
  ['Brake Fluid',                  40_000],
  ['Coolant (Antifreeze)',         60_000],
  ['Transmission Fluid',           60_000],
  ['Belts & Hoses',                80_000],
]

type MaintenanceTier = 'Good' | 'Monitor' | 'DueSoon' | 'Overdue'
const TIER_SEVERITY: Record<MaintenanceTier, number> = { Overdue: 0, DueSoon: 1, Monitor: 2, Good: 3 }

// Same thresholds as dash's maintenanceStatus().
function maintenanceTier(remainingPct: number): MaintenanceTier {
  if (remainingPct > 70) return 'Good'
  if (remainingPct > 40) return 'Monitor'
  if (remainingPct > 15) return 'DueSoon'
  return 'Overdue'
}

/** Worst (most urgent) tier across all 13 checklist items, cycling from
 *  `resetOdoKm` (the vehicle's last garage visit, or 0 if it's never had one) —
 *  exactly what the dashboard grid would show for this vehicle right now. */
function worstMaintenanceTier(odometerKm: number, resetOdoKm: number): MaintenanceTier {
  let worst: MaintenanceTier = 'Good'
  for (const [, intervalKm] of MAINTENANCE_CATALOG) {
    const kmIntoCycle  = (odometerKm - resetOdoKm) % intervalKm
    const remainingPct = ((intervalKm - kmIntoCycle) / intervalKm) * 100
    const tier = maintenanceTier(remainingPct)
    if (TIER_SEVERITY[tier] < TIER_SEVERITY[worst]) worst = tier
  }
  return worst
}

function isDueSoonOrOverdue(s: VehicleSimState): boolean {
  const tier = worstMaintenanceTier(s.odometer, s.maintenanceResetOdoKm)
  return tier === 'DueSoon' || tier === 'Overdue'
}

function nearestGarage(lat: number, lng: number): [number, number, string] {
  let best = GARAGES[0]!
  let bestKm = haversineApproxKm(lat, lng, best[0], best[1])
  for (const g of GARAGES.slice(1)) {
    const d = haversineApproxKm(lat, lng, g[0], g[1])
    if (d < bestKm) { bestKm = d; best = g }
  }
  return best
}

// Real severity signal built from three things already tracked on the
// vehicle: how far past its due odometer it is, how degraded its oil is, and
// how hot the engine is running — not a fabricated random roll.
function garageSeverity(s: VehicleSimState): number {
  const overdueKm      = Math.max(0, s.odometer - s.nextServiceOdoKm)
  const overdueSeverity = clamp(overdueKm / 2_000, 0, 1)          // 2,000 km overdue = maxed out
  const oilSeverity     = clamp((90 - s.oilLevelPct) / 50, 0, 1)  // fresh oil is ~92%
  const tempSeverity    = clamp((s.engineTempC - 95) / 20, 0, 1)  // normal running temp ~90°C
  return clamp(overdueSeverity * 0.4 + oilSeverity * 0.3 + tempSeverity * 0.3, 0, 1)
}

const GARAGE_MAX_MINUTES = 120   // hard cap — never more than 2h simulation time at the garage
const GARAGE_MIN_MINUTES = 30

function garageServiceMinutes(severity: number): number {
  return Math.min(GARAGE_MAX_MINUTES, Math.round(GARAGE_MIN_MINUTES + severity * (GARAGE_MAX_MINUTES - GARAGE_MIN_MINUTES)))
}

// Typical line items a fleet garage visit covers. How many get addressed (and
// whether a part is actually replaced vs. just inspected/topped-up) scales
// with severity, so a vehicle caught barely-overdue gets a light touch and a
// badly-overdue one gets worked on more thoroughly.
const GARAGE_ITEM_CATALOG = [
  'Engine Oil & Filter', 'Brake Pads & Rotors', 'Tyre Rotation & Pressure',
  'Engine Air Filter', 'Coolant Top-up', 'Battery & Terminals', 'Belts & Hoses',
]

function pickGarageItems(severity: number): GarageVisitItem[] {
  const count = Math.max(1, Math.round(1 + severity * (GARAGE_ITEM_CATALOG.length - 1)))
  const pool  = [...GARAGE_ITEM_CATALOG]
  const chosen: string[] = []
  for (let i = 0; i < count && pool.length > 0; i++) {
    chosen.push(pool.splice(randInt(0, pool.length - 1), 1)[0]!)
  }
  // Higher severity → more likely a part actually gets replaced rather than
  // just inspected/topped-up.
  return chosen.map(name => ({ name, replaced: Math.random() < 0.25 + severity * 0.5 }))
}

/** Redirect an overdue vehicle to the nearest garage instead of continuing
 *  its normal cycle. Called from the two places that used to flip straight
 *  into the old MAINTENANCE phase. */
function redirectToGarage(s: VehicleSimState): void {
  const garage = nearestGarage(s.lat, s.lng)
  setLeg(s, [s.lat, s.lng], [garage[0], garage[1]])
  s.garageDestLat  = garage[0]
  s.garageDestLng  = garage[1]
  s.garageDestName = garage[2]
  s.phase = 'TO_GARAGE'
}

/** Draw a fresh daily (and, on a week rollover, weekly) plan for the vehicle. */
function planDay(s: VehicleSimState, tractor: boolean): void {
  const now = simDate()
  s.simDayKey = dayKey(now)

  const wk = weekKey(now)
  if (s.weekStartKey !== wk) {
    s.weekStartKey     = wk
    s.tripsThisWeek    = 0
    // Sukari trucks/lorries: 0–4 depot runs / week. Aquamist trucks/lorries:
    // 1–4 customer deliveries / week — always at least one, so the beverage
    // fleet never sits idle for a whole week.
    s.weeklyTripTarget = s.profile === 'AQUAMIST' ? randInt(1, 4) : randInt(0, 4)
  }

  s.tripsToday      = 0
  // Tractors: 0–3 farm hauls / day. Aquamist saloons: 1–4 residential customer
  // drops / day around Nairobi.
  s.dailyTripTarget = s.profile === 'AQUAMIST' && s.vehicleType === 'SALOON'
    ? randInt(1, 4)
    : randInt(0, 3)

  // Don't yank a vehicle that's mid-haul (or already off getting fixed) when
  // the calendar day rolls over.
  const midHaul = ['TO_FARM', 'TO_INDUSTRY', 'TO_DEPOT', 'TO_PARKING', 'LOADING', 'OFFLOADING', 'DWELL', 'TO_GARAGE', 'AT_GARAGE', 'FROM_GARAGE'].includes(s.phase)
  if (midHaul) return

  if (isSunday(now))                     { s.phase = 'SUNDAY'; return }
  if (s.odometer >= s.nextServiceOdoKm || isDueSoonOrOverdue(s)) { redirectToGarage(s); return }
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
  if (s.odometer >= s.nextServiceOdoKm || isDueSoonOrOverdue(s)) { redirectToGarage(s); return }
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
  } else if (s.profile === 'AQUAMIST') {
    // Direct-to-customer beverage delivery — no depots. Saloons run several
    // small residential drops a day (daily quota); trucks/lorries take bulk
    // orders across Nairobi, Kisumu, Nakuru, and Mombasa (weekly quota).
    const saloon = s.vehicleType === 'SALOON'
    const quotaMet = saloon ? s.tripsToday >= s.dailyTripTarget
                            : s.tripsThisWeek >= s.weeklyTripTarget
    if (quotaMet) { s.phase = idle; return }
    const pool     = aquamistCustomersFor(s.vehicleType)
    const customer = pool[randInt(0, pool.length - 1)]!
    const product  = AQUAMIST_PRODUCTS[randInt(0, AQUAMIST_PRODUCTS.length - 1)]!
    refuelFull(s)                                  // leave the plant full
    setLeg(s, [AQUAMIST_HQ[0], AQUAMIST_HQ[1]], [customer[0], customer[1]])
    s.cargoWeightKg = plannedLoadFor(s)            // crates / pallets of product
    s.cargoKind     = product.kind
    s.cargoDesc     = product.desc
    beginTrip(s, AQUAMIST_HQ[2])
    s.phase = 'TO_DEPOT'                           // reused leg: outbound loaded delivery
  } else {
    if (s.tripsThisWeek >= s.weeklyTripTarget) { s.phase = idle; return }
    const depot = SUGAR_DEPOTS[randInt(0, SUGAR_DEPOTS.length - 1)]!
    refuelFull(s)                                  // leave the premises full
    setLeg(s, [SUKARI[0], SUKARI[1]], [depot[0], depot[1]])
    s.cargoWeightKg = plannedLoadKg(s.vehicleType) // processed sugar, ≤ max − 10 t
    s.cargoKind     = 'PROCESSED_SUGAR'
    s.cargoDesc     = 'Processed sugar'
    beginTrip(s, SUKARI[2])
    s.phase = 'TO_DEPOT'
  }
}

export function tickLogistics(s: VehicleSimState, tractor: boolean): void {
  const now   = simDate()
  const nowMs = simNow()
  const roadKmh = typicalSpeedKmh(s.vehicleType)
  const home  = homeBaseOf(s)

  if (s.simDayKey !== dayKey(now)) planDay(s, tractor)

  switch (s.phase) {
    case 'SUNDAY':
    case 'DONE':
      parkAt(s, home[0], home[1])
      break

    case 'TO_GARAGE': {
      const p = advanceLeg(s, roadKmh, 30)   // urgent, unplanned run — treat like a loaded-ish trip
      if (p >= 0.98) {
        const severity = garageSeverity(s)
        s.garageEnteredAtMs = nowMs
        s.phaseEndsAtMs     = nowMs + garageServiceMinutes(severity) * MIN_MS
        s.phase = 'AT_GARAGE'
      }
      break
    }

    case 'AT_GARAGE':
      parkAt(s, s.garageDestLat, s.garageDestLng)
      if (nowMs >= s.phaseEndsAtMs) {
        const severity = garageSeverity(s)
        const newNextServiceOdoKm = s.odometer + randInt(8_000, 15_000)

        s.eventServiceCompleted = {
          completedAtMs:    nowMs,
          odometerKm:       s.odometer,
          nextServiceOdoKm: newNextServiceOdoKm,
        }
        s.eventGarageVisitCompleted = {
          garageName:    s.garageDestName,
          garageLat:     s.garageDestLat,
          garageLng:     s.garageDestLng,
          enteredAtMs:   s.garageEnteredAtMs,
          exitedAtMs:    nowMs,
          odometerKm:    s.odometer,
          severityScore: severity,
          itemsFixed:    pickGarageItems(severity),
        }

        s.nextServiceOdoKm = newNextServiceOdoKm
        s.oilLevelPct      = jitter(92, 4)
        s.engineTempC      = jitter(88, 3)
        // Reset the 13-item checklist's cycle baseline to right now — the
        // vehicle reads "Good" across the board immediately after a visit,
        // not still Due Soon/Overdue on the very next tick.
        s.maintenanceResetOdoKm = s.odometer
        s.garageEnteredAtMs = 0
        // Drive back from the garage to home base instead of teleporting —
        // once there, the normal AT_PARKING/AT_INDUSTRY → dispatch() cycle
        // resumes the vehicle's mission exactly as it would have otherwise.
        setLeg(s, [s.garageDestLat, s.garageDestLng], [home[0], home[1]])
        s.phase = 'FROM_GARAGE'
      }
      break

    case 'FROM_GARAGE': {
      const p = advanceLeg(s, roadKmh, 30)
      if (p >= 0.98) {
        s.garageDestLat = 0; s.garageDestLng = 0; s.garageDestName = ''
        s.phase = tractor ? 'AT_PARKING' : 'AT_INDUSTRY'
      }
      break
    }

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
      // Tractor loaded with cane: flat rate. Delivery vehicle returning empty:
      // saloons at a car-like rate, trucks/lorries at the load-based rate
      // (cargoWeightKg is 0 here, so that's the table's ~30 L/100 km empty tier).
      const p = advanceLeg(s, roadKmh, tractor ? 28 : deliveryLegL100(s))
      if (p >= 0.98) {
        if (tractor) { s.phase = 'UNLOADING'; s.phaseEndsAtMs = nowMs + UNLOAD_MIN_TRACTOR() * MIN_MS }
        else          { s.phase = 'AT_INDUSTRY' }   // returned empty to home base
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
      // Outbound loaded delivery — Sukari: to a sugar depot; Aquamist: straight
      // to a customer. Saloons burn car-like fuel; trucks/lorries the
      // load-based rate (~38 L/100 km at a standard load).
      const p = advanceLeg(s, roadKmh, deliveryLegL100(s))
      if (p >= 0.98) {
        s.phase = 'OFFLOADING'
        s.phaseEndsAtMs = nowMs + OFFLOAD_MIN_DELIVERY(s.cargoWeightKg ?? 0) * MIN_MS
      }
      break
    }

    case 'OFFLOADING': {
      parkAt(s, s.destLat, s.destLng)   // parked (off-road) at the depot / customer
      if (nowMs >= s.phaseEndsAtMs) {
        const saloon = s.vehicleType === 'SALOON'
        const kind: SimCargoKind = s.profile === 'AQUAMIST'
          ? ((s.cargoKind || 'STILL_WATER') as SimCargoKind)
          : 'PROCESSED_SUGAR'
        completeTrip(s, placeName(s.destLat, s.destLng), kind, s.cargoWeightKg ?? 0)
        s.cargoWeightKg = 0
        s.cargoKind = ''
        s.cargoDesc = ''
        if (saloon) s.tripsToday++
        else        s.tripsThisWeek++
        if (!saloon) refuelFull(s)   // trucks/lorries refuel at the drop point for the return leg
        // Overnight at a far/late destination, otherwise deadhead back home.
        // Saloons never sleep over at a customer's residence — they always
        // return to the plant the same day.
        const destFarKm = haversineApproxKm(home[0], home[1], s.destLat, s.destLng)
        if (!saloon && (hourOfDay(now) >= 16 || destFarKm > 180)) {
          s.phase = 'DWELL'
        } else {
          setLeg(s, [s.destLat, s.destLng], [home[0], home[1]])
          s.phase = 'TO_INDUSTRY'
        }
      }
      break
    }

    case 'DWELL':
      parkAt(s, s.destLat, s.destLng)
      // Head back home the next morning.
      if (hourOfDay(now) >= 6 && hourOfDay(now) < 16) {
        setLeg(s, [s.destLat, s.destLng], [home[0], home[1]])
        s.phase = 'TO_INDUSTRY'
      }
      break

    default:
      s.phase = tractor ? 'AT_PARKING' : 'AT_INDUSTRY'
  }
}

// ─── render state → Controltech wire packet ────────────────────────────────

export function renderSnapshot(s: VehicleSimState): CtDeviceSnapshot {
  const fuelDelta      = s.fuelLevelMl - s.prevFuelLevelMl          // negative = used
  const isOutsideFence = haversineApproxKm(s.haltLat ?? s.lat, s.haltLng ?? s.lng, s.fenceLat, s.fenceLng) * 1000 > s.fenceRadiusM

  // Use frozen halt coordinates when available so the map marker stays pinned
  // to the exact road position for the entire halt duration.
  const snapLat = s.haltLat ?? s.lat
  const snapLng = s.haltLng ?? s.lng

  return {
    imei:            s.imei,
    device_id:       s.deviceId,
    timestamp_utc:   new Date().toISOString(),
    lat:             +snapLat.toFixed(6),
    lng:             +snapLng.toFixed(6),
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
      profile:      s.profile,                 // SUKARI | AQUAMIST
      cargoDesc:    s.cargoDesc || null,       // product on board (Aquamist)
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
          beganAtMs:        s.legBeganAtMs,
          plannedArrivalMs: s.legPlannedArrivalMs,
        }
      })(),
      events: {
        tripCompleted:       s.eventTripCompleted ?? null,
        fuelTheft:           s.eventFuelTheft ?? null,
        refuel:              s.eventRefuel ?? null,
        serviceCompleted:    s.eventServiceCompleted ?? null,
        garageVisitCompleted: s.eventGarageVisitCompleted ?? null,
      },
      // Real per-vehicle service cycle — nextServiceOdoKm is randomised
      // 8,000-15,000 km after each service (see the TO_GARAGE/AT_GARAGE phase
      // handling above); odometer_km (top-level on this frame) is the other
      // half of the picture. The dashboard derives its whole maintenance
      // checklist from these two real numbers instead of faking it.
      maintenance: {
        nextServiceOdoKm:    +s.nextServiceOdoKm.toFixed(1),
        inMaintenance:       s.phase === 'TO_GARAGE' || s.phase === 'AT_GARAGE' || s.phase === 'FROM_GARAGE',
        maintenanceEndsAtMs: s.phase === 'AT_GARAGE' ? s.phaseEndsAtMs : null,
        garageName:          s.phase === 'TO_GARAGE' || s.phase === 'AT_GARAGE' ? s.garageDestName : null,
        // Only populated while the vehicle is en route to or actually at the
        // garage — the dashboard draws the ripple radius off these and hides
        // it the moment the vehicle sets off back on FROM_GARAGE.
        garageLat:           s.phase === 'TO_GARAGE' || s.phase === 'AT_GARAGE' ? +s.garageDestLat.toFixed(6) : null,
        garageLng:           s.phase === 'TO_GARAGE' || s.phase === 'AT_GARAGE' ? +s.garageDestLng.toFixed(6) : null,
        // Baseline the dashboard's own per-item checklist cycles from — see
        // MAINTENANCE_CATALOG / worstMaintenanceTier above. Must be applied
        // client-side exactly as dash/src/lib/maintenanceSchedule.js does.
        resetOdoKm:          +s.maintenanceResetOdoKm.toFixed(1),
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
