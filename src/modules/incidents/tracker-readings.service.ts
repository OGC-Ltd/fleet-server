/**
 * A unit's tracker readings now (operator, 2026-11-27: "all the messages a tracker sends ... with
 * their status as per the time the report is generated", every reading the installer set up).
 *
 * Wialon calculates every sensor the way its own screen shows it (unit/calc_last_message), formulas
 * included; flag 1 takes each sensor's last VALID value, so a reading the tracker sends only in some
 * messages (KDJ 813Z's fuel probe, every other message) still has its value. -348201.3876 is
 * Wialon's "no value". Each reading carries the installer's label for its value (the sensor's `ci`)
 * and a verdict by those labels (wialon.status-codes labelVerdict). Read-only: two Wialon calls,
 * nothing stored; kept a minute per unit so a panel and its PDF do not ask twice.
 */
import { env } from '../../config/env.js'
import { prisma } from '../../lib/prisma.js'
import { WialonClient } from '../../providers/wialon/wialon.client.js'
import { labelFor, labelVerdict, sensorValue } from '../../providers/wialon/wialon.status-codes.js'
import { wialonIdOf } from '../reports/speed-report.service.js'

/** Wialon's "no value" for a sensor. */
export const WIALON_NO_VALUE = -348201.3876

export interface TrackerReading {
  /** The sensor's id on the unit, and its name, type, reading and unit as set up in Wialon. */
  id: string
  name: string
  type: string
  param: string
  unit: string | null
  /** Null: no value (none sent, or none Wialon can calculate). */
  value: number | null
  /** 'wialon' as Wialon calculates it; 'raw' the latest message's reading where Wialon gave none. */
  source: 'wialon' | 'raw' | null
  /** The installer's label for the value, where they set one. */
  label: string | null
  verdict: 'fault' | 'ok' | null
}

export interface TrackerReadings {
  vehicleId: string
  unitName: string | null
  /** When the tracker last sent anything, and what its position said then. */
  lastMessageAt: string | null
  satellites: number | null
  readings: TrackerReading[]
  /** Why there are none: no tracker bound, or Wialon could not be read. */
  reason?: 'no_tracker' | 'unavailable'
}

interface WialonSensorDef { id?: number; n?: string; t?: string; p?: string; m?: string; c?: string }

/**
 * For this report only (it records nothing): a label in plain fault or health words is judged by
 * them where the sensor is not one of the fault-record families ("Sensor not found" on an Fls
 * temperature, "Present" on an internal battery).
 */
const FAULT_WORDS = /\b(error|failed|failure|not found|needs replacement|contact support|abnormal|not paired|disconnected)\b/i
const OK_WORDS = /^(healthy|heathly|ready|ok|present|on with fix|connected)$/i
export const reportVerdict = (name: string, label: string | null): 'fault' | 'ok' | null => {
  const v = labelVerdict(name, label)
  if (v || !label) return v
  if (FAULT_WORDS.test(label)) return 'fault'
  if (OK_WORDS.test(label.trim())) return 'ok'
  return null
}

const sensorOrder = (name: string) => {
  const m = /^(\d+)\./.exec(name)
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
}

/**
 * The unit's sensors with Wialon's calculated values, labelled and judged, in the installer's order.
 * Where Wialon gives no value, the latest message's own reading for a plain sensor (`p`, `p*constN`,
 * `p/constN`) stands in: Wialon withholds a value out of a sensor's bounds, as it did for a BLE
 * probe status reading 1 ("No Fuel Error"), which is the reading a technician needs. Pure.
 */
export function readingsFrom(
  sens: Record<string, WialonSensorDef> | undefined,
  values: Record<string, unknown> | undefined,
  params: Record<string, unknown> | undefined = undefined,
): TrackerReading[] {
  const out: TrackerReading[] = []
  for (const [key, s] of Object.entries(sens ?? {})) {
    const id = String(s.id ?? key)
    const name = String(s.n ?? '').trim()
    if (!name) continue
    const raw = values?.[id]
    const calculated = typeof raw === 'number' && Number.isFinite(raw) && Math.abs(raw - WIALON_NO_VALUE) > 1e-6 ? raw : null
    const fallback = calculated == null && params ? sensorValue(String(s.p ?? ''), params) : null
    const value = calculated ?? fallback
    const label = value == null ? null : labelFor(s.c, value)
    out.push({
      id, name, type: String(s.t ?? ''), param: String(s.p ?? ''), unit: s.m ? String(s.m) : null,
      value, source: calculated != null ? 'wialon' : fallback != null ? 'raw' : null,
      label, verdict: reportVerdict(name, label),
    })
  }
  return out.sort((a, b) => sensorOrder(a.name) - sensorOrder(b.name) || a.name.localeCompare(b.name))
}

const held = new Map<string, { at: number; data: TrackerReadings }>()
const HOLD_MS = 60_000

export async function trackerReadings(orgId: string, vehicleId: string, now = Date.now()): Promise<TrackerReadings | null> {
  const key = `${orgId}|${vehicleId}`
  const hit = held.get(key)
  if (hit && now - hit.at < HOLD_MS) return hit.data
  const v = await prisma.vehicle.findFirst({
    where: { id: vehicleId, organisationId: orgId },
    select: { name: true, registrationPlate: true, deviceId: true },
  })
  if (!v) return null
  const unitName = v.name ?? v.registrationPlate ?? null
  const wialonId = wialonIdOf(v.deviceId)
  if (wialonId == null) return { vehicleId, unitName, lastMessageAt: null, satellites: null, readings: [], reason: 'no_tracker' }
  const client = new WialonClient(env.WIALON_TOKEN || process.env['access_token'] || '', env.WIALON_API_URL)
  let data: TrackerReadings
  try {
    const item = await client.call<{ item?: { nm?: string; lmsg?: { t?: number; p?: Record<string, unknown>; pos?: { sc?: number } }; sens?: Record<string, WialonSensorDef> } }>(
      'core/search_item', { id: wialonId, flags: 0x1 | 0x400 | 0x1000 })
    const values = await client.call<Record<string, unknown>>('unit/calc_last_message', { unitId: wialonId, sensors: [], flags: 1 })
    const u = item.item
    data = {
      vehicleId,
      unitName: u?.nm ?? unitName,
      lastMessageAt: typeof u?.lmsg?.t === 'number' ? new Date(u.lmsg.t * 1000).toISOString() : null,
      satellites: typeof u?.lmsg?.pos?.sc === 'number' ? u.lmsg.pos.sc : null,
      readings: readingsFrom(u?.sens, values, u?.lmsg?.p),
    }
  } catch {
    data = { vehicleId, unitName, lastMessageAt: null, satellites: null, readings: [], reason: 'unavailable' }
  } finally {
    await client.logout().catch(() => { /* best effort */ })
  }
  if (!data.reason) held.set(key, { at: now, data })
  if (held.size > 2000) held.clear()
  return data
}
