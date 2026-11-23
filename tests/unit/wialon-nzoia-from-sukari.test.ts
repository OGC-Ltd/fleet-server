/**
 * The four "SUKARI - Nzoia Sugar - …" trucks moved to Nzoia (2026-11-23).
 *
 * The Nzoia sync adopts them by Wialon unit id, keeps their plate as it is
 * stored today ("KDZ 129S"), and files them in Nzoia's existing group rather
 * than a new "West Sugar · NZOIA SUGAR" one.
 */
import { describe, expect, it } from 'vitest'
import { findFleet, NZOIA_FROM_SUKARI, nzoiaGroup } from '../../src/providers/wialon/wialon.account.js'

describe('Nzoia: the trucks moved from Sukari', () => {
  const nzoia = findFleet('NZOIA')!

  it('adopts exactly the four Wialon units', () => {
    expect(nzoia.extraUnitIds).toEqual([30505255, 30505248, 30505257, 30505254])
    expect(NZOIA_FROM_SUKARI).toHaveLength(4)
  })

  it('no other fleet claims them', () => {
    for (const code of ['KASULU', 'MENENGAI', 'WESTSUGAR', 'KABRAS', 'TIMSALES', 'AQUAMIST']) {
      const extras = findFleet(code)?.extraUnitIds ?? []
      expect(extras.some(id => NZOIA_FROM_SUKARI.includes(id))).toBe(false)
    }
  })

  it('keeps the plate as stored', () => {
    for (const plate of ['KDZ 129S', 'KDZ 132S', 'KDZ 138S', 'KDZ 139S']) {
      expect(nzoia.plateOf(`SUKARI - Nzoia Sugar - ${plate}`)).toBe(plate)
    }
  })

  it("joins Nzoia's existing sugar group", () => {
    expect(nzoia.groupOf('SUKARI - Nzoia Sugar - KDZ 129S'))
      .toEqual({ code: 'WESTSUGAR_WKS_NZOIA_SUGAR', name: 'WKS · NZOIA SUGAR' })
  })

  it("leaves Nzoia's own units' groups as they were", () => {
    expect(nzoiaGroup('WKS - Nzoia Sugar - KDZ 100A').code).toBe('WESTSUGAR_WKS_NZOIA_SUGAR')
    expect(nzoiaGroup('WKS - Nzoia Quarry - KCA 001A').code).toBe('WESTSUGAR_WKS_NZOIA_QUARRY')
  })

  it('does not reach the Sukari units of other sites through the name mask', () => {
    expect(nzoia.nameMask!.test('SUKARI - Nzoia Sugar - KDZ 129S')).toBe(false)
  })
})
