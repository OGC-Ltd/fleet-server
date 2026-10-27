/**
 * Which VSS device a vehicle carries — shared by the live camera
 * (modules/camera) and the dashcam alarms (modules/dashcam).
 *
 * VSS knows nothing of our ids. Its device record has a name and, sometimes, a
 * plate, typed by Control Tech's installers. Two naming styles are in use:
 *
 *   "MUFINDI: FT 13"     our plate "MUFINDI - FT 13"   → whole names compared
 *   "SUKARI - KDR 430Q"  our plate "KDR 430Q"          → the registration after
 *                                                         the org prefix compared
 *
 * Both sides are reduced to letters and digits, upper-cased. The registration
 * after the prefix counts only when it looks like one (6+ characters, letters
 * AND digits): a bare fleet number such as "FT 13" is never matched on its own,
 * since several organisations can have an FT 13 and a camera must never be
 * paired with another company's truck.
 *
 * Pure: no database, no network — so it is unit-tested directly.
 */

export interface MatchableDevice {
  deviceId: string
  name: string
  plate: string
  accessMode: number
}

/** "MUFINDI: FT 13" → "MUFINDIFT13". */
export function cameraKey(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * "SUKARI - KDR 430Q" / "AQUAMIST: KAV 274M" → "KDR430Q" / "KAV274M": the part
 * after the first ':' or '-', when it looks like a real registration.
 */
export function registrationTail(s: string | null | undefined): string | null {
  const m = /^[^:-]+?\s*(?::|\s-\s|-)\s*(.+)$/.exec(s ?? '')
  if (!m) return null
  const t = cameraKey(m[1])
  return t.length >= 6 && /[A-Z]/.test(t) && /\d/.test(t) ? t : null
}

/** "SUKARI - KDR 430Q" → "SUKARI": the organisation part of a device name. */
export function devicePrefix(s: string | null | undefined): string | null {
  const m = /^([^:-]+?)\s*(?::|\s-\s|-)\s*.+$/.exec(s ?? '')
  if (!m) return null
  const p = m[1].trim()
  return p.length >= 3 && !/^\d+$/.test(p) ? p : null
}

function keysOf(labels: (string | null | undefined)[]): Set<string> {
  const keys = new Set<string>()
  for (const l of labels) {
    const k = cameraKey(l)
    if (k.length >= 4) keys.add(k)
    const t = registrationTail(l)
    if (t) keys.add(t)
  }
  return keys
}

/**
 * The device for a vehicle known by these labels (its plate, its name). More
 * than one match (a box swapped and the old record left behind) prefers the
 * one that is online.
 */
export function matchDevice<D extends MatchableDevice>(devices: D[], labels: (string | null | undefined)[]): D | null {
  const keys = keysOf(labels)
  if (keys.size === 0) return null
  const hits = devices.filter((d) => [...keysOf([d.name, d.plate])].some((k) => keys.has(k)))
  return hits.find((d) => d.accessMode >= 1) ?? hits[0] ?? null
}
