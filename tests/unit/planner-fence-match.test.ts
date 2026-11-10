import { describe, it, expect, vi } from 'vitest'
vi.mock('../../src/lib/prisma.js')
import { pickFence, nameWords, OFFER } from '../../src/modules/planner/fence-match.js'

const f = (id: string, name: string, distanceM: number, areaM2 = 31_000) => ({ id, name, distanceM, areaM2 })

describe('nameWords', () => {
  it('drops the provider prefix and the words that only say it is a shop', () => {
    expect(nameWords('MENENGAI_VS:EBENEZER STORES')).toEqual(['EBENEZER'])
    expect(nameWords('Wa Maggy Shop')).toEqual(['MAGGY'])
    expect(nameWords('MINI SHOP')).toEqual([])
  })
})

describe('pickFence', () => {
  it('takes the nearest fence carrying the customer name, even a little way off', () => {
    const p = pickFence('EBENEZER STORES', [f('a', 'MURAMBI MARKET', 0), f('b', 'MENENGAI_VS:EBENEZER STORES', 140)])
    expect(p.match).toMatchObject({ id: 'b', by: 'name', distanceM: 140 })
    expect(p.options[0].id).toBe('b')
  })
  it('never takes a fence by place alone: shops overlap, so the point may sit in the next shop', () => {
    const p = pickFence('ADONAI GEN SHOP', [f('m', 'MENENGAI_VS: MATUNDA WHOLESALERS', 0, 2_827), f('r', 'MENENGAI_VS:THE ROCK ENTERPRISES', 656)])
    expect(p.match).toBeNull()
    expect(p.options.map((o) => [o.id, o.distanceM])).toEqual([['m', 0], ['r', 656]])
  })
  it('matches a name run together: WA MUIRU and WAMUIRU', () => {
    const p = pickFence('WA MUIRU CEREALS & SHOP', [f('a', 'MENENGAI_VS:ARIMIS SHOP', 6), f('w', 'MENENGAI_VS:WAMUIRU SHOP', 43)])
    expect(p.match).toMatchObject({ id: 'w', by: 'name' })
  })
  it('draws a new circle when nothing nearby is the shop, but offers what is near', () => {
    const p = pickFence('UMOJA FOOD MARKET', [f('n', 'MENENGAI_VS:KWA NJOROGE', 45), f('big', 'ESTATE', 0, 9_000_000)])
    expect(p.match).toBeNull()
    expect(p.options.map((o) => o.id)).toEqual(['n'])
  })
  it('a generic name matches nothing by name; a short fence name matches only a small fence', () => {
    expect(pickFence('MINI SHOP', [f('m', 'MINI SHOP', 30)]).match).toBeNull()
    expect(pickFence('SMART CHOICE SHOP SOLAI', [f('s', 'SMART CHOICE', 60)]).match?.id).toBe('s')
    expect(pickFence('SMART CHOICE SHOP SOLAI', [f('s', 'SMART CHOICE', 60, 600_000)]).match).toBeNull()
  })
  it('offers at most a handful, name matches first', () => {
    const near = Array.from({ length: 10 }, (_, i) => f(`x${i}`, `OTHER ${i}`, i * 10))
    near.push(f('me', 'WA MAGGY', 900))
    const p = pickFence('WA MAGGY SHOP', near)
    expect(p.options).toHaveLength(OFFER)
    expect(p.options[0]).toMatchObject({ id: 'me', byName: true })
  })
})
