/**
 * In-process typed event bus — fleet-wide pub/sub.
 *
 * Upgrade path to multi-instance:
 *   Replace the internal EventEmitter with a Redis pub/sub adapter
 *   (e.g. ioredis subscribe/publish). The public API (publish / subscribe)
 *   stays identical; only the transport changes.
 */

import { EventEmitter } from 'node:events'
import type { VehicleTelemetryFrame } from '../providers/telemetry-provider.js'
import type { SimEvents } from './simulation.persistence.js'
import type { ClosedEpisode } from './speeding-episodes.js'
import type { FaultObservation, FaultResolution } from './sensor-faults.js'
import type { LiveFuelDrop } from './fuel-drop-watch.js'

// ─── event payload types ───────────────────────────────────────────────────

export type AlertType =
  | 'overspeeding'
  | 'fuelInconsistency'
  | 'doorOpenWhileMoving'
  | 'lowFuel'
  | 'engineIdling'
  | 'outsideGeofence'
  | 'lowBattery'
  | 'highEngineTemp'
  | 'lowOil'

export interface FleetAlert {
  type:         AlertType
  orgId:        string
  deviceId:     string
  vehicleId:    string
  vehicleName:  string
  plate:        string
  capturedAt:   Date
  lat:          number | null
  lng:          number | null
  speedKmh:     number | null
  fuelLevelMl:  number | null
  meta:         Record<string, unknown>
}

export interface TelemetryProcessedEvent {
  frame:           VehicleTelemetryFrame
  orgId:           string
  vehicleId:       string
  vehicleName:     string
  plate:           string
  tankCapacityMl?: number   // used by telemetry.worker to compute fuelLevelPct
  driverName?:     string | null   // assigned driver, for the live feed
  vehicleType?:    string | null   // for the feed's overspeeding line, which quotes the per-type limit
}

// Published by the poller instead of awaiting syncFrameAlerts() inline — lets
// alerts.worker persist the alert-row bookkeeping off the poll cycle's
// critical path so one vehicle's DB writes don't hold up the next vehicle's
// turn in the concurrency-bounded poll loop.
export interface AlertsSyncEvent {
  orgId:       string
  vehicleId:   string
  deviceId:    string
  frame:       VehicleTelemetryFrame
  activeTypes: AlertType[]
}

// Published by the poller instead of awaiting persistSimEvents() inline —
// same rationale as AlertsSyncEvent. driverId is resolved once by the poller
// (via its 5-min device cache) so sim-events.worker never needs its own
// vehicleAssignment lookup.
export interface SimEventsPersistEvent {
  orgId:       string
  vehicleId:   string
  deviceId:    string
  events:      SimEvents
  vehicleMeta: { plate: string; vehicleName: string; driverId: string | null }
}

/**
 * An alert the PROVIDER composed and handed us (raifactorysuite dispatch/driver
 * governance, Wialon notifications, gate movements) — as opposed to FleetAlert,
 * which we derive ourselves from telemetry flags.
 *
 * These used to call emitDashboardFeed/emitDashboardAlert directly from the
 * intake services, which meant they reached an OPEN browser tab and nothing
 * else: a DRIVER_BLOCKED critical never fired Web Push, so nobody with the tab
 * closed heard about it. Routing them through the bus puts both alert families
 * behind the same fan-out (notification.worker).
 */
export interface ProviderAlertEvent {
  orgId:     string
  /** Feed id, already prefixed by the intake service (`pa-`, `dp-`, `mv-`…). */
  id:        string
  /** Provider that composed it — 'controltech' | 'wialon'. Also the feed `source`. */
  source:    string
  /** The provider's own type string, e.g. TRACTOR_OVERDUE, MOVEMENT_EXIT. */
  alertType: string
  severity:  'info' | 'success' | 'warning' | 'critical'
  /** The provider's own wording — never rewritten. */
  text:      string
  at:        Date
  plate:     string | null
  vehicleId: string | null
  /**
   * Whether to raise a banner and send a Web Push. False for routine
   * narration — a dispatch leaving the yard belongs in the feed, but waking
   * every subscribed phone for it trains people to ignore the alerts that
   * matter.
   *
   * This says nothing about STORAGE. It used to: notification.worker passed it
   * straight through as `persist`, on the reasoning that the only caller
   * setting it false was the boot replay of already-stored alerts. That caller
   * (seedFeedFromStoredAlerts) is long gone, and the one that inherited the
   * flag means something else entirely — with the result that every dispatch
   * and gate movement RaiFactorySuite has ever reported reached whoever had a
   * tab open at that instant and was then lost. Measured 2026-08-03: 1,813
   * dispatches on record, zero surviving feed items.
   */
  notify:    boolean
  /**
   * Whether to write the durable record. Defaults to true and should stay
   * that way for anything that actually happened; only a replay of rows the
   * store already holds sets it false.
   */
  persist?:  boolean
}

type EventMap = {
  'telemetry:processed': TelemetryProcessedEvent
  'alert:triggered':     FleetAlert
  'alerts:sync':         AlertsSyncEvent
  'simEvents:persist':   SimEventsPersistEvent
  'provider:alert':      ProviderAlertEvent
  /** A completed overspeeding episode, ready to be written to the ledger.
   *  Published from the poll loop so the write never blocks a frame's turn. */
  'speeding:closed':     ClosedEpisode
  /** A sensor fault episode to open (or extend) / to close. Published from both
   *  detectors — the poll loop and the 15-minute sweep. */
  /** A tank that dropped while the machine stood still, seen live rather than
   *  waited for. Provisional — see lib/fuel-drop-watch. */
  'fuel:dropped':        LiveFuelDrop
  'sensorFault:open':    FaultObservation
  'sensorFault:close':   FaultResolution
}

// ─── typed wrapper ─────────────────────────────────────────────────────────

class FleetEventBus {
  private readonly ee = new EventEmitter()

  constructor() {
    this.ee.setMaxListeners(50)
  }

  publish<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    this.ee.emit(event, data)
  }

  subscribe<K extends keyof EventMap>(
    event: K,
    handler: (data: EventMap[K]) => void,
  ): () => void {
    this.ee.on(event, handler as (...args: unknown[]) => void)
    return () => this.ee.off(event, handler as (...args: unknown[]) => void)
  }
}

export const eventBus = new FleetEventBus()
