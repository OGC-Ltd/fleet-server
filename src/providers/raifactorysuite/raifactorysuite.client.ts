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

/**
 * A row of the plant/fleet register — `GET /machines`. Undocumented; shape
 * read off the live endpoint 2026-10-01, when it held 366 rows, all
 * `MUFINDI PAPER MILLS` (NDHIWA returns `[]`).
 *
 *   • `gpsUnitId` is the WIALON unit id (e.g. "30356417"), set on 183 rows and
 *     unique where set — the only exact join to our KASULU vehicles.
 *   • `consumptionBasis` HOUR pairs with `rateUnit` "Ltrs/Hr" (or "Ltr/Hr"),
 *     KM_PER_LITRE with "Kms/Ltr": `expectedConsumption` is L/h or km/L
 *     accordingly. Null on 107 rows.
 *   • `registrationNumber` is null on 86 rows (hand compactors, small
 *     generators); `reference` ("BH-01") is always set.
 *   • `limit`, `offset` and `factoryCode` are accepted and change nothing.
 */
export interface RaiFactorySuiteMachineRow {
  id:                  string
  factoryCode:         string
  reference:           string
  registrationNumber?: string | null
  name?:               string | null
  category?:           string | null
  makeModel?:          string | null
  fuelType?:           string | null
  contractor?:         string | null
  consumptionBasis?:   'HOUR' | 'KM_PER_LITRE' | string | null
  expectedConsumption?: number | null
  rateUnit?:           string | null
  fuelSensorFitted?:   boolean | null
  gpsUnitId?:          string | null
  status?:             string | null
  downReason?:         string | null
  downSince?:          string | null
  lastServiceMeter?:   number | null
  lastServiceAt?:      string | null
  active?:             boolean | null
}

/**
 * One machine-shift on a work plan — a line of `GET /fuel/plans`. Read off the
 * live endpoint 2026-11-14 (225 lines). `machine` is the register's
 * `reference` ("EX-01", or a hired truck's plate "T895DSZ") — all 70 distinct
 * machines on the first week of plans matched `/machines` by reference, 63 of
 * them with a `gpsUnitId`. A machine working day and night has a line per
 * shift. `plannedKm` is set only for units rated by distance; `litresRequested`
 * only when `fullTank` is false.
 */
export interface RaiFactorySuiteWorkPlanLine {
  id:               string
  taskId:           string                // "T-261114-ROA-8-01"
  machine:          string                // register reference
  machineName?:     string | null         // "Excavator", "Hired Truck"
  activity:         string
  unit?:            string | null         // unit of the activity ("m", "CUBIC M")
  workLocation?:    string | null         // "Zone 4", "Nursery A", "Intake 3"
  fuelingLocation?: string | null
  operator?:        string | null
  secondOperator?:  string | null
  thirdOperator?:   string | null
  supervisor?:      string | null
  shiftNo?:         number | null         // 1, 2 or 3
  crews?:           number | null
  shiftStart?:      string | null         // "06:00:00", local wall clock
  plannedHours?:    number | null
  litresRequested?: number | null
  fullTank?:        boolean | null
  plannedKm?:       number | null
  expectedOutput?:  number | null
  outputUnit?:      string | null         // "Trips", "Mtrs", "Pcs"
  decision?:        string | null         // reviewer's per-line decision
  decisionNote?:    string | null
  active?:          boolean | null
  notes?:           string | null
}

/**
 * A department's work plan for a day — `GET /fuel/plans?from&to`. FactorySuite's
 * "Work Plans" screen: a department head plans the day's machines, an admin (or
 * the control room) approves it, and at 17:00 the evening before each line is
 * released as that machine's fuel request. Only machines on an approved plan
 * can be fuelled.
 *
 * Measured 2026-11-14 — unlike the weighment feeds, this window is real:
 *   • `from`/`to` (YYYY-MM-DD) are both required, `to` is INCLUSIVE, and they
 *     filter on the plan's own date; over 31 days is refused.
 *   • `factoryCode` and `limit` are honoured (limit 500 by default, max 1000).
 *   • Only MUFINDI PAPER MILLS (our KASULU) and SANDBOX have plans. FactorySuite
 *     wiped its test plans on 2026-11-09, so real ones start 2026-11-11.
 *   • No webhook announces a plan; `fuel.request.decided` fires per released
 *     line. Poll to keep up.
 * Status seen: DRAFT, SUBMITTED, APPROVED.
 */
export interface RaiFactorySuiteWorkPlanRow {
  id:            string
  factoryCode:   string
  planCode:      string                   // "WP-261114-ROA-8"
  department:    string                   // ROADS, IRRIGATION, AGRICULTURE, FACTORY
  title?:        string | null
  startDate:     string                   // YYYY-MM-DD
  endDate:       string
  status:        string
  submittedBy?:  string | null
  submittedAt?:  string | null            // offsetless local wall clock
  reviewedBy?:   string | null
  reviewedAt?:   string | null
  decisionNote?: string | null
  lines?:        RaiFactorySuiteWorkPlanLine[] | null
}

/**
 * A machine-shift's fuel request — `GET /fuel/requests?from&to` (≤ 31 days,
 * `factoryCode` honoured). Each released work plan line becomes one, keyed by
 * machine, day and shift (it carries no line id). Read off the live endpoint
 * 2026-11-14: only SANDBOX had rows; MUFINDI PAPER MILLS had none from
 * 15 Sep to 15 Nov, so the shape is SANDBOX's. Status seen: APPROVED.
 */
export interface RaiFactorySuiteFuelRequestRow {
  id:               string
  factoryCode?:     string | null
  machine:          string                // register reference
  department?:      string | null
  planDate:         string                // YYYY-MM-DD
  shift?:           number | null
  plannedHours?:    number | null
  litresRequested?: number | null
  fullTank?:        boolean | null
  status?:          string | null
  offPlan?:         boolean | null
  serviceOverdue?:  boolean | null
  decisionNote?:    string | null
  slotStart?:       string | null
  slotEnd?:         string | null
  reviewedAt?:      string | null         // offsetless local wall clock
}

/**
 * One fuelling at the pump — `GET /fuel/issues?from&to` (`factoryCode`
 * honoured), its own feed, tied to the request it filled by `requestId`.
 * Read off the live endpoint 2026-11-14 (SANDBOX only, as the requests). The
 * readings are the machine's meter (km or hours) before, as estimated, and as
 * read at the pump; the three mismatch flags and `flagNotes` are the pump's
 * own checks.
 */
export interface RaiFactorySuiteFuelIssueRow {
  id:                 string
  factoryCode?:       string | null
  machine:            string
  machineName?:       string | null
  issueDate:          string              // YYYY-MM-DD
  department?:        string | null
  location?:          string | null       // the pump
  tank?:              string | null
  operator?:          string | null       // the machine's operator
  activity?:          string | null
  fuelingStart?:      string | null       // offsetless local wall clock
  fuelingEnd?:        string | null
  fuelingMinutes?:    number | null
  previousReading?:   number | null
  estimatedReading?:  number | null
  physicalReading?:   number | null
  quantityIssued?:    number | null
  operatorMismatch?:  boolean | null
  deviationFromPlan?: boolean | null
  jobMismatch?:       boolean | null
  flagNotes?:         string | null
  completed?:         boolean | null
  requestId?:         string | null
  /** The fuel voucher, "SIV-000027" (seen 2026-11-19). */
  siv?:               string | null
  /**
   * FactorySuite's own probe check, added by 2026-11-19: the tank before and
   * after the fuelling read off the unit's Wialon fuel sensor (with the same
   * calibration we use), the rise, and its gap to the litres issued.
   * `sensorCheck` is MATCH, MISMATCH or NO_SENSOR; the times carry a Z.
   */
  sensorBeforeLitres?: number | null
  sensorBeforeAt?:     string | null
  sensorAfterLitres?:  number | null
  sensorAfterAt?:      string | null
  sensorRiseLitres?:   number | null
  sensorGapPercent?:   number | null
  sensorCheck?:        string | null
  sensorSummary?:      string | null
  sensorRoomLitres?:   number | null
  sensorNotFull?:      boolean | null
}

/**
 * Auto Workshop feeds (`/workshop/*`), read off the live endpoints on
 * 2026-11-18. Only MUFINDI PAPER MILLS (our KASULU) uses the module. Every
 * time is an OFFSETLESS East Africa wall clock (07:00 is the busiest hour).
 *
 * `/workshop/job-cards` ignores from/to, limit and factoryCode and returns
 * the whole set. `/workshop/parts` returns 500 rows by default and at most
 * 1000 with `limit`, with no offset or page, so the catalogue can be cut short.
 * The UI's other workshop routes (stores, stock movements, services due,
 * technicians) 404 for an API key.
 */
export interface RaiFactorySuiteJobCardRow {
  id:                string
  factoryCode:       string
  cardNumber:        string              // "MUFINDI PAPER MILLS-JC-2026-0247"
  machine:           string              // the /machines reference
  status:            string              // IN_PROGRESS | AWAITING_PARTS | RELEASED | ...
  source?:           string | null
  priority?:         string | null       // "Urgent", "NORMAL", "NOEMAL"... (free text)
  checkedInAt?:      string | null
  meterReadingIn?:   number | null
  fuelLevelIn?:      number | null
  fuelSourceIn?:     string | null
  reportedFault?:    string | null
  category?:         string | null       // MINOR | MAJOR | OTHER
  diagnosis?:        string | null
  confirmedDownAt?:  string | null
  repairStartedAt?:  string | null
  partsRequestedAt?: string | null
  partsReceivedAt?:  string | null
  workCompletedAt?:  string | null
  releasedAt?:       string | null
  service?:          boolean | null
  serviceType?:      string | null
  meterReadingOut?:  number | null
  fuelLevelOut?:     number | null
  fuelSourceOut?:    string | null
  fuelDiscrepancy?:  boolean | null
  labourCost?:       number | null
  partsCost?:        number | null
}

export interface RaiFactorySuiteBreakdownRow {
  id:              string
  factoryCode:     string
  machine:         string
  reportedFault?:  string | null
  location?:       string | null
  status:          string              // CONFIRMED, ...
  reportedAt?:     string | null
  decidedAt?:      string | null
  decisionNote?:   string | null
  jobCardNumber?:  string | null
}

/** No requisition had been raised on 2026-11-18: only id and factoryCode are assumed. */
export interface RaiFactorySuiteRequisitionRow {
  id:              string
  factoryCode:     string
  status?:         string | null
  jobCardNumber?:  string | null
  [field: string]: unknown
}

export interface RaiFactorySuitePartRow {
  id:              string
  factoryCode:     string
  partNumber:      string
  description?:    string | null
  unit?:           string | null
  quantityOnHand?: number | null
  minimumLevel?:   number | null
  unitCost?:       number | null
  supplier?:       string | null
  active?:         boolean | null
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

  /** The machine register — see RaiFactorySuiteMachineRow. Whole set always. */
  async listMachines(): Promise<RaiFactorySuiteMachineRow[]> {
    return this.get<RaiFactorySuiteMachineRow>('/machines?limit=5000')
  }

  /** Work plans whose day falls in `from`..`to` (both inclusive, ≤ 31 days) —
   *  see RaiFactorySuiteWorkPlanRow. */
  async listWorkPlans(from: string, to: string, factoryCode?: string): Promise<RaiFactorySuiteWorkPlanRow[]> {
    const q = new URLSearchParams({ from, to, limit: '1000' })
    if (factoryCode) q.set('factoryCode', factoryCode)
    return this.get<RaiFactorySuiteWorkPlanRow>(`/fuel/plans?${q}`)
  }

  /** Fuel requests whose day falls in `from`..`to` (≤ 31 days) — see
   *  RaiFactorySuiteFuelRequestRow. */
  async listFuelRequests(from: string, to: string, factoryCode?: string): Promise<RaiFactorySuiteFuelRequestRow[]> {
    const q = new URLSearchParams({ from, to, limit: '1000' })
    if (factoryCode) q.set('factoryCode', factoryCode)
    return this.get<RaiFactorySuiteFuelRequestRow>(`/fuel/requests?${q}`)
  }

  /** Fuel issued at the pump whose day falls in `from`..`to` — see
   *  RaiFactorySuiteFuelIssueRow. */
  async listFuelIssues(from: string, to: string, factoryCode?: string): Promise<RaiFactorySuiteFuelIssueRow[]> {
    const q = new URLSearchParams({ from, to, limit: '1000' })
    if (factoryCode) q.set('factoryCode', factoryCode)
    return this.get<RaiFactorySuiteFuelIssueRow>(`/fuel/issues?${q}`)
  }

  /** Every workshop job card (the feed ignores any window). */
  async listJobCards(): Promise<RaiFactorySuiteJobCardRow[]> {
    return this.get<RaiFactorySuiteJobCardRow>('/workshop/job-cards?limit=5000')
  }

  /** Breakdowns reported in `from`..`to` (needs both, ≤ 31 days). */
  async listBreakdowns(from: string, to: string): Promise<RaiFactorySuiteBreakdownRow[]> {
    const q = new URLSearchParams({ from, to, limit: '1000' })
    return this.get<RaiFactorySuiteBreakdownRow>(`/workshop/breakdowns?${q}`)
  }

  async listWorkshopRequisitions(): Promise<RaiFactorySuiteRequisitionRow[]> {
    return this.get<RaiFactorySuiteRequisitionRow>('/workshop/requisitions?limit=1000')
  }

  /** The parts catalogue with stock, cut at 1000 rows by the provider. */
  async listParts(): Promise<RaiFactorySuitePartRow[]> {
    return this.get<RaiFactorySuitePartRow>('/workshop/parts?limit=1000')
  }

  /** The driver register (`GET /drivers`), one factory or all. Rows as the
   *  provider sends them: they carry personal details (ID number, phone,
   *  photo links), so a caller keeps only what it needs. */
  async listDrivers(factoryCode?: string, limit = 2000): Promise<Record<string, unknown>[]> {
    const q = new URLSearchParams({ limit: String(limit), ...(factoryCode ? { factoryCode } : {}) })
    return this.get<Record<string, unknown>>(`/drivers?${q}`)
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
