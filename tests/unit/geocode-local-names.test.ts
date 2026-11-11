import { describe, it, expect } from 'vitest'
import { localName } from '../../src/lib/geocode.js'

describe('places the fleets name otherwise than OpenStreetMap', () => {
  it('calls the Timsales yard area Elburgon', () => {
    expect(localName('Kasarani Mwatu, Molo, Kenya', -0.30, 35.80)).toBe('Elburgon, Molo, Kenya')
    expect(localName('Kasarani Site, Molo, Kenya', -0.29, 35.81)).toBe('Elburgon, Molo, Kenya')
    expect(localName('Kasarani Mwatu, Elburgon, Kenya', -0.3008, 35.8016)).toBe('Elburgon, Kenya')
  })

  it('leaves the other Kasaranis, and every other place, alone', () => {
    expect(localName('Kasarani sublocation, Nairobi, Kenya', -1.24, 36.89)).toBe('Kasarani sublocation, Nairobi, Kenya')
    expect(localName('Kasarani, Rongai, Kenya', -0.12, 35.94)).toBe('Kasarani, Rongai, Kenya')
    expect(localName('Molo, Nakuru, Kenya', -0.30, 35.80)).toBe('Molo, Nakuru, Kenya')
    expect(localName(null, -0.30, 35.80)).toBeNull()
  })
})
