/**
 * Feed sources only some viewers' feeds carry.
 *
 *   repair_flag    a unit flagged for repair: news to the technician who will
 *                  fix it, not to the Control Room that flagged it.
 *   repair_ticket  a repair ticket number issued, or a repair completed and
 *                  tested: for the operator, supervisor, Head of Security and
 *                  Assistant Head of Security only.
 *   repair_verified  a repair verified by the Control Room: for the
 *                  technicians. The job is closed by then, so its unit has
 *                  left a technician's flagged-units scope; this source is
 *                  shown to them whatever the vehicle (SCOPE_EXEMPT_SOURCES).
 *                  (all operator, 2026-10-27)
 *
 * A technician's feed is an allow-list (authz/subject FLAGGED_ONLY_FEED_SOURCES).
 * Every other viewer sees a restricted source only when granted it
 * (feedGrantsFor); the REST page, the SSE replay and the live stream all
 * apply the same rule.
 */
export const RESTRICTED_SOURCES: ReadonlySet<string> = new Set(['repair_flag', 'repair_ticket', 'repair_verified'])

/** Shown to a viewer allowed the source even outside their vehicle scope. */
export const SCOPE_EXEMPT_SOURCES: ReadonlySet<string> = new Set(['repair_verified'])

/** Roles whose holders see repair ticket notices in their feed. */
export const TICKET_FEED_ROLES = ['operator', 'supervisor', 'head_of_security', 'asst_head_of_security'] as const

/** Restricted sources this viewer may NOT see, given the ones granted. */
export function hiddenSources(grants: readonly string[] | null | undefined): string[] {
  return [...RESTRICTED_SOURCES].filter((s) => !grants?.includes(s))
}

/** Drop items in restricted sources not granted, from a read that named no sources. */
export function withoutRestricted<T extends { source?: string | null }>(items: T[], grants?: readonly string[] | null): T[] {
  const hide = new Set(hiddenSources(grants))
  return items.filter((i) => !(i.source && hide.has(i.source)))
}
