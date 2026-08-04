/**
 * Shortening a provider place string to something an operator can read.
 *
 * The fuel system records where a filling happened as a full reverse-geocoded
 * address, administrative hierarchy and all:
 *
 *   "Ndhiwa-Uriri Rd., Kenya, Kanyikela Ward, Ndhiwa Sub County,
 *    Homa Bay County, Riat Centre"
 *
 * Every part of that after the first is true and none of it helps: an operator
 * looking at a Homa Bay fleet already knows it is in Kenya, in Homa Bay County,
 * and the ward and sub-county names are administrative units nobody navigates
 * by. What identifies the place is the road and the centre — "Ndhiwa-Uriri,
 * Riat Centre" — and the rest is six lines of card spent saying where Kenya is.
 *
 * So: drop the administrative tiers, drop the road TYPE suffix (the name is
 * "Ndhiwa-Uriri", the "Rd." is grammar), and keep the two most identifying
 * parts left. Nothing is invented — every word in the output was in the input.
 */

/**
 * Administrative tiers to drop. Matched on the WHOLE remaining part, so a place
 * genuinely called "County Hall" survives while "Homa Bay County" does not.
 */
const ADMIN_SUFFIX =
  /\b(ward|sub[-\s]?county|county|constituency|district|division|region|province|sub[-\s]?location|location|municipality)\b\.?$/i

/** Countries the fleets operate in. Naming them is never the useful part. */
const COUNTRIES = new Set(['kenya', 'tanzania', 'uganda'])

/** Road-type words, when they trail a name: "Ndhiwa-Uriri Rd." → "Ndhiwa-Uriri". */
const ROAD_SUFFIX = /\s+(rd|road|st|street|ave|avenue|hwy|highway|ln|lane|dr|drive|way)\.?$/i

/** How many parts survive into the label. Two is the readable ceiling on a chip. */
const MAX_PARTS = 2

function isNoise(part: string): boolean {
  const p = part.toLowerCase().replace(/\.$/, '').trim()
  if (!p) return true
  if (COUNTRIES.has(p)) return true
  if (/^\d{4,}$/.test(p)) return true          // bare postcodes
  return ADMIN_SUFFIX.test(part.trim())
}

/**
 * "Ndhiwa-Uriri, Riat Centre" from the full address above.
 *
 * Keeps the FIRST and LAST surviving parts when more than two remain: the
 * provider writes these most-specific-first and appends the named centre last,
 * so the ends carry the identity and the middle is the hierarchy between them.
 * Returns the input trimmed when there is nothing to strip, and null for empty
 * input — a caller must be able to tell "no location recorded" from a label.
 */
export function shortPlaceLabel(raw: string | null | undefined): string | null {
  if (!raw) return null
  const parts = String(raw).split(',').map(p => p.trim()).filter(Boolean)
  if (parts.length === 0) return null

  const kept: string[] = []
  for (const part of parts) {
    if (isNoise(part)) continue
    const cleaned = part.replace(ROAD_SUFFIX, '').trim()
    if (!cleaned) continue
    // Case-insensitive de-dupe: an address that names the town twice should
    // not spend both of its two slots on it.
    if (kept.some(k => k.toLowerCase() === cleaned.toLowerCase())) continue
    kept.push(cleaned)
  }

  // Everything was administrative — better the raw first part than nothing.
  if (kept.length === 0) return parts[0] ?? null
  if (kept.length <= MAX_PARTS) return kept.join(', ')
  return [kept[0], kept[kept.length - 1]].join(', ')
}
