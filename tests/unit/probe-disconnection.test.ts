/**
 * The Probe Disconnection Report's working, on alerts in the words of West
 * Kenya's Wialon sheet.
 */
import { describe, it, expect } from 'vitest'
import { disconnectionsOf, parseProbeAlert, RUN_GAP_MS, type ProbeAlert } from '../../src/modules/reports/probe-disconnection.service.js'

const MOVING = 'WKS Fuel Probe Disconnection Alert (Omnicom)\n\nWKS - Nzoia Sugar - KDJ 813Z: Probe has been disconnected, Current Fuel Level = 0L. At 30.10.2026 19:54:54 with a speed of 5 km/h within  Location D267, South Kabras Ward, Malava Sub County, Kakamega County, Kenya, 2.11 km from Kambi-Mwanza Google Map https://maps.google.com/?q=0.376852,34.834289'
const STANDING = 'Kabras Fuel Probe Disconnection Alert (Omnicom)\n\nWKS - Kabras - KDJ 820Z: Probe has been disconnected, Current Fuel Level = 3L. At 27.10.2026 18:53:24 with a speed of  within  Location  Google Map https://maps.google.com/?q=0.378502,34.833738'
const OTHER_RULE = 'WAsset Overspeeding Above 60 KPH In a  West_Kenya Blackspot\n\nWKS - Kabras - KDK 820G arrived to Lugulu Blackspot. WKS - Kabras - KDK 820G violated speed limitations. At 30.10.2026 08:43:10 it moved'

describe('an alert’s words', () => {
  it('reads the time in Nairobi, the speed, the place and the fix', () => {
    expect(parseProbeAlert(MOVING)).toEqual({
      at: Date.parse('2026-10-30T19:54:54+03:00'), speedKmh: 5,
      place: 'D267, South Kabras Ward, Malava Sub County, Kakamega County, Kenya, 2.11 km from Kambi-Mwanza',
      lat: 0.376852, lng: 34.834289,
    })
  })
  it('leaves out a speed and a place Wialon left blank', () => {
    expect(parseProbeAlert(STANDING)).toMatchObject({ speedKmh: null, place: null, lat: 0.378502 })
  })
  it('is not another rule’s event', () => {
    expect(parseProbeAlert(OTHER_RULE)).toBeNull()
  })
  it('falls back on the message’s time, and has none to give without one', () => {
    const words = 'Probe has been disconnected.'
    expect(parseProbeAlert(words, 5_000)?.at).toBe(5_000)
    expect(parseProbeAlert(words)).toBeNull()
  })
})

describe('alerts as disconnections', () => {
  const T = Date.parse('2026-10-30T06:00:00+03:00')
  const alert = (min: number, over: Partial<ProbeAlert> = {}): ProbeAlert => ({ at: T + min * 60_000, speedKmh: null, place: null, lat: null, lng: null, ...over })
  it('counts the two rules’ copies of one second once', () => {
    expect(disconnectionsOf([alert(0), alert(0)])).toMatchObject([{ alerts: 1, to: T }])
  })
  it('keeps alerts under 30 minutes apart as one, and starts another at 30', () => {
    const gap = RUN_GAP_MS / 60_000 // exactly this far apart is a new one
    const runs = disconnectionsOf([alert(0), alert(1), alert(1 + gap), alert(2 + gap), alert(2 + 2 * gap)])
    expect(runs.map(r => r.alerts)).toEqual([2, 2, 1])
    expect(runs[0]).toMatchObject({ at: T, to: T + 60_000 })
  })
  it('takes the first place and speed the run knows, in time order', () => {
    const runs = disconnectionsOf([alert(2, { place: 'Later', speedKmh: 40, lat: 2, lng: 2 }), alert(0), alert(1, { place: 'First', speedKmh: 5, lat: 1, lng: 1 })])
    expect(runs).toMatchObject([{ at: T, place: 'First', speedKmh: 5, lat: 1, lng: 1, alerts: 3 }])
  })
  it('has none without alerts', () => {
    expect(disconnectionsOf([])).toEqual([])
  })
})
