/**
 * Which RaiFactorySuite factory belongs to which of our organisations.
 *
 * ## Why this file exists rather than the two copies it replaces
 *
 * The table was declared twice — once in raifactorysuite-alerts.service and
 * once in raifactorysuite-events.service — with a comment on each saying it
 * mirrored the sync scripts. Two tables that must agree and nothing making
 * them agree: adding a factory to one and not the other silently routes that
 * site's alerts and its dispatches to different places, and the symptom is
 * "some of it arrives", which is the hardest kind to notice.
 *
 * ## The mapping is a filter, and that is the point
 *
 * A factoryCode absent from this table is not an error in the payload — the
 * provider serves factories we do not track, and it is right to drop those.
 * What was wrong is dropping them QUIETLY: the events path returned false and
 * the webhook controller counted zero, which suppressed even the summary log
 * line, so a whole factory's traffic arrived, parsed cleanly, and vanished
 * leaving nothing behind to find. `skipUnmappedFactory` below is the fix — one
 * warning per factory code, not one per event, so a misconfiguration is loud
 * on the first delivery and silent on the next ten thousand.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'

/**
 * Provider factoryCode → our organisation `code`.
 *
 * The provider serves two factories. NDHIWA has been here since this
 * integration was written; NAITIRI is a West Kenya Sugar factory and had never
 * been added, so every dispatch, gate movement and alert it produced was
 * discarded on arrival — half the provider's traffic, for as long as the
 * integration has run.
 */
export const FACTORY_TO_ORG: Record<string, string> = {
  NDHIWA:  'SUKARI',
  NAITIRI: 'WESTSUGAR',
}

/**
 * Cached because it is asked once per event on a hot path and the answer
 * cannot change without a deploy. A null is cached too: an unmapped factory
 * must not re-query for every one of its events.
 */
const orgIdCache = new Map<string, string | null>()

export async function resolveOrgId(factoryCode: string): Promise<string | null> {
  if (orgIdCache.has(factoryCode)) return orgIdCache.get(factoryCode) ?? null
  const code = FACTORY_TO_ORG[factoryCode]
  if (!code) { orgIdCache.set(factoryCode, null); return null }
  const org = await prisma.organisation.findUnique({ where: { code }, select: { id: true } })
  if (!org) {
    // Mapped to an organisation that is not in the database — a typo in the
    // table, or a tenant that was renamed. Worth its own line: it looks
    // identical to "not mapped" from the caller's side and is a quite
    // different mistake.
    logger.warn({ factoryCode, orgCode: code }, 'Factory maps to an organisation code that does not exist')
  }
  orgIdCache.set(factoryCode, org?.id ?? null)
  return org?.id ?? null
}

/** Factory codes already warned about, so the log carries one line per factory
 *  rather than one per event. Reset only by a restart, which is when a changed
 *  table would take effect anyway. */
const warned = new Set<string>()

/**
 * Say once, loudly, that a factory's events are being discarded.
 *
 * Call this wherever `resolveOrgId` returns null. The alerts path has always
 * logged this; the events path never did, which is why NAITIRI's dispatches
 * and gate movements left no trace at all.
 */
export function skipUnmappedFactory(factoryCode: string, what: string, id?: string): void {
  if (warned.has(factoryCode)) return
  warned.add(factoryCode)
  logger.warn(
    { factoryCode, event: what, sampleId: id, mapped: Object.keys(FACTORY_TO_ORG) },
    'Provider event for an unmapped factory — DISCARDED. Add it to FACTORY_TO_ORG to keep it.',
  )
}
