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

type EventMap = {
  'telemetry:processed': TelemetryProcessedEvent
  'alert:triggered':     FleetAlert
  'alerts:sync':         AlertsSyncEvent
  'simEvents:persist':   SimEventsPersistEvent
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
