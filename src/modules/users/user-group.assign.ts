/**
 * Placing an account in a group, at WRITE time.
 *
 * `groupForEmail` is the rule; this is the one place that runs it against the
 * live rule set. Its callers are the two paths that CREATE an account — the
 * roster's own create and the cross-org provisioning flow — and the backfill
 * script.
 *
 * Nothing changes a placement after that, because nothing in this app can
 * change an email: `updateUserSchema` omits the field and self-service only
 * changes a name. If a route to change one is ever added, it must place the
 * account again, and it must not silently overwrite a group an administrator
 * set by hand — that is a deliberate exception (a contractor on a personal
 * address, somebody moved during a handover), and reverting it as a side
 * effect of a profile edit would be the worst kind of bug: correct-looking,
 * invisible, and about who can see whom. prisma/backfill-user-groups.ts
 * already implements exactly that restraint and is the model to follow.
 */

import { prisma } from '../../lib/prisma.js'
import { groupForEmail, type GroupRule } from './user-group.match.js'

/** Every routing rule, shaped for the matcher. */
export async function loadRules(): Promise<GroupRule[]> {
  const rows = await prisma.groupEmailDomain.findMany({
    select: { groupId: true, pattern: true, kind: true },
  })
  return rows.map(r => ({ groupId: r.groupId, pattern: r.pattern, kind: r.kind }))
}

/** The group this address routes to under the live rules, or `null`. */
export async function resolveGroupId(email: string | null | undefined): Promise<string | null> {
  if (!email) return null
  return groupForEmail(email, await loadRules())
}
