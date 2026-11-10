/**
 * An existing geofence for a customer, before the Planner draws a new circle
 * (operator, 2026-11-11: "recall an available geofence, you do not need to
 * redraw"). Menengai already holds thousands of zones imported from Wialon,
 * among them a fence for many of its shops (MENENGAI_VS:<SHOP NAME>), so a
 * customer arriving on its first sheet often has one already.
 *
 * A fence is taken without asking only by name: every significant word of
 * the customer's name is in a fence within MATCH_NEAR_M of the sheet's point
 * (or every word of a small fence's name is in the customer's, or one name
 * run together is inside the other, WA MUIRU and WAMUIRU), the nearest one.
 *
 * Never by place alone. Checked on KDE 128E's sheet against Menengai's zones
 * (2026-11-11): shops stand metres apart and their fences overlap, so a sheet
 * point inside a fence is often inside the shop next door's (ADONAI GEN SHOP's
 * point lies in MATUNDA WHOLESALERS). Everything near the point is offered on
 * the preview instead, nearest first, and a new 100 m circle stays the default.
 */

/** How far from the sheet's point a fence is looked for, and offered. */
export const MATCH_NEAR_M = 1000
/** A fence up to this area is shop sized (a 280 m circle is about this). */
export const SMALL_M2 = 250_000
/** Fences bigger than this (a town, an estate) are never offered for a shop. */
export const BIG_M2 = 2_000_000
/** How many nearby fences the preview offers. */
export const OFFER = 6

export interface NearFence { id: string, name: string, distanceM: number, areaM2: number }
export interface FenceOption { id: string, name: string, distanceM: number, byName: boolean }
export interface FencePick { match: (FenceOption & { by: 'name' }) | null, options: FenceOption[] }

/** Words that say what kind of shop it is, not which one. */
const GENERIC = new Set([
  'SHOP', 'SHOPS', 'STORE', 'STORES', 'SUPERMARKET', 'SUPERMARKETS', 'MINIMARKET', 'MINI', 'MARKET', 'MART',
  'GEN', 'GENERAL', 'LTD', 'LIMITED', 'COMPANY', 'ENTERPRISE', 'ENTERPRISES', 'THE', 'AND', 'WHOLESALE',
  'WHOLESALERS', 'DISTRIBUTORS', 'DISTRIBUTOR', 'RETAIL', 'AGENCIES', 'AGENCY', 'TRADERS', 'TRADING',
  'MENENGAI', 'DEPOT', 'OUTLET', 'KIOSK',
])

const tokens = (s: unknown) => String(s ?? '').toUpperCase().replace(/^[^:]*:/, '').split(/[^A-Z0-9]+/).filter(Boolean)

/** A name's significant words: the provider prefix dropped (MENENGAI_VS:), generic words out. */
export function nameWords(s: unknown): string[] {
  return tokens(s).filter((t) => t.length >= 3 && !GENERIC.has(t))
}

/** The name run together, generic words out but short ones kept: WA MUIRU SHOP is WAMUIRU. */
export function nameRun(s: unknown): string {
  return tokens(s).filter((t) => !GENERIC.has(t)).join('')
}

function sameName(customer: string, fence: NearFence): boolean {
  const c = nameWords(customer)
  const f = nameWords(fence.name)
  if (!c.length || !f.length) return false
  if (c.every((t) => f.includes(t))) return true
  if (fence.areaM2 > SMALL_M2) return false
  if (f.every((t) => c.includes(t))) return true
  const cr = nameRun(customer)
  const fr = nameRun(fence.name)
  return fr.length >= 5 && cr.length >= 5 && (cr.startsWith(fr) || fr.startsWith(cr))
}

/** Pure: which nearby fence, if any, a customer takes, and which are offered. */
export function pickFence(customerName: string, near: NearFence[]): FencePick {
  const usable = near.filter((f) => f.areaM2 <= BIG_M2).sort((a, b) => a.distanceM - b.distanceM || a.areaM2 - b.areaM2)
  const tagged = usable.map((f) => ({ f, byName: sameName(customerName, f) }))
  const named = tagged.find((x) => x.byName && x.f.distanceM <= MATCH_NEAR_M)
  const opt = (x: { f: NearFence, byName: boolean }): FenceOption => ({ id: x.f.id, name: x.f.name, distanceM: Math.round(x.f.distanceM), byName: x.byName })
  // Name matches first, then the nearest
  const offered = [...tagged.filter((x) => x.byName), ...tagged.filter((x) => !x.byName)].slice(0, OFFER).map(opt)
  return { match: named ? { ...opt(named), by: 'name' } : null, options: offered }
}
