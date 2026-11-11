/**
 * Open Location Codes ("plus codes") as Wialon writes them in an itinerary's
 * Address when the dispatcher picked a point Google had no street for:
 * "RWG9+WC9, Ahero, Kenya", "WQ8F+7C Kisumu, Kenya". Those are SHORT codes
 * (the first four characters dropped), recovered against a nearby point —
 * the stop before or after in the same itinerary, which is always well
 * within the half degree the recovery needs.
 *
 * Follows the published algorithm (github.com/google/open-location-code):
 * pairs of base-20 digits, latitude then longitude, at 20°, 1°, 0.05°,
 * 0.0025° and 0.000125°; a grid character after ten digits is ignored here
 * (it refines to ~3 m, finer than any fence). Pure.
 */

const ALPHABET = '23456789CFGHJMPQRVWX'
const RES = [20, 1, 0.05, 0.0025, 0.000125]

/** A plus code inside an address, full or short. */
export const PLUS_CODE_RE = /(?:^|[\s,])((?:[23456789CFGHJMPQRVWX]{2}){2,4}\+[23456789CFGHJMPQRVWX]{0,3})(?=$|[\s,])/i

export function findPlusCode(s: string): string | null {
  const m = PLUS_CODE_RE.exec(s)
  return m ? m[1].toUpperCase() : null
}

/** The centre of a full code's area (8 to 11 characters, '+' after the eighth). */
export function decodeFull(code: string): { lat: number, lng: number } | null {
  const c = code.toUpperCase().replace('+', '').replace(/0+$/, '')
  if (c.length < 8) return null
  let lat = -90
  let lng = -180
  const pairs = Math.min(5, Math.floor(c.length / 2))
  for (let i = 0; i < pairs; i++) {
    const a = ALPHABET.indexOf(c[i * 2])
    const b = ALPHABET.indexOf(c[i * 2 + 1])
    if (a < 0 || b < 0) return null
    lat += a * RES[i]
    lng += b * RES[i]
  }
  const last = RES[pairs - 1]
  return { lat: lat + last / 2, lng: lng + last / 2 }
}

/** The first `pairs` digit pairs of a point's code, no separator. */
export function encodePairs(lat: number, lng: number, pairs: number): string {
  let la = Math.min(Math.max(lat, -90), 90 - 1e-9) + 90
  let lo = ((((lng + 180) % 360) + 360) % 360)
  let out = ''
  for (let i = 0; i < pairs; i++) {
    const a = Math.floor(la / RES[i] + 1e-9)
    const b = Math.floor(lo / RES[i] + 1e-9)
    out += ALPHABET[a] + ALPHABET[b]
    la -= a * RES[i]
    lo -= b * RES[i]
  }
  return out
}

/** A full code's point, or a short code's recovered against the nearest place it can be to `ref`. */
export function decodePlusCode(code: string, ref: { lat: number, lng: number } | null): { lat: number, lng: number } | null {
  const c = code.toUpperCase()
  const sep = c.indexOf('+')
  if (sep === 8) return decodeFull(c)
  if (sep < 2 || sep > 8 || sep % 2 || !ref) return null
  const padding = 8 - sep
  const resolution = 20 ** (2 - padding / 2)
  const half = resolution / 2
  const prefix = encodePairs(ref.lat, ref.lng, padding / 2)
  const area = decodeFull(prefix + c)
  if (!area) return null
  let { lat, lng } = area
  if (ref.lat + half < lat && lat - resolution >= -90) lat -= resolution
  else if (ref.lat - half > lat && lat + resolution <= 90) lat += resolution
  if (ref.lng + half < lng) lng -= resolution
  else if (ref.lng - half > lng) lng += resolution
  return { lat, lng }
}
