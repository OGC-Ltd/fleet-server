/**
 * Feed sources only a technician's Live Feed carries.
 *
 * A unit flagged for repair is news to the technician who will fix it, not to
 * the Control Room that flagged it (operator, 2026-10-27). Every other
 * viewer's feed — the REST page, the SSE replay and the live stream — leaves
 * these out.
 */
export const TECHNICIAN_ONLY_SOURCES: ReadonlySet<string> = new Set(['repair_flag'])

/** Drop technician-only items from a feed read that asked for no sources. */
export function withoutTechnicianOnly<T extends { source?: string | null }>(items: T[]): T[] {
  return items.filter((i) => !(i.source && TECHNICIAN_ONLY_SOURCES.has(i.source)))
}
