/**
 * Alert flags derived from telemetry, for providers that send none.
 *
 * ## What this exists to fix
 *
 * The alerting pipeline is complete and has never run. A frame's `flags` decide
 * everything downstream — `poller` filters them into `activeAlertTypes`,
 * `alerts.worker` opens and resolves `vehicle_alerts` rows, `notification.worker`
 * fans out to SSE, the feed and Web Push — and the Wialon adapter sets all nine
 * to `false` on every frame. Measured 2026-08-31, `vehicle_alerts` held ZERO
 * rows for the entire platform, across every organisation and all time. Five
 * stages of working code had never been given a reason to run.
 *
 * That was a deliberate choice and its reasoning still holds where it applies:
 * the Wialon position payload carries no door channel, no oil level and no
 * per-unit speed limit, so raising those flags from it would be fabrication.
 *
 * But it does not apply to everything. `analytics.repository` has asserted an
 * 80 km/h limit for as long as the Speeding screen has existed, and uses it in
 * the driver-suspension policy — where the consequence lands on a driver's
 * employment. Declining to say the same thing in the operator's feed was not
 * caution; it was one judgement applied in the place where it costs someone a
 * job and withheld from the place where somebody could act on it.
 *
 * So the rule this module follows: derive a flag only where the fleet's own
 * data answers it, and take every threshold from CONFIGURATION rather than
 * inventing one. A limit an operator set and we applied is not a guess.
 *
 * ## Additive, never subtractive
 *
 * `deriveAlertFlags` returns only flags it can positively assert. The caller
 * ORs them onto what the provider supplied, so a provider that computes its own
 * alerts — RaiFactorySuite, and the simulator before it — keeps them, and this
 * can only ever add. Nothing here can silence an alert another source raised.
 */

import { env } from '../config/env.js'
import type { VehicleTelemetryFrame } from '../providers/telemetry-provider.js'
import { zoneLimitAt } from './speed-policy.js'

/** What the derivation needs to know about the vehicle behind a frame. */
export interface DerivationContext {
  vehicleId:      string
  /** 0 when the tank is unknown — see the poller's note. Blocks `lowFuel`. */
  tankCapacityMl: number
  vehicleType:    string | null
  /** For an org with a zone speed policy (lib/speed-policy). */
  orgId?:         string
}

/** The flags this module is able to assert. */
export type DerivedFlags = Partial<Pick<
  VehicleTelemetryFrame['flags'],
  'overspeeding' | 'lowFuel' | 'engineIdling'
>>

/**
 * `TRACTOR:50,PLANT:40` → a lookup. Parsed once.
 *
 * Malformed entries are dropped rather than throwing: this is a deployment
 * string, and a typo in it must not stop a fleet server booting. The fallback
 * is the fleet-wide limit, which is a safe answer rather than an absent one.
 */
const limitByType: ReadonlyMap<string, number> = new Map(
  env.OVERSPEED_LIMIT_BY_TYPE
    .split(',')
    .map(pair => pair.split(':'))
    .filter((p): p is [string, string] => p.length === 2)
    .map(([type, kmh]) => [type!.trim().toUpperCase(), Number(kmh)] as const)
    .filter(([type, kmh]) => type.length > 0 && Number.isFinite(kmh) && kmh > 0),
)

/** Where a unit is, for an org whose limit depends on it. */
export interface LimitPlace {
  orgId: string
  lat:   number | null | undefined
  lng:   number | null | undefined
}

/**
 * The limit that applies to one vehicle.
 *
 * With `at`, an org that has its own policy (lib/speed-policy — Kasulu: LMVs
 * 60 in the factory and 100 on the roads, every other unit 40) is judged by
 * the unit's type and where it is, and that outranks the per-type and fleet
 * limits. Every other org, and every caller that cannot say which org the
 * unit is in, gets the per-type or fleet limit as before.
 */
export function overspeedLimitFor(vehicleType: string | null, at?: LimitPlace): number {
  const zone = at ? zoneLimitAt(at.orgId, vehicleType, at.lat, at.lng) : null
  if (zone) return zone.kmh
  return limitByType.get((vehicleType ?? '').toUpperCase()) ?? env.OVERSPEED_LIMIT_KMH
}

/**
 * Consecutive frames over the limit, per vehicle.
 *
 * The debounce is a COUNT rather than a duration because the poll cadence is
 * the only clock available here and it already paces the frames. A vehicle that
 * drops below the limit resets to zero, so three frames means three in a row,
 * not three in an afternoon.
 *
 * Bounded by the fleet — one small integer per vehicle that has ever sped, and
 * entries are deleted the moment a vehicle comes back under the limit, so the
 * steady state is the number of vehicles currently speeding.
 */
const overCount = new Map<string, number>()

/**
 * Seconds of continuous ignition-on, speed-zero, per vehicle — the idling
 * clock. Keyed on vehicle, cleared as soon as the unit moves or shuts down.
 */
const idleSince = new Map<string, number>()

/** An engine running with the vehicle stationary for at least this long. */
const IDLE_MIN_MS = 5 * 60_000

/** Below this the unit is standing still; GPS rarely reports a clean zero. */
const STATIONARY_KMH = 2

export function deriveAlertFlags(
  frame: VehicleTelemetryFrame,
  ctx:   DerivationContext,
): DerivedFlags {
  const out: DerivedFlags = {}

  // ── overspeeding ─────────────────────────────────────────────────────────
  const speed = frame.speedKmh
  if (Number.isFinite(speed)) {
    const limit = overspeedLimitFor(
      ctx.vehicleType,
      ctx.orgId ? { orgId: ctx.orgId, lat: frame.lat, lng: frame.lng } : undefined,
    )
    if ((speed as number) > limit) {
      const n = (overCount.get(ctx.vehicleId) ?? 0) + 1
      overCount.set(ctx.vehicleId, n)
      if (n >= env.OVERSPEED_MIN_FRAMES) out.overspeeding = true
    } else {
      overCount.delete(ctx.vehicleId)
    }
  }

  // ── lowFuel ──────────────────────────────────────────────────────────────
  //
  // Only against a KNOWN tank. Capacity is 0 for a vehicle whose size nobody
  // has recorded — 355 of 815 active vehicles when the poller's cache note was
  // written — and dividing by it would turn "we do not know this tank" into
  // "this tank is empty", raising a critical alert on missing configuration.
  if (frame.fuelLevelMl != null && ctx.tankCapacityMl > 0) {
    const pct = (frame.fuelLevelMl / ctx.tankCapacityMl) * 100
    if (pct <= env.LOW_FUEL_PCT) out.lowFuel = true
  }

  // ── engineIdling ─────────────────────────────────────────────────────────
  //
  // Claimable only where ignition is MEASURED. Where it is not, `engineOn`
  // falls back to `speed > 0` (see the adapter), which makes "engine on" and
  // "moving" the same signal — so a stationary unit is engine-off by
  // construction and idling is not merely unknown but unrepresentable. On this
  // fleet that is most units: 78% of fuel falls carry no measured engine state.
  const stationary = (frame.speedKmh ?? 0) <= STATIONARY_KMH
  if (frame.ignitionKnown && frame.engineOn && stationary) {
    const since = idleSince.get(ctx.vehicleId)
    const at = frame.capturedAt.getTime()
    if (since == null) idleSince.set(ctx.vehicleId, at)
    else if (at - since >= IDLE_MIN_MS) out.engineIdling = true
  } else {
    idleSince.delete(ctx.vehicleId)
  }

  return out
}

/** Drop a vehicle's debounce state. For tests, and for vehicles going away. */
export function resetDerivationState(vehicleId?: string): void {
  if (vehicleId == null) { overCount.clear(); idleSince.clear(); return }
  overCount.delete(vehicleId)
  idleSince.delete(vehicleId)
}
