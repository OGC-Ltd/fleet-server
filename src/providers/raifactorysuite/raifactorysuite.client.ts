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

/** A sales run. `tonnage` is the only weight this integration receives from
 *  anywhere — see Dispatch.tonnageT. */
export interface RaiFactorySuiteSaleRow {
  id:                 string
  factoryCode:        string
  vehicleNumberPlate: string
  driverName?:        string | null
  tonnage?:           number | null
  destination?:       string | null
  status?:            string | null
  signOutTime?:       string | null
  signOutPhotoUrl?:   string | null
  returnTime?:        string | null
  returnPhotoUrl?:    string | null
}

/**
 * A cane-delivery ticket: one lorry, one token, weighed empty and loaded at a
 * single bridge.
 *
 * `*Time` fields are HHMM INTEGERS, not minutes — `1138` is 11:38 and `2` is
 * 00:02. Read as minutes past midnight they look plausible for half the day
 * and then quietly exceed 24 h (`1641` would be 27:21), which is the kind of
 * wrong that produces a chart rather than an error. The matching `*Date` is
 * always midnight; the two are recombined in `weighmentAt`.
 */
export interface RaiFactorySuiteCaneDeliveryRow {
  category:            'CANE_DELIVERY'
  /** Whose scale software wrote it: NDHIWA, KABRAS or NZOIA as of 2026-09-25.
   *  Absent on the rows seen before ~2026-09-17, when the feed was Ndhiwa's
   *  alone. Centre codes are per factory — 101 is a different yard at each. */
  factoryCode?:        string | null
  tokenNumber:         number
  tokenDate:           string
  tokenTime:           number
  vehicleNo:           string
  driverName:          string
  grossDate?:          string | null
  grossTime?:          number | null
  grossOperator?:      string | null
  grossWeight?:        number | null
  grossWeighbridgeNo?: number | null
  tareDate?:           string | null
  tareTime?:           number | null
  tareOperator?:       string | null
  tareWeight?:         number | null
  tareWeighbridgeNo?:  number | null
  netWeight?:          number | null
  /** Ndhiwa: 101 FACTORY · 102 OPAPO · 103 OYANI · 104 NYAONDO, measured
   *  2026-09-10. Per factory, not global — see `factoryCode`. */
  centerCode:          number
  centerName:          string
  /** Null on all 729 rows measured — modelled upstream, not populated. */
  productCode?:        string | null
  productName?:        string | null
}

/**
 * A cane-transfer ticket: weighed at an outstation, carried in, weighed again
 * at the factory. Four weighings on one token.
 *
 * It names its origin as `centerFrom` — a CODE with no name beside it, unlike
 * a delivery. The name comes from the delivery feed's own code→name mapping.
 */
export interface RaiFactorySuiteCaneTransferRow {
  category:                 'CANE_TRANSFER'
  factoryCode?:             string | null
  tokenNumber:              number
  tokenDate:                string
  tokenTime:                number
  vehicleNo:                string
  driverName:               string
  centerTareDate?:          string | null
  centerTareTime?:          number | null
  centerTareOperator?:      string | null
  centerTareWeight?:        number | null
  centerTareWeighbridgeNo?: number | null
  centerGrossDate?:         string | null
  centerGrossTime?:         number | null
  centerGrossOperator?:     string | null
  centerGrossWeight?:       number | null
  centerGrossWeighbridgeNo?: number | null
  centerNetWeight?:         number | null
  factoryGrossDate?:        string | null
  factoryGrossTime?:        number | null
  factoryGrossOperator?:    string | null
  factoryGrossWeight?:      number | null
  factoryGrossWeighbridgeNo?: number | null
  factoryTareDate?:         string | null
  factoryTareTime?:         number | null
  factoryTareOperator?:     string | null
  factoryTareWeight?:       number | null
  factoryTareWeighbridgeNo?: number | null
  factoryNetWeight?:        number | null
  /** The outstation the load came from, as a code. Never 101 (the factory).
   *  Null on the Kabras and Nzoia rows, which name the yard in `centerCode` /
   *  `centerName` instead and carry the yard's weights at the top level. */
  centerFrom:               number | null
  centerCode?:              number | null
  centerName?:              string | null
  grossWeight?:             number | null
  tareWeight?:              number | null
  netWeight?:               number | null
  status?:                  string | null
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

  /**
   * Sales runs — finished sugar leaving for a customer.
   *
   * Undocumented when this was written; the shape below was read off the live
   * endpoint on 2026-09-09. Two quirks worth knowing before adding a filter:
   *
   *   • `status` is ACCEPTED AND IGNORED. Every value returns the full set, so
   *     there is no "give me only the open ones" — the caller reconciles the
   *     whole window and decides for itself. (`/dispatches` has the same
   *     disease with `offset`.)
   *   • `factoryCode` IS honoured, and an unknown one is a hard error rather
   *     than an empty list: `{"error":"Unknown factory code: ZZZZ"}`. So it is
   *     only ever sent from FACTORIES, never from a provider-supplied string.
   *
   * There is no `/sales/{id}` — that 404s — so enrichment means re-reading the
   * collection.
   */
  async listSales(factoryCode?: string, limit = 500): Promise<RaiFactorySuiteSaleRow[]> {
    const q = factoryCode ? `factoryCode=${encodeURIComponent(factoryCode)}&limit=${limit}` : `limit=${limit}`
    return this.get<RaiFactorySuiteSaleRow>(`/sales?${q}`)
  }

  /**
   * Weighbridge tickets, one endpoint per flow.
   *
   * Both take `from`/`to` as `YYYY-MM-DD`, and all three things you would
   * assume about that window are wrong. Measured 2026-09-10:
   *
   *   • **`to` is EXCLUSIVE.** `from=09-09&to=09-09` returns zero rows, not a
   *     day's worth. A caller asking for "today" must pass tomorrow as `to`.
   *   • **Both are required** — omitting either is a bare `400` with no
   *     message, which is indistinguishable from a bad key until you try it.
   *   • **They do not filter on the ticket's own date.** Asking for
   *     `09-09 → 09-11` returns rows dated 09-08, and asking for a nine-day
   *     window returns exactly the same 729 rows a one-day window does. What
   *     comes back is the provider's recent set — about two days — whatever
   *     you ask for. Windows wider than 31 days are refused outright
   *     (`{"error":"Date range too wide …"}`).
   *
   * The consequence is the whole reason `weighments` is a table: history
   * cannot be re-fetched, so every row seen must be stored, and a gap in our
   * polling is a permanent hole rather than a backfill job.
   */
  async listCaneDeliveries(from: string, to: string): Promise<RaiFactorySuiteCaneDeliveryRow[]> {
    return this.get<RaiFactorySuiteCaneDeliveryRow>(
      `/weighment/cane-delivery?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    )
  }

  async listCaneTransfers(from: string, to: string): Promise<RaiFactorySuiteCaneTransferRow[]> {
    return this.get<RaiFactorySuiteCaneTransferRow>(
      `/weighment/cane-transfer?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    )
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
