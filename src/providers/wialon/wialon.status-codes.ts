/**
 * The tracker's own status codes, judged by the account's own labels.
 *
 * ## Why (operator, 2026-11-27)
 *
 * "Look in the errors in the messages transmitted by the trackers." The Wialon
 * alert rules that used to report probe disconnections stopped saving alerts
 * on 1 Nov 2026, but the trackers still send the codes those rules read. A
 * survey of every unit's latest message that day found status sensors the
 * installers labelled, value by value, in each sensor's `ci` map:
 *
 *   Fls Status (flls1, 423 units)       0 Off, 1 Not Ready, 2 Ready, 3 Error
 *   BLE Probe Status (io_270, 767)      0 Sensor not Paired, 1 No Fuel Error, 2 Healthy, ...
 *   BLE Probe Temperature (io_25, 768)  32765 Abnormal State, 32766 Sensor Failed, 32767 Sensor Not Found
 *   BLE Probe Battery (io_29/10, 768)   0 / 3.2 Needs Replacement, 3.3 Degrading, 3.5 Healthy
 *   GNSS Status (io_69, 768)            0 Off, 1 On with Fix, 2 On without Fix, 3 Sleep, 4 ON with fix, invalid data
 *
 * 57 units then sat on Fls "Error" (KDJ 813Z among them, reading 0 L), and the
 * fault check of 2026-11-25 (readFuelProbeFault) saw none of them: it judges
 * the level line above its calibrated range, and "0" is inside it.
 *
 * ## Judged by the label, never by the number
 *
 * The same number means different things on different sensors ("0" is Off on
 * one and Not Paired on another), so a value is judged only through the label
 * the account wrote for it. A label that names a fault is a fault, one that
 * names health is a recovery, anything else ("Off", "Sleep", a value with no
 * label) is neither: it neither opens a record nor closes one.
 *
 * Pure: the adapter keeps the clock (how long a fault has lasted).
 */

import type { WialonSensor } from './wialon.sensors.js'

/** Episode kinds these codes feed (sensor_fault_episodes.kind). */
export type TrackerStatusKind = 'fuel_probe_status' | 'fuel_probe_battery' | 'gnss_fault'

export interface TrackerStatusFault { kind: TrackerStatusKind; reason: string; raw: number }
export interface TrackerStatusRead { faults: TrackerStatusFault[]; ok: TrackerStatusKind[] }

interface Family {
  /** Which sensors, by the name the account gave them. */
  name: RegExp
  kind: TrackerStatusKind
  fault: RegExp
  healthy: RegExp
  words: (label: string, value: number) => string
}

/** Order matters only for the words: a unit with two probe faults gets both reasons, status first. */
const FAMILIES: Family[] = [
  { name: /\bfls\s*status\b/i, kind: 'fuel_probe_status',
    fault: /\berror\b/i, healthy: /^(ready|healthy)$/i, // one unit labels 2 'Healthy' (2026-11-27)
    words: (l) => `Fuel probe: Status ${l}` }, // 'Status Error': the FCR note strips 'Fuel probe: '
  { name: /\bprobe\w*\s+status\b/i, kind: 'fuel_probe_status',
    fault: /no fuel error|not paired/i, healthy: /^healthy$/i,
    words: (l) => `Fuel probe: ${l}` },
  { name: /\bprobe\w*\s+temperature\b/i, kind: 'fuel_probe_status',
    fault: /abnormal|sensor failed|not found/i, healthy: /$^/, // a plain temperature has no label: neither
    words: (l) => `Fuel probe: ${l}` },
  { name: /\bprobe\w*\s+battery\b/i, kind: 'fuel_probe_battery',
    fault: /needs replacement|degrading/i, healthy: /^(healthy|heathly)$/i, // 'Heathly' on most units, 'Healthy' on some
    words: (l, v) => `Fuel probe battery: ${l} (${v.toFixed(2)} V)` },
  { name: /\bgnss\s+status\b/i, kind: 'gnss_fault',
    fault: /without fix|invalid data/i, healthy: /^on with fix$/i,
    words: (l) => `GPS: ${l}` },
]

/** A sensor's value from a message: `p`, `p*constN` or `p/constN`. Null for anything else or a missing parameter. */
export function sensorValue(expr: string, params: Record<string, unknown>): number | null {
  const m = /^\s*([A-Za-z_][\w]*)\s*(?:([*/])\s*const(\d+(?:\.\d+)?))?\s*$/.exec(expr ?? '')
  if (!m) return null
  const raw = params[m[1]!]
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  const k = m[3] != null ? Number(m[3]) : null
  // Rounded: Wialon sends the probe temperature already scaled (3276.6), and 3276.6 * 10 is
  // 32765.999… in floating point, which would take the label below (Abnormal for Sensor Failed).
  const round = (v: number) => Math.round(v * 1e6) / 1e6
  if (m[2] === '*' && k != null) return round(raw * k)
  if (m[2] === '/' && k) return round(raw / k)
  return raw
}

/** The account's label for a value: the entry with the highest key at or below it. */
export function labelFor(config: string | undefined, value: number): string | null {
  if (!config) return null
  let best: { at: number; text: string } | null = null
  for (const { at, text } of labelsOf(config)) {
    if (at > value) continue
    if (!best || at > best.at) best = { at, text }
  }
  return best?.text ?? null
}

/**
 * A sensor config's labels, parsed once per distinct config string: this runs on every message of
 * every unit, and a fleet has a few dozen distinct configs, not thousands. Bounded all the same.
 */
const parsedLabels = new Map<string, Array<{ at: number; text: string }>>()
function labelsOf(config: string): Array<{ at: number; text: string }> {
  const held = parsedLabels.get(config)
  if (held) return held
  let list: Array<{ at: number; text: string }> = []
  try {
    const ci = (JSON.parse(config) as { ci?: Record<string, { t?: string }> }).ci ?? {}
    list = Object.entries(ci).flatMap(([key, entry]) => {
      const at = Number(key)
      const text = entry?.t?.trim()
      return Number.isFinite(at) && text ? [{ at, text }] : []
    })
  } catch { /* a malformed config costs the label, nothing else */ }
  if (parsedLabels.size > 5_000) parsedLabels.clear()
  parsedLabels.set(config, list)
  return list
}

/** What one message says about the tracker's status sensors. */
export function readTrackerStatus(
  sensors: Record<string, WialonSensor> | undefined,
  params: Record<string, unknown> | null | undefined,
): TrackerStatusRead {
  const faults = new Map<TrackerStatusKind, TrackerStatusFault>()
  const ok = new Set<TrackerStatusKind>()
  if (!sensors || !params) return { faults: [], ok: [] }
  for (const fam of FAMILIES) {
    for (const s of Object.values(sensors)) {
      if (!s?.n || !fam.name.test(s.n)) continue
      // "Fls Status" also reads as a probe status: the first family owns it.
      if (fam !== FAMILIES[0] && FAMILIES[0]!.name.test(s.n)) continue
      const value = sensorValue(s.p, params)
      if (value == null) continue
      // The battery reads 0 when no probe answers: that is the probe's fault (temperature
      // "Sensor Not Found"), not a flat battery.
      if (fam.kind === 'fuel_probe_battery' && value <= 0) continue
      const label = labelFor(s.c, value)
      if (!label) continue
      if (fam.fault.test(label)) {
        const words = fam.words(label, value)
        const prev = faults.get(fam.kind)
        if (!prev) faults.set(fam.kind, { kind: fam.kind, reason: words, raw: value })
        else if (!prev.reason.includes(words)) prev.reason = `${prev.reason}; ${words}`
      } else if (fam.healthy.test(label)) {
        ok.add(fam.kind)
      }
    }
  }
  // A kind with a fault on any of its sensors is not healthy, whatever another sensor says.
  for (const k of faults.keys()) ok.delete(k)
  return { faults: [...faults.values()], ok: [...ok] }
}
