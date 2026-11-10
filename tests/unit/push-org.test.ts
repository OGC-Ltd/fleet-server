import { describe, expect, it } from 'vitest'
import { orgMarkIcon, payloadOrgId, withOrganisation } from '../../src/lib/push-org.js'

describe('push organisation logo', () => {
  it('names the web app mark by the lower-case code', () => {
    expect(orgMarkIcon('MENENGAI')).toBe('/org-marks/menengai.png')
    expect(orgMarkIcon(' WestSugar ')).toBe('/org-marks/westsugar.png')
  })

  it('replaces the icon and adds the code and id to the data', () => {
    const out = withOrganisation({ title: 'T', body: 'B', icon: '/logo-icon.png', data: { itemId: 'i1' } }, 'o1', 'SUKARI')
    expect(out.icon).toBe('/org-marks/sukari.png')
    expect(out.data).toEqual({ itemId: 'i1', orgId: 'o1', orgCode: 'SUKARI' })
  })

  it('leaves the payload alone without an organisation or a code', () => {
    const p = { title: 'T', body: 'B', icon: '/logo-icon.png' }
    expect(withOrganisation(p, null, 'SUKARI')).toBe(p)
    expect(withOrganisation(p, 'o1', null)).toBe(p)
  })

  it('reads the organisation from data.orgId', () => {
    expect(payloadOrgId({ title: 'T', body: 'B', data: { orgId: 'o2' } })).toBe('o2')
    expect(payloadOrgId({ title: 'T', body: 'B' })).toBeNull()
  })
})
