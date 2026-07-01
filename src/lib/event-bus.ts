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

// ─── event payload types ───────────────────────────────────────────────────

export type AlertType =
  | 'overspeeding'
  | 'fuelInconsistency'
  | 'doorOpenWhileMoving'
  | 'lowFuel'
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

type EventMap = {
  'telemetry:processed': TelemetryProcessedEvent
  'alert:triggered':     FleetAlert
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
