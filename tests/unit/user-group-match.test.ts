/**
 * The email→group routing rule.
 *
 * The case this file exists for is `notkasulu.co.ke`. A SUFFIX rule for
 * `kasulu.co.ke` has to match `admin.kasulu.co.ke` and must NOT match
 * `notkasulu.co.ke` — both end with the pattern, so the obvious `endsWith`
 * admits the second, and admitting it hands anyone who can register one domain
 * name a seat inside somebody else's group.
 */

import { describe, it, expect, vi } from 'vitest'
import { groupForEmail, domainOf, normalisePattern, type GroupRule } from '../../src/modules/users/user-group.match.js'

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const RULES: GroupRule[] = [
  { groupId: 'g-offgrid', pattern: 'offgridconsultingltd.com', kind: 'SUFFIX' },
  { groupId: 'g-offgrid', pattern: 'ogc-monitoring',           kind: 'LABEL'  },
  { groupId: 'g-kasulu',  pattern: 'kasulu.co.ke',             kind: 'SUFFIX' },
]

describe('domainOf', () => {
  it('takes the part after the LAST @, lowercased', () => {
    expect(domainOf('Jane.Doe@Kasulu.CO.KE')).toBe('kasulu.co.ke')
    // A quoted local part may legally contain an @.
    expect(domainOf('"odd@name"@kasulu.co.ke')).toBe('kasulu.co.ke')
  })

  it('drops the trailing dot of a fully-qualified name', () => {
    expect(domainOf('a@kasulu.co.ke.')).toBe('kasulu.co.ke')
  })

  it('has no answer for a null, a blank or a non-address', () => {
    expect(domainOf(null)).toBeNull()
    expect(domainOf(undefined)).toBeNull()
    expect(domainOf('not-an-address')).toBeNull()
    expect(domainOf('trailing@')).toBeNull()
  })
})

describe('groupForEmail — SUFFIX', () => {
  it('matches the domain itself and any subdomain', () => {
    expect(groupForEmail('a@kasulu.co.ke', RULES)).toBe('g-kasulu')
    expect(groupForEmail('admin@admin.kasulu.co.ke', RULES)).toBe('g-kasulu')
    expect(groupForEmail('a@mail.admin.kasulu.co.ke', RULES)).toBe('g-kasulu')
  })

  it('does NOT match a domain that merely ends with the pattern', () => {
    // The whole point. `endsWith` would return g-kasulu for all three.
    expect(groupForEmail('a@notkasulu.co.ke', RULES)).toBeNull()
    expect(groupForEmail('a@evilkasulu.co.ke', RULES)).toBeNull()
    expect(groupForEmail('a@kasulu.co.ke.attacker.com', RULES)).toBeNull()
  })

  it('is case-insensitive on both sides', () => {
    expect(groupForEmail('A@ADMIN.KASULU.CO.KE', RULES)).toBe('g-kasulu')
    expect(groupForEmail('a@kasulu.co.ke', [
      { groupId: 'g-kasulu', pattern: 'KASULU.CO.KE', kind: 'SUFFIX' },
    ])).toBe('g-kasulu')
  })
})

describe('groupForEmail — LABEL', () => {
  it('matches a whole dot-separated label under any TLD', () => {
    expect(groupForEmail('a@ogc-monitoring.com', RULES)).toBe('g-offgrid')
    expect(groupForEmail('a@mail.ogc-monitoring.co.ke', RULES)).toBe('g-offgrid')
  })

  it('does not match a label it is merely part of', () => {
    expect(groupForEmail('a@ogc-monitoring-x.com', RULES)).toBeNull()
    expect(groupForEmail('a@xogc-monitoring.com', RULES)).toBeNull()
  })
})

describe('groupForEmail — both of the operator\'s groups', () => {
  it('routes the addresses that prompted this', () => {
    expect(groupForEmail('developer@offgridconsultingltd.com', RULES)).toBe('g-offgrid')
    expect(groupForEmail('ops@ogc-monitoring.co.ke', RULES)).toBe('g-offgrid')
    expect(groupForEmail('admin@admin.kasulu.co.ke', RULES)).toBe('g-kasulu')
  })
})

describe('groupForEmail — the ControlTech pair', () => {
  /* Two rules for one contractor, and the reason is a hyphen. `controltech-ea`
     is a single dot-separated label, so a LABEL rule for `controltech` does NOT
     match it — labels match whole, which is the property the whole matcher is
     built on. The suffix carries the address this group was created for; the
     label is what catches the same firm on a different domain later. */
  const CT: GroupRule[] = [
    { groupId: 'g-ct', pattern: 'controltech-ea.com', kind: 'SUFFIX' },
    { groupId: 'g-ct', pattern: 'controltech',        kind: 'LABEL'  },
  ]

  it('routes the address the group was created for', () => {
    expect(groupForEmail('tech@controltech-ea.com', CT)).toBe('g-ct')
    expect(groupForEmail('tech@mail.controltech-ea.com', CT)).toBe('g-ct')
  })

  it('routes the same firm on another domain, via the label', () => {
    expect(groupForEmail('a@controltech.co.ke', CT)).toBe('g-ct')
    expect(groupForEmail('a@controltech.fleet', CT)).toBe('g-ct')
  })

  it('is why BOTH rules are listed: the label alone would miss the hyphen', () => {
    const labelOnly: GroupRule[] = [{ groupId: 'g-ct', pattern: 'controltech', kind: 'LABEL' }]
    expect(groupForEmail('tech@controltech-ea.com', labelOnly)).toBeNull()
  })

  it('does not catch a lookalike domain', () => {
    expect(groupForEmail('a@notcontroltech-ea.com', CT)).toBeNull()
    expect(groupForEmail('a@controltech-ea.com.attacker.com', CT)).toBeNull()
  })
})

describe('groupForEmail — specificity', () => {
  it('prefers the longer suffix, so a subdomain can have its own group', () => {
    const rules: GroupRule[] = [
      { groupId: 'g-kasulu',  pattern: 'kasulu.co.ke',         kind: 'SUFFIX' },
      { groupId: 'g-special', pattern: 'special.kasulu.co.ke', kind: 'SUFFIX' },
    ]
    expect(groupForEmail('a@special.kasulu.co.ke', rules)).toBe('g-special')
    expect(groupForEmail('a@other.kasulu.co.ke', rules)).toBe('g-kasulu')
  })

  it('prefers an exact domain over a subdomain match of the same length', () => {
    const rules: GroupRule[] = [
      { groupId: 'g-exact', pattern: 'kasulu.co.ke', kind: 'SUFFIX' },
    ]
    expect(groupForEmail('a@kasulu.co.ke', rules)).toBe('g-exact')
  })

  it('prefers any SUFFIX over any LABEL', () => {
    const rules: GroupRule[] = [
      { groupId: 'g-label',  pattern: 'kasulu',                    kind: 'LABEL'  },
      { groupId: 'g-suffix', pattern: 'kasulu.co.ke',              kind: 'SUFFIX' },
    ]
    expect(groupForEmail('a@kasulu.co.ke', rules)).toBe('g-suffix')
  })
})

describe('groupForEmail — refuses a tie rather than guessing', () => {
  it('leaves the account ungrouped when two groups claim it equally', () => {
    const rules: GroupRule[] = [
      { groupId: 'g-one', pattern: 'shared.co.ke', kind: 'SUFFIX' },
      { groupId: 'g-two', pattern: 'shared.co.ke', kind: 'SUFFIX' },
    ]
    // Picking either would place somebody by whichever row came back first,
    // and that placement decides who can administer them.
    expect(groupForEmail('a@shared.co.ke', rules)).toBeNull()
  })

  it('is untroubled by two spellings of the SAME claim', () => {
    const rules: GroupRule[] = [
      { groupId: 'g-one', pattern: 'shared.co.ke',  kind: 'SUFFIX' },
      { groupId: 'g-one', pattern: '.shared.co.ke', kind: 'SUFFIX' },
    ]
    expect(groupForEmail('a@shared.co.ke', rules)).toBe('g-one')
  })
})

describe('groupForEmail — nothing to go on', () => {
  it('returns null for a registry driver, who has no email at all', () => {
    expect(groupForEmail(null, RULES)).toBeNull()
    expect(groupForEmail(undefined, RULES)).toBeNull()
  })

  it('returns null when no rule claims the domain', () => {
    expect(groupForEmail('someone@gmail.com', RULES)).toBeNull()
  })

  it('returns null when there are no rules', () => {
    expect(groupForEmail('a@kasulu.co.ke', [])).toBeNull()
  })

  it('ignores a blank pattern rather than matching everything on it', () => {
    expect(groupForEmail('a@kasulu.co.ke', [
      { groupId: 'g-empty', pattern: '   ', kind: 'SUFFIX' },
    ])).toBeNull()
  })
})

describe('normalisePattern', () => {
  it('lowercases and strips surrounding dots and space', () => {
    expect(normalisePattern('  .Kasulu.CO.KE. ')).toBe('kasulu.co.ke')
  })
})
