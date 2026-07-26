/**
 * Wialon Hosting → `TelemetryProvider` (live positions for KASULU).
 *
 * Plugs into the existing poller unchanged: `startPoller(new WialonLiveAdapter())`.
 * Everything downstream — persistence, SSE, the map — is provider-agnostic.
 *
 * ## Why `core/search_items` and not `avl_evts`
 *
 * `avl_evts` is the event-driven route: subscribe with `core/update_data_flags`,
 * then long-poll every ~2 s for deltas. It is the right end state for a large
 * fleet, but it needs its own ~2 s loop, which does not fit the platform's
 * 30 s poll cycle, and its response contents depend entirely on the subscribed
 * flags — a common source of silent empty payloads.
 *
 * At 224 units one `search_items` call per cycle returns every last-known
 * position in a single request, keeps the session warm (the same thing the
 * `avl_evts` loop does), and needs no subscription state to get out of sync.
 * Move to `avl_evts` when unit count or cadence demands it; the frame mapping
 * below is unchanged by that switch.
 *
 * ## Only genuinely new fixes are emitted
 *
 * `pos.t` advances only when the device actually reports. Emitting every unit
 * every cycle would write ~224 duplicate telemetry rows every 30 s (~40 k/hour
 * of noise) and would make dormant vehicles look like they were reporting
 * continuously. So a frame is produced only when a unit's fix timestamp has
 * moved forward since the last cycle — which is also what keeps `capturedAt`
 * honest.
 */

import { logger } from '../../lib/logger.js'
import { env } from '../../config/env.js'
import type { TelemetryProvider, VehicleTelemetryFrame } from '../telemetry-provider.js'
import { WialonClient, type WialonUnit } from './wialon.client.js'

/** Mirrors sync-wialon.ts — the device key a Wialon unit is registered under. */
export const wialonDeviceId = (unitId: number): string => `wialon:${unitId}`

export class WialonLiveAdapter implements TelemetryProvider {
  readonly name = 'Wialon Hosting (live)'

  private readonly client: WialonClient
  /** unitId → last emitted fix time (unix seconds). */
  private readonly lastFixAt = new Map<number, number>()
  private initialised = false

  constructor(
    token: string = env.WIALON_TOKEN || process.env['access_token'] || '',
    baseUrl: string = env.WIALON_API_URL,
  ) {
    this.client = new WialonClient(token, baseUrl)
  }

  private async init(): Promise<void> {
    await this.client.login()
    // Wialon renders report dates in the account's locale; the raw `pos.t`
    // values this adapter uses are unix seconds and unaffected.
    await this.client.setLocale().catch(() => { /* cosmetic only */ })
    this.initialised = true
  }

  async fetchAll(): Promise<VehicleTelemetryFrame[]> {
    if (!this.initialised) await this.init()

    const units = await this.client.listUnits()
    const frames: VehicleTelemetryFrame[] = []
    let unchanged = 0
    let neverReported = 0

    for (const u of units) {
      if (!u.pos) { neverReported++; continue }

      const fixAt = u.pos.t
      const seen = this.lastFixAt.get(u.id)
      // First sight of a unit still emits, so a restart re-seeds the map from
      // the last known position rather than waiting for the device to move.
      if (seen != null && fixAt <= seen) { unchanged++; continue }
      this.lastFixAt.set(u.id, fixAt)

      const frame = toFrame(u)
      if (frame) frames.push(frame)
    }

    logger.debug(
      { provider: this.name, units: units.length, moved: frames.length, unchanged, neverReported },
      'Wialon poll',
    )
    return frames
  }
}

/**
 * One Wialon unit → one telemetry frame.
 *
 * Only what Wialon actually provides is filled in. Fuel, cargo, door state,
 * battery, engine temperature and oil are NOT in the position payload, so they
 * stay null rather than being invented — the dashboard renders "—" for them.
 */
function toFrame(u: WialonUnit): VehicleTelemetryFrame | null {
  const p = u.pos
  if (!p || !Number.isFinite(p.y) || !Number.isFinite(p.x)) return null

  const speedKmh = p.s ?? null

  return {
    deviceId:   wialonDeviceId(u.id),
    // `pos.t` is unix SECONDS, and it is the moment the DEVICE reported —
    // never "now". A nine-day-old fix must stay nine days old.
    capturedAt: new Date(p.t * 1000),

    lat:        p.y,
    lng:        p.x,
    altitudeM:  p.z ?? null,
    headingDeg: p.c ?? null,
    accuracyM:  null,

    speedKmh,
    // No ignition channel in `pos`, and the column is NOT NULL: moving ⇒ engine
    // on is safe, but stationary does NOT mean off — an idling vehicle reads as
    // off here. Wire a named ignition sensor before trusting engine-hours or
    // idling analytics.
    engineOn:   (speedKmh ?? 0) > 0,

    fuelLevelMl:        null,
    fuelUsedMl:         null,
    cargoWeightKg:      null,
    batteryVoltageV:    null,
    doorStatus:         'UNKNOWN',
    panicButtonPressed: false,
    gpsFixQuality:      null,
    satelliteCount:     p.sc ?? null,
    networkType:        null,
    signalStrengthPct:  null,
    engineTempC:        null,
    oilLevelPct:        null,

    // Every flag needs an input we do not have from this payload: there are no
    // per-unit speed limits, fuel readings or door channels here. Raising them
    // on guesses would fabricate alerts. Wialon's own Notifications are the
    // correct source for speeding/geofence events — it computes them against
    // real per-unit limits and can POST them to /webhook/rai.
    flags: {
      overspeeding:        false,
      fuelInconsistency:   false,
      doorOpenWhileMoving: false,
      lowFuel:             false,
      engineIdling:        false,
      outsideGeofence:     false,
      lowBattery:          false,
      highEngineTemp:      false,
      lowOil:              false,
    },

    rawPayload: { source: 'wialon', unitId: u.id, name: u.nm, pos: p },
  }
}
