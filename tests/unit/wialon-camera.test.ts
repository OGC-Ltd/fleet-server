/**
 * The camera read, pinned against the ONE real camera unit in this account.
 *
 * `VS Menengai CAMERA - KCS 078M` (Wialon id 28628615) — its sensor list and
 * live parameters below are copied from the live account on 2026-08-29, not
 * invented. The URL is the one thing that cannot be pinned to reality: the
 * parameter its Video_URL sensor reads has never arrived, so the tests state
 * what happens for each shape it might take instead.
 */

import { describe, it, expect } from 'vitest'
import { readCamera } from '../../src/providers/wialon/wialon.sensors.js'

/** The real unit's sensors, verbatim from core/search_items. */
const MENENGAI_SENSORS = {
  1: { n: 'ALARM_END',            t: 'custom',            p: 'alarm_end_time' },
  2: { n: 'ALARM_START',          t: 'custom',            p: 'alarm_start_time' },
  3: { n: 'Harsh Acceleration 1', t: 'custom',            p: 'alarm_ec' },
  4: { n: 'Harsh Braking 1',      t: 'custom',            p: 'alarm_ec' },
  5: { n: 'IGN',                  t: 'engine operation',  p: 'status1:1' },
  6: { n: 'Ignition',             t: 'engine operation',  p: 'status1' },
  7: { n: 'Video_URL',            t: 'custom',            p: 'video_uri' },
} as never

/** Its real live parameters, minus the 30-odd irrelevant ones. */
const MENENGAI_PARAMS = {
  recording_status: 7, hd15_status: 1, hd15_size: 59488,
  video_loss: 0, video_blind: 0, status1: 0, mob_signal: 10,
}

/** A fuel-probe unit — the other 1,495 in the account. */
const ORDINARY_SENSORS = {
  1: { n: '1.FUEL', t: 'fuel level',       p: 'io_270' },
  2: { n: '1.IGN',  t: 'engine operation', p: 'io_239' },
} as never

describe('camera detection', () => {
  it('finds the recorder on the real camera unit', () => {
    const c = readCamera(MENENGAI_SENSORS, MENENGAI_PARAMS)
    expect(c.hasCamera).toBe(true)
    expect(c.recording).toBe(true)     // recording_status 7
    expect(c.signalLost).toBe(false)   // video_loss 0
  })

  it('reads the URL parameter NAME off the sensor rather than assuming it', () => {
    // The whole point: `video_uri` is a hand-made custom sensor on one account.
    // Following the sensor's own `p` survives an integrator who names it
    // something else.
    expect(readCamera(MENENGAI_SENSORS, MENENGAI_PARAMS).urlParam).toBe('video_uri')

    const renamed = { 1: { n: 'Stream URL', t: 'custom', p: 'dvr_link' } } as never
    expect(readCamera(renamed, { dvr_link: 'https://x/y.m3u8' }).urlParam).toBe('dvr_link')
  })

  it('reports no camera for an ordinary fuel-probe unit', () => {
    const c = readCamera(ORDINARY_SENSORS, { io_270: 41000, io_239: 1 })
    expect(c.hasCamera).toBe(false)
    expect(c.streamUrl).toBeNull()
  })

  it('detects a recorder from its diagnostics even with no video sensor at all', () => {
    // The capability signal is the hardware talking about itself. A unit whose
    // installer never added a Video_URL sensor still has a camera.
    const c = readCamera(ORDINARY_SENSORS, { recording_status: 1, video_loss: 0 })
    expect(c.hasCamera).toBe(true)
    expect(c.urlParam).toBeNull()
  })
})

describe('the URL, which has never actually arrived', () => {
  it('passes through an http(s) URL', () => {
    const c = readCamera(MENENGAI_SENSORS, { ...MENENGAI_PARAMS, video_uri: 'https://vid.example/a.m3u8' })
    expect(c.streamUrl).toBe('https://vid.example/a.m3u8')
  })

  /**
   * The defensive half. Nobody knows what `video_uri` will hold, so anything
   * that is not a browser-openable URL leaves `streamUrl` null while
   * `hasCamera` stays true — which the client renders as "camera fitted, no
   * stream available" rather than as a black <video> nobody can diagnose.
   */
  it.each([
    ['an rtsp stream',   'rtsp://10.0.0.4:554/ch1'],
    ['a bare path',      '/media/28628615/ch1.ts'],
    ['an opaque token',  'a8f3e1c9d2'],
    ['a channel list',   'ch1,ch2,ch3'],
    ['empty',            ''],
  ])('drops %s but keeps hasCamera true', (_label, value) => {
    const c = readCamera(MENENGAI_SENSORS, { ...MENENGAI_PARAMS, video_uri: value })
    expect(c.streamUrl).toBeNull()
    expect(c.hasCamera).toBe(true)
  })

  it('survives the parameter simply being absent, which is today\'s reality', () => {
    // 0 of 1,707 messages over seven days carried it.
    const c = readCamera(MENENGAI_SENSORS, MENENGAI_PARAMS)
    expect(c.streamUrl).toBeNull()
    expect(c.urlParam).toBe('video_uri')
  })

  it('does not throw on missing sensors or params', () => {
    expect(readCamera(undefined, undefined).hasCamera).toBe(false)
    expect(readCamera(MENENGAI_SENSORS, undefined).hasCamera).toBe(true) // urlSensor alone
  })
})
