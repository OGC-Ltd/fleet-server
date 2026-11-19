/**
 * GET /api/v1/iam/factorysuite/drivers-check[?factoryCode=…]
 *
 * Does FactorySuite's driver register hold Mufindi's (KASULU's) drivers, and
 * under which factory code? (operator, 2026-11-19, before adding Mufindi to
 * prisma/sync-drivers.ts, which maps NDHIWA → SUKARI only). Asks the register
 * once, with the server's own FactorySuite key, and answers with counts and
 * field names only: no names, ID numbers, phones or photo links leave here.
 *
 * Read-only: nothing is stored. System Administrator only (iam.routes).
 */
import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { BadRequestError } from '../../core/errors/errors.js'
import { RaiFactorySuiteClient } from '../../providers/raifactorysuite/raifactorysuite.client.js'

export interface DriversCheck {
  factoryCode: string | null
  total: number
  active: number
  byFactoryCode: Record<string, number>
  byType: Record<string, number>
  /** Every field name the rows carry, and on how many rows each is filled. */
  fields: Record<string, number>
}

const label = (v: unknown) => (v == null || v === '' ? '(none)' : String(v))
const filled = (v: unknown) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0)

/** Pure: the register's rows reduced to counts and field names. */
export function summariseDrivers(rows: readonly Record<string, unknown>[], factoryCode: string | null): DriversCheck {
  const out: DriversCheck = { factoryCode, total: rows.length, active: 0, byFactoryCode: {}, byType: {}, fields: {} }
  for (const r of rows) {
    if (r['active'] === true || String(r['status'] ?? '').toUpperCase() === 'ACTIVE') out.active += 1
    const fc = label(r['factoryCode'])
    out.byFactoryCode[fc] = (out.byFactoryCode[fc] ?? 0) + 1
    const t = label(r['driverType'] ?? r['type'])
    out.byType[t] = (out.byType[t] ?? 0) + 1
    for (const [k, v] of Object.entries(r)) {
      out.fields[k] = (out.fields[k] ?? 0) + (filled(v) ? 1 : 0)
    }
  }
  return out
}

let clientInstance: RaiFactorySuiteClient | null = null
const client = () => (clientInstance ??= new RaiFactorySuiteClient())

export const driversCheck: RequestHandler = async (req, res, next) => {
  try {
    const raw = req.query['factoryCode']
    const factoryCode = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 80) : null
    if (!client().isConfigured) throw new BadRequestError('This server has no FactorySuite key.')
    const rows = await client().listDrivers(factoryCode ?? undefined)
    sendSuccess(res, summariseDrivers(rows, factoryCode))
  } catch (err) { next(err) }
}
