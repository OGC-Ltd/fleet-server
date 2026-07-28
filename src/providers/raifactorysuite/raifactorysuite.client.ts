/**
 * RaiFactorySuite (factorysuite.org) REST client.
 *
 * The provider exposes NO coordinates — it is not a telemetry source and does
 * not implement `TelemetryProvider`. What it does expose is the operational
 * record: the vehicle and driver registries, dispatches, and pre-composed
 * alerts. See docs/LIVE_INTEGRATION.md §3.1 for the verified endpoint shapes.
 *
 * Quirks this client has to live with:
 *   • `/dispatches` is capped at 1000 rows and IGNORES offset/page/skip, so
 *     there is no pagination to implement — roughly four days are visible and
 *     that is the whole window.
 *   • Responses are sometimes a bare array and sometimes `{ data: [...] }`.
 *   • Timestamps are offsetless local wall-clock (see lib/provider-time).
 *
 * Every request is bounded by an AbortController: a provider that accepts the
 * connection and then never answers would otherwise hold a reconcile run open
 * until the poll loop's watchdog fires minutes later.
 */

import { raiFactorySuiteApi } from '../../config/env.js'
import { logger } from '../../lib/logger.js'

const REQUEST_TIMEOUT_MS = 20_000

export interface RaiFactorySuiteAlertRow {
  id:            string
  factoryCode:   string
  type:          string
  message:       string
  relatedId?:    string | null
  acknowledged?: boolean | null
  createdAt?:    string | null
}

export interface RaiFactorySuiteDispatchRow {
  id:                    string
  factoryCode:           string
  vehicleNumberPlate:    string
  driverName:            string
  vehicleType?:          string | null
  destinationOrPurpose?: string | null
  status?:               string | null
  dispatchTime?:         string | null
  expectedReturnTime?:   string | null
  actualReturnTime?:     string | null
}

export class RaiFactorySuiteClient {
  constructor(
    private readonly baseUrl: string = raiFactorySuiteApi.url,
    private readonly apiKey:  string = raiFactorySuiteApi.key,
  ) {}

  /** False when no API key is configured — callers should stay dormant. */
  get isConfigured(): boolean {
    return Boolean(this.apiKey)
  }

  private async get<T>(path: string): Promise<T[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers: { accept: 'application/json', 'X-API-Key': this.apiKey },
        signal:  controller.signal,
      })
      if (!res.ok) throw new Error(`RaiFactorySuite ${path} responded ${res.status}`)
      const body: unknown = await res.json()
      // Bare array or { data: [...] } — the provider uses both.
      const rows = Array.isArray(body) ? body : (body as { data?: unknown[] }).data ?? []
      return rows as T[]
    } finally {
      clearTimeout(timer)
    }
  }

  async listAlerts(limit = 200): Promise<RaiFactorySuiteAlertRow[]> {
    return this.get<RaiFactorySuiteAlertRow>(`/alerts?limit=${limit}`)
  }

  async listDispatches(limit = 500): Promise<RaiFactorySuiteDispatchRow[]> {
    return this.get<RaiFactorySuiteDispatchRow>(`/dispatches?limit=${limit}`)
  }

  /** Cheap liveness probe used when a reconcile run fails, to tell apart
   *  "provider is down" from "this endpoint changed shape". */
  async ping(): Promise<boolean> {
    try {
      await this.get('/alerts?limit=1')
      return true
    } catch (err) {
      logger.debug({ err }, 'RaiFactorySuite ping failed')
      return false
    }
  }
}
