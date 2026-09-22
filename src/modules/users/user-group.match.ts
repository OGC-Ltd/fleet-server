/**
 * Which group an address belongs to.
 *
 * Pure, and exported on its own, because this is the whole of the routing rule
 * and none of the plumbing: it decides who can administer whom, and that is
 * worth a table of cases rather than a click-through per address.
 *
 * ## It runs at WRITE time, never at read time
 *
 * Callers use this to fill `User.groupId` when an account is created or its
 * email changes. Nothing consults it to answer "may this administrator see
 * that row" — that reads the stored column. The separation is deliberate: an
 * access rule derived live from an editable field is an access rule the
 * subject can move, and it leaves no record of how anybody came to be where
 * they are.
 *
 * ## The dot boundary is the whole safety argument
 *
 * A SUFFIX rule for `kasulu.co.ke` must match `admin.kasulu.co.ke` and must
 * not match `notkasulu.co.ke`. Both end with the pattern, so `endsWith` alone
 * admits the second — and admitting it hands an outsider who can register one
 * domain name a seat inside somebody else's group. Every suffix test here goes
 * through `matchesSuffix`, which requires either equality or a `.` immediately
 * before the match.
 */

import { logger } from '../../lib/logger.js'

/** How a pattern is compared against a domain. Mirrors the `DomainMatch` enum. */
export type DomainMatchKind = 'SUFFIX' | 'LABEL'

export interface GroupRule {
  groupId: string
  /** Lowercased at the boundary; see `normalisePattern`. */
  pattern: string
  kind: DomainMatchKind
}

/**
 * The domain part of an address, lowercased — or `null` if there isn't one.
 *
 * `lastIndexOf('@')` rather than a split: a quoted local part may legally
 * contain an `@`, and the domain is what follows the LAST one. Addresses that
 * reach this are already stored, so the job is to read them correctly rather
 * than to judge them.
 */
export function domainOf(email: string | null | undefined): string | null {
  if (!email) return null
  const at = email.lastIndexOf('@')
  if (at < 0) return null
  const domain = email.slice(at + 1).trim().toLowerCase()
  // A trailing dot is legal in a fully-qualified name and means the same
  // thing; leaving it on would defeat every comparison below.
  const trimmed = domain.replace(/\.+$/, '')
  return trimmed.length > 0 ? trimmed : null
}

/** Patterns are compared lowercased, so they are stored lowercased. */
export function normalisePattern(pattern: string): string {
  return pattern.trim().toLowerCase().replace(/^\.+|\.+$/g, '')
}

/** `kasulu.co.ke` ⊇ `admin.kasulu.co.ke`, and NOT `notkasulu.co.ke`. */
function matchesSuffix(domain: string, pattern: string): boolean {
  if (domain === pattern) return true
  return domain.endsWith(`.${pattern}`)
}

/** `ogc-monitoring` ⊇ `mail.ogc-monitoring.co.ke`. */
function matchesLabel(domain: string, pattern: string): boolean {
  return domain.split('.').includes(pattern)
}

/**
 * The group this address routes to, or `null` when no rule claims it.
 *
 * ## Most specific wins, and a tie is refused
 *
 * Rules are ranked: an exact domain beats a longer suffix, a longer suffix
 * beats a shorter one, and any suffix beats a label. That order is what lets
 * `kasulu.co.ke` route to one group while `special.kasulu.co.ke` routes to
 * another without the two fighting.
 *
 * Two rules of EQUAL rank claiming one address is a configuration error, not a
 * coin toss. Picking either would place somebody in a group by whichever row
 * the database happened to return first, and that placement decides who can
 * administer them. So it returns `null` — the account lands ungrouped, which
 * is visible to the platform administrator only and is meant to be noticed —
 * and logs both candidates by name.
 */
export function groupForEmail(email: string | null | undefined, rules: GroupRule[]): string | null {
  const domain = domainOf(email)
  if (!domain) return null

  type Hit = { groupId: string; pattern: string; rank: number }
  const hits: Hit[] = []

  for (const rule of rules) {
    const pattern = normalisePattern(rule.pattern)
    if (!pattern) continue

    if (rule.kind === 'SUFFIX' && matchesSuffix(domain, pattern)) {
      // Exact beats subdomain; among subdomains the longer pattern is the
      // more specific claim. +1000 keeps every suffix above every label.
      hits.push({
        groupId: rule.groupId,
        pattern,
        rank: 1000 + pattern.length + (domain === pattern ? 1 : 0),
      })
    } else if (rule.kind === 'LABEL' && matchesLabel(domain, pattern)) {
      hits.push({ groupId: rule.groupId, pattern, rank: pattern.length })
    }
  }

  if (hits.length === 0) return null

  hits.sort((a, b) => b.rank - a.rank)
  const [best, runnerUp] = hits

  // Same rank, different group — genuinely ambiguous. Same rank and the SAME
  // group is fine: two spellings of one claim, and the answer is unchanged.
  if (runnerUp && runnerUp.rank === best.rank && runnerUp.groupId !== best.groupId) {
    logger.warn(
      { domain, candidates: hits.filter(h => h.rank === best.rank).map(h => ({ pattern: h.pattern, groupId: h.groupId })) },
      'user-group: two rules of equal specificity claim this domain — leaving the account ungrouped',
    )
    return null
  }

  return best.groupId
}
