/**
 * Shortening provider place strings.
 *
 * The rule under test is subtractive: every word in the output was in the
 * input, and what goes is the administrative hierarchy nobody navigates by.
 */

import { describe, it, expect } from 'vitest'
import { shortPlaceLabel } from '../../src/lib/place-label.js'

describe('shortPlaceLabel', () => {
  it('reduces a full reverse-geocoded address to what identifies the place', () => {
    expect(shortPlaceLabel(
      'Ndhiwa-Uriri Rd., Kenya, Kanyikela Ward, Ndhiwa Sub County, Homa Bay County, Riat Centre',
    )).toBe('Ndhiwa-Uriri, Riat Centre')
  })

  it('drops the country wherever it appears', () => {
    expect(shortPlaceLabel('Kigoma, Tanzania')).toBe('Kigoma')
  })

  it('keeps a road name once its type word is stripped', () => {
    expect(shortPlaceLabel('Ndhiwa-Uriri Rd.')).toBe('Ndhiwa-Uriri')
    expect(shortPlaceLabel('Ujiji Road, Kigoma')).toBe('Ujiji, Kigoma')
  })

  it('does not mistake a place NAMED for an admin word for the tier itself', () => {
    // "County Hall" is somewhere you can drive to; "Homa Bay County" is not.
    expect(shortPlaceLabel('County Hall, Homa Bay County, Kenya')).toBe('County Hall')
  })

  it('de-duplicates a name that repeats across tiers', () => {
    expect(shortPlaceLabel('Kigoma, Kigoma, Tanzania')).toBe('Kigoma')
  })

  it('keeps the ends when more than two parts survive', () => {
    expect(shortPlaceLabel('A, B, C, D')).toBe('A, D')
  })

  it('would rather return the raw first part than nothing at all', () => {
    // Everything was administrative. An operator gets a coarse answer, not a
    // blank where a location was recorded.
    expect(shortPlaceLabel('Homa Bay County, Kenya')).toBe('Homa Bay County')
  })

  it('distinguishes no location from an empty one', () => {
    expect(shortPlaceLabel(null)).toBeNull()
    expect(shortPlaceLabel('')).toBeNull()
    expect(shortPlaceLabel('  ,  ')).toBeNull()
  })
})
